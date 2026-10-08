import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { decode as decodeJwt, encodeAuthorizationResponse, encodeUser, type AuthorizationRequest } from '@nats-io/jwt'
import { createAccount, type KeyPair } from '@nats-io/nkeys'
import { connect, type NatsConnection } from '@nats-io/transport-node'
import { subjects } from '@quadrantcapital/proto'
import { decode, encode, type WireMessageByType } from '@quadrantcapital/wire'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openBus, type RunnerBus } from './bus.js'
import { parseConfig } from './config.js'
import { createVenueHttpClient } from './http-relay.js'
import { startNats, type NatsServer } from './nats-harness.js'
import { startRunner } from './runner.js'

/**
 * A registered runner's login (M-367) against a real nats-server with an auth callout. The callout
 * here stands in for Control's and does what it does: a token over the WebSocket listener gets a
 * user with that runner's subjects, its hello and its inbox, for a few seconds.
 *
 * What is proved is the runner's half: it logs in with its token as the NATS password over the
 * WebSocket, learns its organization's scope from the hello, and renews its login before the server
 * would end it — make before break — so a request in flight across the renewal is still answered,
 * and the runner keeps serving past several logins' expiry with no disconnect in between.
 * Control's half — which runner, which permissions, every refusal — is tested in qvantera-control.
 */
const ORG = '6f1c2c9e-8a52-4b7a-9d55-3a1b0c2d4e5f'
const PREFIX = 'abcdef012345'
const TOKEN = `qv_rnr_${PREFIX}_${'B'.repeat(43)}`
/** The login the callout issues lasts this long; the hello says so, and the runner renews at 70 %. */
const LOGIN_SEC = 3

const issuer: KeyPair = createAccount()
const server: NatsServer | null = await startNats(
  `authorization {
  auth_callout {
    issuer: ${issuer.getPublicKey()}
    auth_users: [ gateway, auth ]
  }
  users = [
    { user: gateway, password: gw }
    { user: auth, password: au, permissions: { publish: { allow: [] }, subscribe: { allow: ["$SYS.REQ.USER.AUTH"] }, allow_responses: true } }
  ]
}`,
  { user: 'gateway', pass: 'gw' },
)
const describeNats = server ? describe : describe.skip

