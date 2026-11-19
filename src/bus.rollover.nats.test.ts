import { connect } from '@nats-io/transport-node'
import { encode } from '@quadrantcapital/wire'
import { afterAll, describe, expect, it } from 'vitest'
import { openBus } from './bus.js'
import { startNats } from './nats-harness.js'

const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
const server = await startNats(
  `authorization {
  users = [
    { user: gateway, password: gw }
    { user: runner, password: rp, permissions: { publish: { allow: ["x.>"] }, subscribe: { allow: ["x.>", "_INBOX_runner.>"] }, allow_responses: true } }
  ]
}`,
  { user: 'gateway', pass: 'gw' },
)
const d = server ? describe : describe.skip

d('rollover under load', () => {
  afterAll(() => {
    server?.cleanup()
  })

  it('loses no request while the login is rolled over', async () => {
    const bus = await openBus({ url: server!.url, user: 'runner', pass: 'rp', inboxPrefix: '_INBOX_runner', log })
    bus.subscribe('x.echo', async () => {
      await new Promise((r) => setTimeout(r, 1))
      return { type: 'RunnerHelloResponse', payload: { runnerId: '', scope: 'platform', runner: 'runner', name: 'runner', egress: [], minVersion: '1.0.0', sessionTtlSec: 0 } as never }
    })
    const nc = await connect({ servers: server!.url, user: 'gateway', pass: 'gw' })
    let stop = false
    let sent = 0
    let lost = 0
    const frame = encode('RunnerHelloRequest', { version: '1', lanes: [], instanceId: 'i' } as never)
    const sender = async () => {
      while (!stop) {
        sent += 1
        try {
          await nc.request('x.echo', frame, { timeout: 1500 })
        } catch {
          lost += 1
        }
        await new Promise((r) => setTimeout(r, Math.random() * 3))
      }
    }
    const senders = Array.from({ length: 8 }, () => sender())
    for (let i = 0; i < 150; i += 1) {
      await bus.rollover(2000)
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20))
    }
    stop = true
    await Promise.all(senders)
    console.log(`ROLLOVER sent=${sent} lost=${lost}`)
    await nc.close()
    await bus.close(1000)
    expect(lost).toBe(0)
  }, 120_000)
})
