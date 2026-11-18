import { handleRequest } from './worker'
import type { Env } from './types'

export default {
  async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
    try {
      // Await so a rejection is caught here. A bare return lets it escape
      // and Cloudflare answers with error 1101.
      return await handleRequest(request, env)
    } catch {
      return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
  },
}
