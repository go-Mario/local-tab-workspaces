import { kvFromEnv } from './kv'
import {
  DEFAULT_CREEM_API_BASE,
  DEFAULT_PRODUCT_ID,
  DEFAULT_SYNC_MAX_BYTES,
  type CreemLogEvent,
  type Env,
  type ResolvedEnv,
} from './types'

export function resolveEnv(env: Env): ResolvedEnv {
  const extraOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  let syncMaxBytes = DEFAULT_SYNC_MAX_BYTES
  if (env.SYNC_MAX_BYTES) {
    const n = Number(env.SYNC_MAX_BYTES)
    if (Number.isFinite(n) && n > 0) syncMaxBytes = Math.floor(n)
  }

  return {
    kv: kvFromEnv(env),
    creemApiKey: env.CREEM_API_KEY ?? '',
    creemWebhookSecret: env.CREEM_WEBHOOK_SECRET ?? '',
    creemApiBase: (env.CREEM_API_BASE || DEFAULT_CREEM_API_BASE).replace(/\/$/, ''),
    creemProductId: env.CREEM_PRODUCT_ID || DEFAULT_PRODUCT_ID,
    allowDevGrant: env.ALLOW_DEV_GRANT === '1',
    devGrantSecret: env.DEV_GRANT_SECRET ?? '',
    syncMaxBytes,
    extraOrigins,
    // Call global fetch as a function. Storing it on this object and invoking
    // it as a method throws TypeError: Illegal invocation in workerd.
    creemFetch: env.creemFetch ?? ((input, init) => fetch(input, init)),
    creemTimeoutMs: resolveCreemTimeoutMs(env.creemTimeoutMs),
    creemLog: env.creemLog ?? noopCreemLog,
    unlockDiag: env.UNLOCK_DIAG === '1',
  }
}

function noopCreemLog(_event: CreemLogEvent): void {
  // Diagnosis is returned on the upstream_unavailable JSON body.
  // console.log is not used: Workers log envelopes stored the request URL.
}

function resolveCreemTimeoutMs(raw: number | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 20 && raw <= 20_000) {
    return Math.floor(raw)
  }
  return 8_000
}

export function isDevMode(env: Env | ResolvedEnv): boolean {
  if ('allowDevGrant' in env) return env.allowDevGrant
  return (env as Env).ALLOW_DEV_GRANT === '1'
}
