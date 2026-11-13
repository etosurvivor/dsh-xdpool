#!/usr/bin/env node
/** Synchronize the public package after npm has made the requested version available. */
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const NAME = 'heybash-xdpool'
const NPM = `https://registry.npmjs.org/${NAME}`
const MIRROR = `https://registry.npmmirror.com/${NAME}`
const SYNC = `https://registry.npmmirror.com/-/package/${NAME}/syncs`
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const TASK_ID = /^[0-9A-Za-z_-]+$/u
const MAX_TARBALL_BYTES = 64 * 1024 * 1024
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function request(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${new URL(url).hostname}: HTTP ${response.status}`)
  return response
}

async function retry(label, action, { attempts, intervalMs, sleep, log }) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try { return await action() } catch (error) {
      lastError = error
      log(`${label} (${i + 1}/${attempts}): ${error instanceof Error ? error.message : String(error)}`)
      if (error?.terminal === true) throw error
      if (i + 1 < attempts) await sleep(intervalMs)
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * Poll the real public registry endpoints without credentials.  A matching
 * version, checksum, latest tag and reachable tarball are all required before
 * reporting success. `version` absent means the current official latest.
 */
export async function syncMirror({
  version, fetchImpl = fetch, sleep = delay, log = console.log,
  attempts = 24, officialAttempts = attempts * 2, intervalMs = 10_000, syncAttempts = 3,
} = {}) {
  if (version !== undefined && !VERSION.test(version)) throw new Error('Invalid target version')
  const options = { attempts, intervalMs, sleep, log }
  // Match npm/pnpm's metadata representation. The mirror can cache its
  // generic */* representation separately from the package-manager response.
  const read = async (url) => (await request(fetchImpl, url, {
    headers: { accept: 'application/json' },
  })).json()
  const official = await retry('Waiting for npm', async () => {
    const data = await read(NPM)
    const target = version ?? data['dist-tags']?.latest
    if (typeof target !== 'string' || !VERSION.test(target)) throw new Error('npm has no valid target version')
    const checksum = data.versions?.[target]?.dist?.shasum
    if (typeof checksum !== 'string' || !/^[a-f0-9]{40}$/u.test(checksum)) throw new Error(`npm ${target} is not yet available with a checksum`)
    return { target, checksum, latest: data['dist-tags']?.latest }
  }, { ...options, attempts: officialAttempts })
  log(`npm target ${official.target}; latest ${official.latest}`)

  const verify = async (download = false) => {
    const mirror = await read(MIRROR)
    if (mirror.versions?.[official.target]?.dist?.shasum !== official.checksum) throw new Error(`mirror ${official.target} is missing or has a different checksum`)
    if (official.latest === official.target && mirror['dist-tags']?.latest !== official.target) throw new Error(`mirror latest is not ${official.target}`)
    const tarball = mirror.versions[official.target].dist.tarball
    const expected = `https://registry.npmmirror.com/${NAME}/-/${NAME}-${official.target}.tgz`
    if (tarball !== expected) throw new Error('mirror returned an unexpected tarball URL')
    const artifact = await request(fetchImpl, tarball, { method: download ? 'GET' : 'HEAD' })
    if (download) {
      if (artifact.body === null) throw new Error('mirror tarball has no body')
      const digest = createHash('sha1')
      let bytes = 0
      for await (const chunk of artifact.body) {
        bytes += chunk.length
        if (bytes > MAX_TARBALL_BYTES) throw new Error('mirror tarball exceeds size limit')
        digest.update(chunk)
      }
      if (digest.digest('hex') !== official.checksum) throw new Error('mirror tarball checksum does not match npm')
    }
    return official.target
  }

  try {
    const target = await verify()
    log(`Mirror already serves ${target} with the correct checksum`)
    return { version: target, synced: false }
  } catch (error) {
    log(`Mirror needs synchronization: ${error instanceof Error ? error.message : String(error)}`)
  }

  let lastError
  for (let attempt = 0; attempt < syncAttempts; attempt++) {
    try {
      const task = await (await request(fetchImpl, SYNC, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skipDependencies: true }),
      })).json()
      if (task.ok !== true || typeof task.id !== 'string' || !TASK_ID.test(task.id)) throw new Error('mirror did not return a valid sync task')
      log(`Mirror synchronization task ${task.id}`)
      await retry('Waiting for mirror synchronization', async () => {
        const status = await read(`${SYNC}/${task.id}`)
        if (status.state === 'success') return
        if (status.state === 'failed' || status.state === 'fail') {
          throw Object.assign(new Error(`sync task ${status.state}`), { terminal: true })
        }
        throw new Error(`sync task ${String(status.state)}`)
      }, options)
      const target = await retry('Waiting for mirror availability', () => verify(true), options)
      log(`Mirror serves ${target} with the correct checksum`)
      return { version: target, synced: true }
    } catch (error) {
      lastError = error
      log(`Mirror synchronization attempt ${attempt + 1}/${syncAttempts} failed: ${error instanceof Error ? error.message : String(error)}`)
      // A sync task can fail or time out after another worker already updated
      // the mirror. Verify the artifact before submitting a redundant task.
      try {
        const target = await verify(true)
        log(`Mirror serves ${target} with the correct checksum`)
        return { version: target, synced: true }
      } catch {
        // Still unavailable: proceed with the bounded retry below.
      }
      if (attempt + 1 < syncAttempts) await sleep(intervalMs)
    }
  }
  throw new Error(`Mirror synchronization failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const published = args.length === 1 && args[0] === '--published'
  const publishedVersion = published ? process.env.npm_package_version : undefined
  if ((published && (publishedVersion === undefined || !VERSION.test(publishedVersion)))
    || (!published && args.length !== 0 && (args.length !== 2 || args[0] !== '--version'))) {
    console.error('Usage: node tools/sync-npmmirror.mjs [--version X.Y.Z | --published (npm lifecycle only)]')
    process.exitCode = 2
  } else {
    syncMirror(published ? { version: publishedVersion } : args.length === 2 ? { version: args[1] } : {}).catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
  }
}
