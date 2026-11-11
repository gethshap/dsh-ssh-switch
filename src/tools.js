import { remote } from './ssh.js'

const string = description => ({ type: 'string', description })
const path = string('Path inside the SSH workspace, relative to its root or a remote absolute path.')
const tools = {
  bash: ['Run a noninteractive Bash command on the SSH host. Each call starts in the remote workspace root.', {
    command: string('Bash command to run on the remote host.'),
  }, ['command']],
  read: ['Read UTF-8 text with line numbers over SSH.', {
    file_path: path, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 },
  }, ['file_path']],
  write: ['Create or replace a UTF-8 file in the SSH workspace. Parent directory must exist.', {
    file_path: path, content: string('Complete UTF-8 file content.'),
  }, ['file_path', 'content']],
  edit: ['Replace literal text in a UTF-8 file in the SSH workspace.', {
    file_path: path, old_string: string('Text to replace.'), new_string: string('Replacement text.'),
    replace_all: { type: 'boolean' },
  }, ['file_path', 'old_string', 'new_string']],
  glob: ['List files matching a ripgrep glob on the SSH host.', {
    pattern: string('Glob to match.'), path,
  }, ['pattern']],
  grep: ['Search text using ripgrep on the SSH host.', {
    pattern: string('Regular expression.'), path, include: string('Optional file glob.'),
  }, ['pattern']],
}

/** Expose only SSH-backed workspace capabilities in a remote agent's scope. */
export function bindRemoteAgent(agent, target, sandboxPolicy, transport = remote) {
  const ctx = agent.ctx
  const definitions = new Map()
  ctx.tools.restrict({ allow: [] })
  ctx.tools.presentAs('native')
  ctx.tools.guard(({ name }) => {
    const expected = definitions.get(name)
    if (!expected || ctx.tools.get(name, agent) !== expected) {
      return 'This tool is unavailable in an SSH workspace. Use bash, read, write, edit, glob or grep.'
    }
  })
  for (const [name, [description, properties, required]] of Object.entries(tools)) {
    const definition = {
      name, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      timeoutMs: name === 'bash' ? 115_000 : 40_000,
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute(args, execution) {
        if (!args || typeof args !== 'object' || Array.isArray(args) || required.some(key => !Object.hasOwn(args, key))) {
          throw new Error(`Required arguments: ${required.join(', ')}.`)
        }
        for (const [key, value] of Object.entries(args)) {
          const type = Object.hasOwn(properties, key) ? properties[key].type : undefined
          const valid = type === 'integer' ? Number.isInteger(value) : typeof value === type
          if (!valid) throw new Error(`Invalid argument: ${key}.`)
        }
        const { mode } = sandboxPolicy.resolve({ session: agent.session })
        return transport(target, { op: name, args, mode }, execution.signal)
      },
    }
    // DSH can snapshot definitions at registration. Compare with the scoped
    // view so any replacement from another plugin is refused by the guard.
    ctx.tools.register(definition)
    definitions.set(name, ctx.tools.get(name, agent))
  }
  ctx.systemPrompt.context({
    name: 'ssh-switch:workspace',
    order: 61,
    required: true,
    interpolate: false,
    text: () => `This session uses the SSH workspace ${JSON.stringify(target.host + ':' + target.path)}. The local cwd displayed by DSH is a registration placeholder. Use the remote path or relative paths with read/write/edit/glob/grep/bash. Before changing code, check for AGENTS.md in the remote project. Commands and file changes never fall back to the local machine.`,
  })
}
