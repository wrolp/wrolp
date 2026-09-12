// Frontend tool bridge for the AI appearance/system-config tools
// (`get_ui_settings` / `set_ui_settings` / `reset_ui_settings`).
//
// The AI tools execute in Rust, but appearance settings live in the WebView
// (localStorage + React state). This bridge is the return path:
//
//   Rust tool  →  app.emit('ai-ui-tool-request', {id, op, args})
//                 →  (this module) applies it via src/lib/appSettings.ts
//                    →  invoke('ai_ui_tool_result', {id, result})  →  Rust oneshot
//
// It MUST be installed at the `App.tsx` top level (not inside AiChatPanel) so a
// request is still answered while the AI panel is closed. See
// task/plans/AI-UI-CONFIG-PLAN.md §4.4.

import { useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'
import { aiUiToolResult } from '../commands'
import {
  applySettingChanges,
  listSettingDefs,
  readSettings,
  SettingError,
  SETTING_GROUPS,
  type SettingGroup,
} from './appSettings'

// ---------------------------------------------------------------------------
// Config (master switch + per-group whitelist + confirm toggle)
// ---------------------------------------------------------------------------

const CONFIG_KEY = 'wrolp-ai-appearance'

export interface AiAppearanceConfig {
  /** Master switch — when off, the bridge rejects every write op. */
  enabled: boolean
  /** Per-group whitelist (a group that is false is off-limits to the AI). */
  groups: Record<SettingGroup, boolean>
  /** When on, every `set` is routed through the user-confirm closed loop. */
  requireConfirm: boolean
}

const DEFAULT_CONFIG: AiAppearanceConfig = {
  enabled: true,
  groups: { theme: true, terminal: true, highlight: true, ui: true },
  requireConfirm: false,
}

export function sanitizeAiAppearanceConfig(raw: unknown): AiAppearanceConfig {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const groupsRaw = (rec.groups && typeof rec.groups === 'object' ? rec.groups : {}) as Record<
    string,
    unknown
  >
  const groups = { ...DEFAULT_CONFIG.groups }
  for (const g of SETTING_GROUPS) {
    if (typeof groupsRaw[g] === 'boolean') groups[g] = groupsRaw[g] as boolean
  }
  return {
    enabled: typeof rec.enabled === 'boolean' ? rec.enabled : DEFAULT_CONFIG.enabled,
    groups,
    requireConfirm:
      typeof rec.requireConfirm === 'boolean' ? rec.requireConfirm : DEFAULT_CONFIG.requireConfirm,
  }
}

let config: AiAppearanceConfig = readConfig()

function readConfig(): AiAppearanceConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    return raw ? sanitizeAiAppearanceConfig(JSON.parse(raw)) : { ...DEFAULT_CONFIG }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

const configListeners = new Set<() => void>()

export function getAiAppearanceConfig(): AiAppearanceConfig {
  return config
}

export function saveAiAppearanceConfig(next: AiAppearanceConfig): AiAppearanceConfig {
  config = sanitizeAiAppearanceConfig(next)
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  } catch {
    /* storage unavailable — keep the in-memory value */
  }
  for (const fn of [...configListeners]) fn()
  return config
}

export function subscribeAiAppearance(fn: () => void): () => void {
  configListeners.add(fn)
  return () => {
    configListeners.delete(fn)
  }
}

/** React binding for the settings page. */
export function useAiAppearanceConfig(): AiAppearanceConfig {
  return useSyncExternalStore(subscribeAiAppearance, getAiAppearanceConfig, getAiAppearanceConfig)
}

// ---------------------------------------------------------------------------
// Op handling
// ---------------------------------------------------------------------------

interface UiToolRequest {
  id: number
  op: string
  args?: Record<string, unknown>
}

