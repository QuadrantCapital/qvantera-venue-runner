import { describe, expect, it } from 'vitest'
import { applySelection, isGlobalAddress, laneAddresses, resolveLanes } from './lanes.js'

const iface = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4') => ({
  address,
  family,
  internal: address.startsWith('127.') || address === '::1',
  netmask: '',
  mac: '',
  cidr: null,
  ...(family === 'IPv6' ? { scopeid: 0 } : {}),
})

// A host like the pilot's: two public addresses, loopback, the Docker bridge, a link-local IPv6.
const host = {
  lo: [iface('127.0.0.1'), iface('::1', 'IPv6')],
  eth0: [iface('15.235.228.57'), iface('51.79.202.101'), iface('fe80::1%eth0', 'IPv6'), iface('2001:41d0::1', 'IPv6')],
  docker0: [iface('172.17.0.1')],
} as never

describe('egress lanes (M-367)', () => {
  it('takes every global address with auto, and nothing private, local or link-local', () => {
    expect(laneAddresses('auto', host)).toEqual(['15.235.228.57', '51.79.202.101', '2001:41d0::1'])
  })

  it('falls back to the default route when the host has no global address', () => {
    expect(laneAddresses('auto', { eth0: [iface('192.168.1.20')], lo: [iface('127.0.0.1')] } as never)).toEqual([''])
  })

  it('takes a chosen subset, private addresses included, and refuses an address the host does not have', () => {
    expect(laneAddresses(['51.79.202.101'], host)).toEqual(['51.79.202.101'])
    expect(laneAddresses(['172.17.0.1', '51.79.202.101', '172.17.0.1'], host)).toEqual(['172.17.0.1', '51.79.202.101'])
    expect(() => laneAddresses(['51.79.202.102'], host)).toThrow(/not an address of this host/)
    expect(() => laneAddresses(['not-an-ip'], host)).toThrow(/not an IP address/)
    expect(() => laneAddresses([], host)).toThrow(/lists no address/)
  })

  it('tells global from everything else', () => {
    for (const a of ['15.235.228.57', '8.8.8.8', '2001:41d0::1']) expect(isGlobalAddress(a)).toBe(true)
    for (const a of ['10.0.0.1', '172.20.0.1', '192.168.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '203.0.113.7', 'fe80::1', 'fd00::1', '::1', '2001:db8::1']) {
      expect(isGlobalAddress(a)).toBe(false)
    }
  })

  it('resolves each lane through its own lookup, marks a duplicate public address and a failed lookup', async () => {
    const answers: Record<string, string | null> = { '10.0.0.5': '198.51.1.10', '10.0.0.6': '198.51.1.10', '10.0.0.7': null, '10.0.0.8': '198.51.1.11' }
    const lanes = await resolveLanes(Object.keys(answers), async (local) => answers[local] ?? null, null)
    expect(lanes).toEqual([
      { localAddress: '10.0.0.5', publicAddress: '198.51.1.10', state: 'active' },
      { localAddress: '10.0.0.6', publicAddress: '198.51.1.10', state: 'duplicate' },
      { localAddress: '10.0.0.7', publicAddress: 'unknown', state: 'unresolved' },
      { localAddress: '10.0.0.8', publicAddress: '198.51.1.11', state: 'active' },
    ])
  })

  it('without a lookup, a global address is its own public address', async () => {
    expect(await resolveLanes(['51.79.202.101', ''], null, null)).toEqual([
      { localAddress: '51.79.202.101', publicAddress: '51.79.202.101', state: 'active' },
      { localAddress: '', publicAddress: 'unknown', state: 'active' },
    ])
  })

  it("applies the platform's selection without a restart, and never revives a duplicate", async () => {
    const lanes = await resolveLanes(['15.235.228.57', '51.79.202.101'], null, null)
    const narrowed = applySelection(lanes, ['51.79.202.101'])
    expect(narrowed.map((l) => l.state)).toEqual(['disabled', 'active'])
    expect(applySelection(narrowed, null).map((l) => l.state)).toEqual(['active', 'active'])
    const dup = [{ localAddress: 'a', publicAddress: 'x', state: 'duplicate' as const }]
    expect(applySelection(dup, null)).toEqual(dup)
  })
})
