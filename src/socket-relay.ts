import WebSocket from 'ws'

/** How long a venue has to accept a socket before the open is answered `connect_failed`. */
export const OPEN_TIMEOUT_MS = 15_000

export type SocketEvents = {
  frame(socketId: string, data: Uint8Array, binary: boolean): void
  closed(socketId: string, code: number, reason: string): void
}

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }

function bytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data)
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}

/**
 * The venue sockets this runner holds, by the id spot-gateway gave each (M-366). The runner only
 * moves bytes: a frame from the venue is published as it arrived, a frame from spot-gateway is
 * written as it arrived — the venue's protocol (logins, subscriptions, pings) is spot-gateway's.
 *
 * Every way a socket ends publishes `closed` once: the venue's close, a network error, a close
 * spot-gateway asked for, the runner shutting down. A frame for an id it does not hold — a socket
 * that already ended, or one a restarted runner never had — is answered `closed`/`unknown_socket`,
 * so spot-gateway's stream reconnects rather than writing into nothing.
 */
export function createSocketRelay(opts: {
  events: SocketEvents
  log: Log
  connect?: (url: string) => WebSocket
}) {
  const sockets = new Map<string, WebSocket>()
  const connect = opts.connect ?? ((url: string) => new WebSocket(url))

  const ended = (socketId: string, ws: WebSocket, code: number, reason: string) => {
    // Already ended (closeAll published it), or replaced: nothing more to say about this one.
    if (sockets.get(socketId) !== ws) return
    sockets.delete(socketId)
    opts.events.closed(socketId, code, reason)
  }

  return {
    /** Resolves once the venue accepted the socket, or with why it did not. Never rejects. */
    open(socketId: string, url: string): Promise<{ error?: string }> {
      if (sockets.has(socketId)) return Promise.resolve({ error: 'connect_failed' })
      let ws: WebSocket
      try {
        ws = connect(url)
      } catch (err) {
        opts.log.warn({ host: hostOf(url), err: String(err) }, 'runner ws connect failed')
        return Promise.resolve({ error: 'connect_failed' })
      }
      sockets.set(socketId, ws)
      return new Promise((resolve) => {
        let settled = false
        const settle = (result: { error?: string }) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }
        const timer = setTimeout(() => {
          opts.log.warn({ host: hostOf(url) }, 'runner ws open timed out')
          sockets.delete(socketId)
          ws.terminate()
          settle({ error: 'connect_failed' })
        }, OPEN_TIMEOUT_MS)
        timer.unref?.()
        ws.on('open', () => settle({}))
        ws.on('message', (data, isBinary) => opts.events.frame(socketId, bytes(data), isBinary))
        ws.on('close', (code, reason) => {
          if (!settled) {
            sockets.delete(socketId)
            settle({ error: 'connect_failed' })
            return
          }
          ended(socketId, ws, code, reason.toString())
        })
        ws.on('error', (err) => {
          // The host only: a MEXC private URL carries its listen key.
          opts.log.warn({ host: hostOf(url), err: String(err) }, 'runner ws error')
          // `close` follows an error; it reports the end.
        })
      })
    },

    send(socketId: string, data: Uint8Array, binary: boolean): void {
      const ws = sockets.get(socketId)
      if (!ws) {
        opts.events.closed(socketId, 4404, 'unknown_socket')
        return
      }
      ws.send(Buffer.from(data), { binary }, (err) => {
        if (err) opts.log.warn({ err: String(err) }, 'runner ws send failed')
      })
    },

    close(socketId: string, reason: string): void {
      const ws = sockets.get(socketId)
      if (!ws) return
      sockets.delete(socketId)
      ws.close(1000)
      opts.events.closed(socketId, 1000, reason || 'closed')
    },

    /** Shutdown: every socket ends and says so before the connection drains. */
    closeAll(reason: string): void {
      for (const [socketId, ws] of [...sockets]) {
        sockets.delete(socketId)
        ws.close(1001)
        opts.events.closed(socketId, 1001, reason)
      }
    },

    ids(): string[] {
      return [...sockets.keys()]
    },
  }
}

export type SocketRelay = ReturnType<typeof createSocketRelay>

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}
