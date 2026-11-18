import type { CreemLogError, CreemLogEvent, CreemLogOperation, ResolvedEnv } from './types'

export interface CreemCheckout {
  id?: string
  status?: string
  product?: unknown
  order?: unknown
  license_keys?: unknown
  object?: string
  [key: string]: unknown
}

/** Official LicenseInstanceEntity. `id` here is the instance, not the license. */
export interface CreemLicenseInstance {
  id?: string
  name?: string
  status?: string
}

/**
 * Official activate response is LicenseEntity.
 * `id` is the license id. The device id is `instance.id`.
 * `instance_id` / `instanceId` are accepted only as non-documented fallbacks.
 */
export interface CreemActivation {
  id?: string
  instance_id?: string
  instanceId?: string
  instance?: CreemLicenseInstance | CreemLicenseInstance[] | null
  activation?: number
  activation_limit?: number | null
  activationLimit?: number | null
  expires_at?: string | number | null
  expiresAt?: string | number | null
  [key: string]: unknown
}

export type CreemClientError =
  | 'creem_not_configured'
  | 'checkout_not_found'
  | 'invalid_checkout'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'unknown_key'
  | 'activate_rejected'

const MAX_CREEM_BODY_BYTES = 1_048_576

function extractProductId(product: unknown): string | undefined {
  if (typeof product === 'string' && product.trim()) return product.trim()
  if (product && typeof product === 'object') {
    const rec = product as Record<string, unknown>
    for (const key of ['id', 'product_id', 'productId']) {
      if (typeof rec[key] === 'string' && (rec[key] as string).trim()) {
        return (rec[key] as string).trim()
      }
    }
  }
  return undefined
}

function extractOrderId(order: unknown): string | undefined {
  if (typeof order === 'string' && order.trim()) return order.trim()
  if (order && typeof order === 'object') {
    const rec = order as Record<string, unknown>
    if (typeof rec.id === 'string' && rec.id.trim()) return rec.id.trim()
  }
  return undefined
}

export function extractLicenseKeys(source: unknown): string[] {
  const keys: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) keys.push(v.trim())
    else if (v && typeof v === 'object' && typeof (v as { key?: unknown }).key === 'string') {
      const k = ((v as { key: string }).key || '').trim()
      if (k) keys.push(k)
    }
  }
  if (Array.isArray(source)) {
    for (const item of source) push(item)
  } else {
    push(source)
  }
  return keys
}

export function checkoutProductId(checkout: CreemCheckout): string | undefined {
  return (
    extractProductId(checkout.product) ||
    extractProductId((checkout as { product_id?: unknown }).product_id)
  )
}

export function checkoutOrderId(checkout: CreemCheckout): string | undefined {
  return (
    extractOrderId(checkout.order) ||
    (typeof checkout.order_id === 'string' ? checkout.order_id : undefined)
  )
}

export function checkoutLicenseKeys(checkout: CreemCheckout): string[] {
  const fromRoot = extractLicenseKeys(checkout.license_keys)
  if (fromRoot.length) return fromRoot
  const order = checkout.order
  if (order && typeof order === 'object') {
    const fromOrder = extractLicenseKeys((order as { license_keys?: unknown }).license_keys)
    if (fromOrder.length) return fromOrder
  }
  // Documented deprecated shape: feature.license_key (and feature.license).
  const feature = (checkout as { feature?: unknown }).feature
  if (feature && typeof feature === 'object') {
    const rec = feature as { license_key?: unknown; license?: unknown }
    const fromFeature = extractLicenseKeys(rec.license_key ?? rec.license)
    if (fromFeature.length) return fromFeature
  }
  return []
}

export function isCheckoutPaid(status: string | undefined): boolean {
  const s = (status || '').toLowerCase()
  // Official CheckoutEntity status enum: pending | processing | completed | expired.
  // paid/success are accepted so an older payload still unlocks.
  return s === 'completed' || s === 'paid' || s === 'success'
}

export function productMatches(found: string | undefined, expected: string): boolean {
  if (!found) return false
  return found === expected
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('name' in err)) return false
  const name = (err as { name: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Read or cancel every Creem body before another subrequest starts.
 * Leaving a body open and fetching again makes Workers cancel the first
 * response outside the awaited promise ("stalled HTTP response was canceled
 * to prevent deadlock"), which surfaces as error 1101.
 * The text is only for a JSON success body. Callers must not put it in a
 * client response.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => undefined)
    return null
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf)
}

function isUnsafeHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function emitCreem(
  env: ResolvedEnv,
  operation: CreemLogOperation,
  error: CreemLogError,
  upstreamStatus?: number,
): void {
  const event: CreemLogEvent = { operation, error }
  if (
    typeof upstreamStatus === 'number' &&
    Number.isInteger(upstreamStatus) &&
    upstreamStatus >= 100 &&
    upstreamStatus <= 599
  ) {
    event.upstreamStatus = upstreamStatus
  }
  env.creemLog(event)
}

type CreemCallResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; error: CreemClientError }

async function creemRequest(
  env: ResolvedEnv,
  operation: CreemLogOperation,
  path: string,
  init: RequestInit,
): Promise<CreemCallResult> {
  const url = path.startsWith('http') ? path : `${env.creemApiBase}${path}`
  const headers = new Headers(init.headers)
  if (env.creemApiKey && isUnsafeHeaderValue(env.creemApiKey)) {
    emitCreem(env, operation, 'header_rejected')
    return { ok: false, status: 502, error: 'upstream_unavailable' }
  }
  try {
    if (env.creemApiKey) headers.set('x-api-key', env.creemApiKey)
  } catch {
    emitCreem(env, operation, 'header_rejected')
    return { ok: false, status: 502, error: 'upstream_unavailable' }
  }
  headers.set('Accept', 'application/json')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.creemTimeoutMs)
  try {
    const response = await env.creemFetch(url, { ...init, headers, signal: controller.signal })
    return { ok: true, response }
  } catch (err) {
    if (isAbortError(err) || controller.signal.aborted) {
      emitCreem(env, operation, 'timeout')
      return { ok: false, status: 504, error: 'upstream_timeout' }
    }
    emitCreem(env, operation, 'network')
    return { ok: false, status: 502, error: 'upstream_unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

function asCheckout(data: unknown): CreemCheckout | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const rec = data as Record<string, unknown>
  if (Array.isArray(rec.data)) {
    const first = rec.data[0]
    if (!first || typeof first !== 'object' || Array.isArray(first)) return null
    return first as CreemCheckout
  }
  if (rec.checkout && typeof rec.checkout === 'object' && !Array.isArray(rec.checkout)) {
    return rec.checkout as CreemCheckout
  }
  return rec as CreemCheckout
}

function classifyUpstream(
  status: number,
  kind: 'checkout' | 'activate',
): { status: number; error: CreemClientError; logError: CreemLogError } {
  if (status === 404) {
    return kind === 'checkout'
      ? { status: 404, error: 'checkout_not_found', logError: 'checkout_not_found' }
      : { status: 404, error: 'unknown_key', logError: 'unknown_key' }
  }
  if (status === 400 || status === 422) {
    return kind === 'checkout'
      ? { status: 400, error: 'invalid_checkout', logError: 'invalid_checkout' }
      : { status: 400, error: 'activate_rejected', logError: 'activate_rejected' }
  }
  if (status === 401) {
    return { status: 502, error: 'upstream_unavailable', logError: 'upstream_unauthorized' }
  }
  if (status === 403) {
    return { status: 502, error: 'upstream_unavailable', logError: 'upstream_forbidden' }
  }
  if (status === 408 || status === 504) {
    return { status: 504, error: 'upstream_timeout', logError: 'timeout' }
  }
  return { status: 502, error: 'upstream_unavailable', logError: 'upstream_status' }
}

/**
 * Retrieve a checkout.
 * Official contract: GET /v1/checkouts?checkout_id=… with header x-api-key.
 * https://docs.creem.io/api-reference/endpoint/get-checkout
 * There is no documented GET /v1/checkouts/{id}. A second request on 404 is
 * what left the first body unread and produced Worker error 1101.
 */
export async function retrieveCheckout(
  env: ResolvedEnv,
  checkoutId: string,
): Promise<{ checkout: CreemCheckout | null; status: number; error?: CreemClientError }> {
  if (!env.creemApiKey) {
    return { checkout: null, status: 500, error: 'creem_not_configured' }
  }

  const path = `/v1/checkouts?checkout_id=${encodeURIComponent(checkoutId)}`
  const called = await creemRequest(env, 'creem_checkout_retrieve', path, { method: 'GET' })
  if (!called.ok) return { checkout: null, status: called.status, error: called.error }

  const upstreamStatus = called.response.status
  // Status is classified even when the body is empty, non-JSON, or unreadable.
  const text = await readBodyCapped(called.response, MAX_CREEM_BODY_BYTES)
  if (upstreamStatus !== 200) {
    const failure = classifyUpstream(upstreamStatus, 'checkout')
    emitCreem(env, 'creem_checkout_retrieve', failure.logError, upstreamStatus)
    return { checkout: null, status: failure.status, error: failure.error }
  }
  if (text == null) {
    emitCreem(env, 'creem_checkout_retrieve', 'body_unreadable', upstreamStatus)
    return { checkout: null, status: 502, error: 'upstream_unavailable' }
  }

  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      emitCreem(env, 'creem_checkout_retrieve', 'bad_json', upstreamStatus)
      return { checkout: null, status: 502, error: 'upstream_unavailable' }
    }
  }
  const checkout = asCheckout(data)
  if (!checkout) {
    emitCreem(env, 'creem_checkout_retrieve', 'checkout_not_found', upstreamStatus)
    return { checkout: null, status: 404, error: 'checkout_not_found' }
  }
  return { checkout, status: 200 }
}

