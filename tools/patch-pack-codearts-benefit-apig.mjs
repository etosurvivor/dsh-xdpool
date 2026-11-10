#!/usr/bin/env node
/**
 * CodeArts benefit 通道 APIG.0101 有限回退补丁 —— 幂等，可反复运行。
 *
 * 只做一个改动点：请求走 benefit 通道（maas_type: benefit）被上游以
 * APIG.0101 拒绝时，去掉 benefit 头、重新签名、重试一次，不循环。
 *
 * 实测依据（2026-11-10 02:23Z，本机同凭据、同模型 deepseek-v4.1-flash 对照）：
 *   带 maas_type: benefit → HTTP 200 + SSE error frame：
 *     error_code "InferHub.APIG.0101.404"
 *     error_msg  "The API does not exist or has not been published in the environment"
 *   不带该头            → HTTP 200 正常流式返回
 * 即：网关并不回真正的 HTTP 404，而是 200 包一层 error frame；插件只透出
 * error_msg、丢掉 error_code，界面上就只剩那句文本。glm-5.3-flash 同属
 * CODEARTS_BENEFIT_FALLBACK，走同一条路。
 *
 * 现有实现只对 SSE 里的 InferHub.4004.200（benefit not found）回退，不认
 * APIG.0101 / 404 —— 本机 2026-11-10 10:06 的 INVALID_REQUEST(200) 就卡在这里
 * （网关用 HTTP 200 + SSE error frame 报的 APIG.0101，插件只留下 error_msg）。
 *
 * 用法：
 *   node tools/patch-pack-codearts-benefit-apig.mjs           # 打补丁
 *   node tools/patch-pack-codearts-benefit-apig.mjs --check   # 只检查（0=在位 1=缺失）
 */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECK_ONLY = process.argv.includes('--check');
const fileIndex = process.argv.indexOf('--file');
const PACK = fileIndex < 0
  ? fileURLToPath(new URL('../vendor/channel-pack/pack.js', import.meta.url))
  : path.resolve(process.argv[fileIndex + 1] ?? '');

const MARK = '[patch:codearts-benefit-apig]';

const A_CONST = 'var CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE = "InferHub.4004.200";';

const A_SSE = [
  '            if (data.error_code === CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE) {',
  '              throw new LlmError2(`codearts: ${message2}`, BENEFIT_NOT_FOUND_CODE, { status: 200 });',
  '            }',
  '            throw new LlmError2(`codearts: ${message2}`, "INVALID_REQUEST", { status: 200 });',
].join('\n');

const A_CATCH =
  '          } else if (error instanceof LlmError2 && error.code === BENEFIT_NOT_FOUND_CODE && isBenefitModel && !benefitHeaderDropped) {';

const A_HTTP = [
  '        const errorText = await response.text().catch(() => "");',
  '        if (isAuthError(response.status, errorText) && !authRefreshed) {',
].join('\n');

