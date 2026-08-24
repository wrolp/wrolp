# Wrolp Terminal Release Notes

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
