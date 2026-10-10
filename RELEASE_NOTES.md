# Wrolp Terminal Release Notes

[中文文档](./RELEASE_NOTES.zh.md) · [English](#)

---

## v0.0.10 — 2026-10-11

Gives the terminal something to complete from: command history is persisted and reachable from every pane, a grey tail continues what you are typing, and the commands installed on each device are indexed once and fed into those candidates. Adds a device identity taken from the host key, with an optional strict check and a new Security settings pane. Plus fixes to `ls` links, the live-line recolor, toasts, the file panel's up button and Docker "Enter Shell".

### Features

- **Persisted command history** — every command you run is stored, with the tab type and the host it ran on, and survives closing the terminal or restarting the app; the newest 300 are kept
- **Command-history dropdown** — `⌃ History` in the pane's status bar, or Ctrl+Shift+H for the focused terminal: rows grouped by This terminal / All terminals, ↑/↓ walk the list, Enter puts a command on the input line WITHOUT running it, Esc closes
- **Forget a command** — a ✕ on each row, or Delete / Backspace on the highlighted one, drops it from the persisted history
- **Ghost command completion** — while you type, the likeliest command continues the line in grey after the caret. Candidates are ranked from what has been run in this terminal, the persisted history, your command list and command sets, and what is installed on the device, and each one says where it came from. `→` applies the nearest part of the tail — one space-separated word at a time, so `git s` takes `tatus`, then ` -sb`, and a walk stops where a completion goes wrong — `End` applies the rest, `Alt+/` opens the candidate list where ↑↓ pick and Enter or a click puts the whole command on the line. Inserted, never run. On by default, switchable per terminal from the right-click menu or Settings → Terminal, with a choice of what `→` applies. Serial consoles are left out — they have no line editor to complete into
- **Tab is the shell's again** — the `cd` and command-candidate lists no longer take `Tab`, so path and command completion still reach the shell; the candidate list moved to `Alt+/`
- **Device command index** — the machine a terminal is connected to is enumerated once on first contact and refreshed at most weekly: `compgen` where it exists, with a `$PATH` scan underneath so busybox / ash routers, minimal containers and Windows PowerShell still produce something, capped at 5 000 commands per device. They rank last — anything you have run or saved outranks them. Settings → Terminal reports the count for the focused terminal with "Refresh now" and "Forget this device"; Settings → Data totals commands, devices and the space used
- **Device identity, with strict host key checking** — a session's host key fingerprint is the device's identity (an address can be reused or moved; the key is what says "same box") and appears as a shield chip with the short fingerprint in the status bar. A key that no longer matches raises a toast showing both the recorded and the presented fingerprint, and the new **Settings → Security** pane can refuse such a connection outright instead of only reporting it
- **Welcome page returns to recent hosts** — the host card now lists the six connections used most recently, saved connections and local terminals together, with the protocol tile (SSH / TEL / COM) and a relative time ("just now", "5 min ago", past a week an absolute date), so the page reflects where you actually work instead of sidebar order
- **`cd` suggestions open with nothing selected** — Enter runs what you typed rather than completing a row you never picked; ↑↓ select first and Enter then completes the name, `→` drills in

### Fixes

- Clicking a name in an `ls` / `dir` listing opens the file from the listing under your cursor. Two listings of different directories that share a file name both matched the hovered row, and xterm handed the click to the link stored first — the older listing — so it opened the other directory's file. One link is now built per occurrence and resolved to the entry whose own row is nearest, ties going to the newer listing
- Enter submits what you typed while only a grey tail is showing: the tail is an offer, not a decision, so it no longer inserted the suggestion and swallowed the key. Only a pick from the open candidate list is inserted
- The grey tail no longer vanishes a moment after appearing. A recolor that was still landing on the row briefly made it read as neither a prefix nor an extension of the line, which retired the tail; and once output scrolled or the shell printed a fresh prompt the tail could sit on an unrelated row
- Editing in the middle of a live input line keeps its syntax colouring and leaves the caret where you put it, and the trailing space between two words is no longer eaten by the recolor (`echo hi` came back as `echohi`)
- An error toast holds while the pointer is on it, and dismisses only from its ✕ — which is now keyboard reachable
- A serial or Telnet connection saved before the `kind` field existed opens as itself again: the kind is recovered from the fields only that kind ever writes, so `COM3` is no longer handed to russh as a hostname. Port 23 is deliberately not used as evidence — guessing there would silently downgrade a real SSH server to plaintext
- The file panel's up button walks from the directory the panel opened in all the way to the filesystem root. It had treated the panel's own root as a boundary, so it was grey from the very first frame and after every "Set as root" or jump home; a local pane opened at `""` — really your home — now recovers its displayed path from its own listing, which is what gives it a parent to offer
- Docker "Enter Shell" no longer leaves you at the host shell when the device-identity write lands during the post-connect settle window: the waiting command survives unrelated writes on the tab and is torn down only when the tab closes
- The command palette's dim label colours meet AA contrast
- The `cd` suggestion's folder glyph is drawn from the shared icon set

### Internal

- Five new SQLite tables — `command_history`, `connection_recents`, `hosts`, `connection_hosts`, `host_commands` — with migrations for existing databases
- New backend surface: history list / record / forget, recent connections, host command index collect / refresh / clear / count, and the host key decision taken inside the SSH handshake callback where refusing is still possible
- Device identity is keyed by fingerprint, so it survives the saved connection being renamed, re-grouped or edited; sessions with no host key (local, WSL, serial, Telnet) get a `kind:detail` fallback id
- The enumeration script and its output parser are split so both are testable without a shell; the local machine is never enumerated on behalf of a remote device
- Regression specs added for ghost completion, the `cd` list, command history, device identity, the host command index, `ls` links, toast hover, the file panel's up button, Docker enter-shell and the welcome page
- Version bumped to 0.0.10

---

## v0.0.9 — 2026-09-29

Rebuilds the app shell around an activity rail, a single mode column and a Ctrl+K command palette, and completes the UI redesign — a reskin on new design tokens, a full appearance pane, settings split into one pane per theme, `cd` path suggestions in the terminal, a markdown preview in the editor, and Docker support for a local daemon.

### Features

- **New app shell** — the stacked sidebar sections become an activity rail on the left edge: one mode at a time (hosts, files, transfers, containers, net tools, …) parked in the mode column instead of several panels open at once
- **Ctrl+K command palette** — one entry point for connections, commands, files, the dual-pane view, network scan and settings
- **Welcome page** — with no tab open the main area now shows the ways back in: new SSH connection, local terminal, saved hosts, file transfer, network tools and the command list
- **Dual-pane file view** (Ctrl+Shift+F) — two panes side by side for moving files between places
- **App-wide transfer queue** — transfers no longer live inside the file panel; they are one queue shared with the drawer, so a transfer outlives the panel that started it
- **Net tools docked** — the FTP / HTTP / TFTP tools are a mode in the mode column instead of a floating window
- **Three-column titlebar and a status bar** — workspace selector, tab strip and window controls share one band; the bar at the bottom reports connection state, session details and updates
- **Appearance settings** — accent colour picker, UI font size, density (compact / comfortable), motion (follow system / on / off), focus-visible ring and shape-based status indicators; display preferences apply instantly and are shared with the AI bridge
- **Settings split into one pane per theme** — what used to be a single long "General" scroll is now Appearance / Terminal / Data / Docker / AI / About
- **`cd` suggestions** — while the input line reads `cd <partial path>`, a dropdown under the caret lists that path's real subdirectories (read through the session itself — SFTP, local FS, docker exec, WSL); ↑↓ / Tab / Enter complete the name, and Enter inserts without running it
- **Terminal line numbers** — an opt-in gutter on the left of the terminal, switchable per pane from the pane status bar or the context menu, with the global default in Settings → Terminal and a choice of wrapped-line continuation marker. It takes real width (the remote end sees a resize), and the labels blank out while a full-screen app owns the screen
- **Tail room** — one viewport of scrollable blank space below the last line, so the last line can be scrolled to the top of the view; per-pane and global toggles, off by default
- **Local command output highlighting** — a local shell's command output is highlighted like a remote one (ConPTY input-line repaints are now recognised), `ls` / `dir` listings are coloured by kind while keeping the shell's own colours, and a local prompt stays highlighted
- **Markdown preview in the editor** — split preview for `.md` files, plus sticky-scroll and tail-room / word-wrap toggles, and a "scroll the tail to the top of the view" action
- **Files know where they came from** — the editor toolbar and the tab tooltip name the terminal a file was opened from
- **Docker: local daemon** — the Docker group follows the focused terminal, so a local daemon and a remote host can be used side by side; "Enter Shell" works on local containers too, each running in its own PTY
- **Docker log viewer** — line numbers, and a copy action in the right-click menu that keeps the selection
- **Command list: custom groups** — groups start collapsed and expand as you search; snippets can carry a description and be linked to one another
- **Floating windows resize from every edge and corner** — including the command list, whose handles are now all grabbable

### Fixes

- Version numbers with a trailing `%` are no longer split, and the port / date rules no longer misfire on versions and `file:line`
- A held `cwd` prefix no longer hides what you type
- `clear` uses the shell's native clear for local shells
- Keyboard focus stays in the terminal / editor instead of drifting to the shell chrome
- Light theme: accent text is clamped to AA contrast, and the chat input no longer paints a focus colour
- Docker: the "All" filter no longer collapses the panel, and the log viewer remounts per tab so it shows the right container's logs
- Saving a file refreshes only that file's directory
- Closing a file tab keeps the pane's view in sync
- The welcome page's card grid reflows in a narrow window instead of clipping its right column
- Dock seams (sidebar, drawer, inspector) light up on hover and stay lit while being dragged — each seam has its own drag class, so resizing the inspector no longer lights the sidebar's divider
- Setting hints that still pointed at "Settings → General" now name the pane they actually live on

### Internal

- ESLint configuration added
- The Playwright suite reports frontend coverage
- AI, analysis and command text sizes derive from the `--fs-*` UI font-size tokens
- Per-section collapse switches dropped from the mode column; README updated for the new shell and the MIT license

---

## v0.0.8 — 2026-09-13

Adds a light theme with a decoupled terminal palette, configurable terminal output highlighting, multi-line paste protection, WSL local terminals and an AI appearance bridge — plus a long list of terminal rendering and SSH stability fixes.

### Features

- **Light theme** — dark / light / follow system for the whole UI, applied instantly without a restart: every colour now comes from a CSS-variable token, and the window stays opaque in light mode (translucency over a light desktop looks dirty)
- **Terminal palette decoupled from the UI theme** — "follow interface theme / always dark / always light", so a dark terminal can live under a light UI
- **Terminal output highlighting** — 18 categories (IPv4/IPv6 with CIDR, MAC, UUID, URL, email, number, version, date, time, port, path, hash, error / warning / info / success keywords, TCP states, `$VAR` names) are colourised as output streams in; four built-in schemes (Default, Nord, Solarized, Pastel) plus per-category colours, with any edit switching the scheme to "Custom"
- **Multi-line paste protection** — bracketed paste where the remote supports it, otherwise a dialog asks whether to insert without executing, execute line by line, or cancel; configurable threshold, optional trailing `\` continuation for POSIX shells, and an "always ask / never execute / always execute" mode; serial sessions discard multi-line pastes with a hint, and command snippets now share the same pipeline as Ctrl+V
- **WSL local terminals** — pick a WSL distribution from a dropdown (or leave it as default) and the file panel browses that distribution's filesystem instead of the Windows one; the current directory can be pinned as the entry's startup directory
- **Confirm before closing a terminal with open files** — closing a pane or tab that still has open editors asks first, offering save all / discard all / cancel when something is unsaved; can be turned off in Settings
- **Clear input** — a new terminal context-menu action that erases the shell's current input line (Ctrl+A + Ctrl+K) without submitting it, disabled while the line is empty
- **AI appearance bridge** — the assistant can read and change display settings through `get_ui_settings` / `set_ui_settings` / `reset_ui_settings`: theme, terminal font and cursor, highlight scheme and colours, language. Settings gains a master switch, a per-category whitelist, "ask before applying" and an undo history of the last 20 changes. Credentials, API keys and the data directory stay out of reach, and font changes apply to open terminals immediately
- **Command snippets: parameters, options and connection scope** — snippets can declare parameters and options (value slots with defaults, `=` or space separators, mutually exclusive option groups) and be scoped to a connection; the "General" group now sorts last
- **Wheel scrolling for pane file tabs** — the pane's file/log tab strip scrolls horizontally with the wheel and no longer shows a raw scrollbar

### Fixes

- SSH sessions no longer freeze permanently with keys unresponsive: the PTY channel's bounded inbound queue had no consumer, so its read half is now drained by a background task; the keepalive probe also moved out of the input path and russh's native keepalive is back
- Wrapped command lines no longer erase the previous line or leave stray characters — wrapped input lines are no longer redrawn in place (readline owns that); only single-line input is recoloured
- The second "send straight to terminal" click no longer loses the ` && ` it just typed — the input line is recoloured from xterm's write-completion callback instead of reading a stale buffer
- A stale empty remembered option value no longer shadows its declared default
- `drwxrwxrwx` (other-writable) directories are readable again in the dark theme: low-contrast colour pairs keep their background but get a black or white foreground
- "Analyze Container" logs no longer print raw ANSI escapes and control bytes (cursor moves, screen clears, OSC titles, bell) in either the coloured or the plain-text path
- The hidden `pwd` query is no longer sent before the submitted newline — it could merge with a typed command (`lsecho`)
- Clicking an `ls` entry whose path has since moved now falls back to the current directory
- Windows drive-switch commands (`D:`) are tracked again
- `netstat`'s IPv6 wildcard port (`:::<port>`) is no longer mis-coloured as an IPv6 address
- The AI chat panel is no longer clipped at the right edge by long unbreakable strings
- Real gaps and borders between the terminal area and docked panels
- Session playback skips non-output events
- Recordings are attached to the connection's workspace and group
- Git Bash is located through the registry when it is not on `PATH`, and start-up fails loudly instead of silently
- Command snippet editor fields no longer clip their hints, and allowed-value lists are edited in a textarea

### Internal

- Introduced a generic command-driven filesystem (`CmdFs`) shared by the Docker and WSL backends
- Playwright end-to-end suite grown to 88 cases (theme, paste guard, contrast, highlighting, close guard, AI appearance, WSL, command snippets), plus a self-check script for the paste-guard logic
- Updated Rust and JS dependencies; hardened the redirect guard, timer cleanup and SFTP lifecycle
- Added a Chinese translation of these release notes

---

## v0.0.7 — 2026-09-07

Adds serial (COM) and Telnet sessions, built-in FTP/HTTP/TFTP file tools, a relocatable data directory, and file-based session recordings — plus a round of AI and terminal polish.

### Features
- **Serial port terminal** — connect to COM ports with configurable baud rate, data bits, parity, stop bits, and flow control; each port runs on its own reader thread and shares the same terminal, AI, and recording pipeline as SSH
- **Baud rate auto-detection** — scan common rates and rank the results with a confidence score (runs off the async runtime so the UI stays responsive), plus a dropdown of common rates and custom values
- **Telnet client** — Telnet sessions with IAC negotiation (ECHO, SGA, TERMINAL-TYPE, NAWS) and auto-login; terminal resizes are reported through NAWS
- **Network scanning** — scan a subnet for reachable SSH and Telnet hosts and create connections straight from the results
- **Built-in file transfer tools** — FTP server, HTTP/HTTPS file server with a browser upload page, TFTP server, and FTP / TFTP clients, all reachable from the new "Network tools" button in the titlebar
- **HTTPS self-signed certificate** — generate a certificate and key for the HTTP server with one click
- **Relocatable data directory** — move all app data (database, connections, recordings, config) to a folder of your choice in Settings; the directory is copied on the next start (restart required), with an option to keep `vault.key` next to the data
- **File-based session recordings** — recording events are appended to NDJSON files under `<data dir>/recordings/<workspace>/<group>/<connection>/…jsonl` instead of the SQLite database, keeping `wrolp.db` small and recordings easy to back up
- **Recording management** — session list shows a workspace / group breadcrumb and a "Show in folder" action, one-click migration of legacy recordings still stored in the database, a rescan action that rebuilds the index from the recordings folder, and asciinema v2 (`.cast`) export
- **AI chat improvements** — paste images into the chat input, click thumbnails for a full-size preview, send-to-terminal now works for local shells, serial, and Telnet sessions (text is inserted, not auto-executed), a chat mode selector replaces the read-only flag, endpoint settings live in an accordion, agent rounds can be unlimited, and AI chat is available for Telnet and serial sessions
- **Editor & UI** — configurable maximum file size for opening files in the editor, short container IDs next to container names, shell-specific icons for local terminals, and an easier grab zone for thin scrollbars
- **Database maintenance** — Settings shows the current `wrolp.db` footprint and how much of it is reclaimable, with a "Shrink now" button; deleting sessions now returns the freed pages to disk automatically instead of leaving the database at its old size

### Fixes
- Prevent duplicate terminal tabs for an already-open COM port
- Show the reconnect button on serial tabs
- Skip pager prompts when capturing commands and suspend live coloring on interactive prompts
- Improve prompt / command splitting and recoloring of wrapped command lines
- Apply command-panel opacity to the background only
- Allow clearing numeric settings inputs before committing the value
- Keep the pane terminal tab and its controls visible
- Prevent baud-rate suggestions from being clipped
- Stop dialogs from closing when the overlay is clicked, so an accidental click can't discard input
- Open web links from AI replies (and other markdown) in the OS browser instead of navigating the app's own webview, so there is always a way back to the app

### Internal
- Split the terminal implementation into focused helper modules and reuse a single `ClearableInput` across connection forms
- Add a Playwright end-to-end suite that drives the real UI against a mocked Tauri backend
- Add a user guide and update the README for Telnet, serial, and tunnel support

---

## v0.0.6 — 2026-08-22

Focused on SSH keepalive reliability, terminal rendering quality, and local shell workflows.

### Features
- **Configurable SSH keepalive** — set the keepalive interval (min 10s) and max consecutive failures (min 2) in Settings; persisted to `window.json` and applied to new connections
- **Keepalive probe with suspect status** — actively probe connectivity via a fresh channel (with timeout) so stalled connections are caught; the tab turns yellow ("suspect") after the first failed probe, returns to green when it recovers, and tears down after max consecutive failures
- **Open in File Manager** — right-click a local shell tab (follows the live `cd` cwd) or a local terminal entry in the sidebar to open its directory in the OS file manager
- **Pane duplicate** — right-click a split-pane tab to clone it as a new split pane, supporting SSH sessions, local shells, and Docker terminal sessions
- **Local shell display names** — named local shell entries shown in tab labels
- **Terminal rendering polish** — deferred fit-then-poll so the first frame of output renders at the correct geometry instead of an undersized initial size
- **Bundled nerd font** — ship the MesloLG Nerd Font with the app to fix glyph rendering in the terminal and session replay

### Fixes
- Skip line recolor in alternate-buffer apps (vim, htop, etc.) so full-screen UIs aren't corrupted
- Verify the `cd` target exists before updating the tracked working directory
- Preserve the colored prompt when highlighting the typed command
- Open the user home directory when a local terminal entry has an empty path
- Improve status tooltip readability
- Unify directory picker row styles

### Internal
- Split `commands.rs` into domain-scoped modules (ssh, window, recordings, etc.)
- Code formatting and cleanup across frontend and backend

---

## v0.0.5 — 2026-08-18

Focused on terminal `ls` integration, file transfer performance, SSH tunnels, and Docker container lifecycle management.

### Features
- **Clickable `ls`/`dir` output** — hover tooltips on terminal listings with click-to-open/enter, accurate path resolution from the real working directory, and support for plain multi-column `ls`, `ls -F`, and wrapped lines
- **Nested-session file browsing** — open files and browse directories from `docker exec` shells and nested SSH sessions, tracked via hidden `pwd` probes
- **Terminal output highlighting** — typed commands, table output, command arguments, and post-pipe commands colorized; AI-issued commands show an execution status badge
- **File panel partial refresh** — create, rename, delete, upload, and paste now refresh only the affected directory while preserving expanded subtrees
- **Remote copy/paste** — copy/paste files across directories with conflict prompts; paste files from the clipboard
- **Custom create dialog** — replace native prompts with an in-app dialog for creating files/folders
- **Drag-and-drop directory upload** — upload whole local directories with visual feedback
- **Recursive directory download** — download remote directories over SFTP
- **Chunked streaming uploads** — large file transfers streamed in 4 MB base64 chunks, shared SFTP connections, Rust-side `walkdir` directory streaming, and parallelized transfers
- **Transfer cancellation** — cancel in-flight transfers and directory deletes with progress feedback
- **SSH tunnels** — local port forwarding support with saved tunnel management (CRUD), surfaced forward failures, and auto-stop for refused tunnels
- **Docker container lifecycle** — stop, start, and remove stopped containers, with automatic container-list refresh after actions
- **Floating command snippet list** — floating command snippet panel with persisted panel preferences and append-to-input support
- **Startup directory option** — configure the initial working directory per SSH connection
- **Editor save prompt** — confirm before closing editor tabs with unsaved changes; language options sorted alphabetically
- **Location jump dropdown** — jump to common locations, including local drive roots, with Windows drive path handling
- **Per-target browse persistence** — file panel browse state survives tab switches

### Fixes
- Fix wrapped-line `ls` link detection and hover handling
- Resolve file vs. directory types correctly in `ls` output and terminal `cd` tracking for shell sync
- Improve link tooltip placement near the top edge
- Highlight command args and recolor post-pipe commands in `cmdEcho`
- Avoid empty sessions when recording is disabled
- Improve SFTP upload throughput and Windows drag-and-drop reliability
- Fix transfer row matching and duplicate key issues
- Fix new-item button click position and event propagation in the file panel
- Preserve user-expanded directory state correctly on refresh
- Keep overlays open in split panes when unfocused
- Refresh the Docker container list after actions
- Send snippets to the focused terminal pane and restore focus afterward
- Reduce idle SSH polling and reconnect overhead
- Add acknowledgments section to README

---

## v0.0.4 — 2026-08-08

Adding local terminal support, floating panes, binary file viewing, and AI workflow improvements.

### Features
- **Local terminal** — open PTY-backed shells on your local machine alongside remote SSH tabs, with full AI support
- **Floating panes** — drag any panel (editor, docker logs, hex viewer) out into an independent floating window
- **Hex dump viewer** — inspect binary files as a formatted hex dump with ASCII side-panel
- **Image preview** — view image files (PNG, JPG, GIF, WEBP) directly in the file panel
- **AI prompt templates** — built-in template categories, custom templates with dropdown picker in chat input
- **"Send to terminal"** — send AI-generated code blocks or selected text directly to the active terminal
- **User confirmation for sensitive commands** — AI prompts for confirmation before executing dangerous operations (e.g., `rm -rf`, `docker system prune`)
- **Edit last message** — modify and re-send your last AI chat message, with tool-call history preserved
- **Cancel in-flight AI streams** — stop a running AI response mid-stream
- **Always-on-top toggle** — pin the window above all others
- **Toast notifications** — show brief notifications for Docker container restart events
- **Server label in file panel** — display the connected host name in the file manager header
- **Local terminal entries** — configure named local shell entries in settings
- **HEX/image viewer integrated into tab headers** — seamless switching between file views
- **Improved AI chat UX** — react-markdown rendering, copy buttons on code blocks, simplified icon-only copy button
- **Docker log auto-scroll** — smart scroll anchoring when trimming logs
- **Per-pane session recording toggle** — enable/disable recording per terminal pane; global auto-record setting

### Fixes
- Persist tool calls per assistant message and refocus input after send
- Fall back to local execution when no remote shell is attached to the AI chat tab
- Isolate editor and log tabs per SSH session to prevent cross-session leakage
- Update titlebar icons to Feather style with adjusted spacing
- Support Log4j-style timestamps and improved ANSI color mapping
- Prevent context menu from clipping off-screen
- Fix resize handles on image and hex viewers

---

## v0.0.3 — 2026-08-02

Focusing on internationalization, AI enhancements, and Docker UX.

### Features
- **i18n support** — full English and Chinese (zh) localization; switch language in settings
- **AI endpoint & model picker** — configure OpenAI-compatible endpoint and model per chat session
- **Auto-inject server context** — AI automatically receives current server info; new `get_current_server` tool
- **Per-tab AI chat panels** — docked or floating AI chat windows, one per shell tab
- **Drag-and-drop tab reordering** — reorder tabs by dragging the tab bar
- **Host analysis panel** — gather CPU, memory, disk, network info from remote hosts
- **Docker log viewer enhancements** — ANSI color parsing, right-click "Ask AI Assistant", jump-to-bottom button
- **Docker compose detection** — identify and display compose project context
- **Docker container analysis** — inspect container config, environment, volumes, networks
- **Terminal scrollback control** — configurable max scrollback buffer and clear option
- **AI settings redesign** — tabbed settings layout, dedicated AI config section with new icons
- **Persistent AI chat state** — chat history survives tab switches
- **Configurable Docker log preferences** — line limit, follow mode, auto-scroll
- **Automated release pipeline** — scripts for building, signing, and publishing releases
- **Chinese README** — full translation of project documentation

### Fixes
- Strip leading whitespace from streaming AI text
- Improve dock resize behavior and prevent terminal interference
- Fix multi-column `ls` and `ls -F` output rendering
- Ensure AI edit replaces message and clears tool history correctly
- Sync API key input when switching profiles
- Prevent terminal resize errors during startup

---

## v0.0.2 — 2026-07-28

Significant UI and feature improvements across layout, file management, and security.

### Features
- **Split terminal panes** — split SSH sessions horizontally or vertically with resizable dividers
- **Pane reordering** — drag tabs and panes to rearrange layout
- **Panel docking** — dock any panel (file manager, AI chat, docker logs) to left, right, or bottom
- **Password visibility toggle** — show/hide password in connection form
- **Connection encryption at rest** — securely store SSH passwords and API keys using OS keychain
- **Unified remote filesystem** — shared filesystem abstraction across SSH and Docker targets
- **File transfer progress** — real-time progress bars for upload/download with pause & resume
- **Monaco editor enhancements** — nginx config and properties file language support, minimap toggle, smaller scrollbar
- **Inline remote editing** — open remote files directly from the terminal or file panel
- **Session recording & command sets** — record terminal sessions and save reusable command groups
- **SSH reconnection** — automatic reconnect for stale sessions with monotonic session ID guard
- **Drag-and-drop file upload** — drop files onto the file panel to upload
- **Editable file path input** — type a path directly instead of browsing
- **Workspace layout persistence** — remember split positions and panel states across restarts
- **Terminal status bar** — per-pane size indicator
- **Delete all sessions** — bulk clear with confirmation dialog
- **App icon updates** — refined SVG-based icon set replacing emoji icons
- **Tauri bundle** — MSI installer for Windows (Linux/macOS builds also available)

### Fixes
- Constrain resize handles to image bounds
- Suppress auxiliary channel output leaking into terminal
- Disable minimap by default to reduce visual clutter
- Fix context menu clipping at viewport edges
- Fix SSH key path tilde expansion and default to `~/.ssh/id_rsa`
- Fix tab remount when toggling editor overlay
- Fix Docker panel resize direction

---

## v0.0.1 — 2026-06-28

Initial release.

### Features
- **Multi-tab SSH terminal** using xterm.js with password and SSH key authentication
- **Remote file management** — SFTP file browser with upload/download via `russh-sftp`
- **Remote file editor** — Monaco-based editor with UTF-8/GBK encoding auto-detection
- **Session recording** — auto-record all terminal sessions to SQLite, replayable from the bottom panel
- **Command sets** — save and reuse frequently used command groups
- **Tab management** — drag-to-reorder tabs, duplicate tabs, tab context menu
- **Resizing & layout** — resizable sidebar, split-pane support, docked/floating panels
- **Docker integration** — inspect containers, view logs, enter container shells
- **Host analysis** — gather system info from remote hosts
- **AI assistant** — OpenAI-compatible chat integration with streaming, tool-calling agent loop, and multimodal (image) input
- **System tray** — minimize to tray, show/hide/quit via tray icon
- **Auto-updater** — check for and install updates automatically
- **Window controls** — custom titlebar, transparent/background mode, window geometry persistence
- **Encrypted secrets** — connection credentials encrypted at rest
