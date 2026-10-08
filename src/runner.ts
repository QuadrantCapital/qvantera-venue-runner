import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import type { AxiosInstance } from 'axios'
import { subjects } from '@quadrantcapital/proto'
import type { WireMessageByType } from '@quadrantcapital/wire'
import { ordered, type RunnerBus } from './bus.js'
import { relayHttp } from './http-relay.js'
import { applySelection, resolveLanes, type Lane } from './lanes.js'
import { createSocketRelay, type SocketRelay } from './socket-relay.js'

export const HEARTBEAT_MS = 10_000
/** Each lane's public address is looked up at start and this often after — never per venue request. */
export const EGRESS_LOOKUP_MS = 10 * 60_000
/** How long one hello waits for the platform before the runner asks again. */
export const HELLO_TIMEOUT_MS = 5_000
/** A login is renewed this far into its life, leaving the rest for the old connection's last replies. */
export const ROLLOVER_AT = 0.7
/** The hosted runner's scope (M-366); a registered runner learns its own from the hello. */
export const PLATFORM_SCOPE = 'platform'

type Log = {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

type Hello = WireMessageByType['RunnerHelloResponse']

export type Identity = { scope: string; runner: string; runnerId: string; name: string }

/**
 * The runner's whole job (M-366, M-367, § D-36): answer spot-gateway's relayed requests on its own
 * subjects, from the lane each names; hold the venue sockets spot-gateway opens through it; say
 * every ten seconds that it is alive, which lanes it has and what the venue sees from each; and ask
 * the platform, every round, what it is and which lanes it may use.
 *
 * It decides nothing about where a request goes. A request that names a lane the runner does not
 * have active is refused unsent (`lane_unavailable`), never sent from another lane: spot-gateway
 * counts each lane's venue limit, and a request moved to another lane would spend a budget it did
 * not count.
 */
export async function startRunner(deps: {
  bus: RunnerBus
  /** The NATS user: its subjects' `<runner>` token, and the subject of its hello. */
  user: string
  /** `token`: identity from the hello, which must answer. `static`: the platform's hosted runner. */
  mode: 'token' | 'static'
  addresses: string[]
  clients: Map<string, AxiosInstance>
  lookup: ((localAddress: string) => Promise<string | null>) | null
  maxInflight: number
  version: string
  closeDeadlineMs: number
  log: Log
  /** The platform revoked this runner: it must stop. */
  onRevoked: () => void
  relay?: SocketRelay
  now?: () => number
}) {
  const { bus, log } = deps
  const now = deps.now ?? Date.now
  const instanceId = randomUUID()
  const startedAt = now()
  let inflight = 0
  let egress: string[] | null = null
  let lanes: Lane[] = await resolveLanes(deps.addresses, deps.lookup, egress)
  let draining = false
  let minVersion = ''
  let rolloverTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const hello = async (): Promise<Hello | null> => {
    try {
      const res = await bus.request(
        subjects.runnerHello(deps.user),
        'RunnerHelloRequest',
        { version: deps.version, lanes, instanceId },
        HELLO_TIMEOUT_MS,
      )
      return res.type === 'RunnerHelloResponse' ? (res.payload as Hello) : null
    } catch {
      // No answer — the platform restarting, or one from before the hello: the next round asks again.
      return null
    }
  }

  /** What the platform said, applied: the lanes it selected, draining, the login's lifetime. */
  const apply = (h: Hello) => {
    if (h.error === 'revoked' || (deps.mode === 'token' && h.error === 'unknown_runner')) {
      log.error({ error: h.error }, 'the platform no longer knows this runner; stopping')
      deps.onRevoked()
      return
    }
    if (h.error) return
    // A hosted runner whose first hello went unanswered learns its id and name from a later one.
    if (identity && !identity.runnerId && h.runnerId) Object.assign(identity, { runnerId: h.runnerId, name: h.name })
    const next = h.egress.length > 0 ? [...h.egress] : null
    if (JSON.stringify(next) !== JSON.stringify(egress)) {
      egress = next
      lanes = applySelection(lanes, egress)
      log.info({ egress: egress ?? 'all', lanes }, 'runner lanes selected by the platform')
    }
    if (h.draining !== draining) {
      draining = h.draining
      log.info({ draining }, 'runner draining set by the platform')
    }
    minVersion = h.minVersion
    if (h.sessionTtlSec > 0 && rolloverTimer === undefined) scheduleRollover(h.sessionTtlSec)
  }

  /**
   * The next login renewal, timed from the login now in use: at `ROLLOVER_AT` of its life, and again
   * from each new one. A renewal that fails is tried again shortly, while the current login still has
   * the rest of its life to run.
   */
  const scheduleRollover = (ttlSec: number, inMs = ttlSec * 1000 * ROLLOVER_AT) => {
    rolloverTimer = setTimeout(() => {
      if (stopped) return
      bus
        .rollover(deps.closeDeadlineMs)
        .then(() => {
          log.info({}, 'runner login renewed')
          if (!stopped) scheduleRollover(ttlSec)
        })
        .catch((err) => {
          log.warn({ err: String(err) }, 'runner login renewal failed; trying again')
          if (!stopped) scheduleRollover(ttlSec, HELLO_TIMEOUT_MS)
        })
    }, inMs)
    rolloverTimer.unref?.()
  }

  // Who it is. A registered runner learns its subjects' scope from the platform and cannot serve
  // before it has; the hosted runner's are fixed (M-366), and a platform from before the hello does
  // not answer it.
  let identity: Identity | undefined
  for (;;) {
    const h = await hello()
    if (h && !h.error) {
      identity = { scope: h.scope, runner: h.runner, runnerId: h.runnerId, name: h.name }
      apply(h)
      break
    }
    if (h) apply(h)
    if (deps.mode === 'static') {
      identity = { scope: PLATFORM_SCOPE, runner: deps.user, runnerId: '', name: deps.user }
      break
    }
    log.warn({ error: h?.error ?? 'no answer' }, 'runner hello not answered; asking again')
    await new Promise((r) => setTimeout(r, HELLO_TIMEOUT_MS))
  }
  const { scope, runner } = identity as Identity

  const relay =
    deps.relay ??
    createSocketRelay({
      log,
      events: {
        frame: (socketId, data, binary) =>
          bus.publish(subjects.runnerWsFrame(scope, runner, socketId), 'RunnerWsFrameEvent', { data, binary }),
        closed: (socketId, code, reason) =>
          bus.publish(subjects.runnerWsClosed(scope, runner, socketId), 'RunnerWsClosedEvent', { code, reason }),
      },
    })

  /**
   * The lane a request names, if the runner has it active. `''` is the host's default route; a
   * runner with only addresses of its own takes it as its first active lane — what a spot-gateway
   * from before lanes, which names none, needs.
   */
  const laneFor = (named: string): string | null => {
    const active = lanes.filter((l) => l.state === 'active')
    if (named === '') return active.find((l) => l.localAddress === '')?.localAddress ?? active[0]?.localAddress ?? null
    return active.some((l) => l.localAddress === named) ? named : null
  }

  // Above the cap a request is answered `busy` at once: a request waiting in a queue here is
  // exactly the silent queue the cap exists to prevent.
  bus.subscribe(subjects.runnerHttp(scope, runner), async (msg) => {
    if (msg.type !== 'RunnerHttpRequest') return
    const req = msg.payload as WireMessageByType['RunnerHttpRequest']
    if (inflight >= deps.maxInflight) return { type: 'RunnerHttpResponse', payload: { error: 'busy' } }
    const lane = laneFor(req.lane)
    const client = lane === null ? undefined : deps.clients.get(lane)
    if (!client) return { type: 'RunnerHttpResponse', payload: { error: 'lane_unavailable' } }
    inflight += 1
    try {
      return { type: 'RunnerHttpResponse', payload: await relayHttp(client, req) }
    } finally {
      inflight -= 1
    }
  })

  bus.subscribe(subjects.runnerWsOpen(scope, runner), async (msg) => {
    if (msg.type !== 'RunnerWsOpenRequest') return
    const body = msg.payload as WireMessageByType['RunnerWsOpenRequest']
    const lane = laneFor(body.lane)
    if (lane === null) return { type: 'RunnerWsOpenResponse', payload: { instanceId, error: 'lane_unavailable' } }
    const opened = await relay.open(body.socketId, body.url, lane)
    return { type: 'RunnerWsOpenResponse', payload: { instanceId, error: opened.error ?? '' } }
  })

  // One order for both: a close never overtakes a frame written before it.
  const socketOrder = ordered()
  bus.subscribe(
    subjects.runnerWsSend(scope, runner, '*'),
    (msg, subject) => {
      if (msg.type !== 'RunnerWsSendEvent') return
      const socketId = socketIdOf(subject)
      const body = msg.payload as WireMessageByType['RunnerWsSendEvent']
      if (socketId) relay.send(socketId, body.data, body.binary)
    },
    { order: socketOrder },
  )
  bus.subscribe(
    subjects.runnerWsClose(scope, runner, '*'),
    (msg, subject) => {
      if (msg.type !== 'RunnerWsCloseEvent') return
      const socketId = socketIdOf(subject)
      if (socketId) relay.close(socketId, (msg.payload as WireMessageByType['RunnerWsCloseEvent']).reason)
    },
    { order: socketOrder },
  )
  await bus.flush()

  /** The default lane's public address, for a spot-gateway or a platform from before lanes. */
  const egressIp = () => lanes.find((l) => l.state === 'active')?.publicAddress ?? 'unknown'

  const heartbeat = () => {
    const ids = relay.ids()
    bus.publish(subjects.runnerHeartbeat(scope, runner), 'RunnerHeartbeatEvent', {
      runner,
      scope,
      instanceId,
      version: deps.version,
      uptimeSec: BigInt(Math.floor((now() - startedAt) / 1000)),
      egressIp: egressIp(),
      openSockets: ids.length,
      inflightRequests: inflight,
      maxInflight: deps.maxInflight,
      socketIds: ids,
      lanes,
    })
  }

  const round = async () => {
    heartbeat()
    const h = await hello()
    if (h) apply(h)
  }

  const lookupLanes = async () => {
    const next = await resolveLanes(deps.addresses, deps.lookup, egress)
    if (JSON.stringify(next) !== JSON.stringify(lanes)) log.info({ lanes: next }, 'runner lanes')
    lanes = next
  }

  log.info({ scope, runner, runnerId: identity.runnerId, lanes, instanceId }, 'runner lanes')
  heartbeat()
  const heartbeats = setInterval(() => void round(), HEARTBEAT_MS)
  heartbeats.unref?.()
  const lookups = deps.lookup ? setInterval(() => void lookupLanes(), EGRESS_LOOKUP_MS) : undefined
  lookups?.unref?.()

  return {
    identity: identity as Identity,
    instanceId,
    lanes: () => lanes,
    egressIp,
    inflight: () => inflight,
    openSockets: () => relay.ids().length,
    draining: () => draining,
    outdated: () => minVersion !== '' && compareVersions(deps.version, minVersion) < 0,
    /** Before the bus closes: no more heartbeats or renewals, and every socket says it ended. */
    stop(reason: string): void {
      stopped = true
      clearInterval(heartbeats)
      if (lookups) clearInterval(lookups)
      if (rolloverTimer) clearTimeout(rolloverTimer)
      relay.closeAll(reason)
    },
  }
}

/** `qvantera.v1.runner.<scope>.<runner>.ws.<socketId>.<verb>` → the socket id. */
function socketIdOf(subject: string): string | undefined {
  const tokens = subject.split('.')
  return tokens.length === 8 ? tokens[6] : undefined
}

/** Semver `MAJOR.MINOR.PATCH` order; anything else is older than every release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+\.\d+\.\d+/.test(v) ? v.split(/[.+-]/).slice(0, 3).map(Number) : [-1, -1, -1])
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
  return 0
}

/**
 * The public address the venue sees from one lane, from a plain-text lookup asked through that
 * lane's own client — so through the same route and source address. Anything that is not one IP
 * address is no answer: the owner compares this with the venue's whitelist, and a wrong value
 * there is worse than none.
 */
export async function lookupEgressIp(http: AxiosInstance, url: string): Promise<string | null> {
  try {
    const res = await http.get(url, { timeout: 5_000 })
    const text = Buffer.from(res.data as ArrayBuffer).toString('utf8').trim()
    return res.status === 200 && isIP(text) ? text : null
  } catch {
    return null
  }
}
