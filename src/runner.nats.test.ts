import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { NatsBus, connectWithRetry, subjects } from '@quadrantcapital/messaging'
import { resolveNatsHarness, type NatsHarness } from '@quadrantcapital/messaging/testing'
import type { WireMessageByType } from '@quadrantcapital/wire'
import { createVenueHttpClient } from './http-relay.js'
import { startRunner } from './runner.js'

const harness: NatsHarness | null = await resolveNatsHarness()
const describeNats = harness ? describe : describe.skip

const log = { info: () => undefined, warn: () => undefined }
const enc = new TextEncoder()

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * The runner over a real nats-server (M-366): what spot-gateway sends on the runner's subjects
 * comes back as the venue's answer, the in-flight cap answers `busy` instead of queueing, and the
 * heartbeat says where the venue sees the runner from.
 */
describeNats('venue runner over NATS (M-366)', () => {
  const name = `venue-runner-${Math.random().toString(36).slice(2, 8)}`
  const runnerBus = new NatsBus()
  const gateway = new NatsBus()
  let venue: http.Server
  let base = ''
  let ws: WebSocketServer
  let wsUrl = ''
  const release: Array<() => void> = []
  let runner: Awaited<ReturnType<typeof startRunner>>
  const heartbeats: Array<WireMessageByType['RunnerHeartbeatEvent']> = []

  beforeAll(async () => {
    venue = http.createServer((req, res) => {
      if (req.url === '/whoami') return res.end('203.0.113.7\n')
      if (req.url === '/hold') {
        release.push(() => res.end('{}'))
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    await new Promise<void>((r) => venue.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(venue.address() as AddressInfo).port}`
    ws = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    ws.on('connection', (peer) => peer.on('message', (data) => peer.send(`echo:${data.toString()}`)))
    await new Promise<void>((r) => ws.once('listening', () => r()))
    wsUrl = `ws://127.0.0.1:${(ws.address() as AddressInfo).port}`

    await connectWithRetry(runnerBus, harness!.url)
    await connectWithRetry(gateway, harness!.url)
    await gateway.subscribe(subjects.runnerHeartbeat('platform', name), (msg) => {
      heartbeats.push(msg.payload as WireMessageByType['RunnerHeartbeatEvent'])
    })
    runner = await startRunner({
      bus: runnerBus,
      runner: name,
      http: createVenueHttpClient(),
      maxInflight: 2,
      version: 'sha-test',
      egressIpUrl: `${base}/whoami`,
      log,
    })
  }, 60_000)

  afterAll(async () => {
    runner?.stop('shutdown')
    await runnerBus.close()
    await gateway.close()
    venue?.closeAllConnections()
    await new Promise((r) => venue?.close(r))
    await new Promise((r) => ws?.close(r))
    harness?.cleanup?.()
  })

  it('heartbeats at once with its name, scope, version, cap and the egress address its lookup answered', async () => {
    await until(() => heartbeats.length > 0)
    expect(heartbeats[0]).toMatchObject({
      runner: name,
      scope: 'platform',
      instanceId: runner.instanceId,
      version: 'sha-test',
      egressIp: '203.0.113.7',
      maxInflight: 2,
      openSockets: 0,
    })
  })

  it("relays a request on the runner's own subject and answers with the venue's bytes", async () => {
    const res = await gateway.request<'RunnerHttpRequest', WireMessageByType['RunnerHttpResponse']>(
      subjects.runnerHttp('platform', name),
      'RunnerHttpRequest',
      { method: 'GET', url: `${base}/api/v3/order`, headers: [], body: new Uint8Array(), timeoutMs: 2_000 },
      5_000,
    )
    expect(res.payload.status).toBe(200)
    expect(Buffer.from(res.payload.body).toString()).toBe('{"ok":true}')
  })

  it('answers busy above its cap at once, sending nothing, rather than queueing the request', async () => {
    const held = [0, 1].map(() =>
      gateway.request<'RunnerHttpRequest', WireMessageByType['RunnerHttpResponse']>(
        subjects.runnerHttp('platform', name),
        'RunnerHttpRequest',
        { method: 'GET', url: `${base}/hold`, headers: [], body: new Uint8Array(), timeoutMs: 5_000 },
        8_000,
      ),
    )
    await until(() => release.length === 2)
    const started = Date.now()
    const third = await gateway.request<'RunnerHttpRequest', WireMessageByType['RunnerHttpResponse']>(
      subjects.runnerHttp('platform', name),
      'RunnerHttpRequest',
      { method: 'GET', url: `${base}/hold`, headers: [], body: new Uint8Array(), timeoutMs: 5_000 },
      8_000,
    )
    expect(third.payload.error).toBe('busy')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(release).toHaveLength(2)
    for (const r of release.splice(0)) r()
    expect((await Promise.all(held)).map((h) => h.payload.status)).toEqual([200, 200])
  })

  it('holds a venue socket: open, frames both ways, and closed when the runner shuts it down', async () => {
    const frames: string[] = []
    const closed: Array<WireMessageByType['RunnerWsClosedEvent']> = []
    await gateway.subscribe(subjects.runnerWsFrame('platform', name, 'sock-1'), (msg) => {
      frames.push(Buffer.from((msg.payload as WireMessageByType['RunnerWsFrameEvent']).data).toString())
    })
    await gateway.subscribe(subjects.runnerWsClosed('platform', name, 'sock-1'), (msg) => {
      closed.push(msg.payload as WireMessageByType['RunnerWsClosedEvent'])
    })
    const opened = await gateway.request<'RunnerWsOpenRequest', WireMessageByType['RunnerWsOpenResponse']>(
      subjects.runnerWsOpen('platform', name),
      'RunnerWsOpenRequest',
      { socketId: 'sock-1', url: wsUrl },
      5_000,
    )
    expect(opened.payload).toEqual({ instanceId: runner.instanceId, error: '' })
    await gateway.publish(subjects.runnerWsSend('platform', name, 'sock-1'), 'RunnerWsSendEvent', {
      data: enc.encode('ping'),
      binary: false,
    })
    await until(() => frames.length === 1)
    expect(frames).toEqual(['echo:ping'])
    await until(() => heartbeats.some((h) => h.socketIds.includes('sock-1')), 15_000)

    runner.stop('shutdown')
    await until(() => closed.length === 1)
    expect(closed[0]).toMatchObject({ code: 1001, reason: 'shutdown' })
  }, 30_000)
})
