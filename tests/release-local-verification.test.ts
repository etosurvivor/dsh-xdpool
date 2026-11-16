import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  it('does not run the retired Release Please workflow on pushes', () => {
    expect(existsSync(new URL('../.github/workflows/release-please.yml', import.meta.url))).toBe(false)
    const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
    expect(release).toMatch(/push:\s*\n\s*tags:/u)
    expect(release).toContain("- 'heybash-v*'")
  })
  it('blocks a release PR even with an automerge label and permits ordinary labelled PRs', () => {
    expect(decision('release-please--branches--main', 'true')).toContain('allow=false')
    expect(decision('release-please--branches--main', 'true')).toContain('reason=release-needs-local-verification')
    expect(decision('fix/ordinary', 'true')).toContain('allow=true')
    expect(decision('fix/ordinary', 'false')).toContain('allow=false')
  })
})

describe('release tags', () => {
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const tagBlock = release.match(/      - name: Verify the tag matches package\.json[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/u)?.[1]
  if (tagBlock === undefined) throw new Error('release tag verification script missing')
  const tagScript = tagBlock.split('\n').map(line => line.replace(/^ {10}/u, '')).join('\n')
  it('accepts the project tag and the legacy tag only when they match the package version', () => {
    expect(release).toContain("- 'heybash-v*'")
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
    const run = (ref: string) => spawnSync('bash', ['-c', tagScript], { encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: ref } }).status
    expect(run(`heybash-v${version}`)).toBe(0)
    expect(run(`v${version}`)).toBe(0)
    expect(run('heybash-v0.0.0')).not.toBe(0)
    expect(run(`heybash-vv${version}`)).not.toBe(0)
  })
})
