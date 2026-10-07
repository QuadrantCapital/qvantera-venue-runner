import Fastify from 'fastify'
import { NatsBus, connectWithRetry } from '@quadrantcapital/messaging'
import {
  createPinoOptions,
  describeConfig,
  initBuildIdentity,
  registerGracefulShutdown,
  registerMetricsRoute,
  venueRunnerConfig,
  type BuildIdentity,
} from '@quadrantcapital/observability'
import { createVenueHttpClient } from './http-relay.js'
import { startRunner } from './runner.js'
import { config } from './config.js'

// The venue runner (M-366, § D-36): the venue egress, outside the application. It holds no venue
// secret, no database handle and no adapter — spot-gateway signs, the runner sends.
const cfg = config()
let build: BuildIdentity
try {
  build = initBuildIdentity('venue-runner', cfg.QV_ENV === 'production')
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

if (!cfg.NATS_URL || !cfg.NATS_USER) {
  console.error('NATS_URL and NATS_USER are required')
  process.exit(1)
}

const app = Fastify({ logger: createPinoOptions('venue-runner', build, cfg.LOG_LEVEL) as object })
app.log.info({ build, config: describeConfig(venueRunnerConfig, cfg) }, 'venue runner starting')
registerMetricsRoute(app)

const bus = new NatsBus(cfg.NATS_CLOSE_DEADLINE_MS)
const connected = await connectWithRetry(bus, cfg.NATS_URL, { user: cfg.NATS_USER, pass: cfg.NATS_PASS })
if (!connected) {
  app.log.error({}, 'NATS connect failed')
  process.exit(1)
}

// Its NATS user is its name on the wire: the subjects it may use carry it, so a runner configured
// with another's name could subscribe to nothing.
const runner = await startRunner({
  bus,
  runner: cfg.NATS_USER,
  http: createVenueHttpClient(),
  maxInflight: cfg.RUNNER_MAX_INFLIGHT,
  version: build.sha || 'unknown',
  ...(cfg.RUNNER_EGRESS_IP_URL ? { egressIpUrl: cfg.RUNNER_EGRESS_IP_URL } : {}),
  log: app.log,
})
app.log.info({ runner: cfg.NATS_USER, instanceId: runner.instanceId }, 'venue runner serving')

app.get('/health', async () => ({
  ok: true,
  build,
  runner: cfg.NATS_USER,
  instanceId: runner.instanceId,
  egressIp: runner.egressIp(),
  openSockets: runner.openSockets(),
  inflight: runner.inflight(),
}))

app.addHook('onClose', async () => {
  // Sockets first, while the connection can still say they ended; then the drain, which waits for
  // the requests already being relayed (NATS_CLOSE_DEADLINE_MS) — one cut mid-flight would be an
  // ambiguous create made by the shutdown itself.
  runner.stop('shutdown')
  await bus.close()
})

await app.listen({ port: cfg.RUNNER_PORT, host: '0.0.0.0' })
registerGracefulShutdown(app)
