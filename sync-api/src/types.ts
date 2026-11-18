/** Shared types for the Local Tab Workspaces sync API. */

export interface KV {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
}

/** Minimal Cloudflare KV-shaped binding. */
export interface CloudflareKVBinding {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list?(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/** Fixed categories for Creem diagnostics. Never put request data in `error`. */
export type CreemLogError =
  | 'checkout_not_found'
  | 'invalid_checkout'
  | 'upstream_unauthorized'
  | 'upstream_forbidden'
  | 'upstream_status'
  | 'bad_json'
  | 'body_unreadable'
  | 'timeout'
  | 'network'
  | 'header_rejected'
  | 'unknown_key'
  | 'activate_rejected'

export type CreemLogOperation = 'creem_checkout_retrieve' | 'creem_license_activate'

/** The only fields a Creem diagnostic log may contain. */
export interface CreemLogEvent {
  operation: CreemLogOperation
  error: CreemLogError
  upstreamStatus?: number
}

export type CreemLogger = (event: CreemLogEvent) => void

export interface Env {
  LTW_KV?: CloudflareKVBinding
  CREEM_API_KEY?: string
  CREEM_WEBHOOK_SECRET?: string
  CREEM_API_BASE?: string
  CREEM_PRODUCT_ID?: string
  ALLOW_DEV_GRANT?: string
  DEV_GRANT_SECRET?: string
  SYNC_MAX_BYTES?: string
  ALLOWED_ORIGINS?: string
  /** Injected by the Node dev server / tests. */
  kv?: KV
  /** Test hook to mock Creem HTTP. Defaults to global fetch. */
  creemFetch?: FetchLike
  /**
   * Test-only Creem call budget in milliseconds.
   * Production uses the default. Not a Worker binding.
   */
  creemTimeoutMs?: number
  /** Test hook. Production writes one structured console log. */
  creemLog?: CreemLogger
}

export interface ResolvedEnv {
  kv: KV
  creemApiKey: string
  creemWebhookSecret: string
  creemApiBase: string
  creemProductId: string
  allowDevGrant: boolean
  devGrantSecret: string
  syncMaxBytes: number
  extraOrigins: string[]
  creemFetch: FetchLike
  creemTimeoutMs: number
  creemLog: CreemLogger
}

export interface LicenseInstance {
  instanceId: string
  instanceName: string
  createdAt: number
  tokenHash?: string
}

export interface LicenseRecord {
  key: string
  source: 'creem' | 'minted' | 'dev'
  checkoutId?: string
  orderId?: string
  productId?: string
  createdAt: number
  activationLimit: number
  instances: LicenseInstance[]
  expiresAt?: number | null
  revoked?: boolean
  creemKey?: boolean
}

export interface CheckoutRecord {
  checkoutId: string
  orderId?: string
  productId?: string
  status: string
  licenseKey: string
  source: 'creem' | 'minted'
  createdAt: number
}

export interface TokenRecord {
  tokenHash: string
  licenseKey: string
  instanceId: string
  instanceName: string
  createdAt: number
}

export interface SyncEnvelope {
  schema: 1
  updatedAt: number
  ciphertext: string
  iv: string
  enc: 'aes-gcm-v1'
  salt?: string
}

export const DEFAULT_PRODUCT_ID = 'prod_1sxcev5EyzFKkDzSRj3ZSs'
export const DEFAULT_CREEM_API_BASE = 'https://api.creem.io'
export const DEFAULT_SYNC_MAX_BYTES = 1048576
export const DEFAULT_ACTIVATION_LIMIT = 5
export const API_VERSION = '0.2.0'

export const PUBLISHED_EXTENSION_ORIGIN =
  'chrome-extension://adpnoccebkjackmkebecdcnenlgkcdah'

export const PRODUCTION_ORIGINS = [
  'https://localtabs.top',
  'https://www.localtabs.top',
  PUBLISHED_EXTENSION_ORIGIN,
] as const
