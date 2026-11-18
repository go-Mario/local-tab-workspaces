import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, call, DEV_SECRET } from './helpers'
import { getSyncBlob } from '../src/store'

const SECRET_URL = 'https://private.example/inbox?token=super-secret-tab'

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Worker-side check only. The extension cipher is covered by the extension tests. */
async function sealedEnvelope(plaintext: string, updatedAt: number) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return {
    schema: 1 as const,
    updatedAt,
    ciphertext: bytesToBase64(new Uint8Array(cipher)),
    iv: bytesToBase64(iv),
    enc: 'aes-gcm-v1' as const,
  }
}

test('worker never stores plaintext that includes a tab URL', async () => {
  const ctx = makeCtx({ ALLOW_DEV_GRANT: '1' })
  const grant = await call(ctx.env, 'POST', '/v1/dev/grant', {
    headers: { 'X-Dev-Secret': DEV_SECRET, 'Content-Type': 'application/json' },
    body: { secret: DEV_SECRET, instance_name: 'unit' },
  })
  assert.equal(grant.status, 200)
  const licenseKey = grant.json.licenseKey as string
  const token = grant.json.token as string

  const envelope = await sealedEnvelope(
    JSON.stringify({ tabs: [{ url: SECRET_URL, title: 'Inbox' }] }),
    42,
  )
  assert.equal(envelope.ciphertext.includes(SECRET_URL), false)
  const pushed = await call(ctx.env, 'POST', '/v1/sync/push', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: envelope,
  })
  assert.equal(pushed.status, 200)

  const stored = await getSyncBlob(ctx.kv, licenseKey)
  assert.ok(stored)
  const raw = JSON.stringify(stored)
  assert.equal(raw.includes(SECRET_URL), false)
  assert.equal(raw.includes('private.example'), false)
  assert.equal(raw.includes('super-secret-tab'), false)
  assert.equal(stored!.enc, 'aes-gcm-v1')
  assert.equal(stored!.ciphertext, envelope.ciphertext)
  for (const key of await ctx.kv.list()) {
    const value = await ctx.kv.get(key)
    if (!value) continue
    assert.equal(value.includes(SECRET_URL), false, `plaintext URL leaked in KV key ${key}`)
  }
})
