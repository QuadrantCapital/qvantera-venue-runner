import { describe, expect, it } from 'vitest'
import { natsUrlFor, parseConfig } from './config.js'

const TOKEN = `qv_rnr_0123456789ab_${'A'.repeat(43)}`

describe('runner configuration (M-367)', () => {
  it("logs a registered runner in over the platform's WebSocket, as its token's prefix", () => {
    const c = parseConfig({ QV_PLATFORM_URL: 'https://qvantera.example.com', QV_RUNNER_TOKEN: TOKEN })
    expect(c.natsUrl).toBe('wss://qvantera.example.com/nats')
    expect(c.auth).toEqual({ kind: 'token', user: '0123456789ab', pass: TOKEN })
    expect(c.egress).toBe('auto')
    expect(c.host).toBe('127.0.0.1')
  })

  it('takes a chosen set of egress addresses', () => {
    const c = parseConfig({ QV_PLATFORM_URL: 'https://p.example', QV_RUNNER_TOKEN: TOKEN, RUNNER_EGRESS_IPS: '51.79.202.101, 15.235.228.57' })
    expect(c.egress).toEqual(['51.79.202.101', '15.235.228.57'])
  })

  it('derives the WebSocket address under a path prefix', () => {
    expect(natsUrlFor('https://p.example/qv/')).toBe('wss://p.example/qv/nats')
    expect(natsUrlFor('http://localhost:8080')).toBe('ws://localhost:8080/nats')
  })

  it('refuses no login, two logins, half a static login and a malformed token', () => {
    expect(() => parseConfig({ QV_PLATFORM_URL: 'https://p.example' })).toThrow(/exactly one/)
    expect(() => parseConfig({ QV_PLATFORM_URL: 'https://p.example', QV_RUNNER_TOKEN: TOKEN, NATS_USER: 'u', NATS_PASS: 'p' })).toThrow(/exactly one/)
    expect(() => parseConfig({ NATS_URL: 'nats://nats:4222', NATS_USER: 'venue-runner' })).toThrow(/go together/)
    expect(() => parseConfig({ QV_PLATFORM_URL: 'https://p.example', QV_RUNNER_TOKEN: 'qv_pat_x' })).toThrow(/not a runner token/)
    expect(() => parseConfig({ QV_RUNNER_TOKEN: TOKEN })).toThrow(/QV_PLATFORM_URL/)
  })

  it("keeps the platform's hosted runner on its Compose network", () => {
    const c = parseConfig({ NATS_URL: 'nats://nats:4222', NATS_USER: 'venue-runner', NATS_PASS: 'secret' })
    expect(c.auth).toEqual({ kind: 'static', user: 'venue-runner', pass: 'secret' })
    expect(c.natsUrl).toBe('nats://nats:4222')
  })
})
