import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect, type NatsConnection } from '@nats-io/transport-node'
import { subjects } from '@quadrantcapital/proto'
import { decode, encode, type MessageTypeName, type WireMessageByType, type WirePayloadByType } from '@quadrantcapital/wire'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { openBus, type RunnerBus } from './bus.js'
import { createVenueHttpClient } from './http-relay.js'
import { startNats, type NatsServer } from './nats-harness.js'
import { lookupEgressIp, startRunner } from './runner.js'

const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
const enc = new TextEncoder()

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** spot-gateway's and Control's side, over plain NATS: frames in and out. */
function peer(nc: NatsConnection) {
  return {
    async request<T extends MessageTypeName, R>(subject: string, type: T, payload: WirePayloadByType[T], timeout = 5_000): Promise<R> {
      const res = await nc.request(subject, encode(type, payload), { timeout })
      return decode(res.data).payload as R
    },
    publish<T extends MessageTypeName>(subject: string, type: T, payload: WirePayloadByType[T]): void {
      nc.publish(subject, encode(type, payload))
    },
    on(subject: string, fn: (payload: unknown, subject: string, reply?: (type: MessageTypeName, payload: unknown) => void) => void): void {
      nc.subscribe(subject, {
        callback: (err, msg) => {
          if (err) return
          fn(decode(msg.data).payload, msg.subject, (type, payload) => msg.respond(encode(type, payload as never)))
        },
      })
    },
  }
}

const request = (url: string, lane = '', timeoutMs = 2_000) => ({ method: 'GET', url, headers: [], body: new Uint8Array(), timeoutMs, lane })

/**
 * The runner over a real nats-server as the platform's hosted runner logs in (M-366): a static
 * user, `platform` scope. What spot-gateway sends on the runner's subjects comes back as the venue's
 * answer from the lane it named; the in-flight cap answers `busy` instead of queueing; the heartbeat
 * carries the lanes; the platform's hello reply selects them without a restart.
 */
const name = `venue-runner-${Math.random().toString(36).slice(2, 8)}`
const server: NatsServer | null = await startNats(
  `authorization {
  users = [
    { user: gateway, password: gw }
    { user: ${name}, password: rp, permissions: {
        publish: { allow: ["qvantera.v1.runner.platform.${name}.>", "qvantera.v1.runner.hello.${name}"] }
        subscribe: { allow: ["qvantera.v1.runner.platform.${name}.>", "_INBOX_${name}.>"] }
        allow_responses: true } }
  ]
}`,
  { user: 'gateway', pass: 'gw' },
)
const describeNats = server ? describe : describe.skip

