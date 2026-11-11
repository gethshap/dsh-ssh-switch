import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Registry } from '../src/registry.js'
import { remote } from '../src/ssh.js'

const target = { name: 'Dev', host: 'devbox', path: "/srv/project's source" }

test('concurrent registration preserves one durable binding per SSH directory', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-ssh-switch-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const file = join(folder, 'workspaces.json')
  const registry = new Registry(file)
  const [first, duplicate, second] = await Promise.all([
    registry.add(target),
    registry.add({ ...target, name: 'Duplicate' }),
    registry.add({ ...target, path: '/srv/other' }),
  ])
  assert.equal(duplicate.id, first.id)
  assert.notEqual(second.id, first.id)
  assert.deepEqual(await new Registry(file).list(), [first, second])
})

function fixture(reply) {
  return (program, argv) => {
    assert.equal(program, 'ssh')
    assert.deepEqual(argv.slice(-3, -1), ['--', 'devbox'])
    assert.ok(argv.includes('StrictHostKeyChecking=yes'))
    assert.ok(argv.includes('BatchMode=yes'))
    assert.ok(!argv.at(-1).includes(target.path))
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    })
    child.stdin.on('data', data => reply(child, JSON.parse(data)))
    child.stdin.on('end', () => child.emit('close', 1))
    return child
  }
}

test('tool request sends project coordinates and content only as JSON data', async () => {
  const args = { file_path: "file's name", content: '$HOME; echo x' }
  const start = fixture((child, request) => {
    assert.deepEqual(request, { op: 'write', args, mode: 'workspace-write', root: target.path })
    child.stdout.write(JSON.stringify({ value: 'Updated' }))
    child.emit('close', 0)
  })
  assert.equal(await remote(target, { op: 'write', args, mode: 'workspace-write' }, undefined, start), 'Updated')
})

test('SSH failure and cancellation return errors without retrying a write', async () => {
  const request = { op: 'write', args: { file_path: 'a', content: 'b' }, mode: 'workspace-write' }
  let calls = 0
  const failed = fixture(child => {
    calls++
    child.stderr.write('Host key verification failed.')
    child.emit('close', 255)
  })
  await assert.rejects(remote(target, request, undefined, failed), /Host key verification failed/)
  const controller = new AbortController()
  const cancelled = fixture(() => {
    calls++
    controller.abort()
  })
  await assert.rejects(remote(target, request, controller.signal, cancelled), /may already have completed/)
  assert.equal(calls, 2)
})
