import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CloudflareKVBinding, KV } from './types'

export class MemoryKV implements KV {
  readonly map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }

  async list(prefix = ''): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

export class CloudflareKV implements KV {
  constructor(private readonly binding: CloudflareKVBinding) {}

  async get(key: string): Promise<string | null> {
    return this.binding.get(key)
  }

  async put(key: string, value: string): Promise<void> {
    await this.binding.put(key, value)
  }

  async delete(key: string): Promise<void> {
    await this.binding.delete(key)
  }

  async list(prefix = ''): Promise<string[]> {
    if (!this.binding.list) return []
    const result = await this.binding.list({ prefix })
    return result.keys.map((k) => k.name)
  }
}

/** File-backed KV so a local dev server can be shared by two “devices”. */
export class FileKV implements KV {
  private cache: Map<string, string> | null = null

  constructor(private readonly filePath: string) {}

  private async load(): Promise<Map<string, string>> {
    if (this.cache) return this.cache
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const obj = JSON.parse(raw) as Record<string, string>
      this.cache = new Map(Object.entries(obj))
    } catch {
      this.cache = new Map()
    }
    return this.cache
  }

  private async persist(): Promise<void> {
    const map = await this.load()
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    const obj: Record<string, string> = {}
    for (const [k, v] of map) obj[k] = v
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }

  async get(key: string): Promise<string | null> {
    const map = await this.load()
    return map.has(key) ? (map.get(key) as string) : null
  }

  async put(key: string, value: string): Promise<void> {
    const map = await this.load()
    map.set(key, value)
    await this.persist()
  }

  async delete(key: string): Promise<void> {
    const map = await this.load()
    map.delete(key)
    await this.persist()
  }

  async list(prefix = ''): Promise<string[]> {
    const map = await this.load()
    return [...map.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

export function kvFromEnv(env: { kv?: KV; LTW_KV?: CloudflareKVBinding }): KV {
  if (env.kv) return env.kv
  if (env.LTW_KV) return new CloudflareKV(env.LTW_KV)
  throw new Error('No KV binding configured (env.LTW_KV or env.kv)')
}
