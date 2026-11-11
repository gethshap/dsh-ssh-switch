import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { entry, InputError } from './shared.js'

export class Registry {
  #tail = Promise.resolve()
  #file
  constructor(file) { this.#file = file }

  async list() {
    let raw
    try { raw = await readFile(this.#file, 'utf8') }
    catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const data = JSON.parse(raw)
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid SSH workspace registry.')
    return data.entries.map(item => {
      if (!/^[a-f0-9-]{36}$/.test(item.id)) throw new Error('Invalid SSH workspace identity.')
      return { id: item.id, ...entry(item) }
    })
  }

  #mutate(update) {
    const work = this.#tail.then(async () => {
      const entries = await this.list()
      update(entries)
      const temp = `${this.#file}.${randomUUID()}.tmp`
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      try {
        await writeFile(temp, JSON.stringify({ version: 1, entries }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        await rename(temp, this.#file)
      } finally {
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
      return entries
    })
    this.#tail = work.catch(() => {})
    return work
  }

  add(input) {
    const next = entry(input)
    return this.#mutate(entries => {
      if (!entries.some(item => item.host.toLowerCase() === next.host.toLowerCase() && item.path === next.path)) {
        if (entries.length >= 100) throw new InputError('At most 100 SSH workspaces can be saved.')
        entries.push({ id: randomUUID(), ...next })
      }
    }).then(entries => entries.find(item => item.host.toLowerCase() === next.host.toLowerCase() && item.path === next.path))
  }
}
