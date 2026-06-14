// Tiny zero-dependency topic pub/sub relay for AR Vision's brain + terminal split.
//
//   Brain app (phone)  --POST /pub/render-->  [relay]  --SSE /sub/render-->  Glasses terminal (.ehpk)
//   Glasses terminal   --POST /pub/input -->  [relay]  --SSE /sub/input -->  Brain app
//
// The brain drives the glasses (render commands down) and reacts to glasses input
// (events up). Generic topics, so the same relay carries both directions.
//
// Run:  node relay/server.mjs   (or: npm run relay)   — default port 8787, override with RELAY_PORT.

import { createServer } from 'node:http'

const PORT = Number(process.env.RELAY_PORT) || 8787

/** topic -> Set<ServerResponse> */
const subscribers = new Map()
/** topic -> last payload string (only for topics published with ?retain=1) */
const retained = new Map()

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function subsFor(topic) {
  let set = subscribers.get(topic)
  if (!set) subscribers.set(topic, (set = new Set()))
  return set
}

function broadcast(topic, json) {
  const frame = `data: ${json}\n\n`
  for (const res of subsFor(topic)) res.write(frame)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const parts = url.pathname.split('/').filter(Boolean) // ['sub','render'] etc.

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  // Subscribe: GET /sub/:topic  (Server-Sent Events)
  if (req.method === 'GET' && parts[0] === 'sub' && parts[1]) {
    const topic = parts[1]
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n') // reconnect after 2s if dropped
    const last = retained.get(topic)
    if (last) res.write(`data: ${last}\n\n`)
    subsFor(topic).add(res)
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(keepAlive)
      subsFor(topic).delete(res)
    })
    return
  }

  // Publish: POST /pub/:topic[?retain=1]
  if (req.method === 'POST' && parts[0] === 'pub' && parts[1]) {
    const topic = parts[1]
    const retain = url.searchParams.get('retain') === '1'
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 2_000_000) req.destroy() // basic guard
    })
    req.on('end', () => {
      try {
        JSON.parse(body) // validate
        if (retain) retained.set(topic, body)
        broadcast(topic, body)
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      } catch {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"invalid JSON"}')
      }
    })
    return
  }

  // Health check.
  if (req.method === 'GET' && url.pathname === '/') {
    const counts = Object.fromEntries([...subscribers].map(([t, s]) => [t, s.size]))
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, subscribers: counts }))
    return
  }

  res.writeHead(404, CORS)
  res.end()
})

server.listen(PORT, () => {
  console.log(`AR Vision relay listening on http://0.0.0.0:${PORT}`)
  console.log(`  brain    -> POST /pub/render   glasses -> GET /sub/render`)
  console.log(`  glasses  -> POST /pub/input    brain   -> GET /sub/input`)
})
