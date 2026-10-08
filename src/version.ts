import { readFileSync } from 'node:fs'

/**
 * The runner release, semver, from this package's own `package.json` — what the heartbeat and the
 * hello report, and what the platform compares with the oldest release it serves fully.
 */
export const RUNNER_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version
