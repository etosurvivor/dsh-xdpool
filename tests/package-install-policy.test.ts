import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('plugin installation policy', () => {
  it('does not require lifecycle-script approval while retaining the manual peer repair tool', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
      files: string[]
    }
    for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
      expect(pkg.scripts[lifecycle]).toBeUndefined()
    }
    expect(pkg.files).toContain('scripts')
    expect(pkg.files).toContain('tools/sync-npmmirror.mjs')
    expect(pkg.scripts.postpublish).toContain('sync-npmmirror.mjs --published')
    expect(readFileSync(new URL('../scripts/link-host-peers.mjs', import.meta.url), 'utf8')).toContain('peerDependencies')
  })
})
