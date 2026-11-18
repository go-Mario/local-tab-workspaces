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

The client now always gets a small JSON error. Upstream bodies, exception text, and API keys are not copied into that JSON. A production `502 upstream_unavailable` means the upstream HTTP status was not 404 or 400. It is not, by itself, a not-found result, and it is not evidence of a particular upstream status. The Worker previously had no observability, so that status was not recorded.

## Diagnostic logs

Each failed Creem call writes one `console.log` object. Its only fields are:

| Field | Content |
|---|---|
| `operation` | `creem_checkout_retrieve` or `creem_license_activate` |
| `upstreamStatus` | Upstream HTTP status, omitted when the call never returned one |
| `error` | One of: `checkout_not_found`, `invalid_checkout`, `upstream_unauthorized`, `upstream_forbidden`, `upstream_status`, `bad_json`, `body_unreadable`, `timeout`, `network`, `header_rejected`, `unknown_key`, `activate_rejected` |

The log does not include `checkout_id`, license keys, the upstream body, the request URL or query, or any token. HTTP 404 stays client `404 checkout_not_found` even when the body is empty, non-JSON, or unreadable. HTTP 400 and 422 stay client `400 invalid_checkout`. HTTP 401 and 403 stay client `502 upstream_unavailable` and are not reported to the client as not-found. The log category records which one happened.

Workers Logs configuration in `wrangler.toml`, from the current docs:

```toml
[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
enabled = true
invocation_logs = false

[observability.traces]
enabled = false
```

- `observability.enabled = true` persists Workers Logs. Custom `console.log` is included. Documented at https://developers.cloudflare.com/workers/observability/logs/workers-logs/ (page updated 2026-11-12).
- `invocation_logs = false` disables the automatic invocation record (`$cloudflare.$metadata.type = "cf-worker-event"`). For a fetch handler that record's message is the method and the full request URL, which would contain `checkout_id`. Same page, section "Invocation Logs".
- `traces.enabled = false` keeps traces off. https://developers.cloudflare.com/workers/observability/traces/ says tracing is enabled only by `observability.traces.enabled = true`, and that `observability.enabled = true` currently enables logs only. The explicit `false` keeps a later default from turning traces on in this file.
- Do not enable Workers Logpush or a tail consumer for this pass. Those destinations receive the invocation, including the URL.

`logs.enabled` must stay `true`. Setting it `false` drops `console.log` as well (Wrangler 4.164.0 validates that combination and does not warn). `head_sampling_rate = 1` keeps the single forensic request. This API is low traffic. After the one probe, set the rate back down if you want less retention.

The client error string does not change with the log category. Reading the log is required to tell 401, 403, 5xx, a network failure, and a rejected header apart.

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

After that deploy, only these probes. Do not pay, do not `POST /webhooks/creem`, and do not activate a real license.

Deploy this version with the observability block above included in the uploaded Worker config. Do not enable Logpush, a tail worker, or traces. Keep `invocation_logs = false`.

```bash
curl -sS -D- https://api.localtabs.top/health
# 200 {"ok":true,"version":"0.2.0"}

curl -sS -D- "https://api.localtabs.top/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent"

curl -sS -D- -X POST https://api.localtabs.top/v1/dev/grant \
  -H 'content-type: application/json' \
  -d '{"secret":"probe"}'
# 404 {"ok":false,"error":"not_found"}
```

Then open Workers → `localtabs-sync-api` → Observability. Read the custom log, not a `cf-worker-event` row. It should contain only `operation`, `upstreamStatus` (when an HTTP status came back), and `error`.

| Client JSON | What the log must show before calling the path fixed |
|---|---|
| `404 checkout_not_found` | `error=checkout_not_found`, `upstreamStatus=404` |
| `400 invalid_checkout` | `error=invalid_checkout`, `upstreamStatus=400` or `422` |
| `502 upstream_unavailable` | `upstream_unauthorized` (401), `upstream_forbidden` (403), `upstream_status` (other), `bad_json` (200), `body_unreadable` (200), `network`, or `header_rejected` |
| `504 upstream_timeout` | `error=timeout` |

Do not treat client `502` as not-found. Do not send a webhook, pay, or activate a license for this probe. `/health` staying on `0.2.0` is expected.

No scheduled follow-up is added here. A manual check of the store version and `/health`, if someone wants one, is weekly — not a new daily routine.
