> 这份说明同时给人和 npm 的绑定页面看：npm 的 Trusted Publisher 表单要求填
> 「workflow filename」，必须与下方 `name` 所在文件的文件名完全一致 —— 也就是
> `release.yml`（只填文件名，不带路径，但要带 `.yml`）。
## 这个工作流做什么
打一个 `v*` 的 tag 并推送，GitHub 就会自动把当前版本发布到 npm。
**它不需要任何 npm token、也不需要 2FA 验证码。** npm 通过 OIDC 信任这个
workflow，等效于「本人亲自发布」，这正是它绕开两步验证的原因。
## 为什么用它（而不是 `npm publish --otp=`）
本机账号的 2FA 绑的是**安全密钥（passkey）**，而 npm 命令行的 `--otp`
只接受**认证器 6 位数字码**，两者不通用；npm 的暂存批准页面又没有网页入口。
Trusted Publishing 因此成为唯一无码可用的官方通道，也是 npm 自己推荐的替代方案。
## 首次启用要做的两件事
1. **npm 侧绑定**：npmjs.com → 该包 → Settings → **Trusted Publisher** →
   选 **GitHub Actions**，填：
   - Organization or user：`etosurvivor`
   - Repository：`dsh-xdpool`
   - Workflow filename：`release.yml`
   - Environment name：留空
   - Allowed actions：按需勾选（**至少保留 `npm stage publish`**；
     勾上 direct publish 才能一步到位发布）
2. **GitHub 侧**：确认仓库的 Actions 有写权限（默认有），然后推送一个 tag 即可。
## 发布一个新版本
```powershell
cd D:\DSH\dsh-xdpool
# 1. 改 package.json 的 version，并同步写 CHANGELOG
# 2. 提交
git add -A
git commit -m "release: x.y.z"
# 3. 打 tag 并推送 —— 这一步就会触发自动发布
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```
推送后到仓库的 **Actions** 页看进度，几十秒即可在 npm 上看到新版本。

正式版本在 npm 可用后，Release 工作流会等待并同步到国内镜像，检查版本、校验值和包下载地址。源码目录直接执行 `npm publish` 也会在发布后同步；如果同步报错，npm 版本可能已经发布，应先核对 npm 与 Actions 的 **Sync npm mirror** 工作流，避免重复发布。另有该工作流每 15 分钟检查官方 latest，用于补上安装包方式发布和同步失败；也可在 Actions 页面手动运行。定时任务受 GitHub 调度影响，不保证恰好 15 分钟执行；公开仓库连续 60 天无活动时 GitHub 可能自动停用定时任务。运行失败可在 Actions 日志查看。
> 注意：npm 的 staged publishing 策略下，若绑定页面只勾了 `npm stage publish`，
> 发布仍会停在暂存区等待批准 —— 那种情况下这条通道也帮不上忙，所以**建议把
> direct publish 一并勾上**，让 workflow 直接正式发布。
