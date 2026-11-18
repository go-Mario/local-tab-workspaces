import {
  hmacSha256Hex,
  looksLikeCreemLicenseKey,
  mintLicenseKey,
  sha256Hex,
  timingSafeEqualHex,
  timingSafeEqualString,
} from './crypto-util'
import {
  activateCreemLicense,
  checkoutLicenseKeys,
  checkoutOrderId,
  checkoutProductId,
  isCheckoutPaid,
  pickExpiresAt,
  pickInstanceId,
  productMatches,
  retrieveCheckout,
} from './creem'
import { jsonResponse, preflightResponse } from './cors'
import { resolveEnv } from './env'
import {
  getCheckout,
  getLicense,
  getSyncBlob,
  getToken,
  issueSessionToken,
  newInstanceId,
  newLicenseRecord,
  provisionCheckoutLicense,
  putLicense,
  putSyncBlob,
  keys,
  writeJson,
} from './store'
import {
  API_VERSION,
  type Env,
  type ResolvedEnv,
  type SyncEnvelope,
} from './types'

function originOf(request: Request): string | null {
  return request.headers.get('Origin')
}

function jsonOf(request: Request): Promise<unknown> {
  return request.json().catch(() => null)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

const CLIENT_ERRORS = new Set([
  'missing_checkout_id',
  'invalid_checkout',
  'checkout_not_found',
  'checkout_unpaid',
  'product_mismatch',
  'creem_not_configured',
  'upstream_unavailable',
  'upstream_timeout',
  'unknown_key',
  'activate_rejected',
  'internal_error',
])

function clientError(error: string | undefined, fallback: string): string {
  return error && CLIENT_ERRORS.has(error) ? error : fallback
}

const CHECKOUT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const KNOWN_CHECKOUT_STATUS = new Set([
  'pending',
  'processing',
  'completed',
  'expired',
  'paid',
  'success',
])

function publicCheckoutStatus(status: string): string {
  return KNOWN_CHECKOUT_STATUS.has(status) ? status : 'unknown'
}

async function readBearerOrBodyToken(request: Request, body: Record<string, unknown> | null): Promise<string> {
  const auth = request.headers.get('Authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (m) return m[1]!.trim()
  return str(body?.token)
}

interface AuthOk {
  ok: true
  licenseKey: string
  instanceId: string
}

interface AuthErr {
  ok: false
  status: number
  error: string
}

async function authorize(
  request: Request,
  env: ResolvedEnv,
  body: Record<string, unknown> | null,
): Promise<AuthOk | AuthErr> {
  const token = await readBearerOrBodyToken(request, body)
  if (token) {
    const hash = await sha256Hex(token)
    const rec = await getToken(env.kv, hash)
    if (!rec) return { ok: false, status: 401, error: 'invalid_token' }
    const license = await getLicense(env.kv, rec.licenseKey)
    if (!license || license.revoked) return { ok: false, status: 401, error: 'license_inactive' }
    if (license.expiresAt && license.expiresAt < Date.now()) {
      return { ok: false, status: 401, error: 'license_expired' }
    }
    const inst = license.instances.find((i) => i.instanceId === rec.instanceId)
    if (!inst) return { ok: false, status: 401, error: 'instance_inactive' }
    return { ok: true, licenseKey: rec.licenseKey, instanceId: rec.instanceId }
  }

  const licenseKey =
    str(request.headers.get('X-License-Key')) || str(body?.key) || str(body?.licenseKey)
  const instanceId =
    str(request.headers.get('X-Instance-Id')) ||
    str(body?.instance_id) ||
    str(body?.instanceId)
  if (!licenseKey || !instanceId) {
    return { ok: false, status: 401, error: 'missing_credentials' }
  }
  const license = await getLicense(env.kv, licenseKey)
  if (!license || license.revoked) return { ok: false, status: 401, error: 'license_inactive' }
  if (license.expiresAt && license.expiresAt < Date.now()) {
    return { ok: false, status: 401, error: 'license_expired' }
  }
  const inst = license.instances.find((i) => i.instanceId === instanceId)
  if (!inst) return { ok: false, status: 401, error: 'instance_inactive' }
  return { ok: true, licenseKey, instanceId }
}

async function handleWebhook(request: Request, env: ResolvedEnv, origin: string | null): Promise<Response> {
  if (!env.creemWebhookSecret) {
    return jsonResponse(
      { ok: false, error: 'webhook_secret_not_configured' },
      500,
      origin,
      env,
    )
  }

  const raw = await request.text()
  const signature = request.headers.get('creem-signature') || request.headers.get('Creem-Signature') || ''
  if (!signature) {
    return jsonResponse({ ok: false, error: 'missing_signature' }, 401, origin, env)
  }
  const expected = await hmacSha256Hex(env.creemWebhookSecret, raw)
  // Header may be a bare hex digest (Creem docs).
  const provided = signature.trim().replace(/^sha256=/i, '')
  if (!timingSafeEqualHex(expected, provided)) {
    return jsonResponse({ ok: false, error: 'invalid_signature' }, 401, origin, env)
  }

  let payload: unknown
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400, origin, env)
  }

  const rec = asRecord(payload) || {}
  const eventType = str(rec.eventType || rec.event_type || rec.type)
  const eventId = str(rec.id || rec.event_id)
  const object = asRecord(rec.object) || rec

  if (eventId) {
    const seen = await env.kv.get(keys.event(eventId))
    if (seen) {
      return jsonResponse({ ok: true, idempotent: true }, 200, origin, env)
    }
  }

  if (eventType === 'checkout.completed' || eventType === 'checkout_completed') {
    const obj = asRecord(object) || {}
    const status = str(obj.status) || 'completed'
    const checkoutId = str(obj.id || obj.checkout_id || obj.checkoutId)
    if (checkoutId && isCheckoutPaid(status)) {
      const productId = checkoutProductId(obj) || str(obj.product_id)
      if (!productId || productMatches(productId, env.creemProductId)) {
        const creemKeys = checkoutLicenseKeys(obj)
        await provisionCheckoutLicense(env.kv, {
          checkoutId,
          orderId: checkoutOrderId(obj),
          productId: productId || env.creemProductId,
          status,
          creemLicenseKey: creemKeys[0],
        })
      }
    }
  }

  if (eventId) {
    await writeJson(env.kv, keys.event(eventId), { receivedAt: Date.now(), eventType })
  }

  return jsonResponse({ ok: true }, 200, origin, env)
}

