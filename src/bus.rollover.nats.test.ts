import { connect, errors, type NatsConnection } from '@nats-io/transport-node'
import { encode } from '@quadrantcapital/wire'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openBus } from './bus.js'
import { startNats } from './nats-harness.js'

const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
const server = await startNats(
  `authorization {
  users = [
    { user: gateway, password: gw }
    { user: runner, password: rp, permissions: { publish: { allow: ["x.>"] }, subscribe: { allow: ["x.>", "_INBOX_runner.>"], deny: ["x.denied"] }, allow_responses: true } }
  ]
}`,
  { user: 'gateway', pass: 'gw' },
)
const d = server ? describe : describe.skip

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const frame = encode('RunnerHelloRequest', { version: '1', lanes: [] })

async function echoBus() {
  const bus = await openBus({ url: server!.url, user: 'runner', pass: 'rp', inboxPrefix: '_INBOX_runner', log })
  bus.subscribe('x.echo', async () => {
    await sleep(1)
    return { type: 'RunnerHelloResponse', payload: { runnerId: '', scope: 'platform', runner: 'runner', name: 'runner', egress: [], minVersion: '1.0.0', sessionTtlSec: 0 } }
  })
  await bus.flush()
  return bus
}

const noResponders = (err: unknown) =>
  err instanceof errors.NoRespondersError || (err instanceof Error && err.cause instanceof errors.NoRespondersError)

/**
 * Eight requesters on `x.echo`. A request that gets no answer is lost, unless `shutdown` is set and the
 * answer is "nobody is subscribed": once the runner has left, that is the truth, not a loss.
 */
function load(nc: NatsConnection, shutdown: boolean) {
  let stop = false
  let sent = 0
  let lost = 0
  const requester = async () => {
    while (!stop) {
      sent += 1
      try {
        await nc.request('x.echo', frame, { timeout: 1500 })
      } catch (err) {
        if (!(shutdown && noResponders(err))) lost += 1
      }
      await sleep(Math.random() * 3)
    }
  }
  const requesters = Array.from({ length: 8 }, requester)
  return {
    lost: () => lost,
    sent: () => sent,
    end: async () => {
      stop = true
      await Promise.all(requesters)
    },
  }
}

d('a request in transit when the bus changes connection', () => {
  let nc: NatsConnection

  beforeAll(async () => {
    nc = await connect({ servers: server!.url, user: 'gateway', pass: 'gw' })
  })

  afterAll(async () => {
    await nc?.close()
    server?.cleanup()
  })

  it('is answered while the login is rolled over', async () => {
    const bus = await echoBus()
    const requests = load(nc, false)
    try {
      for (let i = 0; i < 150; i += 1) {
        await bus.rollover(2000)
        await sleep(10 + Math.random() * 20)
      }
    } finally {
      await requests.end()
      await bus.close(1000)
    }
    expect(requests.lost(), `${requests.lost()} of ${requests.sent()} requests lost`).toBe(0)
  }, 120_000)

  it('is answered while the runner shuts down', async () => {
    let sent = 0
    let lost = 0
    for (let i = 0; i < 60; i += 1) {
      const bus = await echoBus()
      const requests = load(nc, true)
      await sleep(15 + Math.random() * 25)
      try {
        await bus.close(2000)
      } finally {
        await requests.end()
      }
      sent += requests.sent()
      lost += requests.lost()
    }
    expect(lost, `${lost} of ${sent} requests lost`).toBe(0)
  }, 120_000)

  it('retires the connection even when the server refused one of its subscriptions', async () => {
    const bus = await echoBus()
    bus.subscribe('x.denied', async () => undefined)
    await bus.flush()
    await expect(bus.rollover(1000)).resolves.toBeUndefined()
    await expect(bus.close(1000)).resolves.toBeUndefined()
  }, 30_000)
})
