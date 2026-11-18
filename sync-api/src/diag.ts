import type { ResolvedEnv } from './types'

export const OFFICIAL_CREEM_API_BASE = 'https://api.creem.io'

export type FailureClass = 'type_error' | 'error' | 'dom_exception' | 'other'
export type FailureReason = 'dns' | 'tls' | 'connection' | 'config' | 'unknown'

export interface FetchDiag {
  failureClass?: FailureClass
  failureReason?: FailureReason
  baseIsExpected: boolean
}

/**
 * Fixed prefixes from Workers fetch/request docs and workerd's own error copy.
 * Match only the start of the message. The remainder often contains a URL or
 * reference id and is never copied into a response.
 */
const REASON_PREFIXES: ReadonlyArray<readonly [FailureReason, string]> = [
  ['dns', 'DNS lookup failed'],
  ['tls', 'TLS handshake failed'],
  ['tls', 'CERTIFICATE_VERIFY_FAILED'],
  ['connection', 'Network connection lost'],
  ['connection', 'Network is unreachable'],
  ['connection', 'Connection refused'],
  ['connection', 'Connection reset'],
  ['connection', 'Connection timed out'],
  ['config', 'Invalid URL'],
  ['config', 'Unsupported cache mode'],
]

export function baseIsExpected(base: string): boolean {
  return base === OFFICIAL_CREEM_API_BASE
}

export function failureClassOf(err: unknown): FailureClass {
  if (!err || typeof err !== 'object') return 'other'
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name
  if (ctor === 'DOMException') return 'dom_exception'
  if (!('name' in err)) return 'other'
  const name = (err as { name: unknown }).name
  if (name === 'TypeError') return 'type_error'
  if (name === 'Error') return 'error'
  if (name === 'DOMException') return 'dom_exception'
  return 'other'
}

export function failureReasonOf(err: unknown): FailureReason {
  if (!err || typeof err !== 'object' || !('message' in err)) return 'unknown'
  const message = (err as { message: unknown }).message
  if (typeof message !== 'string' || !message) return 'unknown'
  for (const [reason, prefix] of REASON_PREFIXES) {
    if (message === prefix || message.startsWith(prefix)) return reason
  }
  return 'unknown'
}

export function diagFromException(env: ResolvedEnv, err: unknown): FetchDiag {
  return {
    failureClass: failureClassOf(err),
    failureReason: failureReasonOf(err),
    baseIsExpected: baseIsExpected(env.creemApiBase),
  }
}

/** Local header rejection, decided before fetch. No exception text is read. */
export function diagFromHeaderRejection(env: ResolvedEnv): FetchDiag {
  return {
    failureClass: 'other',
    failureReason: 'config',
    baseIsExpected: baseIsExpected(env.creemApiBase),
  }
}

/** HTTP-status failure. There is no exception to classify. */
export function diagFromBase(env: ResolvedEnv): FetchDiag {
  return { baseIsExpected: baseIsExpected(env.creemApiBase) }
}

const FAILURE_CLASSES = new Set<FailureClass>(['type_error', 'error', 'dom_exception', 'other'])
const FAILURE_REASONS = new Set<FailureReason>(['dns', 'tls', 'connection', 'config', 'unknown'])

export function publicDiag(env: ResolvedEnv, diag: FetchDiag | undefined): Record<string, unknown> {
  if (!env.unlockDiag || !diag) return {}
  const out: Record<string, unknown> = { baseIsExpected: diag.baseIsExpected === true }
  if (diag.failureClass && FAILURE_CLASSES.has(diag.failureClass)) out.failureClass = diag.failureClass
  if (diag.failureReason && FAILURE_REASONS.has(diag.failureReason)) out.failureReason = diag.failureReason
  return out
}