async function handleUnlock(request: Request, env: ResolvedEnv, origin: string | null): Promise<Response> {
  let checkoutId = ''
  if (request.method === 'GET') {
    checkoutId = new URL(request.url).searchParams.get('checkout_id') || ''
  } else {
    const body = asRecord(await jsonOf(request))
    checkoutId = str(body?.checkout_id || body?.checkoutId)
  }
  checkoutId = checkoutId.trim()
  if (!checkoutId) {
    return jsonResponse({ ok: false, error: 'missing_checkout_id' }, 400, origin, env)
  }
  if (!CHECKOUT_ID_RE.test(checkoutId)) {
    return jsonResponse({ ok: false, error: 'invalid_checkout' }, 400, origin, env)
  }

  const retrieved = await retrieveCheckout(env, checkoutId)
  if (retrieved.status === 404 || (retrieved.status >= 400 && !retrieved.checkout)) {
    // Fallback: already provisioned via webhook.
    const local = await getCheckout(env.kv, checkoutId)
    if (local?.licenseKey) {
      return jsonResponse(
        {
          ok: true,
          licenseKey: local.licenseKey,
          status: publicCheckoutStatus(local.status),
          alreadyProvisioned: true,
        },
        200,
        origin,
        env,
      )
    }
    const status = [400, 404, 500, 502, 504].includes(retrieved.status) ? retrieved.status : 502
    const fallback =
      status === 404
        ? 'checkout_not_found'
        : status === 504
          ? 'upstream_timeout'
          : status === 400
            ? 'invalid_checkout'
            : status === 500
              ? 'creem_not_configured'
              : 'upstream_unavailable'
    return jsonResponse(
      { ok: false, error: clientError(retrieved.error, fallback) },
      status,
      origin,
      env,
    )
  }

  const checkout = retrieved.checkout
  if (!checkout) {
    return jsonResponse({ ok: false, error: 'checkout_not_found' }, 404, origin, env)
  }

  const status = str(checkout.status)
  const productId = checkoutProductId(checkout)
  if (!isCheckoutPaid(status)) {
    return jsonResponse(
      { ok: false, error: 'checkout_unpaid', status: publicCheckoutStatus(status) },
      402,
      origin,
      env,
    )
  }
  if (!productMatches(productId, env.creemProductId)) {
    return jsonResponse({ ok: false, error: 'product_mismatch' }, 400, origin, env)
  }

  const creemKeys = checkoutLicenseKeys(checkout)
  const result = await provisionCheckoutLicense(env.kv, {
    checkoutId: str(checkout.id) || checkoutId,
    orderId: checkoutOrderId(checkout),
    productId: productId || env.creemProductId,
    status,
    creemLicenseKey: creemKeys[0],
  })

  return jsonResponse(
    {
      ok: true,
      licenseKey: result.record.licenseKey,
      status: publicCheckoutStatus(status),
      alreadyProvisioned: result.alreadyProvisioned,
    },
    200,
    origin,
    env,
  )
}