describeNats('a registered runner logs in with its token (M-367)', () => {
  let auth: NatsConnection
  let gatewayNc: NatsConnection
  let bus: RunnerBus
  let venue: http.Server
  let base = ''
  const logins: Array<{ type?: string; user?: string }> = []
  const held: Array<() => void> = []
  const disconnects: string[] = []
  let runner: Awaited<ReturnType<typeof startRunner>>

  beforeAll(async () => {
    venue = http.createServer((req, res) => {
      if (req.url === '/hold') {
        held.push(() => res.end('{"held":true}'))
        return
      }
      res.end('{"ok":true}')
    })
    await new Promise<void>((r) => venue.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(venue.address() as AddressInfo).port}`

    auth = await connect({ servers: server!.url, user: 'auth', pass: 'au' })
    auth.subscribe('$SYS.REQ.USER.AUTH', {
      callback: (err, msg) => {
        if (err) return
        void (async () => {
          const req = decodeJwt<AuthorizationRequest>(new TextDecoder().decode(msg.data)).nats as AuthorizationRequest
          logins.push({ type: req.client_info.type, user: req.connect_opts.user })
          const own = `qvantera.v1.runner.${ORG}.${PREFIX}`
          const ok = req.connect_opts.pass === TOKEN && req.client_info.type === 'websocket'
          const jwt = ok
            ? await encodeUser(PREFIX, req.user_nkey, issuer, {
                pub: { allow: [`${own}.heartbeat`, `${own}.ws.*.frame`, `${own}.ws.*.closed`, `qvantera.v1.runner.hello.${PREFIX}`] },
                sub: { allow: [`${own}.http`, `${own}.ws.open`, `${own}.ws.*.send`, `${own}.ws.*.close`, `_INBOX_${PREFIX}.>`] },
                resp: { max: 1, ttl: 0 },
              }, { aud: '$G', exp: Math.ceil(Date.now() / 1000) + LOGIN_SEC + 1 })
            : undefined
          const res = await encodeAuthorizationResponse(req.user_nkey, req.server_id.id, issuer, jwt ? { jwt } : { error: 'refused' }, {})
          msg.respond(new TextEncoder().encode(res))
        })()
      },
    })
    await auth.flush()

    gatewayNc = await connect({ servers: server!.url, user: 'gateway', pass: 'gw' })
    gatewayNc.subscribe(subjects.runnerHello(PREFIX), {
      callback: (_err, msg) => {
        msg.respond(
          encode('RunnerHelloResponse', {
            runnerId: '00000000-0000-4000-8000-0000000000aa',
            scope: ORG,
            runner: PREFIX,
            name: 'customer-host',
            minVersion: '1.0.0',
            sessionTtlSec: LOGIN_SEC,
          }),
        )
      },
    })
    await gatewayNc.flush()

    const cfg = parseConfig({ NATS_URL: server!.wsUrl, QV_RUNNER_TOKEN: TOKEN })
    expect(cfg.auth.user).toBe(PREFIX)
    bus = await openBus({
      url: cfg.natsUrl,
      user: cfg.auth.user,
      pass: cfg.auth.pass,
      inboxPrefix: `_INBOX_${cfg.auth.user}`,
      log: { info: () => undefined, warn: (o: object) => disconnects.push(JSON.stringify(o)) },
    })
    runner = await startRunner({
      bus,
      user: cfg.auth.user,
      mode: 'token',
      addresses: [''],
      clients: new Map([['', createVenueHttpClient('')]]),
      lookup: null,
      maxInflight: 8,
      version: '1.0.0',
      closeDeadlineMs: 5_000,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      onRevoked: () => undefined,
    })
  }, 60_000)

  afterAll(async () => {
    runner?.stop('shutdown')
    await bus?.close(1_000)
    await gatewayNc?.close()
    await auth?.close()
    venue?.closeAllConnections()
    await new Promise((r) => venue?.close(r))
    server?.cleanup()
  })

  const relay = async (path: string, timeout = 8_000) => {
    const res = await gatewayNc.request(
      subjects.runnerHttp(ORG, PREFIX),
      encode('RunnerHttpRequest', { method: 'GET', url: `${base}${path}`, headers: [], body: new Uint8Array(), timeoutMs: timeout, lane: '' }),
      { timeout: timeout + 1_000 },
    )
    return decode(res.data).payload as WireMessageByType['RunnerHttpResponse']
  }

  it("logs in over the WebSocket with its token and serves under its organization's scope", async () => {
    expect(runner.identity).toMatchObject({ scope: ORG, runner: PREFIX, name: 'customer-host' })
    expect(logins[0]).toEqual({ type: 'websocket', user: PREFIX })
    expect((await relay('/api/v3/order')).status).toBe(200)
  })

  it('renews its login before the server ends it, and answers a request held across the renewal', async () => {
    const before = logins.length
    const answer = relay('/hold')
    await new Promise((r) => setTimeout(r, 200))
    expect(held).toHaveLength(1)
    // The renewal is due at 70 % of the login; release the venue's answer only after it happened.
    const deadline = Date.now() + LOGIN_SEC * 1000
    while (logins.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(logins.length).toBeGreaterThan(before)
    held.shift()!()
    const res = await answer
    expect(res.status).toBe(200)
    expect(Buffer.from(res.body).toString()).toBe('{"held":true}')
  }, 20_000)

  it('keeps serving past several logins, with no connection ever cut by an expiry', async () => {
    await new Promise((r) => setTimeout(r, (LOGIN_SEC + 2) * 1000))
    expect(logins.length).toBeGreaterThanOrEqual(3)
    expect((await relay('/api/v3/order')).status).toBe(200)
    expect(disconnects.filter((d) => /disconnect|Expired/i.test(d))).toEqual([])
  }, 30_000)
})
