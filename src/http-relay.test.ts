import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVenueHttpClient, relayHttp } from './http-relay.js'

const enc = new TextEncoder()

describe('relayHttp (M-366)', () => {
  let server: http.Server
  let base: string
  let connections: number
  let received: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>

  beforeEach(async () => {
    connections = 0
    received = []
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        const url = new URL(req.url ?? '/', 'http://x')
        const status = Number(url.searchParams.get('status') ?? 200)
        const delay = Number(url.searchParams.get('delay') ?? 0)
        setTimeout(() => {
          res.setHeader('content-type', 'application/json')
          res.setHeader('x-mbx-used-weight', ['1', '2'])
          res.writeHead(status)
          res.end('{"orderId":"123456789012345678901"}')
        }, delay)
      })
    })
    server.on('connection', () => {
      connections += 1
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const request = (url: string, extra: Partial<Parameters<typeof relayHttp>[1]> = {}) => ({
    method: 'GET',
    url,
    headers: [],
    body: new Uint8Array(),
    timeoutMs: 2_000,
    lane: '',
    ...extra,
  })

  it('sends the signed body byte for byte and hands back the venue answer as bytes', async () => {
    // Gate signs a hash of the exact payload: a re-serialized body would be refused.
    const body = '{"text":"t-1","amount":"0.10000000","price":"1e-8"}'
    const res = await relayHttp(
      createVenueHttpClient(),
      request(`${base}/api/v4/spot/orders`, {
        method: 'POST',
        headers: [
          { name: 'KEY', value: 'api-key' },
          { name: 'SIGN', value: 'signature' },
          { name: 'Content-Type', value: 'application/json' },
        ],
        body: enc.encode(body),
      }),
    )
    expect(received[0]).toMatchObject({ method: 'POST', url: '/api/v4/spot/orders', body })
    expect(received[0]!.headers).toMatchObject({ key: 'api-key', sign: 'signature' })
    expect(res.status).toBe(200)
    expect(res.error ?? '').toBe('')
    // The order id stays the venue's text: no JSON parse here, so no 2^53 rounding either.
    expect(Buffer.from(res.body!).toString('utf8')).toBe('{"orderId":"123456789012345678901"}')
    expect(res.headers).toEqual(
      expect.arrayContaining([
        { name: 'content-type', value: 'application/json' },
        // Node joins a repeated header as the old client saw it.
        { name: 'x-mbx-used-weight', value: '1, 2' },
      ]),
    )
  })

  it("passes a venue's 5xx and 429 through as statuses: classifying them is spot-gateway's", async () => {
    const client = createVenueHttpClient()
    expect((await relayHttp(client, request(`${base}/?status=503`))).status).toBe(503)
    expect((await relayHttp(client, request(`${base}/?status=429`))).status).toBe(429)
  })

  it('answers timeout for a request sent and not answered in time, and lane_failed for one that never connected', async () => {
    const client = createVenueHttpClient()
    const slow = await relayHttp(client, request(`${base}/?delay=500`, { timeoutMs: 100 }))
    expect(slow).toMatchObject({ error: 'timeout' })
    expect(slow.status ?? 0).toBe(0)
    expect(received).toHaveLength(1)

    const closed = base
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    // Refused before a connection existed: nothing reached the venue (M-367), so spot-gateway may
    // call it unsent rather than ambiguous.
    expect(await relayHttp(client, request(`${closed}/`))).toMatchObject({ error: 'lane_failed' })
    server = http.createServer()
  })

  it("sends from the lane's address, and refuses a lane the host does not have before connecting", async () => {
    const seen: string[] = []
    server.on('connection', (socket) => seen.push(socket.remoteAddress ?? ''))
    const res = await relayHttp(createVenueHttpClient('127.0.0.1'), request(`${base}/`))
    expect(res.status).toBe(200)
    expect(seen.at(-1)).toMatch(/127\.0\.0\.1$/)
    // 192.0.2.1 is documentation space, never a local address: binding it fails before any connect.
    expect(await relayHttp(createVenueHttpClient('192.0.2.1'), request(`${base}/`))).toMatchObject({
      error: 'lane_failed',
    })
  })

  // M-320, moved with the client: the pilot's ~720 ms a request was a fresh TCP and TLS handshake
  // each time.
  it('reuses one connection for consecutive requests, and says so on each answer', async () => {
    const client = createVenueHttpClient()
    const reused: Array<boolean | undefined> = []
    for (let i = 0; i < 5; i++) {
      const res = await relayHttp(client, request(`${base}/api/v3/order`))
      expect(res.status).toBe(200)
      reused.push(res.reusedSocket)
    }
    expect(connections).toBe(1)
    expect(reused).toEqual([false, true, true, true, true])
  })
})
