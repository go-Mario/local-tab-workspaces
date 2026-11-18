import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, signedWebhook, paidCheckout, call } from './helpers'
import { getCheckout } from '../src/store'

test('webhook: missing signature → 401', async () => {
  const { env } = makeCtx()
  const res = await call(env, 'POST', '/webhooks/creem', {
    body: { eventType: 'checkout.completed' },
  })
  assert.equal(res.status, 401)
})

test('webhook: bad signature → 401', async () => {
  const { env } = makeCtx()
  const res = await signedWebhook(env, { eventType: 'checkout.completed' }, 'wrong-secret')
  assert.equal(res.status, 401)
})

test('webhook: secret not configured → 500', async () => {
  const { env } = makeCtx({ CREEM_WEBHOOK_SECRET: '' })
  const res = await call(env, 'POST', '/webhooks/creem', {
    body: { eventType: 'checkout.completed' },
    headers: { 'creem-signature': '00' },
  })
  assert.equal(res.status, 500)
})

test('webhook: valid checkout.completed records license and is idempotent', async () => {
  const { env, kv } = makeCtx()
  const payload = {
    id: 'evt_1',
    eventType: 'checkout.completed',
    object: paidCheckout('ch_abc', {
      license_keys: [{ key: 'creem_lic_abc' }],
    }),
  }
  const a = await signedWebhook(env, payload)
  assert.equal(a.status, 200)
  assert.equal(a.json.ok, true)
  const rec = await getCheckout(kv, 'ch_abc')
  assert.ok(rec)
  assert.equal(rec!.licenseKey, 'creem_lic_abc')

  const b = await signedWebhook(env, payload)
  assert.equal(b.status, 200)
  assert.equal(b.json.idempotent, true)
  const rec2 = await getCheckout(kv, 'ch_abc')
  assert.equal(rec2!.licenseKey, 'creem_lic_abc')
})

test('webhook: event_type alias also accepted', async () => {
  const { env, kv } = makeCtx()
  const payload = {
    id: 'evt_2',
    event_type: 'checkout.completed',
    object: paidCheckout('ch_def'),
  }
  const res = await signedWebhook(env, payload)
  assert.equal(res.status, 200)
  const rec = await getCheckout(kv, 'ch_def')
  assert.ok(rec)
  assert.match(rec!.licenseKey, /^ltw_/)
})
