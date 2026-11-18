import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureClassOf, failureReasonOf, publicDiag } from '../src/diag'
import type { ResolvedEnv } from '../src/types'
import { makeCtx, call, paidCheckout } from './helpers'

const LEAK_URL = 'https://api.creem.io/v1/checkouts?checkout_id=ch_secret&token=sekret-token'
const LEAK_BITS = ['ch_secret', 'sekret-token', 'sekret', 'evil.example', 'test-api.creem.io', 'https://']

function envWith(base: string, unlockDiag: boolean): ResolvedEnv {
  return {
    creemApiBase: base,
    unlockDiag,
  } as ResolvedEnv
}

function assertClosed(text: string): void {
  for (const bit of LEAK_BITS) assert.equal(text.includes(bit), false, bit)
}

test('failure reason uses only a fixed prefix and drops the rest of the message', () => {
  const cases: Array<{ name: string; err: unknown; klass: string; reason: string }> = [
    {
      name: 'connection',
      err: new Error(`Network connection lost. ${LEAK_URL}`),
      klass: 'error',
      reason: 'connection',
    },
    {
      name: 'dns',
      err: new Error(`DNS lookup failed: evil.example token=sekret-token ${LEAK_URL}`),
      klass: 'error',
      reason: 'dns',
    },
    {
      name: 'tls',
      err: new Error(`TLS handshake failed: ${LEAK_URL}`),
      klass: 'error',
      reason: 'tls',
    },
    {
      name: 'cert',
      err: new Error(`CERTIFICATE_VERIFY_FAILED ${LEAK_URL}`),
      klass: 'error',
      reason: 'tls',
    },
    {
      name: 'invalid url',
      err: new TypeError(`Invalid URL: ${LEAK_URL}`),
      klass: 'type_error',
      reason: 'config',
    },
    {
      name: 'cache',
      err: new TypeError(`Unsupported cache mode: reload ${LEAK_URL}`),
      klass: 'type_error',
      reason: 'config',
    },
    {
      name: 'opaque',
      err: new Error(`internal error; reference = abc ${LEAK_URL}`),
      klass: 'error',
      reason: 'unknown',
    },
    {
      name: 'dom',
      err: new DOMException(`token=sekret-token ${LEAK_URL}`, 'NotSupportedError'),
      klass: 'dom_exception',
      reason: 'unknown',
    },
    {
      name: 'other',
      err: Object.assign(new Error(LEAK_URL), { name: 'CustomBoom' }),
      klass: 'other',
      reason: 'unknown',
    },
  ]
  for (const item of cases) {
    assert.equal(failureClassOf(item.err), item.klass, item.name)
    assert.equal(failureReasonOf(item.err), item.reason, item.name)
    const body: Record<string, unknown> = {
      ok: false,
      error: 'upstream_unavailable',
      ...publicDiag(envWith('https://api.creem.io', true), {
        failureClass: failureClassOf(item.err),
        failureReason: failureReasonOf(item.err),
        baseIsExpected: true,
      }),
    }
    const text = JSON.stringify(body)
    assertClosed(text)
    assert.equal(body.failureClass, item.klass, item.name)
    assert.equal(body.failureReason, item.reason, item.name)
  }
})

test('diag off keeps the original upstream_unavailable object', async () => {
  const ctx = makeCtx({
    creemFetch: async () => {
      throw new TypeError(`Invalid URL: ${LEAK_URL}`)
    },
  })
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent')
  assert.equal(res.status, 502)
  assert.deepEqual(res.json, { ok: false, error: 'upstream_unavailable' })
  assertClosed(res.text)
})

test('diag on reports class, reason, and base flag without the exception text', async () => {
  const ctx = makeCtx({
    UNLOCK_DIAG: '1',
    creemFetch: async () => {
      throw new Error(`Network connection lost. ${LEAK_URL}`)
    },
  })
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent')
  assert.equal(res.status, 502)
  assert.deepEqual(res.json, {
    ok: false,
    error: 'upstream_unavailable',
    baseIsExpected: true,
    failureClass: 'error',
    failureReason: 'connection',
  })
  assertClosed(res.text)
})

test('a wrong API base is a boolean and is not echoed', async () => {
  const ctx = makeCtx({
    UNLOCK_DIAG: '1',
    CREEM_API_BASE: 'https://test-api.creem.io',
    creemFetch: async () => {
      throw new Error(`internal error; reference = zz ${LEAK_URL}`)
    },
  })
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent')
  assert.equal(res.json.baseIsExpected, false)
  assert.equal(res.json.failureClass, 'error')
  assert.equal(res.json.failureReason, 'unknown')
  assertClosed(res.text)
})

test('control-character key is config and does not echo the key', async () => {
  let called = false
  const ctx = makeCtx({
    UNLOCK_DIAG: '1',
    CREEM_API_KEY: 'test-key\nsekret-token',
    creemFetch: async () => {
      called = true
      return new Response('{}', { status: 200 })
    },
  })
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_ok')
  assert.equal(called, false)
  assert.equal(res.status, 502)
  assert.deepEqual(res.json, {
    ok: false,
    error: 'upstream_unavailable',
    baseIsExpected: true,
    failureClass: 'other',
    failureReason: 'config',
  })
  assert.equal(res.text.includes('test-key'), false)
  assertClosed(res.text)
})

test('diag on does not change a normal 404, 402, or paid unlock', async () => {
  const missing = makeCtx({ UNLOCK_DIAG: '1' })
  const missingRes = await call(missing.env, 'GET', '/v1/unlock?checkout_id=ch_missing')
  assert.equal(missingRes.status, 404)
  assert.deepEqual(missingRes.json, { ok: false, error: 'checkout_not_found' })

  const unpaid = makeCtx({ UNLOCK_DIAG: '1' })
  unpaid.creemStore.set('checkout:ch_pending', paidCheckout('ch_pending', { status: 'pending' }))
  const unpaidRes = await call(unpaid.env, 'GET', '/v1/unlock?checkout_id=ch_pending')
  assert.equal(unpaidRes.status, 402)
  assert.equal(unpaidRes.json.error, 'checkout_unpaid')
  assert.equal('failureClass' in unpaidRes.json, false)

  const paid = makeCtx({ UNLOCK_DIAG: '1' })
  paid.creemStore.set('checkout:ch_ok', paidCheckout('ch_ok'))
  const paidRes = await call(paid.env, 'GET', '/v1/unlock?checkout_id=ch_ok')
  assert.equal(paidRes.status, 200)
  assert.equal(paidRes.json.ok, true)
  assert.match(paidRes.json.licenseKey, /^ltw_/)
  assert.equal('failureClass' in paidRes.json, false)
  assert.equal('baseIsExpected' in paidRes.json, false)
})

test('an HTTP 401 with diag on reports only the base flag', async () => {
  const ctx = makeCtx({
    UNLOCK_DIAG: '1',
    creemFetch: async () =>
      new Response(JSON.stringify({ message: LEAK_URL, token: 'sekret-token' }), { status: 401 }),
  })
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent')
  assert.equal(res.status, 502)
  assert.deepEqual(res.json, {
    ok: false,
    error: 'upstream_unavailable',
    baseIsExpected: true,
  })
  assertClosed(res.text)
})
