import { createServer } from 'node:http'
import { hostname } from 'node:os'
import pino from 'pino'
import { openBus } from './bus.js'
import { loadBuildInfo } from './build-info.js'
import { config } from './config.js'
import { createVenueHttpClient } from './http-relay.js'
import { laneAddresses } from './lanes.js'
import { recordBuildInfo, registry, sample } from './metrics.js'
import { lookupEgressIp, startRunner } from './runner.js'
import { RUNNER_VERSION } from './version.js'

// The venue runner (M-366, M-367, § D-36): the venue egress, outside the platform. It holds no venue
// secret, no database handle and no adapter — spot-gateway signs, the runner sends, from the lane
// spot-gateway chose.
let cfg: ReturnType<typeof config>
try {
  cfg = config()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

const build = loadBuildInfo()
const log = pino({
  level: cfg.logLevel,
  // Every line names the service and the build (M-500), as every platform service's does.
  base: { pid: process.pid, hostname: hostname(), build_sha: build.sha, service: 'venue-runner' },
  // The token is the runner's NATS password: no field of that name is ever written.
  redact: { paths: ['pass', '*.pass', 'token', '*.token'], censor: '[redacted]' },
})
recordBuildInfo(build, RUNNER_VERSION)

let addresses: string[]
try {
  addresses = laneAddresses(cfg.egress)
} catch (err) {
  // A configured address this host does not have: refuse to start rather than send nothing from it.
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'venue-runner refused its egress addresses')
  process.exit(1)
}

log.info(
  {
    build,
    version: RUNNER_VERSION,
    config: {
      natsUrl: cfg.natsUrl,
      login: cfg.auth.kind,
      user: cfg.auth.user,
      egress: cfg.egress,
      egressIpUrl: cfg.egressIpUrl ?? null,
      maxInflight: cfg.maxInflight,
    },
  },
  'venue-runner starting',
)

const clients = new Map(addresses.map((a) => [a, createVenueHttpClient(a)]))
const lookup = cfg.egressIpUrl
  ? (local: string) => lookupEgressIp(clients.get(local)!, cfg.egressIpUrl as string)
  : null

const bus = await openBus({
  url: cfg.natsUrl,
  user: cfg.auth.user,
  pass: cfg.auth.pass,
  inboxPrefix: `_INBOX_${cfg.auth.user}`,
  log,
  ...(cfg.name ? { name: cfg.name } : {}),
})

let shuttingDown = false
// What exists by the time a signal or a revocation arrives: the runner may be revoked before it serves.
const live: { runner?: Awaited<ReturnType<typeof startRunner>>; server?: ReturnType<typeof createServer> } = {}
const shutdown = async (signal: string, code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'graceful shutdown started')
  // Sockets first, while the connection can still say they ended; then the requests already being
  // relayed are answered (NATS_CLOSE_DEADLINE_MS) — one cut mid-flight would be an ambiguous create
  // made by the shutdown itself.
  live.runner?.stop('shutdown')
  await bus.close(cfg.closeDeadlineMs).catch(() => undefined)
  live.server?.close()
  log.info({}, 'graceful shutdown complete')
  process.exit(code)
}

const r = await startRunner({
  bus,
  user: cfg.auth.user,
  mode: cfg.auth.kind,
  addresses,
  clients,
  lookup,
  maxInflight: cfg.maxInflight,
  version: RUNNER_VERSION,
  closeDeadlineMs: cfg.closeDeadlineMs,
  log,
  onRevoked: () => void shutdown('revoked', 1),
})
live.runner = r
log.info({ ...r.identity, instanceId: r.instanceId, lanes: r.lanes() }, 'venue runner serving')

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        ok: bus.connected(),
        build,
        version: RUNNER_VERSION,
        outdated: r.outdated(),
        runner: r.identity.runner,
        runnerId: r.identity.runnerId,
        scope: r.identity.scope,
        instanceId: r.instanceId,
        draining: r.draining(),
        egressIp: r.egressIp(),
        lanes: r.lanes(),
        openSockets: r.openSockets(),
        inflight: r.inflight(),
      }),
    )
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
live.server = server
server.listen(cfg.port, cfg.host)

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
