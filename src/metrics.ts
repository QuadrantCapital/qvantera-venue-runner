import client from 'prom-client'
import type { BuildInfo } from './build-info.js'
import type { Lane } from './lanes.js'

/**
 * The runner's metrics. Its liveness, as the platform sees it, is the heartbeat Control turns into
 * `qvantera_runner_up`; these are for whoever runs the host. No label names a runner, a request or
 * an address: the set of series is fixed.
 */
export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

const buildInfo = new client.Gauge({
  name: 'qvantera_build_info',
  help: 'Always 1; the labels identify the build this process runs',
  labelNames: ['sha', 'tree', 'service', 'version'],
  registers: [registry],
})

const laneCount = new client.Gauge({
  name: 'qvantera_runner_lanes',
  help: 'Egress lanes by state',
  labelNames: ['state'],
  registers: [registry],
})

const inflightGauge = new client.Gauge({
  name: 'qvantera_runner_inflight_requests',
  help: 'Venue requests being relayed now',
  registers: [registry],
})

const sockets = new client.Gauge({
  name: 'qvantera_runner_open_sockets',
  help: 'Venue WebSockets held now',
  registers: [registry],
})

export function recordBuildInfo(build: BuildInfo, version: string): void {
  buildInfo.set({ sha: build.sha, tree: build.tree, service: 'venue-runner', version }, 1)
}

export function sample(state: { lanes: Lane[]; inflight: number; openSockets: number }): void {
  for (const s of ['active', 'disabled', 'duplicate', 'unresolved'] as const) {
    laneCount.set({ state: s }, state.lanes.filter((l) => l.state === s).length)
  }
  inflightGauge.set(state.inflight)
  sockets.set(state.openSockets)
}
