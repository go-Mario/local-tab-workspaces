# Local Tab Workspaces — Landing page

Bilingual (EN primary, CN secondary) Early Access page for the local-first Chrome tab workspace.

## Creem product website URL (use this — NOT github.io)

**https://slender-yttrium-ml4at.ship.place/**

- Host: ship.page anonymous HTTPS (static; verified HTTP 200)
- Anonymous free plan expires ~**2026-11-20** (Asia/Shanghai ≈ 2026-11-20 20:06); claim to keep longer:
  https://ship.page/claim?slug=slender-yttrium-ml4at&token=spc_ia34d5zsvqp6ybeu5vz719wf&via=api
- Operator (legal name on site): **LIAO XIANG** — individual indie developer based in China (matches Creem merchant onboarding)
- Support email: `lililiaoxiang0913@gmail.com`
- Legal: `/privacy.html`, `/terms.html` (both name operator LIAO XIANG)
- Creem `$1` CTA → `https://www.creem.io/payment/prod_1sxcev5EyzFKkDzSRj3ZSs`
- Updated: 2026-10-21 Asia/Shanghai (UTC+8) — non-github.io deploy for Creem production-domain request

## Mirror (GitHub Pages — backup only, do not submit to Creem)

**https://go-mario.github.io/local-tab-workspaces/**

- Repo: https://github.com/go-Mario/local-tab-workspaces
- Commit with legal name: `c1a7840`

## Short-lived backup

https://local-tab-workspaces.beacon.host/ (anonymous ≈24h; expires ~2026-10-22 20:06 Asia/Shanghai)

## Previous temporary URL (do not submit)

https://squat-mocha-41.beacon.host/

## Files

| Path | Purpose |
|------|---------|
| `index.html` | Landing (CSS + light JS inline) |
| `privacy.html` | Privacy Policy |
| `terms.html` | Terms of Service |
| `README.md` | This file |
| `deploy-meta.json` | Deploy metadata |

## Re-deploy

1. Edit files under `/workspace/landing` (and sync to `/workspace/landing-pages-deploy`).
2. Push `landing-pages-deploy` to `main` for GitHub Pages mirror.
3. Re-zip `index.html` + `privacy.html` + `terms.html` and `POST` to `https://ship.page/deploy` for the Creem-facing URL (or claim the existing slug).
