import type { Page } from '@playwright/test'

/**
 * Minimal shape of a `ConnectionConfig` as far as the UI renders it
 * (host/port/name/group). The full type lives in src/types.ts.
 */
export interface MockConnection {
  id: string
  name: string
  host: string
  port: number
  username?: string
  group?: string
  description?: string
}

export interface TauriMockOptions {
  /** Initial connection list returned by `list_connections`. */
  connections?: MockConnection[]
  /**
   * Chunks fed to `poll_output`, drained one array per call (each element is a
   * single poll response: an array of output chunks). Once drained, subsequent
   * calls return `[]` — so the terminal receives its prompt/output once.
   */
  pollOutputChunks?: string[][]
  /** Value returned by `list_command_snippets` (defaults to `[]`). */
  commandSnippets?: unknown[]
  /** Value returned by `list_workspaces`. */
  workspaces?: { workspaces: unknown[]; activeWorkspaceId: string }
  /** Value returned by `load_window_config`. */
  windowConfig?: Record<string, unknown>
  /** Raw JSON string returned by `load_layout`. */
  layout?: string
}

/**
 * Inject a fake Tauri backend into the page before any app code runs.
 *
 * The frontend talks to Rust exclusively through `window.__TAURI_INTERNALS__.invoke`
 * (wrapped by `@tauri-apps/api`). This helper stubs that object plus the event
 * plugin internals, and keeps an in-memory connection list so CRUD flows
 * (save -> refresh) behave like the real backend.
 *
 * The mock is serialized into `addInitScript`, so `options` must be JSON-safe.
 */
export async function installTauriMock(page: Page, options: TauriMockOptions = {}) {
  await page.addInitScript((opts) => {
    const callbacks = new Map<number, (payload: unknown) => void>()
    const listeners = new Map<string, Array<(event: { id: number; payload: unknown }) => void>>()
    let counter = 1

    // Stateful connection store so save -> refresh reflects new entries.
    const conns: MockConnection[] = (opts.connections ?? []).map((c) => ({ ...c }))
    const pollChunks: string[][] = (opts.pollOutputChunks ?? []).map((c) => [...c])
    // Every invoke is recorded here so tests can assert backend interactions
    // (e.g. "connect was called", "poll_output stopped after connection-closed").
    const invoked: string[] = []

    const internals: Record<string, unknown> = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: (cb: (payload: unknown) => void, _once = false) => {
        const id = counter++
        callbacks.set(id, cb)
        return id
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id)
      },
      convertFileSrc: (p: string) => p,
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        invoked.push(cmd)
        if (cmd === 'plugin:event|listen') {
          const cb = callbacks.get(args.handler as number)
          if (cb) {
            const list = listeners.get(args.event as string) ?? []
            list.push(cb as (event: { id: number; payload: unknown }) => void)
            listeners.set(args.event as string, list)
          }
          return counter++ // event id
        }
        if (cmd === 'plugin:event|unlisten') return null
        if (cmd.startsWith('plugin:window|')) {
          switch (cmd) {
            case 'plugin:window|outer_position':
            case 'plugin:window|inner_position':
              return { x: 0, y: 0 }
            case 'plugin:window|outer_size':
            case 'plugin:window|inner_size':
              return { width: 1440, height: 900 }
            case 'plugin:window|scale_factor':
              return 1
            case 'plugin:window|is_maximized':
            case 'plugin:window|is_minimized':
            case 'plugin:window|is_focused':
            case 'plugin:window|is_fullscreen':
              return false
            default:
              // set_*, on_*, start_dragging... — no return value needed.
              return null
          }
        }
        if (cmd.startsWith('plugin:updater|')) return null
        if (cmd === 'plugin:dialog|') return null

        switch (cmd) {
          case 'poll_output': {
            const batch = pollChunks.shift()
            return batch ?? []
          }
          case 'list_connections':
            return JSON.stringify(conns)
          case 'save_connection': {
            const c = args.config as MockConnection
            const i = conns.findIndex((x) => x.id === c.id)
            if (i >= 0) conns[i] = c
            else conns.push(c)
            return null
          }
          case 'delete_connection': {
            const id = args.id as string
            const i = conns.findIndex((x) => x.id === id)
            if (i >= 0) conns.splice(i, 1)
            return true
          }
          case 'list_workspaces':
            return JSON.stringify(
              opts.workspaces ?? { workspaces: [], activeWorkspaceId: 'default' },
            )
          // Everything below returns the raw value (no JSON.stringify) — most
          // commands.ts wrappers use the invoke result directly.
          case 'load_window_config':
            return opts.windowConfig ?? {}
          case 'load_layout':
            return opts.layout ?? '{}'
          case 'get_keepalive':
            return { interval: 30, max: 3 }
          case 'get_app_version':
            return {
              version: '0.0.7',
              gitHash: 'mock',
              gitBranch: 'main',
              buildTime: '2026-08-28',
              gitCommit: 'mock',
            }
          case 'load_ai_config':
            return {}
          case 'get_local_terminals':
          case 'get_local_shell_dirs':
          case 'list_local_drives':
          case 'list_tunnels':
          case 'list_sessions':
          case 'list_command_sets':
          case 'list_global_variables':
          case 'list_ai_prompt_templates':
          case 'list_hidden_builtin_templates':
          case 'list_docker_containers':
            return []
          case 'list_command_snippets':
            return opts.commandSnippets ?? []
          case 'get_recording_enabled':
            return true
          case 'get_auto_record':
            return true
          default:
            return null
        }
      },
    }

    // Tauri's event helpers also reach into the event-plugin internals.
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: internals,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      value: { unregisterListener: () => {} },
      configurable: true,
      writable: true,
    })
    // Test hook: read which commands the app invoked (in order).
    Object.defineProperty(window, '__TAURI_INVOKED__', {
      value: invoked,
      configurable: true,
      writable: true,
    })
    // Test hook: emit a backend event from the test via page.evaluate.
    Object.defineProperty(window, '__TAURI_EMIT__', {
      value: (event: string, payload?: unknown) => {
        for (const cb of listeners.get(event) ?? []) {
          cb({ id: counter++, payload })
        }
      },
      configurable: true,
      writable: true,
    })
  }, options)
}

/** Emit a Tauri event from a test (drives `listen` handlers in the app). */
export async function emitTauriEvent(page: Page, event: string, payload?: unknown) {
  await page.evaluate(
    ([e, p]) =>
      (window as unknown as { __TAURI_EMIT__: (ev: string, pl?: unknown) => void }).__TAURI_EMIT__(
        e,
        p,
      ),
    [event, payload] as const,
  )
}

/** Read the list of commands the app has invoked so far (via the mock). */
export async function invokedCommands(page: Page): Promise<string[]> {
  return await page.evaluate(() => [
    ...((window as unknown as { __TAURI_INVOKED__: string[] }).__TAURI_INVOKED__ ?? []),
  ])
}
