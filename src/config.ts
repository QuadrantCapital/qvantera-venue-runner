import { z } from 'zod'

/**
 * The runner's configuration — the only place it reads its environment. Parsed once, on first use;
 * `index.ts` makes that the first thing it does, so a mistake stops the runner with one line that
 * names it.
 *
 * Two ways to log in, never both:
 *   - `QV_RUNNER_TOKEN` — a registered runner (M-367): the token is the NATS password, presented
 *     over the platform's WebSocket listener, and the platform's auth callout decides what it may do.
 *   - `NATS_USER` / `NATS_PASS` — the platform's own hosted runner on its Compose network (M-366),
 *     which the platform's configuration names. Never a customer's.
 */

/** `qv_rnr_<prefix>_<secret>`: twelve hex digits that name the runner, then 32 random bytes. */
export const TOKEN_FORMAT = /^qv_rnr_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

const intFrom = (fallback: number, min: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min))

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))

const schema = z
  .object({
    QV_PLATFORM_URL: optionalText.pipe(z.string().url().optional()),
    NATS_URL: optionalText.pipe(z.string().url().optional()),
    QV_RUNNER_TOKEN: optionalText.pipe(z.string().regex(TOKEN_FORMAT, 'is not a runner token (qv_rnr_…)').optional()),
    NATS_USER: optionalText,
    NATS_PASS: optionalText,
    RUNNER_EGRESS_IPS: optionalText.transform((v) => v ?? 'auto'),
    RUNNER_EGRESS_IP_URL: optionalText.pipe(z.string().url().optional()),
    RUNNER_NAME: optionalText,
    RUNNER_MAX_INFLIGHT: intFrom(64, 1),
    RUNNER_PORT: intFrom(3005, 0),
    // The host network on a customer's machine: /health and /metrics stay on loopback unless asked.
    RUNNER_HOST: optionalText.transform((v) => v ?? '127.0.0.1'),
    // On stop, a request already relayed is waited for: one cut mid-flight is an ambiguous create
    // made by the shutdown itself. Above the venue HTTP timeout spot-gateway sets (20 s).
    NATS_CLOSE_DEADLINE_MS: intFrom(25_000, 0),
    LOG_LEVEL: z.enum(LOG_LEVELS).optional().default('info'),
  })
  .superRefine((c, ctx) => {
    const token = c.QV_RUNNER_TOKEN !== undefined
    const user = c.NATS_USER !== undefined || c.NATS_PASS !== undefined
    if (token === user) {
      ctx.addIssue({
        code: 'custom',
        path: ['QV_RUNNER_TOKEN'],
        message: 'set QV_RUNNER_TOKEN (a registered runner), or NATS_USER and NATS_PASS (the hosted runner) — exactly one',
      })
    }
    if (user && (c.NATS_USER === undefined || c.NATS_PASS === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['NATS_PASS'], message: 'NATS_USER and NATS_PASS go together' })
    }
    if (c.QV_PLATFORM_URL === undefined && c.NATS_URL === undefined) {
      ctx.addIssue({ code: 'custom', path: ['QV_PLATFORM_URL'], message: "is required: the platform's https:// address" })
    }
  })

export type RunnerConfig = {
  natsUrl: string
  auth: { kind: 'token'; user: string; pass: string } | { kind: 'static'; user: string; pass: string }
  egress: 'auto' | string[]
  egressIpUrl?: string
  name?: string
  maxInflight: number
  port: number
  host: string
  closeDeadlineMs: number
  logLevel: (typeof LOG_LEVELS)[number]
}

/**
 * The platform's NATS: its WebSocket listener behind the HTTPS ingress, `wss://<host>/nats`
 * (§ D-36). `NATS_URL` replaces it for a runner beside the platform (its Compose network, a test).
 */
export function natsUrlFor(platformUrl: string): string {
  const url = new URL(platformUrl)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/nats`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function parseConfig(env: Record<string, string | undefined>): RunnerConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
    throw new Error(`venue-runner configuration: ${lines.join('; ')}`)
  }
  const c = parsed.data
  const token = c.QV_RUNNER_TOKEN ? TOKEN_FORMAT.exec(c.QV_RUNNER_TOKEN) : null
  const egress =
    c.RUNNER_EGRESS_IPS === 'auto'
      ? ('auto' as const)
      : c.RUNNER_EGRESS_IPS.split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
  return {
    natsUrl: c.NATS_URL ?? natsUrlFor(c.QV_PLATFORM_URL as string),
    // A token runner's NATS user is its token's prefix: the name its subjects carry.
    auth: token
      ? { kind: 'token', user: token[1] as string, pass: c.QV_RUNNER_TOKEN as string }
      : { kind: 'static', user: c.NATS_USER as string, pass: c.NATS_PASS as string },
    egress,
    ...(c.RUNNER_EGRESS_IP_URL ? { egressIpUrl: c.RUNNER_EGRESS_IP_URL } : {}),
    ...(c.RUNNER_NAME ? { name: c.RUNNER_NAME } : {}),
    maxInflight: c.RUNNER_MAX_INFLIGHT,
    port: c.RUNNER_PORT,
    host: c.RUNNER_HOST,
    closeDeadlineMs: c.NATS_CLOSE_DEADLINE_MS,
    logLevel: c.LOG_LEVEL,
  }
}

let loaded: RunnerConfig | null = null

export function config(): RunnerConfig {
  return (loaded ??= parseConfig(process.env))
}