function fail(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function countOf(src, needle) {
  return src.split(needle).length - 1;
}

function main() {
  if (!fs.existsSync(PACK)) fail(`找不到 pack.js：${PACK}`);

  let src = fs.readFileSync(PACK, 'utf8');
  const original = src;
  const changes = [];

  if (src.includes(MARK)) {
    for (const fragment of ['var BENEFIT_HEADER_REJECTED_CODE =', 'data.error_code.includes("APIG.0101")', 'error.code === BENEFIT_HEADER_REJECTED_CODE', 'response.status === 404 || errorText.includes("APIG.0101")']) {
      if (!src.includes(fragment)) fail('补丁不完整：' + fragment);
    }
    console.log('· 四处有限回退补丁均已在位');
    if (CHECK_ONLY) {
      console.log('\n✓ CodeArts benefit 回退补丁已就位');
      process.exit(0);
    }
    return;
  }
  if (CHECK_ONLY) {
    console.log('✗ 未打补丁（缺 ' + MARK + '）');
    process.exit(1);
  }

  // ---- 0. 锚点校验：每处必须恰好出现一次，否则说明版本结构变了 ----
  for (const [name, needle] of [
    ['常量行', A_CONST],
    ['SSE 错误分支', A_SSE],
    ['调用侧 catch', A_CATCH],
    ['HTTP 非 2xx 分支', A_HTTP],
  ]) {
    const n = countOf(src, needle);
    if (n !== 1) fail(`锚点「${name}」命中 ${n} 次（预期 1 次），版本结构已变化，需要人工确认。`);
  }

  // ---- 1. 新增标记码 ----
  src = src.replace(
    A_CONST,
    A_CONST + '\n' +
    '// ' + MARK + ' benefit 通道被拒（APIG.0101 / 404）≠ 凭据或模型无效：\n' +
    '// 同凭据对照实测，去掉 maas_type: benefit 头即恢复 200。单独一个错误码，\n' +
    '// 供调用侧只对该情形做一次有限回退（不重复循环）。\n' +
    'var BENEFIT_HEADER_REJECTED_CODE = "BENEFIT_HEADER_REJECTED";'
  );
  changes.push('新增 BENEFIT_HEADER_REJECTED_CODE');

  // ---- 2. SSE error frame：APIG.0101（网关也会用 200 + error frame 上报） ----
  src = src.replace(
    A_SSE,
    [
      '            if (data.error_code === CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE) {',
      '              throw new LlmError2(`codearts: ${message2}`, BENEFIT_NOT_FOUND_CODE, { status: 200 });',
      '            }',
      '            // ' + MARK + ' 同样的问题也可能以 200 + SSE error frame 出现，',
      '            // 且插件的报错只带 error_msg，丢了 error_code（本机 10:06 即此路径）。',
      '            if (data.error_code.includes("APIG.0101") || message2.includes("APIG.0101")) {',
      '              throw new LlmError2(`codearts: ${data.error_code} ${message2}`, BENEFIT_HEADER_REJECTED_CODE, { status: 200 });',
      '            }',
      '            throw new LlmError2(`codearts: ${message2}`, "INVALID_REQUEST", { status: 200 });',
    ].join('\n')
  );
  changes.push('SSE APIG.0101 → BENEFIT_HEADER_REJECTED_CODE');

  // ---- 3. 调用侧：两种 benefit 拒绝都走同一条“去掉头重试一次” ----
  src = src.replace(
    A_CATCH,
    '          } else if (error instanceof LlmError2 && (error.code === BENEFIT_NOT_FOUND_CODE || error.code === BENEFIT_HEADER_REJECTED_CODE) && isBenefitModel && !benefitHeaderDropped) {\n'
    + '            // ' + MARK + ' One header-free retry, shared with the existing benefit fallback.'
  );
  changes.push('catch 接受 BENEFIT_HEADER_REJECTED_CODE');

  // ---- 4. HTTP 404 / APIG.0101：去掉 benefit 头后重签重试一次 ----
  src = src.replace(
    A_HTTP,
    [
      '        const errorText = await response.text().catch(() => "");',
      '        // ' + MARK + ' benefit 通道被拒：404 或 APIG.0101 —— 去掉 maas_type 重签重试一次；',
      '        // benefitHeaderDropped 置位后不会再走这里，失败即按普通错误抛出，不会循环。',
      '        if (isBenefitModel && !benefitHeaderDropped && (response.status === 404 || errorText.includes("APIG.0101"))) {',
      '          benefitHeaderDropped = true;',
      '          continue;',
      '        }',
      '        if (isAuthError(response.status, errorText) && !authRefreshed) {',
    ].join('\n')
  );
  changes.push('HTTP 404/APIG.0101 去 benefit 头重试一次');

  if (src === original) fail('没有产生任何改动，但也没找到补丁标记，需人工检查。');

  // ---- 写回前备份 + 语法校验 ----
  const backupDir = path.join(os.tmpdir(), 'heybash-codearts-benefit-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `pack-${process.pid}-${new Date().toISOString().replace(/[:.]/g, '-')}.js`);
  fs.writeFileSync(backup, original);
  console.log(`已备份: ${backup}`);

  const tmp = path.join(backupDir, `pack-check-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    fs.unlinkSync(tmp);
    fail(`补丁后语法校验失败，已放弃写入（原文件未改动）：\n${e.stderr?.toString() || e.message}`);
  }
  fs.unlinkSync(tmp);

  fs.writeFileSync(PACK, src);
  console.log(`\n✓ 补丁已写入（${changes.length} 处）：${changes.join('、')}`);

  try {
    execFileSync(process.execPath, ['--check', PACK], { stdio: 'pipe' });
    console.log('✓ 落盘语法校验通过');
  } catch (e) {
    fs.writeFileSync(PACK, original);
    fail(`落盘后语法校验失败，已回滚：\n${e.stderr?.toString() || e.message}`);
  }

  console.log('\n⚠ 必须完全退出 DSH Desktop 再重新打开，pack.js 只在 profile 启动时 import 一次。');
}

try {
  main();
} catch (e) {
  fail(`运行异常：${e && e.stack ? e.stack : e}`, 2);
}
