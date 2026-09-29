import type { ReactNode, CSSProperties } from 'react'

/**
 * Lucide-stroke icons, inlined from lucide-static so no runtime icon font or
 * fetch is needed. Each icon inherits `currentColor` (round caps, 2px stroke
 * from the wrapper below), so it adapts to the active theme. A handful of
 * glyphs the design set has no equivalent for (stop, record, the five shell
 * marks, float/dockBack/inspector) are hand-drawn in the same 24px grid.
 */
export type IconName =
  | 'refresh'
  | 'desktop'
  | 'link'
  | 'folder'
  | 'folderOpen'
  | 'folderUp'
  | 'file'
  | 'arrowUp'
  | 'home'
  | 'pin'
  | 'upload'
  | 'plus'
  | 'lock'
  | 'undo'
  | 'user'
  | 'play'
  | 'pause'
  | 'stop'
  | 'stepBack'
  | 'trash'
  | 'edit'
  | 'download'
  | 'container'
  // The drawer's transfer queue: two opposing arrows — the pair every transfer
  // is one half of (lucide arrow-left-right).
  | 'transfer'
  | 'clipboard'
  | 'copy'
  | 'paste'
  | 'record'
  | 'eye'
  | 'eyeOff'
  | 'search'
  | 'x'
  | 'terminal'
  | 'sparkles'
  | 'send'
  | 'chevronDown'
  | 'settings'
  | 'externalLink'
  | 'minimize'
  | 'panelTop'
  | 'panelBottom'
  | 'panelLeft'
  | 'panelRight'
  | 'float'
  | 'dockBack'
  | 'inspector'
  | 'drag'
  | 'image'
  | 'network'
  | 'check'
  // The activity rail's two modes: a rack for 主机 and a clock-arrow for
  // 会话（`record` is the *recording* dot, a different meaning).
  | 'server'
  | 'history'
  // Shell flavours for local-terminal entries. All five are a terminal window
  // carrying a distinguishing mark, so they stay recognisable as terminals while
  // still telling cmd / PowerShell / bash / WSL / Git Bash apart at 14px.
  | 'shellCmd'
  | 'shellPowershell'
  | 'shellBash'
  | 'shellWsl'
  | 'shellGitBash'

