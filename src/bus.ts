import { wsconnect, type ConnectionOptions, type Msg, type NatsConnection, type Subscription } from '@nats-io/nats-core'
import { connect as tcpconnect } from '@nats-io/transport-node'
import { decode, encode, type DecodedMessage, type MessageTypeName, type WirePayloadByType } from '@quadrantcapital/wire'

/**
 * The runner's NATS connection (M-367). A plain NATS client, outbound only: over the platform's
 * WebSocket listener with a token, or over TCP on the platform's own Compose network for its hosted
 * runner. Every message is a QVPB frame (`@quadrantcapital/wire`).
 *
 * **A login expires.** The platform's auth callout issues a user that lasts `session_ttl_sec`, and
 * the server ends the connection then. A reply can only go out on the connection its request came
 * in on (the reply permission is per connection), so a request in flight when the server cut the
 * connection would lose its answer — and a lost create answer is an ambiguous order. So the runner
 * changes connections before that, make before break: `rollover` logs in again, subscribes the new
 * connection, unsubscribes the old one, and closes it only once every request it delivered has been
 * answered. Every subscription is in one queue group, so while both are subscribed each message
 * reaches one of them, never both — the same holds for two processes started with one token.
 */

export type Reply = { type: MessageTypeName; payload: unknown }
export type Handler = (msg: DecodedMessage, subject: string) => Promise<Reply | void> | Reply | void

/** One ordering domain: handlers sharing it run one at a time, in arrival order. */
export type Ordered = { tail: Promise<unknown> }
export const ordered = (): Ordered => ({ tail: Promise.resolve() })

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }

type Spec = { subject: string; handler: Handler; order?: Ordered }

type Live = { nc: NatsConnection; subs: Subscription[]; inflight: number }

export type BusOptions = {
  url: string
  user: string
  pass: string
  name?: string
  inboxPrefix: string
  log: Log
}

/** Every runner subscription is in this queue group (see above). */
export const QUEUE = 'runner'

/**
 * A login that is never given up on. The platform may be down when the runner starts or restart
 * under it, and while Control restarts its auth callout refuses every login: nats.js by default
 * aborts after two refusals in a row and throws out of the first connect, which ended the runner
 * (found on a local stack, 2026-10-08). `ignoreAuthErrorAbort` keeps it asking, first connect
 * included, and `watch` logs each refusal. A token refused for good was rotated or revoked — the log
 * says `Authorization Violation`, and the runner keeps asking rather than restart-looping.
 */
async function login(opts: BusOptions): Promise<NatsConnection> {
  const common: ConnectionOptions = {
    servers: opts.url,
    user: opts.user,
    pass: opts.pass,
    inboxPrefix: opts.inboxPrefix,
    ...(opts.name ? { name: opts.name } : {}),
    waitOnFirstConnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2_000,
    ignoreAuthErrorAbort: true,
  }
  return /^wss?:/.test(opts.url) ? wsconnect(common) : tcpconnect(common)
}

export async function openBus(opts: BusOptions) {
  const specs: Spec[] = []
  let current: Live = { nc: await login(opts), subs: [], inflight: 0 }
  watch(current.nc, opts.log)

  const deliver = (live: Live, spec: Spec, msg: Msg) => {
    let decoded: DecodedMessage
    try {
      decoded = decode(msg.data)
    } catch (err) {
      opts.log.warn({ subject: msg.subject, err: String(err) }, 'runner dropped an undecodable frame')
      return
    }
    live.inflight += 1
    const run = async () => {
      try {
        const reply = await spec.handler(decoded, msg.subject)
        if (reply && msg.reply) msg.respond(encode(reply.type, reply.payload as never))
      } catch (err) {
        opts.log.warn({ subject: msg.subject, err: String(err) }, 'runner handler failed')
      } finally {
        live.inflight -= 1
      }
    }
    if (spec.order) spec.order.tail = spec.order.tail.then(run)
    else void run()
  }

  const attach = (live: Live, spec: Spec) => {
    live.subs.push(
      live.nc.subscribe(spec.subject, {
        queue: QUEUE,
        callback: (err, msg) => {
          if (!err) deliver(live, spec, msg)
        },
      }),
    )
  }

  return {
    subscribe(subject: string, handler: Handler, opt: { order?: Ordered } = {}): void {
      const spec: Spec = { subject, handler, ...(opt.order ? { order: opt.order } : {}) }
      specs.push(spec)
      attach(current, spec)
    },

    publish<T extends MessageTypeName>(subject: string, type: T, payload: WirePayloadByType[T]): void {
      current.nc.publish(subject, encode(type, payload))
    },

    async request<T extends MessageTypeName>(
      subject: string,
      type: T,
      payload: WirePayloadByType[T],
      timeoutMs: number,
    ): Promise<DecodedMessage> {
      const res = await current.nc.request(subject, encode(type, payload), { timeout: timeoutMs })
      return decode(res.data)
    },

    async flush(): Promise<void> {
      await current.nc.flush()
    },

    /** Make before break: see the module comment. Resolves once the old connection is closed. */
    async rollover(deadlineMs: number): Promise<void> {
      const next: Live = { nc: await login(opts), subs: [], inflight: 0 }
      watch(next.nc, opts.log)
      for (const spec of specs) attach(next, spec)
      await next.nc.flush()
      const old = current
      current = next
      for (const sub of old.subs) sub.unsubscribe()
      await retire(old, deadlineMs)
    },

    inflight: () => current.inflight,
    connected: () => !current.nc.isClosed() && current.nc.info !== undefined,

    /** Shutdown: no new message is taken, the ones being handled are answered, then the connection closes. */
    async close(deadlineMs: number): Promise<void> {
      for (const sub of current.subs) sub.unsubscribe()
      await retire(current, deadlineMs)
    },
  }
}

async function retire(live: Live, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (live.inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  await live.nc.flush().catch(() => undefined)
  await live.nc.close()
}

function watch(nc: NatsConnection, log: Log): void {
  void (async () => {
    for await (const s of nc.status()) {
      if (s.type === 'disconnect' || s.type === 'error') {
        log.warn({ status: s.type, detail: 'error' in s ? String(s.error) : undefined }, 'runner NATS connection')
      } else if (s.type === 'reconnect') {
        log.info({ status: s.type }, 'runner NATS connection')
      }
    }
  })()
}

export type RunnerBus = Awaited<ReturnType<typeof openBus>>
