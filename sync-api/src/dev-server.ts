/**
 * Local Node server wrapping the Module Worker.
 * Listens on http://127.0.0.1:8787 with FileKV + ALLOW_DEV_GRANT=1.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileKV } from './kv'
import { handleRequest } from './worker'
import type { Env } from './types'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const dataFile = path.resolve(rootDir, '../.data/kv.json')
const host = '127.0.0.1'
const port = Number(process.env.PORT || 8787)

const kv = new FileKV(dataFile)

const env: Env = {
  kv,
  CREEM_API_KEY: process.env.CREEM_API_KEY || '',
  CREEM_WEBHOOK_SECRET: process.env.CREEM_WEBHOOK_SECRET || '',
  CREEM_API_BASE: process.env.CREEM_API_BASE || 'https://api.creem.io',
  CREEM_PRODUCT_ID: process.env.CREEM_PRODUCT_ID || 'prod_1sxcev5EyzFKkDzSRj3ZSs',
  ALLOW_DEV_GRANT: process.env.ALLOW_DEV_GRANT ?? '1',
  DEV_GRANT_SECRET: process.env.DEV_GRANT_SECRET || 'dev-grant-local',
  SYNC_MAX_BYTES: process.env.SYNC_MAX_BYTES || '1048576',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
}

function incomingToRequest(req: IncomingMessage, raw: Buffer): Request {
  const url = new URL(req.url || '/', `http://${host}:${port}`)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v)
    else if (Array.isArray(v)) headers.set(k, v.join(', '))
  }
  const method = req.method || 'GET'
  const init: RequestInit = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = new Uint8Array(raw)
  }
  return new Request(url, init)
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(response.status, headers)
  const buf = Buffer.from(await response.arrayBuffer())
  res.end(buf)
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    const request = incomingToRequest(req, raw)
    void handleRequest(request, env)
      .then((response) => writeResponse(res, response))
      .catch((err) => {
        console.error('[dev-server]', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
      })
  })
})

server.listen(port, host, () => {
  const grantSecret = env.DEV_GRANT_SECRET
  console.log(`Local Tab Workspaces sync API (dev) listening on http://${host}:${port}`)
  console.log(`KV file: ${dataFile}`)
  console.log(`ALLOW_DEV_GRANT=${env.ALLOW_DEV_GRANT}`)
  console.log('')
  console.log('Grant a test license:')
  console.log(
    `  curl -sS -X POST http://${host}:${port}/v1/dev/grant -H 'Content-Type: application/json' -H 'X-Dev-Secret: ${grantSecret}' -d '{"instance_name":"dev-a"}'`,
  )
  console.log('')
  console.log('Health:')
  console.log(`  curl -sS http://${host}:${port}/health`)
})
