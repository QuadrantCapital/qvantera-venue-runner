import http from 'node:http'
import https from 'node:https'
import axios, { type AxiosInstance, isAxiosError } from 'axios'
import type { WireMessageByType, WirePayloadByType } from '@quadrantcapital/wire'

type RunnerHttpRequest = WireMessageByType['RunnerHttpRequest']
type RunnerHttpResponse = WirePayloadByType['RunnerHttpResponse']

/**
 * Connection reuse for every venue request (M-320, moved here from spot-gateway by M-366). Built
 * without `keepAlive`, every request paid a fresh TCP and TLS handshake: ~720 ms a request against a
 * ~150 ms round trip on the pilot.
 *
 * `timeout` closes a pooled socket after 5 s idle, as Node's global agent does: a venue's load
 * balancer that closes idle connections first would otherwise race a request onto a dead socket,
 * and a create on a reset socket is `ambiguous`. `maxSockets` bounds concurrent connections per
 * venue host across every credential (MEXC allows 12 requests/s per key); `maxFreeSockets` keeps
 * one credential's burst warm for the next.
 */
const AGENT_OPTIONS = {
  keepAlive: true,
  timeout: 5_000,
  maxSockets: 64,
  maxFreeSockets: 16,
  scheduling: 'lifo',
} as const

/** The one client every relayed request goes out on. No `localAddress`: the host's route is the egress. */
export function createVenueHttpClient(): AxiosInstance {
  return axios.create({
    httpAgent: new http.Agent(AGENT_OPTIONS),
    httpsAgent: new https.Agent(AGENT_OPTIONS),
    validateStatus: () => true,
    // The bytes as the venue sent them: spot-gateway parses, as it did before the relay.
    responseType: 'arraybuffer',
    transformResponse: [(data) => data],
    // A body is relayed exactly as signed (Gate hashes the payload).
    transformRequest: [(data) => data],
  })
}

/**
 * Whether the request went out on a pooled connection (Node's `ClientRequest.reusedSocket`), so a
 * slow answer can be told apart: `false` paid TCP + TLS (+ DNS) before its round trip.
 */
function reusedSocket(request: unknown): boolean | undefined {
  const reused = (request as { reusedSocket?: unknown } | undefined)?.reusedSocket
  return typeof reused === 'boolean' ? reused : undefined
}

function failureKind(err: unknown): 'timeout' | 'network' {
  const code = isAxiosError(err) ? err.code : undefined
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT' ? 'timeout' : 'network'
}

function responseHeaders(raw: Record<string, unknown>): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  for (const [name, value] of Object.entries(raw)) {
    if (value == null) continue
    for (const v of Array.isArray(value) ? value : [value]) out.push({ name: name.toLowerCase(), value: String(v) })
  }
  return out
}

/**
 * Send one signed request, exactly once, and say what happened. Never retried here: a request
 * that went out and was not answered is spot-gateway's to call ambiguous (§ D-9).
 */
export async function relayHttp(client: AxiosInstance, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const started = performance.now()
  const venueMs = () => Math.round(performance.now() - started)
  try {
    const res = await client.request({
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers.map((h) => [h.name, h.value])),
      data: req.body.byteLength > 0 ? Buffer.from(req.body) : undefined,
      timeout: req.timeoutMs,
    })
    const reused = reusedSocket(res.request)
    return {
      status: res.status,
      headers: responseHeaders(res.headers as Record<string, unknown>),
      body: new Uint8Array(res.data as ArrayBuffer),
      venueMs: venueMs(),
      ...(reused === undefined ? {} : { reusedSocket: reused }),
    }
  } catch (err) {
    const reused = isAxiosError(err) ? reusedSocket(err.request) : undefined
    return {
      error: failureKind(err),
      venueMs: venueMs(),
      ...(reused === undefined ? {} : { reusedSocket: reused }),
    }
  }
}
