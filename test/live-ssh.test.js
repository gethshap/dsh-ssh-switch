import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { remote } from '../src/ssh.js'

const config = process.env.DSH_SSH_TEST_CONFIG

test('OpenSSH workspace tools use the registered directory and enforce limits', { skip: !config }, async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ssh-live-')))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const path = join(temp, "project's workspace")
  await mkdir(path)
  const target = { name: 'Loopback test', host: 'dsh-loopback', path }
  const connect = (program, args, options) => spawn(program, ['-F', config, ...args], options)
  const run = (op, args = {}, mode = 'workspace-write') =>
    remote(target, { op, args, mode }, AbortSignal.timeout(15_000), connect)

  assert.equal(await run('probe'), path)
  await run('write', { file_path: 'note.txt', content: 'hello\nworld\n' })
  assert.match(await run('read', { file_path: 'note.txt' }), /2: world/)
  await run('edit', { file_path: 'note.txt', old_string: 'world', new_string: 'SSH' })
  assert.match(await run('grep', { pattern: 'SSH' }), /note\.txt:2:SSH/)
  assert.match(await run('glob', { pattern: '*.txt' }), /note\.txt/)
  assert.equal(await readFile(join(path, 'note.txt'), 'utf8'), 'hello\nSSH\n')
  await assert.rejects(run('write', { file_path: 'note.txt', content: 'changed' }, 'read-only'), /read-only/)
  await writeFile(join(temp, 'outside.txt'), 'outside')
  await symlink(join(temp, 'outside.txt'), join(path, 'link.txt'))
  await assert.rejects(run('read', { file_path: 'link.txt' }), /symbolic link/i)
  await assert.rejects(run('read', { file_path: '../outside.txt' }), /outside the remote workspace/)
  await writeFile(join(path, 'large.txt'), 'a'.repeat(256 * 1024))
  await assert.rejects(run('edit', {
    file_path: 'large.txt', old_string: 'a', new_string: '123456789', replace_all: true,
  }), /2 MiB/)
  assert.equal((await readFile(join(path, 'large.txt'))).length, 256 * 1024)
  assert.match(await run('bash', { command: 'pwd' }, 'danger-full-access'), /Remote exit code: 0/)

  if (process.env.DSH_SSH_TEST_BWRAP === '1') {
    const inside = await run('bash', { command: 'printf confined > shell.txt' })
    assert.match(inside, /Remote exit code: 0/)
    assert.equal(await readFile(join(path, 'shell.txt'), 'utf8'), 'confined')
    assert.match(await run('bash', { command: 'printf confined > ../outside.txt' }), /Remote exit code: [1-9]/)
    assert.equal(await readFile(join(temp, 'outside.txt'), 'utf8'), 'outside')
    assert.match(await run('bash', {
      command: "python3 -c 'import socket; socket.socket(socket.AF_UNIX)'",
    }), /PermissionError/)
  }
})
