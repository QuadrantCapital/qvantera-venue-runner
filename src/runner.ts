import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import type { AxiosInstance } from 'axios'
import { dispatchLimit, subjects, subjectTokens, type NatsBus } from '@quadrantcapital/messaging'
import type { WireMessageByType } from '@quadrantcapital/wire'
import { relayHttp } from './http-relay.js'
import { createSocketRelay, type SocketRelay } from './socket-relay.js'

export const HEARTBEAT_MS = 10_000
/** The egress lookup is asked at start and this often after — never per venue request. */
export const EGRESS_LOOKUP_MS = 10 * 60_000
/**
 * A hosted runner's scope (M-366). M-367 gives a self-hosted runner its organization's at
 * registration.
 */
export const PLATFORM_SCOPE = 'platform'

type Log = {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
}

export type RunnerBus = Pick<NatsBus, 'subscribe' | 'publish'>

/**
 * The runner's whole job (M-366, § D-36): answer spot-gateway's relayed requests on its own
 * subjects, hold the venue sockets spot-gateway opens through it, and say every ten seconds that
 * it is alive and where the venue sees it from.
 *
 * It subscribes only under `qvantera.v1.runner.<scope>.<runner>.` and replies through the
 * request's own reply subject: its NATS user holds nothing else, so another runner's traffic is
 * not something it could read even by mistake.
 */
export async function startRunner(deps: {
  bus: RunnerBus
  runner: string
  http: AxiosInstance
  maxInflight: number
  version: string
  egressIpUrl?: string
  log: Log
  relay?: SocketRelay
  now?: () => number
}) {
  const { bus, runner, log } = deps
  const scope = PLATFORM_SCOPE
  const instanceId = randomUUID()
  const startedAt = (deps.now ?? Date.now)()
  let inflight = 0
  let egressIp = 'unknown'

  const relay =
    deps.relay ??
    createSocketRelay({
      log,
      events: {
        frame: (socketId, data, binary) =>
          void bus.publish(subjects.runnerWsFrame(scope, runner, socketId), 'RunnerWsFrameEvent', { data, binary }),
        closed: (socketId, code, reason) =>
          void bus.publish(subjects.runnerWsClosed(scope, runner, socketId), 'RunnerWsClosedEvent', { code, reason }),
      },
    })

  // Above the cap a request is answered `busy` at once, so the dispatch limit must leave room for
  // those answers: a request waiting in the limit's backlog is exactly the silent queue the cap
  // exists to prevent.
  await bus.subscribe(
    subjects.runnerHttp(scope, runner),
    async (msg) => {
      if (msg.type !== 'RunnerHttpRequest') return
      if (inflight >= deps.maxInflight) {
        return { type: 'RunnerHttpResponse' as const, payload: { error: 'busy' } }
      }
      inflight += 1
      try {
        const payload = await relayHttp(deps.http, msg.payload as WireMessageByType['RunnerHttpRequest'])
        return { type: 'RunnerHttpResponse' as const, payload }
      } finally {
        inflight -= 1
      }
    },
    { concurrency: deps.maxInflight * 4 },
  )

  await bus.subscribe(
    subjects.runnerWsOpen(scope, runner),
    async (msg) => {
      if (msg.type !== 'RunnerWsOpenRequest') return
      const body = msg.payload as WireMessageByType['RunnerWsOpenRequest']
      const opened = await relay.open(body.socketId, body.url)
      return { type: 'RunnerWsOpenResponse' as const, payload: { instanceId, error: opened.error ?? '' } }
    },
    { concurrency: deps.maxInflight },
  )

  // One limit for both: a close never overtakes a frame written before it.
  const ordered = dispatchLimit(1)
  const sendPattern = subjects.runnerWsSend(scope, runner, '*')
  await bus.subscribe(
    sendPattern,
    (msg, meta) => {
      if (msg.type !== 'RunnerWsSendEvent') return
      const [socketId] = subjectTokens(sendPattern, meta.subject) ?? []
      if (!socketId) return
      const body = msg.payload as WireMessageByType['RunnerWsSendEvent']
      relay.send(socketId, body.data, body.binary)
    },
    { concurrency: ordered },
  )
  const closePattern = subjects.runnerWsClose(scope, runner, '*')
  await bus.subscribe(
    closePattern,
    (msg, meta) => {
      if (msg.type !== 'RunnerWsCloseEvent') return
      const [socketId] = subjectTokens(closePattern, meta.subject) ?? []
      if (socketId) relay.close(socketId, (msg.payload as WireMessageByType['RunnerWsCloseEvent']).reason)
    },
    { concurrency: ordered },
  )

  const heartbeat = () => {
    const ids = relay.ids()
    void bus.publish(subjects.runnerHeartbeat(scope, runner), 'RunnerHeartbeatEvent', {
      runner,
      scope,
      instanceId,
      version: deps.version,
      uptimeSec: BigInt(Math.floor(((deps.now ?? Date.now)() - startedAt) / 1000)),
      egressIp,
      openSockets: ids.length,
      inflightRequests: inflight,
      maxInflight: deps.maxInflight,
      socketIds: ids,
    })
  }

  const lookupEgress = async () => {
    if (!deps.egressIpUrl) return
    const found = await lookupEgressIp(deps.http, deps.egressIpUrl)
    if (found !== egressIp) log.info({ egressIp: found }, 'runner egress ip')
    egressIp = found
  }

  await lookupEgress()
  heartbeat()
  const heartbeats = setInterval(heartbeat, HEARTBEAT_MS)
  heartbeats.unref?.()
  const lookups = setInterval(() => void lookupEgress(), EGRESS_LOOKUP_MS)
  lookups.unref?.()

  return {
    instanceId,
    egressIp: () => egressIp,
    inflight: () => inflight,
    openSockets: () => relay.ids().length,
    /** Before the bus drains: no more heartbeats, and every socket says it ended. */
    stop(reason: string): void {
      clearInterval(heartbeats)
      clearInterval(lookups)
      relay.closeAll(reason)
    },
  }
}

/**
 * The public address the venue sees, from a plain-text lookup asked through the same client the
 * venue requests use — so through the same route. Anything that is not one IP address is `unknown`:
 * the owner compares this with the venue's whitelist, and a wrong value there is worse than none.
 */
export async function lookupEgressIp(http: AxiosInstance, url: string): Promise<string> {
  try {
    const res = await http.get(url, { timeout: 5_000 })
    const text = Buffer.from(res.data as ArrayBuffer).toString('utf8').trim()
    return res.status === 200 && isIP(text) ? text : 'unknown'
  } catch {
    // Unreachable lookup: the heartbeat says so rather than repeating an address it can no longer vouch for.
    return 'unknown'
  }
}
