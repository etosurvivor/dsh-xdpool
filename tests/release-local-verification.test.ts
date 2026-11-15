import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../.github/workflows/auto-merge.yml', import.meta.url), 'utf8')
const block = workflow.match(/      - name: Decide whether to auto-merge[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/u)?.[1]
if (block === undefined) throw new Error('auto-merge decision script missing')
const script = block.split('\n').map(line => line.replace(/^ {10}/u, '')).join('\n')
function decision(branch: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'xdpool-release-test-'))
  const output = join(dir, 'output')
  try {
    const run = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PR_HEAD_REF: branch, HAS_LABEL: label, IS_DEP: 'false', UPDATE_TYPE: '', GITHUB_OUTPUT: output } })
    expect(run.status, run.stderr).toBe(0)
    return readFileSync(output, 'utf8')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
describe('release automation waits for local desktop verification', () => {
  it('does not label release PRs for automatic merge', () => {
    const config = JSON.parse(readFileSync(new URL('../release-please-config.json', import.meta.url), 'utf8'))
    expect(config.packages['.'].labels ?? []).not.toContain('automerge')
  })
  it('blocks a release PR even with an automerge label and permits ordinary labelled PRs', () => {
    expect(decision('release-please--branches--main', 'true')).toContain('allow=false')
    expect(decision('release-please--branches--main', 'true')).toContain('reason=release-needs-local-verification')
    expect(decision('fix/ordinary', 'true')).toContain('allow=true')
    expect(decision('fix/ordinary', 'false')).toContain('allow=false')
  })
})
