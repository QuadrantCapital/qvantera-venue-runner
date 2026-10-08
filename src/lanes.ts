import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { isIP } from 'node:net'

/**
 * Egress lanes (M-367, owner 2026-10-08). A lane is one local address of the runner's host, bound
 * as the source of every venue connection sent on it; several addresses are several lanes, and a
 * venue's per-address limits count each one separately. spot-gateway chooses the lane of every
 * request and socket — this module only finds the addresses, says what the venue sees from each,
 * and which the platform has selected.
 *
 * `''` is the default lane: no address bound, the host's default route. A runner with no address
 * of its own to offer (`auto` on a host behind NAT) has exactly that one.
 */

export type LaneState = 'active' | 'disabled' | 'duplicate' | 'unresolved'

export type Lane = {
  localAddress: string
  publicAddress: string
  state: LaneState
}

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

/** Every address the host's interfaces carry, loopback and link-local included. */
export function hostAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
  const out: string[] = []
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) out.push(withoutZone(info.address))
  }
  return out
}

function withoutZone(address: string): string {
  const i = address.indexOf('%')
  return i < 0 ? address : address.slice(0, i)
}

function v4(address: string): number[] {
  return address.split('.').map(Number)
}

/**
 * A globally routable unicast address: not loopback, link-local, private (RFC 1918, IPv6 ULA),
 * shared (100.64/10), documentation or multicast. What `auto` takes — a private address leaves
 * through a NAT whose public address another lane may already be, and the venue would count both
 * as one.
 */
export function isGlobalAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = v4(address)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    if (a === 198 && b === 51 && c === 100) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return false
    if (/^fe[89ab]/.test(lower)) return false // link-local fe80::/10
    if (/^f[cd]/.test(lower)) return false // unique local fc00::/7
    if (lower.startsWith('ff')) return false // multicast
    if (lower.startsWith('2001:db8') || lower.startsWith('2001:0db8')) return false // documentation
    if (lower.startsWith('::ffff:')) return isGlobalAddress(lower.slice(7))
    return true
  }
  return false
}

/**
 * The addresses to bind, from `RUNNER_EGRESS_IPS`: `auto` takes every global address of the host,
 * or the default lane when there is none; a list names them, and each must be an address of this
 * host — a runner told to send from an address it does not have would fail every request on that
 * lane, so it refuses to start instead.
 */
export function laneAddresses(spec: 'auto' | string[], interfaces: Interfaces = networkInterfaces()): string[] {
  const local = hostAddresses(interfaces)
  if (spec === 'auto') {
    const global = [...new Set(local.filter(isGlobalAddress))]
    return global.length > 0 ? global : ['']
  }
  if (spec.length === 0) throw new Error('RUNNER_EGRESS_IPS lists no address; use auto or name one')
  const out: string[] = []
  for (const raw of spec) {
    const address = withoutZone(raw)
    if (isIP(address) === 0) throw new Error(`RUNNER_EGRESS_IPS: ${raw} is not an IP address`)
    if (!local.includes(address)) {
      throw new Error(`RUNNER_EGRESS_IPS: ${address} is not an address of this host (it has ${local.join(', ')})`)
    }
    if (!out.includes(address)) out.push(address)
  }
  return out
}

/**
 * Each lane as the venue sees it. `lookup` asks a plain-text "what is my address" service through
 * that lane; without one, a global address is its own public address and any other is `unknown`.
 * A failed lookup leaves the lane `unresolved` — not used until the next lookup finds it, because
 * the platform shows the address to whitelist, and a wrong one is worse than none. Two lanes that
 * leave from one public address are one to the venue: the second is `duplicate` and never used.
 * Then the platform's selection (`egress`, null for all) disables the rest.
 */
export async function resolveLanes(
  addresses: string[],
  lookup: ((localAddress: string) => Promise<string | null>) | null,
  egress: string[] | null,
): Promise<Lane[]> {
  const resolved = await Promise.all(
    addresses.map(async (localAddress) => {
      if (lookup) {
        const found = await lookup(localAddress)
        return { localAddress, publicAddress: found ?? 'unknown', ok: found !== null }
      }
      const known = localAddress !== '' && isGlobalAddress(localAddress)
      return { localAddress, publicAddress: known ? localAddress : 'unknown', ok: true }
    }),
  )
  const seen = new Set<string>()
  return resolved.map(({ localAddress, publicAddress, ok }): Lane => {
    if (!ok) return { localAddress, publicAddress, state: 'unresolved' }
    if (publicAddress !== 'unknown') {
      if (seen.has(publicAddress)) return { localAddress, publicAddress, state: 'duplicate' }
      seen.add(publicAddress)
    }
    return { localAddress, publicAddress, state: selected(localAddress, egress) ? 'active' : 'disabled' }
  })
}

/** Whether the platform's selection keeps a lane: everything when it selected nothing in particular. */
export function selected(localAddress: string, egress: string[] | null): boolean {
  return egress === null || egress.length === 0 || egress.includes(localAddress)
}

/** A selection change applied to lanes already resolved, on the next heartbeat round — no restart. */
export function applySelection(lanes: Lane[], egress: string[] | null): Lane[] {
  return lanes.map((lane) => {
    if (lane.state !== 'active' && lane.state !== 'disabled') return lane
    return { ...lane, state: selected(lane.localAddress, egress) ? 'active' : 'disabled' }
  })
}

/** Socket options that send from a lane: its address bound, and the address family to resolve in. */
export function laneSocketOptions(localAddress: string): { localAddress?: string; family?: 4 | 6 } {
  if (localAddress === '') return {}
  return { localAddress, family: isIP(localAddress) === 6 ? 6 : 4 }
}
