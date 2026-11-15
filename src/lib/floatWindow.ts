// Floating a terminal pane into a real OS window.
//
// A popped-out pane is a second webview: its own JS heap, its own xterm instance.
// Two things therefore have to cross the boundary explicitly —
//
//   1. the session itself, which is really a hand-over: output is *polled* per tab,
//      so exactly one window may own the terminal at a time (see the Rust side,
//      `commands/float_window.rs`), and
//   2. the rendered screen, so the pop-out opens with the output the user was
//      reading instead of a blank grid (and the same on dock-back).

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { TerminalComponentProps } from '../components/terminal/types'

/**
 * Everything the float window needs about the session it adopts, but cannot read
 * for itself: the tab metadata and connection fields live in the main window's
 * React state. `Reconnect` needs the whole set — without the connection fields it
 * could only re-attach to whatever is left.
 */
export interface FloatTerminalContext {
  title: string
  /** `localShell` / `ssh` / `serial` / `telnet`. */
  tabType: string
  host?: string
  connectConfig?: TerminalComponentProps['connectConfig']
  isLocal?: boolean
  isSerial?: boolean
  isTelnet?: boolean
  dockerContainer?: string | null
  kubectlExec?: TerminalComponentProps['kubectlExec']
  localCwd?: string
  localShellType?: string
  localDistro?: string
}

/** Payload of `float-window-closed`, emitted by the backend when a float dies. */
export interface FloatClosedEvent {
  /** The window label, which is also the float id the panel tracks. */
  label: string
  /** Session the window showed; null when it was already gone. */
  tabId: number | null
}

/** Query string a float window is opened with (`index.html?float=terminal…`). */
export interface FloatWindowParams {
  kind: 'terminal'
  tabId: number
  label: string
}

/** The float window described by the current URL, or null in the main window. */
export function readFloatParams(search: string = window.location.search): FloatWindowParams | null {
  const params = new URLSearchParams(search)
  if (params.get('float') !== 'terminal') return null
  const tabId = Number(params.get('tab'))
  if (!Number.isFinite(tabId)) return null
  return { kind: 'terminal', tabId, label: params.get('label') ?? `float-${tabId}` }
}

export async function openTerminalFloatWindow(
  label: string,
  tabId: number,
  title: string,
  size: { width: number; height: number },
): Promise<void> {
  await invoke('open_float_window', {
    label,
    title,
    tabId,
    width: size.width,
    height: size.height,
  })
}

export async function closeFloatWindow(label: string): Promise<void> {
  await invoke('close_float_window', { label })
}

/** Bring the main window forward (the AI panel and inspector live there). */
export async function focusMainWindow(): Promise<void> {
  await invoke('focus_main_window')
}

// ===== Split geometry (terminal | AI column) =====
//
// Both bounds scale with the window instead of being two fixed pixel values: a
// fixed maximum is what made the terminal stop shrinking at an arbitrary size on a
// wide window, and kept the column from using space that was plainly there.

/** Persisted width of the AI column. */
export const AI_WIDTH_KEY = 'wrolp-float-ai-width'
/** Below this the chat bubbles stop being readable. */
export const AI_MIN_WIDTH = 240
/**
 * The terminal never goes below this when the AI column is dragged wider. It is a
 * *usable* floor — below roughly a dozen columns nothing lines up — so the seam
 * stopping here is intended, not a stuck drag. Set where the user asked for it:
 * they wanted the terminal able to give up more of the window.
 */
export const TERM_MIN_WIDTH = 120
/** The AI column may take at most this share of the window, whatever the pixels. */
export const AI_MAX_RATIO = 0.9
/** Sanity cap for a remembered width, used before the body width is known. */
export const AI_MAX_WIDTH = 1200

/** The AI column's width bounds for a body of `bodyWidth` px. */
export function aiWidthBounds(bodyWidth: number): { min: number; max: number } {
  if (!(bodyWidth > 0)) return { min: AI_MIN_WIDTH, max: AI_MAX_WIDTH }
  return {
    min: AI_MIN_WIDTH,
    max: Math.max(AI_MIN_WIDTH, Math.min(bodyWidth * AI_MAX_RATIO, bodyWidth - TERM_MIN_WIDTH)),
  }
}

/** Leave the session's rendered screen for the window that picks the tab up. */
export async function putFloatScrollback(tabId: number, data: string): Promise<void> {
  if (!data) return
  await invoke('float_scrollback_put', { tabId, data })
}

/** Take the screen the previous window left behind, if any. */
export async function takeFloatScrollback(tabId: number): Promise<string | null> {
  return await invoke<string | null>('float_scrollback_take', { tabId })
}

/** Leave the tab's context for its float window (see {@link FloatTerminalContext}). */
export async function putFloatContext(tabId: number, context: FloatTerminalContext): Promise<void> {
  await invoke('float_context_put', { tabId, data: JSON.stringify(context) })
}

/** Take that context when the float window boots. */
export async function takeFloatContext(tabId: number): Promise<FloatTerminalContext | null> {
  const raw = await invoke<string | null>('float_context_take', { tabId })
  if (!raw) return null
  try {
    return JSON.parse(raw) as FloatTerminalContext
  } catch {
    return null
  }
}

export async function onFloatWindowClosed(
  handler: (event: FloatClosedEvent) => void,
): Promise<UnlistenFn> {
  return await listen<FloatClosedEvent>('float-window-closed', (e) => handler(e.payload))
}