async function handleActivate(request: Request, env: ResolvedEnv, origin: string | null): Promise<Response> {
  const body = asRecord(await jsonOf(request))
  const key = str(body?.key || body?.licenseKey)
  const instanceName = str(body?.instance_name || body?.instanceName) || 'device'
  if (!key) {
    return jsonResponse({ ok: false, error: 'missing_key' }, 400, origin, env)
  }

  let license = await getLicense(env.kv, key)

  const tryCreem =
    looksLikeCreemLicenseKey(key) && Boolean(env.creemApiKey) && (!license || license.creemKey || license.source === 'creem')

  if (tryCreem && !license) {
    // Unknown Creem-looking key: try official activate first.
    const creem = await activateCreemLicense(env, key, instanceName)
    if (!creem.ok) {
      const status = [400, 404, 500, 502, 504].includes(creem.status) ? creem.status : 502
      return jsonResponse(
        { ok: false, error: clientError(creem.error, 'upstream_unavailable') },
        status,
        origin,
        env,
      )
    }
    license = newLicenseRecord({
      key,
      source: 'creem',
      creemKey: true,
      activationLimit:
        creem.data.activation_limit ?? creem.data.activationLimit ?? undefined,
    })
    const instanceId = pickInstanceId(creem.data, newInstanceId(), instanceName)
    const inst = {
      instanceId,
      instanceName,
      createdAt: Date.now(),
    }
    license.instances.push(inst)
    license.expiresAt = pickExpiresAt(creem.data)
    const token = await issueSessionToken(env.kv, license, inst)
    return jsonResponse(
      {
        ok: true,
        instanceId,
        activation: creem.data.activation ?? license.instances.length,
        activationLimit: license.activationLimit,
        expiresAt: license.expiresAt ?? null,
        token,
      },
      200,
      origin,
      env,
    )
  }

  if (!license) {
    return jsonResponse({ ok: false, error: 'unknown_key' }, 404, origin, env)
  }
  if (license.revoked) {
    return jsonResponse({ ok: false, error: 'license_revoked' }, 401, origin, env)
  }
  if (license.expiresAt && license.expiresAt < Date.now()) {
    return jsonResponse({ ok: false, error: 'license_expired' }, 401, origin, env)
  }

  // Known Creem key + API configured: also tell Creem, then reuse/create instance.
  if (tryCreem && license) {
    const creem = await activateCreemLicense(env, key, instanceName)
    if (creem.ok) {
      let inst = license.instances.find((i) => i.instanceName === instanceName)
      const instanceId = pickInstanceId(creem.data, inst?.instanceId || newInstanceId(), instanceName)
      if (inst) {
        inst.instanceId = instanceId
      } else {
        if (license.instances.length >= license.activationLimit) {
          return jsonResponse({ ok: false, error: 'activation_limit' }, 403, origin, env)
        }
        inst = { instanceId, instanceName, createdAt: Date.now() }
        license.instances.push(inst)
      }
      license.expiresAt = pickExpiresAt(creem.data) ?? license.expiresAt
      const token = await issueSessionToken(env.kv, license, inst)
      return jsonResponse(
        {
          ok: true,
          instanceId,
          activation: creem.data.activation ?? license.instances.length,
          activationLimit: license.activationLimit,
          expiresAt: license.expiresAt ?? null,
          token,
        },
        200,
        origin,
        env,
      )
    }
    // If Creem activate failed but we have a KV copy (e.g. webhook recorded the key
    // and activate API is flaky), fall through to KV activate.
  }

  let inst = license.instances.find((i) => i.instanceName === instanceName)
  if (!inst) {
    if (license.instances.length >= license.activationLimit) {
      return jsonResponse({ ok: false, error: 'activation_limit' }, 403, origin, env)
    }
    inst = {
      instanceId: newInstanceId(),
      instanceName,
      createdAt: Date.now(),
    }
    license.instances.push(inst)
  }
  const token = await issueSessionToken(env.kv, license, inst)
  return jsonResponse(
    {
      ok: true,
      instanceId: inst.instanceId,
      activation: license.instances.length,
      activationLimit: license.activationLimit,
      expiresAt: license.expiresAt ?? null,
      token,
    },
    200,
    origin,
    env,
  )
}