const PATHS: Record<IconName, ReactNode> = {
  // lucide: refresh-cw
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
  // lucide: monitor
  desktop: (
    <>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </>
  ),
  // lucide: link
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  // lucide: folder
  folder: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  // lucide: folder-up (the toolbar's "parent directory" action)
  folderUp: (
    <>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path d="M12 10v6" />
      <path d="m9 13 3-3 3 3" />
    </>
  ),
  // lucide: folder-open
  folderOpen: (
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  ),
  // lucide: file
  file: (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    </>
  ),
  // lucide: arrow-up
  arrowUp: (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  // lucide: house
  home: (
    <>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  // lucide: pin
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </>
  ),
  // lucide: upload
  upload: (
    <>
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </>
  ),
  // lucide: plus
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  // lucide: lock
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  // lucide: undo-2
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </>
  ),
  // lucide: user
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  // lucide: play (stroke triangle, like the design's media row)
  play: <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />,
  // lucide: pause
  pause: (
    <>
      <rect x="14" y="3" width="5" height="18" rx="1" />
      <rect x="5" y="3" width="5" height="18" rx="1" />
    </>
  ),
  // No lucide stop equivalent in the design; a filled square stays filled so the
  // recording row's stop reads at 14px the way the old feather glyph did.
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  // lucide: skip-back
  stepBack: (
    <>
      <path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" />
      <path d="M3 20V4" />
    </>
  ),
  // lucide: trash-2
  trash: (
    <>
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  // lucide: pencil
  edit: (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  // lucide: download
  download: (
    <>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </>
  ),
  // lucide: container
  container: (
    <>
      <path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z" />
      <path d="M10 21.9V14L2.1 9.1" />
      <path d="m10 14 11.9-6.9" />
      <path d="M14 19.8v-8.1" />
      <path d="M18 17.5V9.4" />
    </>
  ),
  // lucide: arrow-left-right — two opposing arrows, the direction pair a
  // transfer is always one half of.
  transfer: (
    <>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </>
  ),
  // lucide: clipboard
  clipboard: (
    <>
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </>
  ),
  // lucide: copy
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  // lucide: clipboard-paste
  paste: (
    <>
      <path d="M11 14h10" />
      <path d="M16 4h2a2 2 0 0 1 2 2v1.344" />
      <path d="m17 18 4-4-4-4" />
      <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </>
  ),
  // Recording dot: deliberately smaller than lucide's circle-dot (r10) — in a
  // session row it is a status pip, not a button.
  record: <circle cx="12" cy="12" r="7" />,
  // lucide: eye
  eye: (
    <>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // lucide: eye-off
  eyeOff: (
    <>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </>
  ),
  // lucide: search
  search: (
    <>
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </>
  ),
  // lucide: x
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  // lucide: square-terminal — the design's terminal glyph (the plain `terminal`
  // has no window frame and reads as nothing at tab-bar sizes).
  terminal: (
    <>
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    </>
  ),
  // cmd.exe — prompt plus the block cursor that is its signature.
  shellCmd: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <polyline points="6.5 9 9.5 12 6.5 15" />
      <rect x="12" y="11" width="4" height="4" rx="0.6" />
    </>
  ),
  // PowerShell — lightning bolt.
  shellPowershell: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M14.2 8.4 10.3 14h2.6l-1 3.6 4-5.7h-2.7l1-3.5z" />
    </>
  ),
  // bash / sh / zsh — dollar prompt.
  shellBash: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M14.8 9.4c-1.2-1-3.5-.8-3.7.9-.2 1.7 3.3 1.5 3.1 3.3-.1 1.7-2.5 1.9-3.7.8" />
      <line x1="12.6" y1="7.8" x2="12.6" y2="16.6" />
    </>
  ),
  // WSL — a terminal hosted inside a windowed (Windows) frame: title-bar rule.
  shellWsl: (
    <>
      <rect x="2.5" y="3.5" width="19" height="17" rx="2" />
      <line x1="2.5" y1="8" x2="21.5" y2="8" />
      <polyline points="6.5 12.5 9 15 6.5 17.5" />
      <line x1="11" y1="17.5" x2="16.5" y2="17.5" />
    </>
  ),
  // Git Bash — the git fork mark.
  shellGitBash: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.8" cy="9.4" r="2" />
      <circle cx="8.8" cy="16.6" r="2" />
      <path d="M8.8 11.4v3.2" />
      <circle cx="15.4" cy="12.9" r="2" />
      <path d="M15.4 10.9c-1.6.2-4 .5-5.2 1.2" />
    </>
  ),
  // lucide: sparkles
  sparkles: (
    <>
      <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
      <path d="M20 2v4" />
      <path d="M22 4h-4" />
      <circle cx="4" cy="20" r="2" />
    </>
  ),
  // lucide: send
  send: (
    <>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </>
  ),
  // lucide: chevron-down
  chevronDown: <path d="m6 9 6 6 6-6" />,
  // lucide: settings
  settings: (
    <>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // lucide: external-link
  externalLink: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  // lucide: minus
  minimize: <path d="M5 12h14" />,
  // Detach a panel into its own window: the front frame sits offset from the
  // surface it leaves. Replaces the `⤢` text glyph, whose size and baseline
  // varied with whatever font the WebView fell back to.
  float: (
    <>
      <rect x="7" y="4" width="13" height="12" rx="1.5" />
      <path d="M17 20H5.5A1.5 1.5 0 0 1 4 18.5V8" />
    </>
  ),
  // Return a floated panel to its column. This is `float` turned 180°, on purpose:
  // the two states of one toggle should read as a pair, not as two unrelated marks.
  dockBack: (
    <g transform="rotate(180 12 12)">
      <rect x="7" y="4" width="13" height="12" rx="1.5" />
      <path d="M17 20H5.5A1.5 1.5 0 0 1 4 18.5V8" />
    </g>
  ),
  // lucide: panel-top
  panelTop: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
    </>
  ),
  // lucide: panel-bottom
  panelBottom: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 15h18" />
    </>
  ),
  // lucide: panel-left
  panelLeft: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  // lucide: panel-right
  panelRight: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </>
  ),
  // Inspector column: lucide has no close cousin the sidebar buttons don't
  // already use, so this stays a hand-drawn rules variant (a right-hand pane
  // with two rows) to keep it distinct from `panelRight`.
  inspector: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M14 3v18" />
      <path d="M16.5 8.5h2.5" />
      <path d="M16.5 12.5h2.5" />
    </>
  ),
  // lucide: grip-vertical
  drag: (
    <>
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="19" r="1" />
    </>
  ),
  // lucide: image
  image: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </>
  ),
  // lucide: network
  network: (
    <>
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
      <path d="M12 12V8" />
    </>
  ),
  // lucide: check
  check: <path d="M20 6 9 17l-5-5" />,
  // lucide: server
  server: (
    <>
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </>
  ),
  // lucide: history
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </>
  ),
}

export function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName
  size?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: 'inline-block', flexShrink: 0, verticalAlign: 'middle', ...style }}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
