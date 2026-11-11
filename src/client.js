window.__ModuleLoader__.load({
  id: 'dsh-ssh-switch',
  factory(require) {
    const { createElement: h, useRef, useState } = require('react')
    const browserHeader = 'x-dsh-ssh-switch'
    const route = '/api/ssh-switch/workspaces'

    const inject = ['slots', 'uiWorkspace']

    const labels = {
      zh: {
        title: 'SSH 工作区', close: '关闭', loading: '正在加载…', add: '添加', name: '名称', host: 'SSH 别名',
        path: '远程目录', open: '打开', empty: '还没有保存 SSH 工作区。',
        busy: '正在连接…',
        hint: '填写 ~/.ssh/config 中的别名和远程绝对路径。连接使用已有的 SSH 密钥。',
      },
      en: {
        title: 'SSH workspaces', close: 'Close', loading: 'Loading…', add: 'Add', name: 'Name', host: 'SSH alias',
        path: 'Remote directory', open: 'Open', empty: 'No saved SSH workspaces.',
        busy: 'Connecting…',
        hint: 'Use an alias from ~/.ssh/config and an absolute remote path. SSH uses your existing key.',
      },
    }

    async function request(body) {
      const response = await fetch(route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { [browserHeader]: '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      return data
    }

    function Switcher({ wide, openWorkspace }) {
      const t = labels[document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en']
      const dialog = useRef(null)
      const inFlight = useRef(false)
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const run = async (body, form) => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setError('')
        try {
          const next = await request(body)
          if (next.workspaceId) {
            await openWorkspace(next.workspaceId)
            form?.reset()
            dialog.current?.close()
          } else {
            setData(next)
            form?.reset()
          }
        } catch (failure) {
          setError(failure.message)
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }
      const field = (key, props) => h('label', { style: { display: 'grid', gap: 4 } }, t[key],
        h('input', { name: key, required: true, ...props }))
      const add = event => {
        event.preventDefault()
        const form = event.currentTarget
        const fields = Object.fromEntries(new FormData(form))
        void run({ action: 'add', entry: fields }, form)
      }

      return h('div', null,
        h('button', { type: 'button', title: t.title, 'aria-label': t.title, onClick: () => {
          dialog.current.showModal()
          void run()
        } }, wide ? t.title : 'SSH'),
        h('dialog', { ref: dialog, 'aria-label': t.title, style: {
          width: 'min(36rem, calc(100vw - 2rem))', boxSizing: 'border-box',
          border: '1px solid var(--dsw-alias-border-l3, #888)', borderRadius: 12,
          padding: '1.2rem', background: 'var(--dsw-alias-surface-layer-1, Canvas)', color: 'CanvasText',
        } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('strong', null, t.title),
          h('button', { type: 'button', onClick: () => dialog.current.close() }, t.close)),
        busy && h('p', { role: 'status' }, data ? t.busy : t.loading),
        error && h('pre', { role: 'alert', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, error),
        data && h('div', null,
          data.entries.length === 0 && h('p', null, t.empty),
          ...data.entries.map(item => h('div', { key: item.id, style: { marginBlock: 12, overflowWrap: 'anywhere' } },
            h('strong', null, item.name),
            h('div', null, `${item.host}:${item.path}`),
            h('button', { disabled: busy, onClick: () => void run({ action: 'open', id: item.id }) }, t.open))),
          h('hr'),
          h('p', null, t.hint),
          h('form', { onSubmit: add, style: { display: 'grid', gap: 8 } },
            field('name', { maxLength: 100 }),
            field('host', { placeholder: 'devbox', maxLength: 100, autoCapitalize: 'none' }),
            field('path', { placeholder: '/srv/project', maxLength: 4096 }),
            h('button', { type: 'submit', disabled: busy }, t.add))),
        ))
    }

    /** Mount the switcher in DSH's sidebar and open remote workspaces using native navigation. */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'ssh-switch', order: 180,
        inject: () => ({ openWorkspace: id => ctx.get('uiWorkspace').openWorkspace(id) }),
      }, Switcher))
    }

    return { apply, inject }
  },
})
