import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect } from '@nats-io/transport-node'

/**
 * A throwaway nats-server for one test file, with the configuration the test needs — users, the
 * WebSocket listener, an auth callout — on ports Docker picks. `nats:2.10-alpine`, the version the
 * platform runs. Tests only; the runner never imports it.
 *
 * The configuration goes in through the environment and is written inside the container, so this
 * works with a Docker daemon on another host too. Without Docker the tests skip (`null`); Docker
 * present and the server not starting is a failure — a green run that tested nothing is worse than
 * a red one.
 */
export type NatsServer = { url: string; wsUrl: string; cleanup: () => void }

function remove(name: string): void {
  spawnSync('docker', ['rm', '-f', '-v', name], { encoding: 'utf8' })
}

function hostPort(name: string, port: string): string {
  const out = spawnSync('docker', ['port', name, `${port}/tcp`], { encoding: 'utf8' }).stdout
  const found = /:(\d+)\s*$/m.exec(out)?.[1]
  if (!found) throw new Error(`nats harness: Docker published no host port for ${name} ${port}`)
  return found
}

export async function startNats(conf: string, auth: { user: string; pass: string }): Promise<NatsServer | null> {
  if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0) {
    console.warn('NATS tests skipped: Docker unavailable')
    return null
  }
  const name = `qv-runner-nats-${process.pid}-${randomBytes(3).toString('hex')}`
  const labels = ['--label', 'qv.nats-harness=1']
  if (process.env.RUNNER_NAME) labels.push('--label', `qv.runner=${process.env.RUNNER_NAME}`)
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--name', name, ...labels,
      '-p', '127.0.0.1::4222', '-p', '127.0.0.1::8080',
      '-e', `NATS_CONF=port: 4222\nwebsocket { port: 8080, no_tls: true }\n${conf}`,
      '--entrypoint', 'sh', 'nats:2.10-alpine',
      '-c', 'printf "%s\\n" "$NATS_CONF" > /tmp/nats.conf && exec nats-server -c /tmp/nats.conf',
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) {
    remove(name)
    throw new Error(`nats harness: docker run failed: ${(run.stderr || run.stdout).trim()}`)
  }
  const url = `nats://127.0.0.1:${hostPort(name, '4222')}`
  const wsUrl = `ws://127.0.0.1:${hostPort(name, '8080')}`
  let last: unknown
  for (let i = 0; i < 40; i += 1) {
    try {
      const nc = await connect({ servers: url, ...auth, reconnect: false })
      await nc.close()
      return { url, wsUrl, cleanup: () => remove(name) }
    } catch (err) {
      last = err
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
  remove(name)
  throw new Error(`nats harness: not ready: ${String(last)}\n${logs.stdout}${logs.stderr}`)
}
