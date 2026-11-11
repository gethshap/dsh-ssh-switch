import { lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Registry } from './registry.js'
import { remote } from './ssh.js'
import { bindRemoteAgent } from './tools.js'
import { browserHeader, entry, InputError, remotePath, route } from './shared.js'

export const inject = ['connection', 'workspaceRegistry', 'agents', 'tools', 'sandboxPolicy', 'systemPrompt']

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

async function openAnchor(root, id) {
  const path = join(root, id)
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(path, await realpath(path)) !== '') {
    throw new Error('SSH workspace placeholder was replaced.')
  }
  return path
}

/** Connect DSH's workspace registry and per-agent tool scope to OpenSSH. */
export function apply(ctx) {
  const directory = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ssh-switch')
  const registry = new Registry(join(directory, 'workspaces.json'))
  const anchorRoot = join(directory, 'anchors')
  const lifetime = new AbortController()
  const root = async () => {
    await mkdir(anchorRoot, { recursive: true, mode: 0o700 })
    return realpath(anchorRoot)
  }
  ctx.effect(() => () => lifetime.abort())

  ctx.on('agent/created', async ({ agent }) => {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const anchor = relative(await root(), cwd)
    if (anchor === '' || anchor === '..' || anchor.startsWith('..' + sep) || isAbsolute(anchor)) return
    const target = (await registry.list()).find(item => item.id === anchor)
    if (!target) throw new Error('This SSH workspace registration is missing. Register the remote directory before continuing.')
    bindRemoteAgent(agent, target, ctx.sandboxPolicy, (target, request, signal) =>
      remote(target, request, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal))
  })

  ctx.connection.fetch.register({
    path: route,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get(browserHeader) !== '1') return json({ error: 'Use the SSH workspace panel.' }, 403)
      try {
        const base = await root()
        if (request.method === 'GET') {
          const byPath = new Map(ctx.workspaceRegistry.list().map(workspace => [workspace.path, workspace.id]))
          return json({ entries: (await registry.list()).map(item => ({
            ...item, workspaceId: byPath.get(join(base, item.id)),
          })) })
        }
        if (request.headers.get('content-type') !== 'application/json') {
          return json({ error: 'Expected JSON.' }, 415)
        }
        let body
        try { body = await request.json() }
        catch { return json({ error: 'Invalid JSON.' }, 400) }
        if (body?.action === 'add') {
          const target = entry(body.entry)
          const path = remotePath(await remote(target, { op: 'probe' }, AbortSignal.any([request.signal, lifetime.signal])))
          const item = await registry.add({ ...target, path })
          const workspace = await ctx.workspaceRegistry.create(await openAnchor(base, item.id), `SSH · ${item.name} (${item.host})`)
          return json({ workspaceId: workspace.id })
        }
        if (body?.action === 'open') {
          const item = (await registry.list()).find(candidate => candidate.id === body.id)
          if (!item) throw new InputError('SSH workspace was not found.')
          const workspace = await ctx.workspaceRegistry.create(await openAnchor(base, item.id), `SSH · ${item.name} (${item.host})`)
          return json({ workspaceId: workspace.id })
        }
        throw new InputError('Unknown SSH workspace action.')
      } catch (error) {
        if (error instanceof InputError) return json({ error: error.message }, 400)
        console.error('[ssh-switch]', error)
        return json({ error: 'SSH workspace operation failed. Check the local DSH log.' }, 500)
      }
    },
  })
}
