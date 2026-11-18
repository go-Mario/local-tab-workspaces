const textEncoder = new TextEncoder()

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase()
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64 =
    typeof btoa === 'function'
      ? btoa(bin)
      : Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

export function randomToken(prefix = 'tok', bytes = 32): string {
  return `${prefix}_${bytesToBase64Url(randomBytes(bytes))}`
}

export function mintLicenseKey(): string {
  return `ltw_${bytesToBase64Url(randomBytes(24))}`
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    let acc = 0
    const dummy = a.length ? a : new Uint8Array(1)
    for (let i = 0; i < dummy.length; i++) acc |= dummy[i]!
    void acc
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = hexToBytes(a)
  const bb = hexToBytes(b)
  if (!ba || !bb) return false
  return timingSafeEqualBytes(ba, bb)
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ba = textEncoder.encode(a)
  const bb = textEncoder.encode(b)
  return timingSafeEqualBytes(ba, bb)
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder.encode(body))
  return bytesToHex(new Uint8Array(sig))
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

export function looksLikeCreemLicenseKey(key: string): boolean {
  const k = key.trim()
  if (!k) return false
  if (k.startsWith('ltw_')) return false
  // Creem license keys are typically creem-style / non-ltw tokens.
  return k.length >= 8
}
