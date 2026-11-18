import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, call, DEV_SECRET } from './helpers'
import { getSyncBlob } from '../src/store'

function envelope(updatedAt: number, ciphertext = 'Y2lwaGVy', extra: Record<string, string> = {}) {
  return {
    schema: 1 as const,
    updatedAt,
    ciphertext,
    iv: 'aXY=',
    enc: 'aes-gcm-v1' as const,
    salt: 'c2FsdA==',
    ...extra,
  }
}

test('dev grant disabled → 404', async () => {
  const { env } = makeCtx({ ALLOW_DEV_GRANT: '0' })
  const res = await call(env, 'POST', '/v1/dev/grant', {
    body: { secret: DEV_SECRET },
  })
  assert.equal(res.status, 404)
})

test('dev grant enabled + secret → license; activate; push; pull; 409; size cap', async () => {
  const ctx = makeCtx({ ALLOW_DEV_GRANT: '1', SYNC_MAX_BYTES: '256' })

  const badSecret = await call(ctx.env, 'POST', '/v1/dev/grant', {
    body: { secret: 'nope' },
    headers: { 'Content-Type': 'application/json', 'X-Dev-Secret': 'nope' },
  })
  assert.equal(badSecret.status, 401)

  const grant = await call(ctx.env, 'POST', '/v1/dev/grant', {
    body: { secret: DEV_SECRET },
    headers: { 'Content-Type': 'application/json', 'X-Dev-Secret': DEV_SECRET },
  })
  assert.equal(grant.status, 200)
  const licenseKey = grant.json.licenseKey as string
  assert.match(licenseKey, /^ltw_/)

  const act = await call(ctx.env, 'POST', '/v1/license/activate', {
    body: { key: licenseKey, instance_name: 'device-a' },
  })
  assert.equal(act.status, 200)
  assert.ok(act.json.token)
  assert.ok(act.json.instanceId)
  const token = act.json.token as string

  const validate = await call(ctx.env, 'POST', '/v1/license/validate', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: {},
  })
  assert.equal(validate.status, 200)
  assert.equal(validate.json.active, true)

  const blob = envelope(1_000, 'Y2lwaGVyVGV4dA==')
  const pushed = await call(ctx.env, 'POST', '/v1/sync/push', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: blob,
  })
  assert.equal(pushed.status, 200)
  assert.equal(pushed.json.updatedAt, 1_000)

  const pulled = await call(ctx.env, 'POST', '/v1/sync/pull', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: {},
  })
  assert.equal(pulled.status, 200)
  assert.equal(pulled.json.empty, false)
  assert.equal(pulled.json.ciphertext, blob.ciphertext)
  assert.equal(pulled.json.iv, blob.iv)
  assert.equal(pulled.json.enc, 'aes-gcm-v1')
  assert.equal(pulled.json.updatedAt, 1_000)

  // stored value is the envelope, not plaintext
  const stored = await getSyncBlob(ctx.kv, licenseKey)
  assert.ok(stored)
  assert.equal(stored!.ciphertext, blob.ciphertext)

  const older = await call(ctx.env, 'POST', '/v1/sync/push', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: envelope(999, 'b2xkZXI='),
  })
  assert.equal(older.status, 409)
  assert.equal(older.json.ciphertext, blob.ciphertext)
  assert.equal(older.json.updatedAt, 1_000)

  const tooBig = 'A'.repeat(300)
  const huge = await call(ctx.env, 'POST', '/v1/sync/push', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: envelope(2_000, tooBig),
  })
  assert.equal(huge.status, 413)
})

test('activation cap is 5 unique instance names', async () => {
  const ctx = makeCtx({ ALLOW_DEV_GRANT: '1' })
  const grant = await call(ctx.env, 'POST', '/v1/dev/grant', {
    headers: { 'X-Dev-Secret': DEV_SECRET, 'Content-Type': 'application/json' },
    body: { secret: DEV_SECRET },
  })
  const key = grant.json.licenseKey as string
  for (let i = 0; i < 5; i++) {
    const res = await call(ctx.env, 'POST', '/v1/license/activate', {
      body: { key, instance_name: `dev-${i}` },
    })
    assert.equal(res.status, 200)
  }
  const sixth = await call(ctx.env, 'POST', '/v1/license/activate', {
    body: { key, instance_name: 'dev-5' },
  })
  assert.equal(sixth.status, 403)
  const reuse = await call(ctx.env, 'POST', '/v1/license/activate', {
    body: { key, instance_name: 'dev-0' },
  })
  assert.equal(reuse.status, 200)
})
