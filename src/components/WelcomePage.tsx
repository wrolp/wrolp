import { useEffect, useMemo, useState } from 'react'
import type { ConnectionConfig, LocalTerminalEntry, RecentConnectionEntry } from '../types'
import { useI18n } from '../i18n'
import { listRecentConnections } from '../commands'
import { formatRelativeTime } from '../lib/format'
import { Icon } from './Icon'

/**
 * How many hosts the card lists.
 *
 * Six is a judgement, not a limit. The card sits in an auto-fit grid
 * (`minmax(min(240px, 100%), 1fr)`, max-width 880px), so on a wide window it is
 * one of three ~285px columns and a much taller list unbalances the row without
 * telling the user anything new. Six is also the smallest count at which the
 * ordering reads as *recent* rather than as sidebar order — with four, the two are
 * indistinguishable whenever they overlap, which was the whole problem.
 *
 * Still a fixed cap, and deliberately not a scroll area: a scrolling list here is
 * the sidebar again, in a place with no way to reach the rest of it.
 */
const RECENT_LIMIT = 6

/** The protocol letters, matching the sidebar's `.conn-icon` tiles. These three
 *  abbreviations are identical in both locales, which is why they are not behind
 *  `t()` — same reasoning as the sidebar's own tiles. */
function protoOf(conn: ConnectionConfig): { cls: string; text: string } {
  if (conn.kind === 'telnet') return { cls: 'wl-proto-telnet', text: 'TEL' }
  if (conn.kind === 'serial') return { cls: 'wl-proto-serial', text: 'COM' }
  return { cls: 'wl-proto-ssh', text: 'SSH' }
}

/** The id the backend stores a local terminal under, and the one the built-in
 *  "open local shell" row uses — it has no saved entry of its own. */
const LOCAL_PREFIX = 'local:'
const DEFAULT_LOCAL_ID = '__default__'

/** One rendered row. `usedAtMs` is null for the fallback rows (saved hosts with
 *  no usage record), which is what suppresses the timestamp cell. */
type RecentRow =
  | { kind: 'connection'; conn: ConnectionConfig; usedAtMs: number | null }
  | { kind: 'local'; entry: LocalTerminalEntry; usedAtMs: number | null }

/**
 * The empty state for the main area — v8's `welcome.html`.
 *
 * It replaces the terminal stage only while there is no tab at all: a window
 * whose tabs were all closed has nothing to show but the ways back in, and an
 * empty black rectangle is the least useful answer to that.
 */
export interface WelcomePageProps {
  connections: ConnectionConfig[]
  /** Saved local terminals, so a recency row recorded for one of them resolves.
   *  Global (not workspace-scoped), like the sidebar's own list. */
  localTerminals: LocalTerminalEntry[]
  /** The active workspace, so switching it re-reads the recency list. Resolved
   *  against the connections the backend has — never passed down as a filter. */
  activeWorkspaceId: string
  onOpenConnection: (conn: ConnectionConfig) => void
  onNewConnection: () => void
  /** No argument opens the built-in default shell; an entry reopens that one. */
  onOpenLocalTerminal: (entry?: LocalTerminalEntry) => void
  onOpenFiles: () => void
  onOpenNetTools: () => void
  onOpenCommandList: () => void
  onScanNetwork: () => void
}

