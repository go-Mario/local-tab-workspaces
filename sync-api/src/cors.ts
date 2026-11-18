import { PRODUCTION_ORIGINS } from './types'
import type { ResolvedEnv } from './types'

export function isAllowedOrigin(origin: string | null, env: ResolvedEnv): boolean {
  if (!origin) return false
  if ((PRODUCTION_ORIGINS as readonly string[]).includes(origin)) return true
  if (env.extraOrigins.includes(origin)) return true
  if (env.allowDevGrant) {
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return true
    }
    if (origin === 'http://localhost' || origin === 'http://127.0.0.1') return true
    if (origin.startsWith('chrome-extension://')) return true
  }
  return false
}

export function corsHeaders(
  origin: string | null,
  env: ResolvedEnv,
  extra?: Record<string, string>,
): Headers {
  const headers = new Headers(extra)
  headers.set('Vary', 'Origin')
  if (origin && isAllowedOrigin(origin, env)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-License-Key, X-Device-Id, X-Instance-Id, X-Dev-Secret',
    )
    headers.set('Access-Control-Max-Age', '86400')
  }
  return headers
}

function safeJson(body: unknown): string {
  try {
    const text = JSON.stringify(body)
    if (typeof text === 'string') return text
  } catch {
    // Lone surrogates and circular values must not escape the handler.
  }
  return '{"ok":false,"error":"internal_error"}'
}

export function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  env: ResolvedEnv,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = corsHeaders(origin, env, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  const statusCode =
    Number.isInteger(status) && status >= 200 && status <= 599 ? status : 500
  return new Response(safeJson(body), { status: statusCode, headers })
}

export function preflightResponse(origin: string | null, env: ResolvedEnv): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin, env) })
}
