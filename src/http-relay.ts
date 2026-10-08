import http from 'node:http'
import https from 'node:https'
import axios, { type AxiosInstance, isAxiosError } from 'axios'
import type { WireMessageByType, WirePayloadByType } from '@quadrantcapital/wire'
import { laneSocketOptions } from './lanes.js'

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

/**
 * The client one lane's requests go out on (M-367): its own keep-alive pool, every connection bound
 * to the lane's address. `''` is the host's default route. A pooled connection never changes lanes,
 * so the venue sees each lane's requests from that lane's address and nowhere else.
 */
export function createVenueHttpClient(localAddress = ''): AxiosInstance {
  const options = { ...AGENT_OPTIONS, ...laneSocketOptions(localAddress) }
  return axios.create({
    httpAgent: new http.Agent(options),
    httpsAgent: new https.Agent(options),
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

/**
 * Failures that happen before a connection exists: no name for the lane's address family, the
 * address not bindable, no route, the venue refusing the connection. Nothing reached the venue.
 */
const NEVER_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED'])

/**
 * `lane_failed` only for a fresh connection that never opened (M-367): spot-gateway refuses such a
 * request as unsent and stops using the lane. Anything on a pooled connection, or after the
 * connection opened, may have reached the venue and is `timeout` or `network` as before (§ D-9).
 */
function failureKind(err: unknown, reused: boolean | undefined): 'timeout' | 'network' | 'lane_failed' {
  const code = isAxiosError(err) ? err.code : undefined
  const errno = isAxiosError(err) ? (err.cause as NodeJS.ErrnoException | undefined)?.code : undefined
  if (reused !== true && ((code && NEVER_CONNECTED.has(code)) || (errno && NEVER_CONNECTED.has(errno)))) {
    return 'lane_failed'
  }
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
      error: failureKind(err, reused),
      venueMs: venueMs(),
      ...(reused === undefined ? {} : { reusedSocket: reused }),
    }
  }
}
