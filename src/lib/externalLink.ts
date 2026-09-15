import type { MouseEvent as ReactMouseEvent } from 'react'
import { open } from '@tauri-apps/plugin-shell'

/**
 * Links inside rendered Markdown must never navigate the app's own WebView — the whole
 * UI would be replaced by the target page and there is no way back. So *every* link is
 * stopped from navigating: `http(s)` URLs are handed to the OS browser instead
 * (`shell:allow-open` is in `capabilities/default.json`), everything else (relative
 * paths, `#anchors`, other schemes) simply does nothing.
 *
 * Shared by the AI chat replies (`AiChatPanel`) and the file editor's Markdown preview.
 */
export function handleMarkdownLinkClick(e: ReactMouseEvent, href?: string): void {
  e.preventDefault()
  if (!href || !/^https?:\/\//i.test(href)) return
  open(href).catch(() => {
    // No shell permission / outside Tauri — a plain new tab is still better than
    // replacing the app.
    window.open(href, '_blank', 'noopener,noreferrer')
  })
}
