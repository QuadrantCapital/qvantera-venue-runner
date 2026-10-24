import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { statusServer } from './status.js'

/** The bus at its boundary: what a live, lost or silent NATS connection answers. */
type Link = 'up' | 'down' | 'silent'
const busOn = (link: () => Link) => ({
  connected: () => link() === 'up',
  ping: () =>
    link() === 'up'
      ? Promise.resolve(1)
      : link() === 'down'
        ? Promise.reject(new Error('connection disconnected'))
        : new Promise<number>(() => undefined),
})

const runner = {
  identity: { scope: 'platform', runner: 'venue-runner', runnerId: 'r-1', name: 'venue-runner' },
  instanceId: '00000000-0000-4000-8000-000000000001' as const,
  outdated: () => false,
  draining: () => false,
  egressIp: () => '203.0.113.7',
  lanes: () => [],
  openSockets: () => 0,
  inflight: () => 0,
}

describe('the runner status routes (M-805a)', () => {
  let server: Server | undefined
  let link: Link = 'up'
  let shuttingDown = false
  const warned: unknown[] = []

  const start = async () => {
    server = statusServer({
      bus: busOn(() => link),
      runner,
      build: { sha: 'unknown', tree: 'unknown', time: 'unknown' },
      version: '1.0.0',
      shuttingDown: () => shuttingDown,
      log: { warn: (obj) => void warned.push(obj) },
      readyTimeoutMs: 100,
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return async (path: string) => {
      const res = await fetch(`${base}${path}`)
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
  }

  afterEach(async () => {
    link = 'up'
    shuttingDown = false
    warned.length = 0
    await new Promise((resolve) => server?.close(resolve))
  })

  it('connected: /ready 200 with nats ok, /health 200 and connected', async () => {
    const get = await start()
    expect(await get('/ready')).toEqual({ status: 200, body: { ready: true, checks: { nats: 'ok' } } })
    const health = await get('/health')
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({ ok: true, connected: true, runner: 'venue-runner', draining: false })
  })

  it('disconnected: /ready 503 naming nats, /health still 200 — liveness never looks at NATS', async () => {
    const get = await start()
    link = 'down'
    expect(await get('/ready')).toEqual({ status: 503, body: { ready: false, checks: { nats: 'failed' } } })
    // The reason is logged, never served: the route is unauthenticated.
    expect(warned).toEqual([{ failing: { nats: 'connection disconnected' } }])
    const health = await get('/health')
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({ ok: true, connected: false })
  })

  it('a PING with no answer: /ready 503 with nats timeout, inside its deadline', async () => {
    const get = await start()
    link = 'silent'
    expect(await get('/ready')).toEqual({ status: 503, body: { ready: false, checks: { nats: 'timeout' } } })
  })

  it('shutting down or revoked: /ready 503 with draining alone, whatever NATS says; /health 200', async () => {
    const get = await start()
    shuttingDown = true
    expect(await get('/ready')).toEqual({ status: 503, body: { ready: false, checks: { draining: 'failed' } } })
    link = 'down'
    expect(await get('/ready')).toEqual({ status: 503, body: { ready: false, checks: { draining: 'failed' } } })
    expect((await get('/health')).status).toBe(200)
  })

  it('anything else is 404', async () => {
    await start()
    const res = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/readyz`)
    expect(res.status).toBe(404)
  })
})
