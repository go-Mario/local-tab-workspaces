import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FetchLike } from '../src/types'
import { makeCtx, call, paidCheckout } from './helpers'

const LEAK = 'upstream-secret-marker-do-not-echo'
const LICENSE_KEY = 'ABC123-XYZ456-XYZ456-XYZ456'

test('activate posts the official body and keeps the instance id', async () => {
  const captured = {
    url: '',
    method: '',
    apiKey: '',
    contentType: '',
    body: null as unknown,
  }
  const creemFetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    captured.url = url
    captured.method = (init?.method || 'GET').toUpperCase()
    captured.apiKey = headers.get('x-api-key') || ''
    captured.contentType = headers.get('content-type') || ''
    captured.body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.includes('/v1/licenses/activate')) {
      return new Response(
        JSON.stringify({
          id: 'lic_LICENSE_NOT_INSTANCE',
          object: 'license',
          mode: 'prod',
          product_id: 'prod_1sxcev5EyzFKkDzSRj3ZSs',
          status: 'active',
          key: LICENSE_KEY,
          activation: 1,
          activation_limit: 5,
          expires_at: '2026-12-01T00:00:00.000Z',
          created_at: '2026-11-18T00:00:00.000Z',
          instance: {
            id: 'linst_REAL_INSTANCE',
            object: 'license-instance',
            name: 'device-a',
            status: 'active',
            created_at: '2026-11-18T00:00:00.000Z',
          },
          private_note: LEAK,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ message: LEAK }), { status: 404 })
  }

  const { env } = makeCtx({ creemFetch })
  const res = await call(env, 'POST', '/v1/license/activate', {
    body: { key: LICENSE_KEY, instance_name: 'device-a' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.instanceId, 'linst_REAL_INSTANCE')
  assert.notEqual(res.json.instanceId, 'lic_LICENSE_NOT_INSTANCE')
  assert.equal(res.json.activation, 1)
  assert.equal(res.json.activationLimit, 5)
  assert.equal(typeof res.json.expiresAt, 'number')
  assert.equal(res.text.includes(LEAK), false)
  assert.equal(res.text.includes('test-creem-api-key'), false)
  const url = new URL(captured.url)
  assert.equal(url.pathname, '/v1/licenses/activate')
  assert.equal(captured.method, 'POST')
  assert.equal(captured.apiKey, 'test-creem-api-key')
  assert.equal(captured.contentType, 'application/json')
  assert.deepEqual(captured.body, { key: LICENSE_KEY, instance_name: 'device-a' })
})

test('activate upstream failures do not echo Creem bodies', async () => {
  const cases = [
    { upstream: 404, status: 404, error: 'unknown_key' },
    { upstream: 400, status: 400, error: 'activate_rejected' },
    { upstream: 401, status: 502, error: 'upstream_unavailable' },
    { upstream: 500, status: 502, error: 'upstream_unavailable' },
  ]
  for (const item of cases) {
    const creemFetch: FetchLike = async () =>
      new Response(JSON.stringify({ message: LEAK, key: LICENSE_KEY }), { status: item.upstream })
    const { env } = makeCtx({ creemFetch })
    const res = await call(env, 'POST', '/v1/license/activate', {
      body: { key: LICENSE_KEY, instance_name: 'device-a' },
    })
    assert.equal(res.status, item.status, String(item.upstream))
    assert.deepEqual(res.json, { ok: false, error: item.error }, String(item.upstream))
    assert.equal(res.text.includes(LEAK), false, String(item.upstream))
    assert.equal(res.text.includes(LICENSE_KEY), false, String(item.upstream))
  }
})

test('activate timeout is 504 JSON', async () => {
  const creemFetch: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) => {
      const fail = () => {
        const err = new Error(LEAK)
        err.name = 'TimeoutError'
        reject(err)
      }
      const signal = init?.signal
      if (!signal || signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
  const { env } = makeCtx({ creemFetch, creemTimeoutMs: 30 })
  const res = await call(env, 'POST', '/v1/license/activate', {
    body: { key: LICENSE_KEY, instance_name: 'device-a' },
  })
  assert.equal(res.status, 504)
  assert.deepEqual(res.json, { ok: false, error: 'upstream_timeout' })
  assert.equal(res.text.includes(LEAK), false)
})

test('a known Creem key still activates locally when activate is flaky', async () => {
  const ctx = makeCtx()
  ctx.creemStore.set(
    'checkout:ch_known',
    paidCheckout('ch_known', { license_keys: [{ key: LICENSE_KEY }] }),
  )
  const unlocked = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_known')
  assert.equal(unlocked.status, 200)
  ctx.env.creemFetch = async () => new Response(JSON.stringify({ message: LEAK }), { status: 503 })
  const res = await call(ctx.env, 'POST', '/v1/license/activate', {
    body: { key: LICENSE_KEY, instance_name: 'device-a' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(typeof res.json.instanceId, 'string')
  assert.match(String(res.json.instanceId), /^inst_/)
  assert.equal(res.text.includes(LEAK), false)
})
