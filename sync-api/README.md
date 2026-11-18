# localtabs-sync-api

Cloudflare Worker that provisions Early Access licenses and stores **encrypted** workspace blobs for Local Tab Workspaces 0.2.0.

- Production base: `https://api.localtabs.top`
- Worker name: `localtabs-sync-api`
- Local dev: `http://127.0.0.1:8787` (`ALLOW_DEV_GRANT=1`)

```bash
cd sync-api
npm install
npm test
npm run build
```

Do not put `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, or `DEV_GRANT_SECRET` in this repo. `wrangler.toml` has no secrets. `ALLOW_DEV_GRANT` must stay unset in production.

This directory is the API source. It does not change the marketing pages (`index.html`, `privacy.html`, `terms.html`, `unlock.html`).

## Unlock 1101

`GET /v1/checkouts?checkout_id=` is the only documented retrieve call. On an unknown id Creem answers 404. The previous code did not read that body and then called an undocumented `/v1/checkouts/{id}`. Workers cancels the unread subrequest outside the awaited promise (`A stalled HTTP response was canceled to prevent deadlock`). `handleRequest` also returned handler promises without `await`, so the `try/catch` never saw the rejection. Cloudflare turns that into error **1101** instead of JSON. Node tests still returned 404, which is why 15/15 could pass.

Global `fetch` is called as a function. Assigning it onto the env object and calling it as a method throws `TypeError: Illegal invocation` in workerd (`failureClass=type_error`, `failureReason=unknown`). A direct `fetch()` of the same URL returns an HTTP response.

The client now always gets a small JSON error. Upstream bodies, exception text, and API keys are not copied into that JSON. A `502 upstream_unavailable` means this response is not a 404 or 400. Without an HTTP status it is not an authentication result. Creem's introduction and error-codes pages disagree on whether a bad key is 401 or 403; that disagreement does not apply when `fetch` never returned a response.

## Response diagnosis

`UNLOCK_DIAG` defaults to `"0"`. `[observability] enabled = false`. This build does not call `console.log`.

Set `UNLOCK_DIAG = "1"` for one read-only probe. Only `502` bodies whose `error` is `upstream_unavailable` gain fields. `200`, `400`, `402`, `404`, and `504` stay as they are.

| Field | Values |
|---|---|
| `failureClass` | `type_error`, `error`, `dom_exception`, `other`. Present only when an exception was caught. |
| `failureReason` | `dns`, `tls`, `connection`, `config`, `unknown`. Present only for that exception. `unknown` means the message did not start with a fixed Workers phrase. |
| `baseIsExpected` | `true` only when `CREEM_API_BASE` is exactly `https://api.creem.io`. The value itself is not returned. |

`failureReason` is chosen only when `error.message` starts with one of these fixed strings: `DNS lookup failed`, `TLS handshake failed`, `CERTIFICATE_VERIFY_FAILED`, `Network connection lost`, `Network is unreachable`, `Connection refused`, `Connection reset`, `Connection timed out`, `Invalid URL`, `Unsupported cache mode`. A header rejected for a control character, before `fetch`, is `failureClass=other` and `failureReason=config`. An opaque `internal error; reference = …` stays `unknown`. Nothing from the message, stack, URL, token, or body is copied out.

After the probe, set `UNLOCK_DIAG` back to `"0"` and upload that var change. No code revert is required. The extra fields disappear. Leave observability off.

| Situation | Response |
|---|---|
| Unknown checkout id | `404` `checkout_not_found` |
| Unpaid (`pending`, `processing`, `expired`) | `402` `checkout_unpaid` |
| Bad id | `400` `invalid_checkout` |
| Upstream 5xx / 401 / non-JSON | `502` `upstream_unavailable` |
| Upstream timeout (8s) | `504` `upstream_timeout` |
| API key not configured | `500` `creem_not_configured` |

`POST /v1/licenses/activate` sends `{ "key", "instance_name" }` and `x-api-key`, matching the Creem OpenAPI. The stored instance id is `instance.id` from `LicenseEntity`. `LicenseEntity.id` is the license id and is not used as the device id.

Creem HTTP in `npm test` is mocked. A green test run is not a real payment, not a live webhook delivery, and not a production activate.

## Deploy

This does not deploy by itself. Do not change production secrets, routes, or `ALLOW_DEV_GRANT`. Do not create a new KV namespace.

1. In the Cloudflare dashboard, copy the **existing** `LTW_KV` namespace id already bound to `localtabs-sync-api`.
2. Put that id in `wrangler.toml` (`kv_namespaces`). The committed id is a placeholder (`0000…`). Deploying the placeholder would point production at an empty namespace.
3. From `sync-api`, with the existing Wrangler login: `npx wrangler deploy`.
4. Do not run `wrangler secret put`. `CREEM_API_KEY` and `CREEM_WEBHOOK_SECRET` are already bound. Do not set `ALLOW_DEV_GRANT`. Do not point `CREEM_API_BASE` at `https://test-api.creem.io`.

## Acceptance (read-only)

Deploy with `UNLOCK_DIAG = "1"` and `observability.enabled = false`. Do not enable Logpush, a tail worker, or traces. Do not pay, do not `POST /webhooks/creem`, and do not activate a real license.

```bash
curl -sS https://api.localtabs.top/health
# 200 {"ok":true,"version":"0.2.0"}

curl -sS "https://api.localtabs.top/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent"
# 502 with error upstream_unavailable, plus only:
#   failureClass: type_error | error | dom_exception | other
#   failureReason: dns | tls | connection | config | unknown
#   baseIsExpected: true | false

curl -sS -X POST https://api.localtabs.top/v1/dev/grant \
  -H 'content-type: application/json' -d '{"secret":"probe"}'
# 404 {"ok":false,"error":"not_found"}
```

Then set `UNLOCK_DIAG` to `"0"` and upload that variable. The same routes return the original JSON, with no `failureClass`, `failureReason`, or `baseIsExpected`.

No scheduled follow-up is added here. A manual check of the store version and `/health`, if someone wants one, is weekly — not a new daily routine.
