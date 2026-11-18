import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function wranglerBin(): string {
  if (process.env.WRANGLER_BIN) return process.env.WRANGLER_BIN
  const local = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (!existsSync(local)) throw new Error('wrangler is not installed')
  return local
}

test('workerd: full worker unlock reaches Creem instead of throwing TypeError', { timeout: 60_000 }, async () => {
  const port = 8811
  const child: ChildProcess = spawn(
    process.execPath,
    [
      wranglerBin(),
      'dev',
      '--local',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--show-interactive-dev-session=false',
      '--var',
      'CREEM_API_KEY:not-a-secret',
      '--var',
      'UNLOCK_DIAG:1',
      '--var',
      'CREEM_API_BASE:https://api.creem.io',
      '--var',
      'CREEM_PRODUCT_ID:prod_1sxcev5EyzFKkDzSRj3ZSs',
      '--var',
      'SYNC_MAX_BYTES:1048576',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  child.stdout?.on('data', (chunk) => {
    log += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    log += String(chunk)
  })
  const stop = () => {
    if (!child.killed) child.kill('SIGTERM')
  }
  try {
    const ready = Date.now()
    while (!log.includes('Ready on')) {
      if (child.exitCode != null) {
        throw new Error(`wrangler exited ${child.exitCode}`)
      }
      if (Date.now() - ready > 40_000) throw new Error('wrangler did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/unlock?checkout_id=ch_ltw_verify_probe_nonexistent`,
    )
    const text = await res.text()
    const body = JSON.parse(text) as Record<string, unknown>
    assert.equal(text.includes('Illegal invocation'), false)
    assert.equal(text.includes('not-a-secret'), false)
    assert.equal(body.failureClass, undefined)
    assert.equal(body.failureReason, undefined)
    assert.equal(body.ok, false)
    assert.ok(res.status === 502 || res.status === 404, `status ${res.status}`)
    if (res.status === 502) assert.equal(body.error, 'upstream_unavailable')
    if (res.status === 404) assert.equal(body.error, 'checkout_not_found')
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(health.status, 200)
  } finally {
    stop()
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
  }
})
