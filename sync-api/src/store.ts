import { mintLicenseKey, randomToken, sha256Hex } from './crypto-util'
import {
  DEFAULT_ACTIVATION_LIMIT,
  type CheckoutRecord,
  type KV,
  type LicenseInstance,
  type LicenseRecord,
  type SyncEnvelope,
  type TokenRecord,
} from './types'

export const keys = {
  checkout: (id: string) => `checkout:${id}`,
  license: (key: string) => `license:${key}`,
  token: (hash: string) => `token:${hash}`,
  sync: (licenseKey: string) => `sync:${licenseKey}`,
  event: (id: string) => `event:${id}`,
}

export async function readJson<T>(kv: KV, key: string): Promise<T | null> {
  const raw = await kv.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function writeJson(kv: KV, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value))
}

export async function getLicense(kv: KV, key: string): Promise<LicenseRecord | null> {
  return readJson<LicenseRecord>(kv, keys.license(key))
}

export async function putLicense(kv: KV, rec: LicenseRecord): Promise<void> {
  await writeJson(kv, keys.license(rec.key), rec)
}

export async function getCheckout(kv: KV, checkoutId: string): Promise<CheckoutRecord | null> {
  return readJson<CheckoutRecord>(kv, keys.checkout(checkoutId))
}

export async function putCheckout(kv: KV, rec: CheckoutRecord): Promise<void> {
  await writeJson(kv, keys.checkout(rec.checkoutId), rec)
}

export async function getToken(kv: KV, tokenHash: string): Promise<TokenRecord | null> {
  return readJson<TokenRecord>(kv, keys.token(tokenHash))
}

export async function putToken(kv: KV, rec: TokenRecord): Promise<void> {
  await writeJson(kv, keys.token(rec.tokenHash), rec)
}

export async function deleteToken(kv: KV, tokenHash: string): Promise<void> {
  await kv.delete(keys.token(tokenHash))
}

export async function getSyncBlob(kv: KV, licenseKey: string): Promise<SyncEnvelope | null> {
  return readJson<SyncEnvelope>(kv, keys.sync(licenseKey))
}

export async function putSyncBlob(kv: KV, licenseKey: string, blob: SyncEnvelope): Promise<void> {
  await writeJson(kv, keys.sync(licenseKey), blob)
}

export async function findLicenseByInstanceId(
  kv: KV,
  instanceId: string,
): Promise<{ license: LicenseRecord; instance: LicenseInstance } | null> {
  const licenseKeys = await kv.list('license:')
  for (const k of licenseKeys) {
    const rec = await readJson<LicenseRecord>(kv, k)
    if (!rec) continue
    const inst = rec.instances.find((i) => i.instanceId === instanceId)
    if (inst) return { license: rec, instance: inst }
  }
  return null
}

export function newLicenseRecord(partial: {
  key: string
  source: LicenseRecord['source']
  checkoutId?: string
  orderId?: string
  productId?: string
  activationLimit?: number
  creemKey?: boolean
}): LicenseRecord {
  return {
    key: partial.key,
    source: partial.source,
    checkoutId: partial.checkoutId,
    orderId: partial.orderId,
    productId: partial.productId,
    createdAt: Date.now(),
    activationLimit: partial.activationLimit ?? DEFAULT_ACTIVATION_LIMIT,
    instances: [],
    expiresAt: null,
    revoked: false,
    creemKey: partial.creemKey,
  }
}

/**
 * Provision a stable license for a completed checkout (idempotent).
 * Prefers a Creem-issued key; otherwise mints `ltw_…` and reuses it on retry.
 */
export async function provisionCheckoutLicense(
  kv: KV,
  args: {
    checkoutId: string
    orderId?: string
    productId?: string
    status: string
    creemLicenseKey?: string
  },
): Promise<{ record: CheckoutRecord; alreadyProvisioned: boolean; license: LicenseRecord }> {
  const existing = await getCheckout(kv, args.checkoutId)
  if (existing?.licenseKey) {
    let license = await getLicense(kv, existing.licenseKey)
    if (!license) {
      license = newLicenseRecord({
        key: existing.licenseKey,
        source: existing.source,
        checkoutId: existing.checkoutId,
        orderId: existing.orderId,
        productId: existing.productId,
        creemKey: existing.source === 'creem',
      })
      await putLicense(kv, license)
    }
    return { record: existing, alreadyProvisioned: true, license }
  }

  const source: CheckoutRecord['source'] = args.creemLicenseKey ? 'creem' : 'minted'
  const licenseKey = args.creemLicenseKey || mintLicenseKey()
  const record: CheckoutRecord = {
    checkoutId: args.checkoutId,
    orderId: args.orderId,
    productId: args.productId,
    status: args.status,
    licenseKey,
    source,
    createdAt: Date.now(),
  }
  const license = newLicenseRecord({
    key: licenseKey,
    source,
    checkoutId: args.checkoutId,
    orderId: args.orderId,
    productId: args.productId,
    creemKey: source === 'creem',
  })
  await putLicense(kv, license)
  await putCheckout(kv, record)
  return { record, alreadyProvisioned: false, license }
}

export async function issueSessionToken(
  kv: KV,
  license: LicenseRecord,
  instance: LicenseInstance,
): Promise<string> {
  if (instance.tokenHash) {
    await deleteToken(kv, instance.tokenHash)
  }
  const token = randomToken('tok', 32)
  const tokenHash = await sha256Hex(token)
  instance.tokenHash = tokenHash
  const rec: TokenRecord = {
    tokenHash,
    licenseKey: license.key,
    instanceId: instance.instanceId,
    instanceName: instance.instanceName,
    createdAt: Date.now(),
  }
  await putToken(kv, rec)
  await putLicense(kv, license)
  return token
}

export function newInstanceId(): string {
  return randomToken('inst', 16)
}
