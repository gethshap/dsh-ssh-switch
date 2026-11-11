export const route = '/api/ssh-switch/workspaces'
export const browserHeader = 'x-dsh-ssh-switch'

export class InputError extends Error {}

export function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new InputError('Enter an absolute POSIX directory, such as /srv/project.')
  }
  return value
}

export function entry(input) {
  if (typeof input?.name !== 'string' || !input.name.trim() || input.name.length > 100) {
    throw new InputError('Enter a name (1–100 characters).')
  }
  if (typeof input.host !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/.test(input.host)) {
    throw new InputError('Use an OpenSSH Host alias. Put the user, port and keys in ~/.ssh/config.')
  }
  return { name: input.name.trim(), host: input.host, path: remotePath(input.path) }
}
