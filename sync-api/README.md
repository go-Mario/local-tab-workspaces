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

The client now always gets a small JSON error. Upstream bodies, exception text, and API keys are not copied into that JSON.

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

```bash
curl -sS -D- https://api.localtabs.top/health
# 200 {"ok":true,"version":"0.2.0"}

curl -sS -D- "https://api.localtabs.top/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent"
# 404 {"ok":false,"error":"checkout_not_found"}
# The body is JSON. It must not be a Cloudflare 1101 HTML page.

curl -sS -D- -X POST https://api.localtabs.top/v1/dev/grant \
  -H 'content-type: application/json' \
  -d '{"secret":"probe"}'
# 404 {"ok":false,"error":"not_found"}
```

`/health` staying on `0.2.0` is expected. This fix does not bump the API version and does not change the Chrome Web Store package.

No scheduled follow-up is added here. A manual check of the store version and `/health`, if someone wants one, is weekly — not a new daily routine.
