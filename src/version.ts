/** Version embedded in the browser bundle at build time from the package manifest. */
import manifest from '../package.json'

export const POOL_VERSION = manifest.version
