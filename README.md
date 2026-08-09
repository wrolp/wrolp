# Wrolp Terminal

<p align="center">
  <img src="src-tauri/icons/512x512.png" alt="Wrolp Terminal" width="128" />
</p>

<p align="center">
  <strong>A Rust-powered desktop SSH terminal and server-ops tool</strong>
</p>

<p align="center">
  <a href="https://github.com/wrolp/wrolp/releases"><img src="https://img.shields.io/github/v/release/wrolp/wrolp?style=flat-square" alt="Release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20Rust-ff4124?style=flat-square" alt="Built with Tauri" />
</p>

[中文文档](./README.zh.md) · [English](#)

**Wrolp Terminal** is a Tauri 2 + React 19 + TypeScript desktop SSH terminal client. The native backend is written in Rust and connects directly to remote servers using the pure-Rust async [`russh`](https://github.com/warp-tech/russh) library. File transfer and remote editing use `russh-sftp`. Windows-first (MSI bundle), but builds on Linux/macOS too.

> **Note**: This README describes the current state of the code. The app has grown well beyond a single-tab JSON terminal — it now includes multi-tab SSH, SFTP file management, a remote file editor, session recording, command sets, Docker/host analysis, an AI assistant with tool-calling, and more.

## ✨ Highlights

- 🖥️ **Multi-tab SSH terminal** with xterm.js, password/key auth, and auto-reconnect
- 💻 **Local terminal** — open shells on your own machine and browse local files, side by side with remote tabs
- 📂 **SFTP file manager** — upload/download with pause & resume, remote file tree
- ✍️ **Remote file editor** (Monaco) with UTF-8/GBK encoding auto-detect
- 🔍 **Hex & image viewer** — inspect binary files as a hex dump or preview images directly
- 🎬 **Session recording** to SQLite, replayable from the bottom panel
- 🐳 **Docker & host analysis** — inspect containers, stream logs, analyze servers
- 🤖 **AI assistant** with tool-calling agent mode, multimodal input, and encrypted API-key storage
- 🪟 **Floating panes & split layout** — split the terminal area any way you like and pop panes out into independent floating windows
- 🪟 **Polished UX** — custom titlebar, tray icon, window geometry persistence, auto-updater

<p align="center">
  <!-- TODO: add a screenshot -->
  <!-- <img src="docs/screenshot.png" alt="Wrolp Terminal screenshot" width="720" /> -->
</p>

## Features

### SSH terminal
- **Connection management**: CRUD connection profiles, grouping, drag-to-reorder, rename groups. Right-click a connection for connect / edit / delete and split-pane open (right / below); deletes use an in-app confirmation dialog (`ConfirmDialog`), not a browser `confirm()`.
- **Interactive terminal**: xterm.js rendering per tab, multi-tab switching.
- **Authentication**: password and SSH key authentication.
- **PTY**: `xterm-256color` PTY + shell, resize support.
- **Reconnect**: reusing a tab reuses the same instance; a stale-task guard (`session_id` monotonic counter) prevents a superseded background task from corrupting state.
- **Working directory sync**: SFTP operations stay in sync with `cd` typed in the shell (`poll_working_dir` runs `pwd` on a throwaway exec channel).

### SFTP file management
- Remote file tree browser (sidebar `FilePanel`).
- List / read / write / rename / delete / create directories.
- Upload and download (file or raw bytes), with **pause / resume** support and `transfer-progress` events.
- Switching the SFTP user (`switch_sftp_user` / `revert_sftp_user`) to operate as a different account.

### Remote file editor
- Monaco-based inline editor for remote files, shown as a split-tree pane or a floating window.
- Encoding auto-detect: UTF-8 → GBK (`encoding_rs`); non-UTF-8 files are flagged and must be re-saved in the same charset.

### Local terminal & local files
- Open a **local shell** as a top-level tab or as a split pane inside an existing workspace (`openLocalShellTab` / `handleOpenLocalSplit`); runs a native shell on your own machine.
- **Local file browser**: navigate and edit files on the local machine through the same `FilePanel` / `FileEditor` UI. A `LocalFs` (`local_fs.rs`) implements the same `RemoteFs` trait as SFTP, so local and remote targets share one code path. On Windows the local root maps to the current drive's root.

### Hex & image viewer
- Binary files opened in the editor can be viewed as a **hex dump** (`hex_base64` + `HexViewer.tsx`).
- Image files are previewed inline; the backend reports the MIME type via `image_mime` / `detect_image_mime`.

### Floating panes & split layout
- The terminal area is a **split-tree** layout (`splitTree.ts`): tabs can be split horizontally or vertically, and each leaf shows a terminal, a docker-log, or an open file editor.
- Any pane can be **popped out** into a floating window (`floatPane` / `FloatingWindow.tsx`, `position: fixed`, z-index starting at 1000). Terminal floats detach the leaf from the tree (the session stays alive); file-editor / docker-log floats render as an overlay above the still-mounted shell and restore `shellView` on close.
- **Per-session view state** (`shellView` / `activeEditorKey` are `Record<number, ...>`) keeps each tab's open files and docker logs isolated — files opened in one session don't appear in another.

### Session recording
- Recording is on by default (disable with `WROLP_RECORDING=0` / `false`).
- Buffers events in memory, flushed every 5s and on disconnect into a SQLite `session_events` table.
- Two event kinds: `input` (raw keystrokes) and `command` (full command line captured on Enter, preserving tab-completed text).
- Browser in the bottom panel (`SessionListPanel` / `SessionViewer`); recordings can be deleted/replayed.

### Command sets
- Save reusable groups of commands (optionally scoped to a connection) in SQLite.
- Managed via `CommandSetPanel` in the bottom panel.

### Docker & host analysis
- `analyze_host`: read-only analysis of a connected server (OS, kernel, arch, packages, installed tools).
- `analyze_docker_container` + `docker_container_logs`: inspect containers and stream their logs (`docker_logs_stream_start` / `poll_docker_logs` / `stop_docker_logs_stream`).
- **Docker log tabs & floating**: a container's logs can be opened as a dedicated log tab and popped out into a floating window. When a tab reconnects, its `postConnectCmd` (e.g. the original `docker exec`) is re-sent automatically so the pane stays consistent across reconnects.
- `command_help`: look up man-page / help text for a command on a connected server.
- UI panels: `DockerPanel`, `DockerLogViewer`, `DockerAnalysisPanel`, `HostAnalysisPanel`.

### AI assistant
- Chat panel (`AiChatPanel`) with two modes:
  - **Chat** (non-streaming `ai_chat_sync`).
  - **Agent** (streaming with tool calling, `run_agent_stream`) — a full agent loop that can call tools on the connected servers.
- **Multimodal input**: attach images to a message (the backend accepts `content` as structured multi-part via `openai_content`), so the model can reason about screenshots, diagrams, etc.
- **Templates & re-send**: insert prompts from a template dropdown next to the image button; **edit and re-send** any previous message (re-runs from the edited content).
- **Pause**: abort an in-flight agent/chat generation with `cancel_ai_chat` and continue from where it stopped.
- **Multiple API endpoints**: save several `AiEndpointProfile`s, each with its own encrypted API key, endpoint URL, model, and system prompt. Select/apply one active profile. Legacy single-endpoint configs are migrated automatically.
- **Model fetching**: `list_ai_models` calls `{endpoint}/v1/models` to populate the model dropdown; manual entry is always available.
- **Agent tools** (dispatched to the Rust backend, which has `AppState` access): `run_command`, `analyze_server`, `list_directory`, `read_file`, `list_connections`, `search_help`, and more. Tool calls are grouped under their assistant message and surfaced as tool cards with lifecycle events (`pending` → `executing` → `done`/`error`). Bash code blocks in assistant messages get a one-click **copy** button.
- **Security**: API keys are encrypted at rest via an AES-256-GCM file vault (`encrypt_api_key` / `decrypt_api_key`). The encryption key is a machine-specific file (`vault.key`); no OS keyring is used.

### Window & shell integration
- Custom titlebar (window `decorations: false`); window geometry/opacity persisted (`window.json`).
- Show/hide on close, tray icon, auto-updater (GitHub release endpoint — set a real `pubkey` in `tauri.conf.json` before shipping).
- Persistent connection configs (`connections.json`) and SQLite DB (`wrolp.db`, WAL mode) under the OS config dir + `wrolp-terminal/`.

## System Dependencies

### Linux (Debian/Ubuntu)

```bash
sudo apt-get install -y pkg-config libdbus-1-dev libssl-dev libgtk-3-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libwebkit2gtk-4.1-dev
```

### macOS / Windows

No extra dependencies.

## Installation

### 1. Install Rust Toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. Install Frontend Dependencies

`yarn.lock` is committed, so prefer `yarn`:

```bash
yarn        # or: npm install
```

## Development

```bash
yarn tauri dev      # or: npm run tauri dev
```

Tauri 2 auto-starts the Vite dev server via `beforeDevCommand` before loading the frontend.

Frontend-only dev server (no Rust/SSH — useful for UI work):

```bash
yarn dev
```

### Debugging the Rust backend

- **Logging**: backend diagnostics use `eprintln!` to stderr (visible in the `yarn tauri dev` terminal). Add `eprintln!("[module] ...")` where needed.
- **Static checks / tests**:
  ```bash
  cd src-tauri
  cargo check                 # type-check
  cargo build                 # debug build
  cargo clippy                # lints
  cargo test                  # all Rust unit tests
  cargo run --bin ssh_test    # standalone russh connectivity probe (src/ssh_test.rs)
  ```
- **Breakpoints**: a `.vscode/launch.json` (`Debug Tauri (dev)`, CodeLLDB extension) builds and launches the binary with `RUST_BACKTRACE=1`. Note it launches a standalone process — don't also run `yarn tauri dev` simultaneously. For most backend work, `eprintln!` logging via `yarn tauri dev` is the usual workflow.
- **Gotchas**: terminal output is polled (`poll_output`) not event-streamed; new `#[tauri::command]`s require a backend rebuild (restart `yarn tauri dev`).

## Build

```bash
yarn tauri build     # or: npm run tauri build
```

Output: `src-tauri/target/release/bundle/`. Bundle target is `["msi"]` only.

### Clean Rebuild

```bash
cd src-tauri && cargo clean && cd ..
# Then:
yarn tauri build
```

## Project Structure

```
├── src/                            # Frontend source
│   ├── App.tsx                     # Single orchestrator: top-level state + layout
│   ├── main.tsx                    # Entry point
│   ├── types.ts                    # TS types shared with Rust (camelCase)
│   ├── commands.ts                 # All Tauri command wrappers (one export per command)
│   ├── styles/                     # SCSS
│   │   ├── index.scss              # Global base styles
│   │   ├── App.scss                # App layout & component styles
│   │   └── _variables.scss         # Shared variables (colors etc.)
│   └── components/
│       ├── Titlebar.tsx            # Custom titlebar (window decorations off)
│       ├── ConnectionManager.tsx   # Connection CRUD, groups, drag-reorder
│       ├── Terminal.tsx            # xterm.js per tab + 100ms poll_output loop
│       ├── FilePanel.tsx           # Remote SFTP file tree
│       ├── FileEditor.tsx          # Monaco-based remote file editor
│       ├── AiChatPanel.tsx         # AI chat / agent UI
│       ├── BottomPanel.tsx         # Sessions + command sets container
│       ├── SessionListPanel.tsx    # Session recordings browser
│       ├── SessionViewer.tsx       # Recording playback
│       ├── CommandSetPanel.tsx     # Command sets UI
│       ├── DockerPanel.tsx         # Docker containers / analysis
│       ├── DockerLogViewer.tsx     # Docker log streaming viewer
│       ├── DockerAnalysisPanel.tsx # Docker analysis results
│       ├── HostAnalysisPanel.tsx   # Host analysis results
│       ├── ConfirmDialog.tsx       # Reusable confirm dialog
│       ├── Icon.tsx                # SVG icons
│       ├── FloatingWindow.tsx      # Detached pane rendered as a floating window
│       ├── HexViewer.tsx            # Hex dump viewer for binary files
│       └── splitTree.ts            # Split-pane tree helpers (horizontal/vertical split layout)
├── src-tauri/                      # Rust backend
│   ├── src/
│   │   ├── main.rs                 # App entry
│   │   ├── lib.rs                  # Tauri builder, plugins, SQLite init, tray, recording flush, invoke_handler
│   │   ├── commands.rs             # All #[tauri::command] handlers
│   │   ├── ssh_session.rs          # AppState, SshSession, SshHandler, ConnectionConfig, TransferControl
│   │   ├── ai.rs                   # AI chat/agent, tool definitions, model fetching
│   │   ├── db.rs                   # SQLite access (recordings + command sets)
│   │   ├── vault.rs                # Encrypted API key storage (AES-256-GCM file vault)
│   │   ├── remote_fs.rs            # SFTP helpers
│   │   ├── local_fs.rs             # Local filesystem (LocalFs, implements RemoteFs trait)
│   │   ├── docker_fs.rs            # Docker log/analysis helpers
│   │   ├── docker_analysis.rs      # Docker analysis logic
│   │   ├── host_analysis.rs        # Host analysis logic
│   │   ├── schema.sql              # SQLite schema
│   │   └── ssh_test.rs             # Standalone russh test binary
│   ├── Cargo.toml
│   ├── tauri.conf.json             # Tauri config (msi bundle, transparent window)
│   ├── capabilities/default.json   # Tauri API permissions
│   └── build.rs
├── scripts/
│   └── generate-icons.mjs          # Regenerate app icons
├── package.json
├── tsconfig.json
├── vite.config.ts
└── yarn.lock
```

## Tech Stack

- **Frontend**: React 19 + TypeScript + xterm.js + Monaco editor + Vite + SCSS
- **Backend**: Tauri 2 + Rust (tokio) + russh / russh-sftp
- **SSH**: pure-Rust [`russh`](https://github.com/warp-tech/russh) async SSH client
- **IPC**: Tauri `invoke` commands + frontend polling for terminal output (Windows background-task workaround). Only `connection-closed` and `transfer-progress` use Tauri events.
- **Storage**: JSON (`connections.json`, `window.json`) + SQLite (`wrolp.db`, WAL) for recordings and command sets; encrypted secrets via an AES-256-GCM file vault (no OS keyring).

## Conventions

- Types shared with Rust use `#[serde(rename_all = "camelCase")]` on the Rust side and matching camelCase interfaces in `src/types.ts`.
- Frontend formatting is enforced by Prettier (`.prettierrc`: singleQuote, no semi, printWidth 100) — run `yarn format`.
- New backend commands must be registered in both `commands.rs` and the `generate_handler!` list in `lib.rs`.

## License

Released under the [MIT License](./LICENSE). See [LICENSE](./LICENSE) for details.

## Acknowledgements

- [russh](https://github.com/warp-tech/russh) — pure-Rust async SSH client
- [Tauri](https://tauri.app/) — the app framework
- [React](https://react.dev/) — UI library
- [xterm.js](https://xtermjs.org/) — terminal rendering
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — code editor
- …and many other open-source libraries that make this project possible.

