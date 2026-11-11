import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { entry, InputError } from './shared.js'

const helper = readFileSync(new URL('./remote.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const command = 'exec python3 -u -c ' + quote(helper)

/** Submit only a JSON request on stdin. Workspace paths and tool arguments never become SSH options. */
export function remote(target, request, signal, start = spawn) {
  const { host, path } = entry(target)
  const payload = JSON.stringify({ ...request, root: path }) + '\n'
  if (Buffer.byteLength(payload) > 12 * 1024 * 1024) throw new InputError('Remote request is too large.')
  const timeout = AbortSignal.timeout(request.op === 'bash' ? 110_000 : 35_000)
  const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout
  lifetime.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = start('ssh', [
      '-T', '-a', '-x', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ClearAllForwardings=yes',
      '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none', '--', host, command,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let failure
    let killTimer
    const stop = error => {
      if (failure) return
      failure = error
      killTimer = setTimeout(() => child.kill(), 1500)
      killTimer.unref()
      child.stdin.end()
    }
    const abort = () => stop(new InputError('SSH request stopped or timed out. A remote write may already have completed.'))
    const cleanup = () => {
      clearTimeout(killTimer)
      lifetime.removeEventListener('abort', abort)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 512 * 1024) stop(new InputError('Remote response exceeded its size limit.'))
      else if (!failure) stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
    child.stdin.on('error', () => {}) // A failed SSH handshake may close stdin before the request is written.
    child.once('error', error => { cleanup(); reject(new InputError(`Cannot start OpenSSH: ${error.message}`)) })
    child.once('close', code => {
      cleanup()
      if (failure) return reject(failure)
      if (code !== 0) {
        return reject(new InputError(`SSH to ${host} failed (${code}). ${stderr.trim() || 'Check the host alias, known_hosts, key and remote python3.'}`))
      }
      try {
        const response = JSON.parse(stdout)
        if (typeof response?.error === 'string') return reject(new InputError(`${host}: ${response.error}`))
        if (typeof response?.value === 'string') return resolve(response.value)
      } catch {
        // A login script that writes to stdout also invalidates the response.
      }
      return reject(new InputError(`${host}: invalid SSH helper response. Check the remote shell startup output.`))
    })
    lifetime.addEventListener('abort', abort, { once: true })
    if (lifetime.aborted) abort()
    else child.stdin.write(payload)
  })
}
