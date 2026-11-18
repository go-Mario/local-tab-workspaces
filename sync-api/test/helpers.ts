import { MemoryKV } from '../src/kv'
import { handleRequest } from '../src/worker'
import type { Env, FetchLike } from '../src/types'
import { hmacSha256Hex } from '../src/crypto-util'

export const PRODUCT_ID = 'prod_1sxcev5EyzFKkDzSRj3ZSs'
export const WEBHOOK_SECRET = 'test-webhook-secret'
export const DEV_SECRET = 'test-dev-secret'

export interface TestCtx {
  kv: MemoryKV
  env: Env
  creemStore: Map<string, unknown>
}

export function makeCtx(overrides: Partial<Env> = {}): TestCtx {
  const kv = (overrides.kv as MemoryKV) || new MemoryKV()
  const creemStore = new Map<string, unknown>()

  const creemFetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method || 'GET').toUpperCase()
    const u = new URL(url, 'https://api.creem.io')

    if (method === 'GET' && u.pathname === '/v1/checkouts') {
      const id = u.searchParams.get('checkout_id') || ''
      const checkout = creemStore.get(`checkout:${id}`)
      if (!checkout) return json(404, { error: 'not_found' })
      return json(200, checkout)
    }
    if (method === 'GET' && u.pathname.startsWith('/v1/checkouts/')) {
      const id = u.pathname.split('/').pop() || ''
      const checkout = creemStore.get(`checkout:${id}`)
      if (!checkout) return json(404, { error: 'not_found' })
      return json(200, checkout)
    }
    if (method === 'POST' && u.pathname === '/v1/licenses/activate') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const rec = creemStore.get(`license:${body.key}`) as
        | { key: string; activations?: number; activation_limit?: number }
        | undefined
      if (!rec) return json(404, { error: 'license_not_found' })
      rec.activations = (rec.activations ?? 0) + 1
      return json(200, {
        id: `inst_creem_${rec.activations}`,
        instance_id: `inst_creem_${rec.activations}`,
        activation: rec.activations,
        activation_limit: rec.activation_limit ?? 5,
        expires_at: null,
      })
    }
    return json(404, { error: 'unknown_creem_path', url })
  }

  const env: Env = {
    kv,
    CREEM_API_KEY: 'test-creem-api-key',
    CREEM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    CREEM_API_BASE: 'https://api.creem.io',
    CREEM_PRODUCT_ID: PRODUCT_ID,
    ALLOW_DEV_GRANT: '0',
    DEV_GRANT_SECRET: DEV_SECRET,
    SYNC_MAX_BYTES: '1048576',
    creemFetch,
    ...overrides,
  }

  return { kv, env, creemStore }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function call(
  env: Env,
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string }> {
  const headers = new Headers(opts.headers)
  let body: BodyInit | undefined
  if (opts.raw !== undefined) {
    body = opts.raw
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers.set('Content-Type', 'application/json')
  }
  const req = new Request(`http://127.0.0.1:8787${path}`, { method, headers, body })
  const res = await handleRequest(req, env)
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, json: parsed, text }
}

export async function signedWebhook(
  env: Env,
  payload: unknown,
  secret = WEBHOOK_SECRET,
  headerOverride?: string,
): Promise<{ status: number; json: any }> {
  const raw = JSON.stringify(payload)
  const sig = headerOverride ?? (await hmacSha256Hex(secret, raw))
  return call(env, 'POST', '/webhooks/creem', {
    raw,
    headers: { 'creem-signature': sig, 'Content-Type': 'application/json' },
  })
}

export function paidCheckout(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: 'checkout',
    status: 'completed',
    product: { id: PRODUCT_ID },
    order: { id: `ord_${id}` },
    license_keys: extra.license_keys ?? [],
    ...extra,
  }
}
