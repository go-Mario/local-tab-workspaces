import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, call, paidCheckout, PRODUCT_ID } from './helpers'

test('unlock: unpaid checkout rejected with 402', async () => {
  const ctx = makeCtx()
  ctx.creemStore.set(
    'checkout:ch_pending',
    paidCheckout('ch_pending', { status: 'pending' }),
  )
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_pending')
  assert.equal(res.status, 402)
  assert.equal(res.json.ok, false)
})

test('unlock: missing checkout_id → 400', async () => {
  const { env } = makeCtx()
  const res = await call(env, 'GET', '/v1/unlock')
  assert.equal(res.status, 400)
})

test('unlock: unknown checkout → 404', async () => {
  const { env } = makeCtx()
  const res = await call(env, 'GET', '/v1/unlock?checkout_id=ch_missing')
  assert.equal(res.status, 404)
})

test('unlock: completed checkout mints a stable ltw_ key when Creem has no license_keys', async () => {
  const ctx = makeCtx()
  ctx.creemStore.set('checkout:ch_ok', paidCheckout('ch_ok'))
  const a = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_ok')
  assert.equal(a.status, 200)
  assert.equal(a.json.ok, true)
  assert.equal(a.json.alreadyProvisioned, false)
  assert.match(a.json.licenseKey, /^ltw_/)
  const first = a.json.licenseKey as string

  const b = await call(ctx.env, 'POST', '/v1/unlock', { body: { checkout_id: 'ch_ok' } })
  assert.equal(b.status, 200)
  assert.equal(b.json.licenseKey, first)
  assert.equal(b.json.alreadyProvisioned, true)
})

test('unlock: uses Creem-issued license key when present', async () => {
  const ctx = makeCtx()
  ctx.creemStore.set(
    'checkout:ch_lic',
    paidCheckout('ch_lic', { license_keys: [{ key: 'CREEMKEY123' }] }),
  )
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_lic')
  assert.equal(res.status, 200)
  assert.equal(res.json.licenseKey, 'CREEMKEY123')
})

test('unlock: product mismatch → 400', async () => {
  const ctx = makeCtx()
  ctx.creemStore.set(
    'checkout:ch_other',
    paidCheckout('ch_other', { product: { id: 'prod_OTHER' } }),
  )
  const res = await call(ctx.env, 'GET', '/v1/unlock?checkout_id=ch_other')
  assert.equal(res.status, 400)
  void PRODUCT_ID
})
