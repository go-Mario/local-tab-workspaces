import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index'
import { pickInstanceId } from '../src/creem'
import type { CreemLogEvent, Env, FetchLike } from '../src/types'
import { makeCtx, call, paidCheckout, signedWebhook } from './helpers'

const LEAK = 'upstream-secret-marker-do-not-echo'

test('unknown checkout is one documented GET, body consumed, safe 404', async () => {
  const rejections: string[] = []
  const onRejection = (err: unknown) => {
    rejections.push(err instanceof Error ? err.message : String(err))
  }
  process.on('unhandledRejection', onRejection)
  const seen: Response[] = []
  const calls: string[] = []
  const creemFetch: FetchLike = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const previous = seen[seen.length - 1]
    if (previous && !previous.bodyUsed) {
      Promise.reject(new Error('A stalled HTTP response was canceled to prevent deadlock'))
    }
    const res = new Response(JSON.stringify({ message: LEAK, error: 'no_such_checkout' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
    seen.push(res)
    return res
  }
  try {
    const { env } = makeCtx({ creemFetch })
    const res = await call(env, 'GET', '/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(res.status, 404)
    assert.deepEqual(res.json, { ok: false, error: 'checkout_not_found' })
    assert.equal(res.text.includes(LEAK), false)
    assert.equal(calls.length, 1)
    const url = new URL(calls[0]!)
    assert.equal(url.pathname, '/v1/checkouts')
    assert.equal(url.searchParams.get('checkout_id'), 'ch_ltw_verify_probe_nonexistent')
    assert.equal(seen[0]!.bodyUsed, true)
    assert.deepEqual(rejections, [])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('upstream 500, 401, HTML 200, and network errors stay JSON and do not echo the body', async () => {
  const cases: Array<{ name: string; status: number; impl: FetchLike; expectStatus: number; expectError: string }> = [
    {
      name: '500',
      status: 500,
      expectStatus: 502,
      expectError: 'upstream_unavailable',
      impl: async () =>
        new Response(JSON.stringify({ message: LEAK, stack: 'secret' }), { status: 500 }),
    },
    {
      name: '401',
      status: 401,
      expectStatus: 502,
      expectError: 'upstream_unavailable',
      impl: async () => new Response(JSON.stringify({ message: LEAK, api_key: 'sk_test' }), { status: 401 }),
    },
    {
      name: 'html 200',
      status: 200,
      expectStatus: 502,
      expectError: 'upstream_unavailable',
      impl: async () => new Response(`<html>${LEAK}</html>`, { status: 200 }),
    },
    {
      name: 'network',
      status: 0,
      expectStatus: 502,
      expectError: 'upstream_unavailable',
      impl: async () => {
        throw new Error(`connect ${LEAK}`)
      },
    },
  ]
  for (const item of cases) {
    const { env } = makeCtx({ creemFetch: item.impl })
    const res = await call(env, 'GET', '/v1/unlock?checkout_id=ch_upstream')
    assert.equal(res.status, item.expectStatus, item.name)
    assert.equal(res.json.error, item.expectError, item.name)
    assert.equal(res.text.includes(LEAK), false, item.name)
    assert.equal(JSON.stringify(res.json).includes('sk_test'), false, item.name)
  }
})

test('Creem timeout returns 504 without hanging or echoing', async () => {
  const creemFetch: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal
      const fail = () => {
        const err = new Error(`timed out ${LEAK}`)
        err.name = 'AbortError'
        reject(err)
      }
      if (!signal) {
        fail()
        return
      }
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
  const { env } = makeCtx({ creemFetch, creemTimeoutMs: 30 })
  const started = Date.now()
  const res = await call(env, 'GET', '/v1/unlock?checkout_id=ch_slow')
  assert.equal(res.status, 504)
  assert.deepEqual(res.json, { ok: false, error: 'upstream_timeout' })
  assert.equal(res.text.includes(LEAK), false)
  assert.ok(Date.now() - started < 2_000)
})

test('official unpaid statuses are 402 and do not reflect customer fields', async () => {
  for (const status of ['pending', 'processing', 'expired']) {
    const ctx = makeCtx()
    ctx.creemStore.set(
      `checkout:ch_${status}`,
      paidCheckout(`ch_${status}`, {
        status,
        customer: { email: 'buyer@example.com' },
        metadata: { note: LEAK },
      }),
    )
    const res = await call(ctx.env, 'GET', `/v1/unlock?checkout_id=ch_${status}`)
    assert.equal(res.status, 402, status)
    assert.equal(res.json.error, 'checkout_unpaid')
    assert.equal(res.json.status, status)
    assert.equal(res.text.includes('buyer@example.com'), false)
    assert.equal(res.text.includes(LEAK), false)
    assert.equal('licenseKey' in res.json, false)
  }
})

test('empty list payload is not treated as an unpaid checkout', async () => {
  const creemFetch: FetchLike = async () =>
    new Response(JSON.stringify({ data: [], message: LEAK }), { status: 200 })
  const { env } = makeCtx({ creemFetch })
  const res = await call(env, 'GET', '/v1/unlock?checkout_id=ch_empty')
  assert.equal(res.status, 404)
  assert.equal(res.json.error, 'checkout_not_found')
  assert.equal(res.text.includes(LEAK), false)
})

test('missing Creem key does not call upstream', async () => {
  let called = false
  const creemFetch: FetchLike = async () => {
    called = true
    return new Response('{}', { status: 200 })
  }
  const { env } = makeCtx({ CREEM_API_KEY: '', creemFetch })
  const res = await call(env, 'GET', '/v1/unlock?checkout_id=ch_ok')
  assert.equal(res.status, 500)
  assert.equal(res.json.error, 'creem_not_configured')
  assert.equal(called, false)
})

test('invalid checkout id is rejected before any Creem call', async () => {
  let called = false
  const creemFetch: FetchLike = async () => {
    called = true
    return new Response('{}', { status: 200 })
  }
  const { env } = makeCtx({ creemFetch })
  const res = await call(env, 'GET', '/v1/unlock?checkout_id=' + encodeURIComponent('ch_bad id'))
  assert.equal(res.status, 400)
  assert.equal(res.json.error, 'invalid_checkout')
  assert.equal(called, false)
})

test('webhook-provisioned checkout still unlocks when Creem returns 404', async () => {
  const ctx = makeCtx()
  const payload = {
    id: 'evt_local',
    eventType: 'checkout.completed',
    object: paidCheckout('ch_local_only', { license_keys: [{ key: 'CREEM-LOCAL-KEY' }] }),
  }
  const hooked = await signedWebhook(ctx.env, payload)
  assert.equal(hooked.status, 200)
  const creemFetch: FetchLike = async () =>
    new Response(JSON.stringify({ message: LEAK }), { status: 404 })
  ctx.env.creemFetch = creemFetch
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_local_only')
  assert.equal(res.status, 200)
  assert.equal(res.json.licenseKey, 'CREEM-LOCAL-KEY')
  assert.equal(res.json.alreadyProvisioned, true)
  assert.equal(res.text.includes(LEAK), false)
})

test('deprecated feature.license_key is used when license_keys is empty', async () => {
  const ctx = makeCtx()
  ctx.creemStore.set(
    'checkout:ch_feature',
    paidCheckout('ch_feature', {
      license_keys: [],
      feature: { license_key: { key: 'FEATURE-KEY-123' } },
    }),
  )
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_feature')
  assert.equal(res.status, 200)
  assert.equal(res.json.licenseKey, 'FEATURE-KEY-123')
})

test('worker entry returns JSON when KV is missing', async () => {
  const res = await worker.fetch(
    new Request('http://127.0.0.1:8787/v1/unlock?checkout_id=ch_missing'),
    {} as Env,
  )
  assert.equal(res.status, 500)
  const body = (await res.json()) as { ok: boolean; error: string }
  assert.deepEqual(body, { ok: false, error: 'internal_error' })
})

test('pickInstanceId uses LicenseInstanceEntity.id, not the license id', () => {
  const official = {
    id: 'lic_LICENSE_NOT_INSTANCE',
    key: 'ABC123-XYZ456-XYZ456-XYZ456',
    activation: 1,
    activation_limit: 5,
    instance: {
      id: 'linst_REAL_INSTANCE',
      name: 'device-a',
      status: 'active',
    },
  }
  assert.equal(pickInstanceId(official, 'fallback', 'device-a'), 'linst_REAL_INSTANCE')
  assert.equal(pickInstanceId({ id: 'lic_only' }, 'fallback', 'device-a'), 'fallback')
  assert.equal(pickInstanceId({ instance_id: 'legacy_inst' }, 'fallback'), 'legacy_inst')
})

const PROBE_ID = 'ch_ltw_verify_probe_nonexistent'
const LOG_KEYS = new Set(['operation', 'error', 'upstreamStatus'])

function watch(env: Env): CreemLogEvent[] {
  const events: CreemLogEvent[] = []
  env.creemLog = (event) => {
    events.push(event)
  }
  return events
}

function assertSafeLog(events: CreemLogEvent[], secretBits: string[]): void {
  assert.equal(events.length, 1)
  const event = events[0]!
  for (const key of Object.keys(event)) {
    assert.equal(LOG_KEYS.has(key), true, key)
  }
  const encoded = JSON.stringify(event)
  for (const bit of secretBits) {
    assert.equal(encoded.includes(bit), false, bit)
  }
  assert.equal(event.operation, 'creem_checkout_retrieve')
}

test('non-JSON 404 and an unreadable 404 stay checkout_not_found', async () => {
  const plain = makeCtx({
    creemFetch: async () => new Response('plain-not-found ' + LEAK, { status: 404 }),
  })
  const plainLogs = watch(plain.env)
  const plainRes = await call(plain.env, 'GET', `/v1/unlock?checkout_id=${PROBE_ID}`)
  assert.equal(plainRes.status, 404)
  assert.deepEqual(plainRes.json, { ok: false, error: 'checkout_not_found' })
  assert.equal(plainRes.text.includes(LEAK), false)
  assertSafeLog(plainLogs, [PROBE_ID, LEAK, 'plain-not-found'])
  assert.equal(plainLogs[0]!.error, 'checkout_not_found')
  assert.equal(plainLogs[0]!.upstreamStatus, 404)

  const broken = new ReadableStream({
    pull(controller) {
      controller.error(new Error(LEAK))
    },
  })
  const unread = makeCtx({
    creemFetch: async () => new Response(broken, { status: 404 }),
  })
  const unreadLogs = watch(unread.env)
  const unreadRes = await call(unread.env, 'GET', `/v1/unlock?checkout_id=${PROBE_ID}`)
  assert.equal(unreadRes.status, 404)
  assert.equal(unreadRes.json.error, 'checkout_not_found')
  assert.equal(unreadRes.text.includes(LEAK), false)
  assertSafeLog(unreadLogs, [PROBE_ID, LEAK])
  assert.equal(unreadLogs[0]!.upstreamStatus, 404)
})

test('non-JSON 400 stays invalid_checkout', async () => {
  const ctx = makeCtx({
    creemFetch: async () =>
      new Response('<html>validation ' + LEAK + '</html>', {
        status: 400,
        headers: { 'content-type': 'text/html' },
      }),
  })
  const logs = watch(ctx.env)
  const res = await call(ctx.env, 'GET', `/v1/unlock?checkout_id=${PROBE_ID}`)
  assert.equal(res.status, 400)
  assert.deepEqual(res.json, { ok: false, error: 'invalid_checkout' })
  assert.equal(res.text.includes(LEAK), false)
  assertSafeLog(logs, [PROBE_ID, LEAK, 'validation'])
  assert.equal(logs[0]!.error, 'invalid_checkout')
  assert.equal(logs[0]!.upstreamStatus, 400)
})

test('401 and 403 stay 502 and are logged as distinct categories', async () => {
  const cases = [
    { status: 401, error: 'upstream_unauthorized' },
    { status: 403, error: 'upstream_forbidden' },
    { status: 500, error: 'upstream_status' },
  ]
  for (const item of cases) {
    const ctx = makeCtx({
      creemFetch: async () =>
        new Response(JSON.stringify({ message: LEAK, checkout_id: PROBE_ID, token: 'tok_secret' }), {
          status: item.status,
        }),
    })
    const logs = watch(ctx.env)
    const res = await call(ctx.env, 'GET', `/v1/unlock?checkout_id=${PROBE_ID}`)
    assert.equal(res.status, 502, String(item.status))
    assert.deepEqual(res.json, { ok: false, error: 'upstream_unavailable' }, String(item.status))
    assert.equal(res.text.includes(LEAK), false)
    assert.equal(res.text.includes('tok_secret'), false)
    assertSafeLog(logs, [PROBE_ID, LEAK, 'tok_secret'])
    assert.equal(logs[0]!.error, item.error, String(item.status))
    assert.equal(logs[0]!.upstreamStatus, item.status)
  }
})

test('a control character in the API key is header_rejected and does not call Creem', async () => {
  let called = false
  const ctx = makeCtx({
    CREEM_API_KEY: 'test-key\n',
    creemFetch: async () => {
      called = true
      return new Response('{}', { status: 200 })
    },
  })
  const logs = watch(ctx.env)
  const res = await call(ctx.env, 'GET', `/v1/unlock?checkout_id=${PROBE_ID}`)
  assert.equal(res.status, 502)
  assert.equal(res.json.error, 'upstream_unavailable')
  assert.equal(called, false)
  assertSafeLog(logs, [PROBE_ID, 'test-key'])
  assert.equal(logs[0]!.error, 'header_rejected')
  assert.equal('upstreamStatus' in logs[0]!, false)
})

test('network and timeout logs omit upstreamStatus', async () => {
  const network = makeCtx({
    creemFetch: async () => {
      throw new Error('connect ' + LEAK)
    },
  })
  const networkLogs = watch(network.env)
  const networkRes = await call(network.env, 'GET', `/v1/unlock?checkout_id=${PROBE_ID}`)
  assert.equal(networkRes.status, 502)
  assert.equal(networkRes.json.error, 'upstream_unavailable')
  assertSafeLog(networkLogs, [PROBE_ID, LEAK])
  assert.equal(networkLogs[0]!.error, 'network')
  assert.equal('upstreamStatus' in networkLogs[0]!, false)

  const timeout = makeCtx({
    creemTimeoutMs: 30,
    creemFetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error(LEAK)
          err.name = 'AbortError'
          reject(err)
        }
        const signal = init?.signal
        if (!signal || signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      }),
  })
  const timeoutLogs = watch(timeout.env)
  const timeoutRes = await call(timeout.env, 'GET', `/v1/unlock?checkout_id=${PROBE_ID}`)
  assert.equal(timeoutRes.status, 504)
  assert.equal(timeoutRes.json.error, 'upstream_timeout')
  assertSafeLog(timeoutLogs, [PROBE_ID, LEAK])
  assert.equal(timeoutLogs[0]!.error, 'timeout')
  assert.equal('upstreamStatus' in timeoutLogs[0]!, false)
})
