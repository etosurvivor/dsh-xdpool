/** Hide only model IDs also offered by the corresponding WorkBuddy pool.
 * The channel adapter itself stays registered so previously saved routes work.
 * If the pool is unavailable, keep the original channel catalog intact.
 */
export async function withoutPoolDuplicates(rows, provider, listModels) {
  const poolProvider = provider === 'buddy' ? 'xdpool'
    : provider === 'workbuddy' ? 'xdpool-global' : undefined
  if (poolProvider === undefined) return rows
  try {
    const poolRows = await listModels(poolProvider)
    const ids = new Set(poolRows.map(row => row.id))
    return rows.filter(row => !ids.has(row.id))
  } catch {
    return rows
  }
}
