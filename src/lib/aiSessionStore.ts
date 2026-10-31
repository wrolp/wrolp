// AI conversation persistence preferences + the per-scope "last active
// session" map. Display-ish prefs live in localStorage (following the other UI
// prefs), and the active-session map remembers which persisted session each
// conversation scope (a connection, a local terminal, or the global chat) was
// last using — so a restore can reopen the right one without scanning files.

import type { AiStoredMessage, ConnectionConfig, TabInfo } from '../types'
import type { ChatMessage } from '../aiChatRun'

const PERSIST_KEY = 'wrolp-ai-session-persist'
const RESTORE_KEY = 'wrolp-ai-session-restore'
const ACTIVE_KEY = 'wrolp-ai-active-session'

export const AI_SESSION_PERSIST_DEFAULT = true
export const AI_SESSION_RESTORE_DEFAULT = true

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* storage unavailable — keep the in-memory value */
  }
}

export const loadAiSessionPersist = (): boolean => readFlag(PERSIST_KEY, AI_SESSION_PERSIST_DEFAULT)
export const saveAiSessionPersist = (v: boolean): void => writeFlag(PERSIST_KEY, v)
export const loadAiSessionRestore = (): boolean => readFlag(RESTORE_KEY, AI_SESSION_RESTORE_DEFAULT)
export const saveAiSessionRestore = (v: boolean): void => writeFlag(RESTORE_KEY, v)

/** The active-session map: `{ [scopeKey]: sessionId }`. */
export function loadActiveAiSession(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function saveActiveAiSession(scopeKey: string, sessionId: string): void {
  try {
    const map = loadActiveAiSession()
    map[scopeKey] = sessionId
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

/** The durable subset of a chat message written to disk (transient `flow` /
 *  `error` dropped — they are rebuilt on restore). */
export function toStoredMessage(m: ChatMessage): AiStoredMessage {
  const stored: AiStoredMessage = { id: m.id, role: m.role, content: m.content }
  if (m.images && m.images.length) stored.images = m.images
  if (m.toolCalls && m.toolCalls.length) stored.toolCalls = m.toolCalls
  return stored
}

/** Rebuild a display message from a stored one (transient fields left unset). */
export function fromStoredMessage(m: AiStoredMessage): ChatMessage {
  const msg: ChatMessage = { id: m.id, role: m.role, content: m.content }
  if (m.images && m.images.length) msg.images = m.images
  if (m.toolCalls && m.toolCalls.length) msg.toolCalls = m.toolCalls
  return msg
}

/** The first user message's text (used to auto-title a session). */
export function firstUserMessage(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  return first ? first.content.slice(0, 40) : ''
}

/** The "last active session" scope for a conversation: a connection, a local
 *  terminal entry, a tab type (serial/telnet), or the global chat. */
export function aiScopeKey(tabId: number | null, tabs: TabInfo[]): string {
  if (tabId == null) return 'global'
  const tab = tabs.find((t) => t.tabId === tabId)
  if (tab?.connectionId) return `conn:${tab.connectionId}`
  if (tab?.tabType === 'localShell' && tab?.localShellEntryId) {
    return `local:${tab.localShellEntryId}`
  }
  return `type:${tab?.tabType ?? 'terminal'}`
}

export interface AiConvContext {
  tabId: number | null
  connectionId: string | null
  connectionName: string | null
  workspaceId: string | null
}

/** The save context (connection + workspace) for a conversation bound to `tabId`. */
export function aiConvContext(
  tabId: number | null,
  tabs: TabInfo[],
  connections: ConnectionConfig[],
): AiConvContext {
  if (tabId == null) {
    return { tabId: null, connectionId: null, connectionName: null, workspaceId: null }
  }
  const tab = tabs.find((t) => t.tabId === tabId)
  const connectionId = tab?.connectionId ?? null
  const connectionName = tab?.connectionName ?? null
  const workspaceId = connectionId
    ? (connections.find((c) => c.id === connectionId)?.workspaceId ?? null)
    : null
  return { tabId, connectionId, connectionName, workspaceId }
}
