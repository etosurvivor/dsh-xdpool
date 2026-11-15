/** A login channel member has a colon before any slash in its model id. */
export function channelMemberOf(id: string): { channel: string; model: string } | undefined {
  const colon = id.indexOf(':')
  if (colon <= 0) return undefined
  const channel = id.slice(0, colon)
  const model = id.slice(colon + 1)
  if (!/^[A-Za-z0-9_-]+$/u.test(channel) || model === '' || model.startsWith('//')) return undefined
  return { channel, model: id }
}

/** Remove repeated legacy slash prefixes while preserving canonical colon IDs. */
export function memberForOwner(owner: string, model: string): string {
  if (owner === 'workbuddy') return model
  while (model.startsWith(`${owner}/`)) model = model.slice(owner.length + 1)
  while (model.startsWith(`${owner}:${owner}:`)) model = model.slice(owner.length + 1)
  return model
}

/** Flatten one editor member; canonical channel IDs are already complete. */
export function flattenMember(owner: string, model: string): string {
  const value = memberForOwner(owner, model)
  if (owner === 'workbuddy' || channelMemberOf(value)?.channel === owner) return value
  return `${owner}/${value}`
}