describeNats('venue runner over NATS (M-366, M-367)', () => {
  let gatewayNc: NatsConnection
  let gw: ReturnType<typeof peer>
  let bus: RunnerBus
  let venue: http.Server
  let base = ''
  let ws: WebSocketServer
  let wsUrl = ''
  const release: Array<() => void> = []
  const venueSaw: string[] = []
  let runner: Awaited<ReturnType<typeof startRunner>>
  const heartbeats: Array<WireMessageByType['RunnerHeartbeatEvent']> = []
  let egress: string[] = []

  beforeAll(async () => {
    venue = http.createServer((req, res) => {
      venueSaw.push(req.socket.remoteAddress ?? '')
      if (req.url === '/whoami') return res.end('198.51.100.7\n')
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
    ws.on('connection', (p) => p.on('message', (data) => p.send(`echo:${data.toString()}`)))
    await new Promise<void>((r) => ws.once('listening', () => r()))
    wsUrl = `ws://127.0.0.1:${(ws.address() as AddressInfo).port}`

    gatewayNc = await connect({ servers: server!.url, user: 'gateway', pass: 'gw' })
    gw = peer(gatewayNc)
    gw.on(subjects.runnerHeartbeat('platform', name), (p) => heartbeats.push(p as WireMessageByType['RunnerHeartbeatEvent']))
    // Control's side of the hello: who the runner is, and the lanes it selected.
    gw.on(subjects.runnerHello(name), (_p, _s, reply) =>
      reply!('RunnerHelloResponse', {
        runnerId: '00000000-0000-4000-8000-000000000001',
        scope: 'platform',
        runner: name,
        name,
        egress,
        minVersion: '1.0.0',
        sessionTtlSec: 0,
      }),
    )
    await gatewayNc.flush()

    bus = await openBus({ url: server!.url, user: name, pass: 'rp', inboxPrefix: `_INBOX_${name}`, log })
    // Two lanes on loopback: one host, two source addresses, as a host with two public addresses.
    const clients = new Map([
      ['127.0.0.1', createVenueHttpClient('127.0.0.1')],
      ['127.0.0.2', createVenueHttpClient('127.0.0.2')],
    ])
    const lanes = process.platform === 'linux' ? ['127.0.0.1', '127.0.0.2'] : ['127.0.0.1']
    runner = await startRunner({
      bus,
      user: name,
      mode: 'static',
      addresses: lanes,
      clients,
      lookup: (local) => lookupEgressIp(clients.get(local)!, `${base}/whoami`),
      maxInflight: 2,
      version: '1.0.0',
      closeDeadlineMs: 5_000,
      log,
      onRevoked: () => undefined,
    })
  }, 60_000)

  afterAll(async () => {
    runner?.stop('shutdown')
    await bus?.close(1_000)
    await gatewayNc?.close()
    venue?.closeAllConnections()
    await new Promise((r) => venue?.close(r))
    await new Promise((r) => ws?.close(r))
    server?.cleanup()
  })

  it('heartbeats at once with its name, scope, version, cap and each lane as the venue sees it', async () => {
    await until(() => heartbeats.length > 0)
    expect(heartbeats[0]).toMatchObject({
      runner: name,
      scope: 'platform',
      instanceId: runner.instanceId,
      version: '1.0.0',
      egressIp: '198.51.100.7',
      maxInflight: 2,
      openSockets: 0,
    })
    // Both loopback lanes report one public address: the second is the same lane to the venue.
    expect(heartbeats[0]!.lanes[0]).toMatchObject({ localAddress: '127.0.0.1', publicAddress: '198.51.100.7', state: 'active' })
    if (process.platform === 'linux') expect(heartbeats[0]!.lanes[1]).toMatchObject({ localAddress: '127.0.0.2', state: 'duplicate' })
  })

  it("relays a request from the lane it names and answers with the venue's bytes", async () => {
    venueSaw.length = 0
    const res = await gw.request<'RunnerHttpRequest', WireMessageByType['RunnerHttpResponse']>(
      subjects.runnerHttp('platform', name),
      'RunnerHttpRequest',
      request(`${base}/api/v3/order`, '127.0.0.1'),
    )
    expect(res.status).toBe(200)
    expect(Buffer.from(res.body).toString()).toBe('{"ok":true}')
    expect(venueSaw.at(-1)).toMatch(/127\.0\.0\.1$/)
  })

  it('refuses a lane it does not have active, unsent — never moves the request to another lane', async () => {
    venueSaw.length = 0
    for (const lane of ['10.9.8.7', ...(process.platform === 'linux' ? ['127.0.0.2'] : [])]) {
      const res = await gw.request<'RunnerHttpRequest', WireMessageByType['RunnerHttpResponse']>(
        subjects.runnerHttp('platform', name),
        'RunnerHttpRequest',
        request(`${base}/api/v3/order`, lane),
      )
      expect(res.error).toBe('lane_unavailable')
    }
    expect(venueSaw).toEqual([])
  })

  it('answers busy above its cap at once, sending nothing, rather than queueing the request', async () => {
    const held = [0, 1].map(() =>
      gw.request<'RunnerHttpRequest', WireMessageByType['RunnerHttpResponse']>(
        subjects.runnerHttp('platform', name),
        'RunnerHttpRequest',
        request(`${base}/hold`, '127.0.0.1', 5_000),
        8_000,
      ),
    )
    await until(() => release.length === 2)
    const started = Date.now()
    const third = await gw.request<'RunnerHttpRequest', WireMessageByType['RunnerHttpResponse']>(
      subjects.runnerHttp('platform', name),
      'RunnerHttpRequest',
      request(`${base}/hold`, '127.0.0.1', 5_000),
      8_000,
    )
    expect(third.error).toBe('busy')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(release).toHaveLength(2)
    for (const r of release.splice(0)) r()
    expect((await Promise.all(held)).map((h) => h.status)).toEqual([200, 200])
  })

  it("applies the platform's lane selection on the next heartbeat round, without a restart", async () => {
    egress = ['10.9.8.7']
    await until(() => heartbeats.at(-1)?.lanes[0]?.state === 'disabled', 25_000)
    const refused = await gw.request<'RunnerHttpRequest', WireMessageByType['RunnerHttpResponse']>(
      subjects.runnerHttp('platform', name),
      'RunnerHttpRequest',
      request(`${base}/api/v3/order`, '127.0.0.1'),
    )
    expect(refused.error).toBe('lane_unavailable')
    egress = []
    await until(() => heartbeats.at(-1)?.lanes[0]?.state === 'active', 25_000)
  }, 60_000)

  it('holds a venue socket from its lane: open, frames both ways, and closed when the runner shuts it down', async () => {
    const frames: string[] = []
    const closed: Array<WireMessageByType['RunnerWsClosedEvent']> = []
    gw.on(subjects.runnerWsFrame('platform', name, 'sock-1'), (p) =>
      frames.push(Buffer.from((p as WireMessageByType['RunnerWsFrameEvent']).data).toString()),
    )
    gw.on(subjects.runnerWsClosed('platform', name, 'sock-1'), (p) => closed.push(p as WireMessageByType['RunnerWsClosedEvent']))
    await gatewayNc.flush()
    const opened = await gw.request<'RunnerWsOpenRequest', WireMessageByType['RunnerWsOpenResponse']>(
      subjects.runnerWsOpen('platform', name),
      'RunnerWsOpenRequest',
      { socketId: 'sock-1', url: wsUrl, lane: '127.0.0.1' },
    )
    expect(opened).toEqual({ instanceId: runner.instanceId, error: '' })
    gw.publish(subjects.runnerWsSend('platform', name, 'sock-1'), 'RunnerWsSendEvent', { data: enc.encode('ping'), binary: false })
    await until(() => frames.length === 1)
    expect(frames).toEqual(['echo:ping'])
    await until(() => heartbeats.some((h) => h.socketIds.includes('sock-1')), 15_000)

    runner.stop('shutdown')
    await until(() => closed.length === 1)
    expect(closed[0]).toMatchObject({ code: 1001, reason: 'shutdown' })
  }, 30_000)
})