export interface UiToolOutcome {
  settings?: unknown
  applied?: Record<string, unknown>
  previous?: Record<string, unknown>
  undoId?: string
  /** When true, Rust pauses the agent loop for user confirmation and re-runs
   *  the very same call with force=true once the user approves. */
  needsConfirmation?: boolean
  op?: string
  changes?: Record<string, unknown>
  error?: string
}

/** Groups touched by a change map (for the whitelist check). */
function groupsOf(keys: string[]): SettingGroup[] {
  const defs = new Map(listSettingDefs().map((d) => [d.key, d.group]))
  const out: SettingGroup[] = []
  for (const k of keys) {
    const g = defs.get(k)
    if (g && !out.includes(g)) out.push(g)
  }
  return out
}

/** Pure-ish handler (exported for tests): never throws, always returns JSON-able. */
export async function handleUiToolRequest(op: string, args: Record<string, unknown>): Promise<UiToolOutcome> {
  const cfg = getAiAppearanceConfig()

  if (op === 'get') {
    return { settings: readSettings(args.keys) }
  }

  if (op !== 'set' && op !== 'reset') {
    return { error: `Unknown UI tool op "${op}".` }
  }

  if (!cfg.enabled) {
    return { error: 'The user has disabled AI appearance changes in Settings.' }
  }

  try {
    let changes: Record<string, unknown>
    if (op === 'reset') {
      // Reset the requested keys (or every registered key) to their defaults.
      const keys = Array.isArray(args.keys) && args.keys.length > 0
        ? args.keys.map(String)
        : listSettingDefs().map((d) => d.key)
      changes = {}
      const defs = new Map(listSettingDefs().map((d) => [d.key, d]))
      for (const k of keys) {
        const def = defs.get(k)
        if (!def) return { error: `Unknown setting key "${k}".` }
        changes[k] = def.default
      }
    } else {
      if (!args.changes || typeof args.changes !== 'object' || Array.isArray(args.changes)) {
        return { error: '"changes" must be an object of setting key → value.' }
      }
      changes = args.changes as Record<string, unknown>
    }

    // Whitelist: every touched group must be permitted.
    const denied = groupsOf(Object.keys(changes)).filter((g) => !cfg.groups[g])
    if (denied.length > 0) {
      return { error: `The user has not allowed AI changes to: ${denied.join(', ')}.` }
    }

    // "Appearance changes need confirmation": reuse the existing
    // needsConfirmation loop. Rust re-runs the same call with force=true after
    // the user approves, at which point we apply it here.
    if (cfg.requireConfirm && args.force !== true) {
      return { needsConfirmation: true, op, changes }
    }

    const res = applySettingChanges(changes, 'ai')
    return { applied: res.applied, previous: res.previous, undoId: res.undoId }
  } catch (e) {
    return { error: e instanceof SettingError ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// Installer (App.tsx top level)
// ---------------------------------------------------------------------------

/**
 * Install the bridge. Returns a disposer. Idempotent per request id (a replayed
 * event is ignored). The Rust side also drops late results, so a duplicate
 * answer is harmless.
 */
export function installAiUiBridge(): () => void {
  const processed = new Set<number>()
  let unlisten: (() => void) | undefined
  let disposed = false

  listen<UiToolRequest>('ai-ui-tool-request', (ev) => {
    const payload = ev.payload
    if (!payload || typeof payload.id !== 'number') return
    if (processed.has(payload.id)) return
    processed.add(payload.id)
    void (async () => {
      let outcome: UiToolOutcome
      try {
        outcome = await handleUiToolRequest(payload.op, payload.args ?? {})
      } catch (e) {
        outcome = { error: String(e) }
      }
      try {
        // The Rust side parses this as JSON; always send a string.
        await aiUiToolResult(payload.id, JSON.stringify(outcome))
      } catch {
        /* Rust already timed out — nothing to do */
      }
    })()
  }).then((un) => {
    if (disposed) un()
    else unlisten = un
  })

  return () => {
    disposed = true
    unlisten?.()
  }
}
