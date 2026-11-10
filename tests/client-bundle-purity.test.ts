import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('the browser bundle registers under its package name', () => {
  it('can be found by the host manifest after a package rename', () => {
    const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const registrations = new Map<string, unknown>()
    runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
      window: {
        __ModuleLoader__: {
          load({ id, factory }: { id: string; factory: unknown }) {
            if (registrations.has(id)) throw new Error(`duplicate factory: ${id}`)
            registrations.set(id, factory)
          },
        },
      },
    })
    expect([...registrations.keys()]).toEqual([name])
    expect(registrations.get(name)).toBeTypeOf('function')
  })
})

/**
 * The client bundle runs in a browser, where `process` does not exist.
 *
 * A bare `process.env.X` anywhere in it is a `ReferenceError` at module
 * evaluation time — not at call time — so the whole client half of the plugin
 * fails to import and the shell's boot audit reports the entry as
 * "import failed (see console for the import error)". That is exactly what
 * shipped once: a server-only `process.env.XDPOOL_FREE_BASE` survived into
 * `lib/client.js`, the browser threw on the first line of the factory, and the
 * app came up in recovery mode with no diagnostic that named the cause.
 *
 * The guard is cheap and the failure is total, so the rule is absolute: every
 * `process.<member>` read in the browser bundle has to sit on a line that also
 * tests `typeof process`. A comment mentioning "process." is fine — the match
 * requires an identifier after the dot.
 *
 * This reads the built artifact, not the source, because that is the thing that
 * actually ships: the source can be correct and the bundle still wrong when a
 * server-only module is pulled into the client graph.
 */
describe('the browser bundle never touches process unguarded', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  it('every process.<member> read is behind a typeof guard', () => {
    const offenders = bundle
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\bprocess\.[A-Za-z_$]/u.test(line))
      .filter(({ line }) => !/typeof\s+process/u.test(line))
      .map(({ line, number }) => `${number}: ${line.trim().slice(0, 160)}`)
    expect(offenders).toEqual([])
  })

  it('still finds the guarded reads, so the scan above cannot pass vacuously', () => {
    // A rename that dropped `process` from the bundle entirely would make the
    // first assertion true for the wrong reason. The env override is a real
    // feature, so its guarded read has to be present.
    expect(bundle).toMatch(/typeof\s+process[^\n]*process\.env/u)
  })
})