async function handleValidate(request: Request, env: ResolvedEnv, origin: string | null): Promise<Response> {
  const body = asRecord(await jsonOf(request))
  const auth = await authorize(request, env, body)
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: auth.error, active: false }, auth.status, origin, env)
  }
  const license = await getLicense(env.kv, auth.licenseKey)
  return jsonResponse(
    {
      ok: true,
      active: true,
      instanceId: auth.instanceId,
      activationLimit: license?.activationLimit ?? 5,
      expiresAt: license?.expiresAt ?? null,
    },
    200,
    origin,
    env,
  )
}

function asEnvelope(body: Record<string, unknown> | null): SyncEnvelope | null {
  if (!body) return null
  const schema = body.schema
  const updatedAt = body.updatedAt
  const ciphertext = body.ciphertext
  const iv = body.iv
  const enc = body.enc
  if (schema !== 1) return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  if (typeof ciphertext !== 'string' || typeof iv !== 'string') return null
  if (enc !== 'aes-gcm-v1') return null
  const envelope: SyncEnvelope = {
    schema: 1,
    updatedAt,
    ciphertext,
    iv,
    enc: 'aes-gcm-v1',
  }
  if (typeof body.salt === 'string') envelope.salt = body.salt
  return envelope
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

async function handlePush(request: Request, env: ResolvedEnv, origin: string | null): Promise<Response> {
  const raw = await request.text()
  if (utf8Bytes(raw) > env.syncMaxBytes) {
    return jsonResponse({ ok: false, error: 'payload_too_large' }, 413, origin, env)
  }
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400, origin, env)
  }
  const body = asRecord(parsed)
  const auth = await authorize(request, env, body)
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: auth.error }, auth.status, origin, env)
  }
  const envelope = asEnvelope(body)
  if (!envelope) {
    return jsonResponse({ ok: false, error: 'invalid_envelope' }, 400, origin, env)
  }
  if (utf8Bytes(envelope.ciphertext) > env.syncMaxBytes) {
    return jsonResponse({ ok: false, error: 'payload_too_large' }, 413, origin, env)
  }

  const existing = await getSyncBlob(env.kv, auth.licenseKey)
  if (existing && existing.updatedAt > envelope.updatedAt) {
    return jsonResponse(
      {
        ok: false,
        error: 'conflict',
        ...existing,
      },
      409,
      origin,
      env,
    )
  }

  // Store ciphertext envelope only — never decrypt.
  await putSyncBlob(env.kv, auth.licenseKey, envelope)
  return jsonResponse({ ok: true, updatedAt: envelope.updatedAt }, 200, origin, env)
}