/**
 * Official contract: POST /v1/licenses/activate
 * body { key, instance_name }, header x-api-key.
 * https://docs.creem.io/api-reference/endpoint/activate-license
 * 200 body is LicenseEntity. Instance id is instance.id, not LicenseEntity.id.
 */
export async function activateCreemLicense(
  env: ResolvedEnv,
  key: string,
  instanceName: string,
): Promise<{ ok: true; data: CreemActivation } | { ok: false; status: number; error: CreemClientError }> {
  if (!env.creemApiKey) {
    return { ok: false, status: 500, error: 'creem_not_configured' }
  }
  const called = await creemRequest(env, 'creem_license_activate', '/v1/licenses/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, instance_name: instanceName }),
  })
  if (!called.ok) return { ok: false, status: called.status, error: called.error }

  const upstreamStatus = called.response.status
  const text = await readBodyCapped(called.response, MAX_CREEM_BODY_BYTES)
  if (!called.response.ok) {
    const failure = classifyUpstream(upstreamStatus, 'activate')
    emitCreem(env, 'creem_license_activate', failure.logError, upstreamStatus)
    return { ok: false, status: failure.status, error: failure.error }
  }
  if (text == null) {
    emitCreem(env, 'creem_license_activate', 'body_unreadable', upstreamStatus)
    return { ok: false, status: 502, error: 'upstream_unavailable' }
  }

  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    emitCreem(env, 'creem_license_activate', 'bad_json', upstreamStatus)
    return { ok: false, status: 502, error: 'upstream_unavailable' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    emitCreem(env, 'creem_license_activate', 'bad_json', upstreamStatus)
    return { ok: false, status: 502, error: 'upstream_unavailable' }
  }
  return { ok: true, data: data as CreemActivation }
}

export function pickInstanceId(
  data: CreemActivation,
  fallback: string,
  instanceName?: string,
): string {
  const raw = data.instance
  const list = (Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []).filter(
    (item): item is CreemLicenseInstance => !!item && typeof item === 'object',
  )
  const named = instanceName
    ? list.find((item) => typeof item.name === 'string' && item.name === instanceName)
    : undefined
  const chosen = named || list[0]
  if (chosen && typeof chosen.id === 'string' && chosen.id.trim()) return chosen.id.trim()
  // Do not use data.id. On LicenseEntity that field is the license id, so every
  // device would share one instance id.
  if (typeof data.instance_id === 'string' && data.instance_id.trim()) return data.instance_id.trim()
  if (typeof data.instanceId === 'string' && data.instanceId.trim()) return data.instanceId.trim()
  return fallback
}

export function pickExpiresAt(data: CreemActivation): number | null {
  const raw = data.expires_at ?? data.expiresAt ?? null
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return raw
  const ms = Date.parse(String(raw))
  return Number.isFinite(ms) ? ms : null
}