export function WelcomePage({
  connections,
  localTerminals,
  activeWorkspaceId,
  onOpenConnection,
  onNewConnection,
  onOpenLocalTerminal,
  onOpenFiles,
  onOpenNetTools,
  onOpenCommandList,
  onScanNetwork,
}: WelcomePageProps) {
  const { t } = useI18n()

  // Read here rather than held above, because this component *is* the moment the
  // list is needed: it exists only while there is no tab, so closing every tab
  // remounts us and re-reads, and a workspace switch changes the dependency. No
  // polling, and no invalidation to wire for deletes — see the join below.
  const [recentConnections, setRecentConnections] = useState<RecentConnectionEntry[]>([])
  useEffect(() => {
    let live = true
    listRecentConnections()
      .then((rows) => {
        if (live) setRecentConnections(rows)
      })
      .catch((err) => console.error('Failed to load recent connections:', err))
    return () => {
      live = false
    }
  }, [activeWorkspaceId])

  const recent = useMemo<RecentRow[]>(() => {
    const byId = new Map(connections.map((c) => [c.id, c]))
    const localsById = new Map(localTerminals.map((l) => [l.id, l]))
    const used = recentConnections
      // A row whose connection was deleted — or moved to another workspace, and
      // is therefore absent from this `connections` list — resolves to nothing and
      // drops out here. That is the whole dangling-row defence on this side. A
      // local row drops out the same way once its entry is gone.
      .map((r): RecentRow | null => {
        if (r.kind === 'localTerminal' || r.connectionId.startsWith(LOCAL_PREFIX)) {
          const entryId = r.connectionId.slice(LOCAL_PREFIX.length)
          // The built-in shortcut has no saved entry: it is whatever the default
          // directory and system shell are, reopened with no arguments.
          if (entryId === DEFAULT_LOCAL_ID) {
            return {
              kind: 'local',
              entry: { id: DEFAULT_LOCAL_ID, name: t('openLocalShell'), cwd: '', shell: '' },
              usedAtMs: r.usedAtMs,
            }
          }
          const entry = localsById.get(entryId)
          return entry ? { kind: 'local', entry, usedAtMs: r.usedAtMs } : null
        }
        const conn = byId.get(r.connectionId)
        return conn ? { kind: 'connection', conn, usedAtMs: r.usedAtMs } : null
      })
      .filter((r): r is RecentRow => r !== null)
      .slice(0, RECENT_LIMIT)
    if (used.length > 0) return used
    // No usage history at all — a fresh install, or a workspace nothing has been
    // opened in yet. Fall back to the first saved hosts, so the card stays a way
    // in rather than becoming an empty box.
    return connections
      .slice(0, RECENT_LIMIT)
      .map((conn): RecentRow => ({ kind: 'connection', conn, usedAtMs: null }))
  }, [recentConnections, connections, localTerminals, t])

  return (
    <div className="welcome" data-testid="welcome-page">
      <div className="welcome-hero">
        <img src="/icon-256.png" alt="" className="welcome-brand" />
        <h1 className="welcome-title">{t('welcomeTitle')}</h1>
        <p className="welcome-sub">{t('welcomeSub')}</p>
        <div className="welcome-actions">
          <button type="button" className="btn pri" onClick={onNewConnection}>
            <Icon name="plus" size={14} />
            <span>{t('welcomeNewConn')}</span>
          </button>
          {/* No argument: the built-in default shell, not a saved entry. */}
          <button type="button" className="btn" onClick={() => onOpenLocalTerminal()}>
            <Icon name="desktop" size={14} />
            <span>{t('welcomeLocalTerm')}</span>
          </button>
        </div>
      </div>

      <div className="welcome-grid">
        <section className="welcome-card">
          <div className="welcome-card-head">
            <Icon name="history" size={14} />
            <span>{t('welcomeRecentHosts')}</span>
          </div>
          {recent.length === 0 ? (
            <p className="welcome-empty">{t('welcomeNoHosts')}</p>
          ) : (
            <ul className="welcome-list">
              {recent.map((row) => {
                const key = row.kind === 'local' ? `${LOCAL_PREFIX}${row.entry.id}` : row.conn.id
                const proto =
                  row.kind === 'local' ? { cls: 'wl-proto-local', text: 'LOC' } : protoOf(row.conn)
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() =>
                        row.kind === 'local'
                          ? // The built-in shortcut is not a saved entry, so it is
                            // reopened by passing nothing at all.
                            onOpenLocalTerminal(
                              row.entry.id === DEFAULT_LOCAL_ID ? undefined : row.entry,
                            )
                          : onOpenConnection(row.conn)
                      }
                    >
                      <span className={`wl-proto ${proto.cls}`}>{proto.text}</span>
                      <span className="wl-text">
                        <span className="wl-name">
                          {row.kind === 'local' ? row.entry.name : row.conn.name}
                        </span>
                        <span className="wl-sub mono">
                          {row.kind === 'local'
                            ? row.entry.cwd || t('openLocalShellHint')
                            : row.conn.kind === 'serial'
                              ? `${row.conn.portName || 'Serial'}${
                                  row.conn.baudRate ? ' @ ' + row.conn.baudRate : ''
                                }`
                              : `${row.conn.username ? `${row.conn.username}@` : ''}${row.conn.host}:${row.conn.port}`}
                        </span>
                      </span>
                      {row.usedAtMs !== null && (
                        <span className="wl-when">{formatRelativeTime(row.usedAtMs, t)}</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="welcome-card">
          <div className="welcome-card-head">
            <Icon name="folderOpen" size={14} />
            <span>{t('welcomeSftp')}</span>
          </div>
          <p className="welcome-desc">{t('welcomeSftpDesc')}</p>
          <button type="button" className="btn sm" onClick={onOpenFiles}>
            <span>{t('welcomeSftp')}</span>
          </button>
        </section>

        <section className="welcome-card">
          <div className="welcome-card-head">
            <Icon name="network" size={14} />
            <span>{t('welcomeNetTools')}</span>
          </div>
          <p className="welcome-desc">{t('welcomeNetToolsDesc')}</p>
          <div className="welcome-card-actions">
            <button type="button" className="btn sm" onClick={onOpenNetTools}>
              <span>{t('welcomeNetTools')}</span>
            </button>
            <button type="button" className="btn sm" onClick={onScanNetwork}>
              <span>{t('welcomeScan')}</span>
            </button>
          </div>
        </section>

        <section className="welcome-card">
          <div className="welcome-card-head">
            <Icon name="clipboard" size={14} />
            <span>{t('welcomeCmdList')}</span>
          </div>
          <p className="welcome-desc">{t('welcomeCmdListDesc')}</p>
          <button type="button" className="btn sm" onClick={onOpenCommandList}>
            <span>{t('welcomeCmdList')}</span>
          </button>
        </section>
      </div>
    </div>
  )
}