async function handlePull(request: Request, env: ResolvedEnv, origin: string | null): Promise<Response> {
  let body: Record<string, unknown> | null = null
  if (request.method === 'POST') {
    body = asRecord(await jsonOf(request))
  }
  const auth = await authorize(request, env, body)
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: auth.error }, auth.status, origin, env)
  }
  const blob = await getSyncBlob(env.kv, auth.licenseKey)
  if (!blob) {
    return jsonResponse({ ok: true, empty: true }, 200, origin, env)
  }
  return jsonResponse({ ok: true, empty: false, ...blob }, 200, origin, env)
}

async function handleDevGrant(request: Request, env: ResolvedEnv, origin: string | null): Promise<Response> {
  if (!env.allowDevGrant) {
    return jsonResponse({ ok: false, error: 'not_found' }, 404, origin, env)
  }
  if (!env.devGrantSecret) {
    return jsonResponse({ ok: false, error: 'dev_grant_secret_not_configured' }, 500, origin, env)
  }
  const body = asRecord(await jsonOf(request))
  const provided =
    str(request.headers.get('X-Dev-Secret')) ||
    str(body?.secret) ||
    str(body?.dev_secret)
  if (!provided || !timingSafeEqualString(provided, env.devGrantSecret)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401, origin, env)
  }

  const instanceName = str(body?.instance_name || body?.instanceName)
  const preActivate = Boolean(instanceName) || body?.preActivate === true || body?.pre_activate === true
  const license = newLicenseRecord({
    key: mintLicenseKey(),
    source: 'dev',
  })
  let token: string | undefined
  let instanceId: string | undefined
  if (preActivate) {
    const name = instanceName || 'dev-device'
    const inst = {
      instanceId: newInstanceId(),
      instanceName: name,
      createdAt: Date.now(),
    }
    license.instances.push(inst)
    token = await issueSessionToken(env.kv, license, inst)
    instanceId = inst.instanceId
  } else {
    await putLicense(env.kv, license)
  }

  return jsonResponse(
    {
      ok: true,
      licenseKey: license.key,
      instanceId: instanceId ?? null,
      token: token ?? null,
    },
    200,
    origin,
    env,
  )
}

function internalErrorResponse(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  let resolved: ResolvedEnv
  try {
    resolved = resolveEnv(env)
  } catch {
    return internalErrorResponse()
  }
  const origin = originOf(request)
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return internalErrorResponse()
  }
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (request.method === 'OPTIONS') {
    return preflightResponse(origin, resolved)
  }

  try {
    if (path === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true, version: API_VERSION }, 200, origin, resolved)
    }
    if (path === '/webhooks/creem' && request.method === 'POST') {
      return await handleWebhook(request, resolved, origin)
    }
    if (path === '/v1/unlock' && (request.method === 'GET' || request.method === 'POST')) {
      return await handleUnlock(request, resolved, origin)
    }
    if (path === '/v1/license/activate' && request.method === 'POST') {
      return await handleActivate(request, resolved, origin)
    }
    if (path === '/v1/license/validate' && request.method === 'POST') {
      return await handleValidate(request, resolved, origin)
    }
    if (path === '/v1/sync/push' && request.method === 'POST') {
      return await handlePush(request, resolved, origin)
    }
    if (path === '/v1/sync/pull' && (request.method === 'POST' || request.method === 'GET')) {
      return await handlePull(request, resolved, origin)
    }
    if (path === '/v1/dev/grant' && request.method === 'POST') {
      return await handleDevGrant(request, resolved, origin)
    }

    return jsonResponse({ ok: false, error: 'not_found' }, 404, origin, resolved)
  } catch {
    // Never copy err.message into the body. Fetch failures can embed upstream text.
    try {
      return jsonResponse({ ok: false, error: 'internal_error' }, 500, origin, resolved)
    } catch {
      return internalErrorResponse()
    }
  }
}
