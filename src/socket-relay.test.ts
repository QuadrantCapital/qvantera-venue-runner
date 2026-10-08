import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createSocketRelay } from './socket-relay.js'

const log = { info: () => undefined, warn: () => undefined }

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('socket relay (M-366)', () => {
  let venue: WebSocketServer
  let url: string
  let peers: WebSocket[]
  let fromGateway: Array<{ data: string; binary: boolean }>
  let frames: Array<{ socketId: string; data: string; binary: boolean }>
  let closed: Array<{ socketId: string; code: number; reason: string }>

  beforeEach(async () => {
    peers = []
    fromGateway = []
    frames = []
    closed = []
    venue = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    venue.on('connection', (ws) => {
      peers.push(ws)
      ws.on('message', (data, isBinary) => fromGateway.push({ data: data.toString(), binary: isBinary }))
    })
    await new Promise<void>((r) => venue.once('listening', () => r()))
    url = `ws://127.0.0.1:${(venue.address() as AddressInfo).port}/ws`
  })

  afterEach(async () => {
    for (const p of peers) p.terminate()
    await new Promise((r) => venue.close(r))
  })

  // The arrays this test's relay writes to, captured now: a socket of an earlier test that the
  // venue closes after it ended must not land in this one's.
  const relay = () => {
    const ownFrames = frames
    const ownClosed = closed
    return createSocketRelay({
      log,
      events: {
        frame: (socketId, data, binary) => ownFrames.push({ socketId, data: Buffer.from(data).toString(), binary }),
        closed: (socketId, code, reason) => ownClosed.push({ socketId, code, reason }),
      },
    })
  }

  it('opens, writes what spot-gateway sends and publishes what the venue sends, text and binary alike', async () => {
    const r = relay()
    expect(await r.open('s1', url)).toEqual({})
    expect(r.ids()).toEqual(['s1'])
    r.send('s1', Buffer.from('{"method":"SUBSCRIPTION"}'), false)
    await until(() => fromGateway.length === 1)
    expect(fromGateway[0]).toEqual({ data: '{"method":"SUBSCRIPTION"}', binary: false })

    peers[0]!.send('{"msg":"PONG"}')
    peers[0]!.send(Buffer.from([0x0a, 0x01]), { binary: true })
    await until(() => frames.length === 2)
    expect(frames[0]).toEqual({ socketId: 's1', data: '{"msg":"PONG"}', binary: false })
    expect(frames[1]).toMatchObject({ socketId: 's1', binary: true })
  })

  it("publishes the venue's close once, and forgets the socket", async () => {
    const r = relay()
    await r.open('s1', url)
    peers[0]!.close(4000, 'venue going away')
    await until(() => closed.length === 1)
    expect(closed).toEqual([{ socketId: 's1', code: 4000, reason: 'venue going away' }])
    expect(r.ids()).toEqual([])
  })

  it('answers a frame for a socket it does not hold with closed/unknown_socket — a restarted runner holds none', () => {
    const r = relay()
    r.send('gone', Buffer.from('x'), false)
    expect(closed).toEqual([{ socketId: 'gone', code: 4404, reason: 'unknown_socket' }])
  })

  it('says connect_failed for a venue that refuses, and holds nothing for it', async () => {
    const r = relay()
    const port = (venue.address() as AddressInfo).port
    await new Promise((res) => venue.close(res))
    expect(await r.open('s1', `ws://127.0.0.1:${port}/ws`)).toEqual({ error: 'connect_failed' })
    expect(r.ids()).toEqual([])
    expect(closed).toEqual([])
    venue = new WebSocketServer({ noServer: true })
  })

  it('on shutdown closes every socket and says so for each before the connection drains', async () => {
    const r = relay()
    await r.open('s1', url)
    await r.open('s2', url)
    r.closeAll('shutdown')
    expect(closed.map((c) => [c.socketId, c.reason]).sort()).toEqual([
      ['s1', 'shutdown'],
      ['s2', 'shutdown'],
    ])
    // The venue's own close handshake that follows publishes nothing more.
    await until(() => peers.every((p) => p.readyState === WebSocket.CLOSED))
    expect(closed).toHaveLength(2)
  })

  it('a close spot-gateway asked for is published once, as it asked', async () => {
    const r = relay()
    await r.open('s1', url)
    r.close('s1', 'stopped')
    await until(() => peers[0]!.readyState === WebSocket.CLOSED)
    expect(closed).toEqual([{ socketId: 's1', code: 1000, reason: 'stopped' }])
  })
})
