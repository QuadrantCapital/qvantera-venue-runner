import { loadConfig, venueRunnerConfig, type ConfigOf } from '@quadrantcapital/observability'

export type RunnerConfig = ConfigOf<typeof venueRunnerConfig>

let loaded: RunnerConfig | null = null

/**
 * The venue runner's configuration (M-800, M-366) — the only way it reads its environment. Parsed
 * once, on first use; `index.ts` makes that the first thing it does.
 */
export function config(): RunnerConfig {
  return (loaded ??= loadConfig(venueRunnerConfig))
}
