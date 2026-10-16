import { createServer, type Server, type ServerResponse } from 'node:http'
import type { BuildInfo } from './build-info.js'
import type { RunnerBus } from './bus.js'
import { registry, sample } from './metrics.js'
import type { Runner } from './runner.js'

/**
 * The runner's HTTP surface, on the probe contract every platform service follows (M-502, M-805,
 * M-805a): `/health` is liveness and looks at nothing outside the process, so a lost NATS login
 * never fails it and a healthcheck never restarts a runner that is only waiting for the platform;
 * `/ready` names what the runner cannot serve without.
 */
export type ReadinessCheck = 'ok' | 'failed' | 'timeout'
export type Readiness = { ready: boolean; checks: Record<string, ReadinessCheck>; errors: Record<string, string> }

/** The platform services' deadline: a probe that needs longer than this has already answered. */
export const READY_TIMEOUT_MS = 2_000

/**
 * `nats` is a PING answered now. From the shutdown on — a signal or a revocation — `draining` alone,
 * asking nothing, as the platform services answer from their signal on.
 */
export async function readiness(
  deps: { ping: () => Promise<unknown>; shuttingDown: () => boolean },
  timeoutMs = READY_TIMEOUT_MS,
): Promise<Readiness> {
  if (deps.shuttingDown()) return { ready: false, checks: { draining: 'failed' }, errors: { draining: 'shutting down' } }
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const outcome = await Promise.race([deps.ping().then(() => 'ok' as const), deadline])
    if (outcome === 'ok') return { ready: true, checks: { nats: 'ok' }, errors: {} }
    return { ready: false, checks: { nats: 'timeout' }, errors: { nats: `no PONG within ${timeoutMs}ms` } }
  } catch (err) {
    return { ready: false, checks: { nats: 'failed' }, errors: { nats: err instanceof Error ? err.message : String(err) } }
  } finally {
    clearTimeout(timer)
  }
}

export function statusServer(deps: {
  bus: Pick<RunnerBus, 'connected' | 'ping'>
  runner: Pick<Runner, 'identity' | 'instanceId' | 'outdated' | 'draining' | 'egressIp' | 'lanes' | 'openSockets' | 'inflight'>
  build: BuildInfo
  version: string
  shuttingDown: () => boolean
  log: { warn: (obj: object, msg: string) => void }
  readyTimeoutMs?: number
}): Server {
  const { bus, runner: r } = deps
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  return createServer((req, res) => {
    if (req.url === '/health') {
      json(res, 200, {
        ok: true,
        // What an operator reads, never what the probe tests: /ready is the one that fails on it.
        connected: bus.connected(),
        build: deps.build,
        version: deps.version,
        outdated: r.outdated(),
        runner: r.identity.runner,
        runnerId: r.identity.runnerId,
        scope: r.identity.scope,
        instanceId: r.instanceId,
        // Set by the runner's administrator on the platform: spot-gateway sends it nothing new. The
        // process still serves what is in flight, so this is not a readiness check.
        draining: r.draining(),
        egressIp: r.egressIp(),
        lanes: r.lanes(),
        openSockets: r.openSockets(),
        inflight: r.inflight(),
      })
      return
    }
    if (req.url === '/ready') {
      void readiness({ ping: bus.ping, shuttingDown: deps.shuttingDown }, deps.readyTimeoutMs).then(({ ready, checks, errors }) => {
        // The error text goes to the log, never the body, as on the platform services.
        if (!ready) deps.log.warn({ failing: errors }, 'not ready')
        json(res, ready ? 200 : 503, { ready, checks })
      })
      return
    }
    if (req.url === '/metrics') {
      sample({ lanes: r.lanes(), inflight: r.inflight(), openSockets: r.openSockets() })
      void registry.metrics().then((text) => {
        res.setHeader('content-type', registry.contentType)
        res.end(text)
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
}
