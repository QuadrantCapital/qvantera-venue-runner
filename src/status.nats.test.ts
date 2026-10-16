import { afterAll, describe, expect, it } from 'vitest'
import { openBus, type RunnerBus } from './bus.js'
import { startNats, type NatsServer } from './nats-harness.js'
import { readiness } from './status.js'

const log = { info: () => undefined, warn: () => undefined, error: () => undefined }

/**
 * `/ready`'s `nats` against a real server that goes away (M-805a): the PING fails, fast, while the
 * client is redialling — not after the readiness deadline as an unanswered one would.
 */
const server: NatsServer | null = await startNats('authorization { users = [ { user: rn, password: rp } ] }', { user: 'rn', pass: 'rp' })
const describeNats = server ? describe : describe.skip

describeNats('readiness over a real NATS connection (M-805a)', () => {
  let bus: RunnerBus

  afterAll(async () => {
    await bus?.close(0)
    server?.cleanup()
  })

  it('nats ok while the server answers, failed as soon as it is gone', async () => {
    bus = await openBus({ url: server!.url, user: 'rn', pass: 'rp', inboxPrefix: '_INBOX_rn', log })
    const ready = () => readiness({ ping: bus.ping, shuttingDown: () => false })
    expect((await ready()).checks).toEqual({ nats: 'ok' })

    server!.cleanup()
    const gone = Date.now()
    let checks = (await ready()).checks
    while (checks.nats === 'ok' && Date.now() - gone < 5_000) checks = (await ready()).checks
    expect(checks).toEqual({ nats: 'failed' })
    const t = Date.now()
    await ready()
    expect(Date.now() - t).toBeLessThan(500)
  })
})
