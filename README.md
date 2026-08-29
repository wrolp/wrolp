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

**Wrolp Terminal** is a Tauri 2 + React 19 + TypeScript desktop terminal client for SSH, Telnet and serial (COM) ports. The native backend is written in Rust and connects directly to remote servers using the pure-Rust async [`russh`](https://github.com/warp-tech/russh) library. File transfer and remote editing use `russh-sftp`. Windows is the primary target — the release bundle target is MSI only — but the app runs and can be developed on Linux/macOS too.

> **Note**: This README tracks the current state of the code, not a roadmap. When in doubt, trust the code.

## ✨ Highlights

- 🖥️ **Multi-tab SSH terminal** with xterm.js, password/key auth, and a keepalive-driven health indicator
- 🔌 **Telnet & serial (COM)** — plain-TCP sessions with IAC negotiation, and serial ports with auto-detected baud rate
- 🔀 **SSH tunnels** — save local port-forwarding rules per connection and start/stop them from the sidebar
- 💻 **Local terminal** — open shells on your own machine and browse local files, side by side with remote tabs
- 📂 **SFTP file manager** — upload/download with pause & resume, remote file tree
- ✍️ **Remote file editor** (Monaco) with UTF-8/GBK encoding auto-detect
- 🔍 **Hex & image viewer** — inspect binary files as a hex dump or preview images directly
- 🎬 **Session recording** to SQLite, replayable from the bottom panel
- 🐳 **Docker & host analysis** — inspect containers, stream logs, analyze servers
- 🤖 **AI assistant** with tool-calling agent mode, multimodal input, and encrypted API-key storage
- 🪟 **Floating panes & split layout** — split the terminal area any way you like and pop panes out into independent floating windows
- 🪟 **Polished UX** — custom titlebar, tray icon, window geometry persistence, auto-updater

## 📸 Screenshots

### New connection dialog

<p align="center">
  <img src="docs/images/new-connection.png" alt="Wrolp Terminal - New connection dialog" width="720" />
</p>

### AI assistant

<p align="center">
  <img src="docs/images/use-ai.png" alt="Wrolp Terminal - AI assistant analyzing a connected server" width="720" />
</p>

## Features

### SSH terminal
- **Connection management**: CRUD connection profiles, grouping, drag-to-reorder, rename groups. Right-click a connection for connect / edit / delete and split-pane open (right / below); deletes use an in-app confirmation dialog (`ConfirmDialog`), not a browser `confirm()`.
- **Interactive terminal**: xterm.js rendering per tab, multi-tab switching.
- **Authentication**: password and SSH key authentication.
- **PTY**: `xterm-256color` PTY + shell, resize support.
- **Connection health**: an SSH-level keepalive (interval + max retries, configurable in Settings) drives the tab status dot — green → yellow (`connection-suspect`) on a failed probe, red (`connection-closed`) once the retries are exhausted. A **Reconnect** button re-uses the same tab instance; a stale-task guard (`session_id` monotonic counter) prevents a superseded background task from corrupting state.
- **Working directory sync**: SFTP operations stay in sync with `cd` typed in the shell (`poll_working_dir` runs `pwd` on a throwaway exec channel).

### SSH tunnels

- Save local port-forwarding rules on a connection (`TunnelConfig`) and manage them from the sidebar — add, edit, delete, start, stop.
- Each saved rule shows its local address and remote target and is marked active while forwarding.
- The backend emits `tunnel-changed` whenever a tunnel starts, stops or dies, so the sidebar stays in sync (including after a tab disconnects).

### Telnet

- Plain-TCP sessions (`connect_telnet`) with a small built-in IAC negotiation state machine (ECHO / SGA / TERMINAL-TYPE / NAWS).
- Window resizes are reported to the server through the NAWS sub-option (Telnet has no PTY).
- Optional best-effort auto-login that matches `login:` / `Password:` prompts — **off by default**, since Telnet is unencrypted.

### Serial port (COM)

- Enumerates available ports with friendly names (USB manufacturer / product, VID:PID); pick one from the list or type a custom port name.
- Configurable baud rate, data bits, stop bits, parity and flow control; the baud rate can also be picked from a dropdown of common values.
- **Baud-rate auto-detection**: UART has no clock line and no negotiation, so the peer's real rate cannot be read. The backend instead probes each common rate, listens (nudging silent devices with a newline) and scores how much the received bytes look like terminal text — results come back ranked with a confidence score and a sample preview.

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
- Persistent connection configs (`connections.json`, encrypted — it also stores workspaces) and SQLite DB (`wrolp.db`, WAL mode) under the OS config dir + `wrolp-terminal/`.

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

## Testing

### Rust unit & integration tests

```bash
cd src-tauri
cargo test                 # run all Rust unit tests (#[cfg(test)] in local_fs, ai_term, …)
cargo run --bin ssh_test   # standalone russh connectivity probe binary
```

- Backend unit tests live inside each module (e.g. `local_fs.rs`, `ai_term.rs`) using `#[cfg(test)]` + `#[tokio::test]`, covering pure logic (path parsing, protocol (de)serialization, RemoteFs adapters, config validation, …).
- Prefer adding unit tests for pure-logic features; for real network/process behaviour use a standalone binary such as `ssh_test` as a smoke probe.

### Frontend E2E (Playwright + mocked IPC)

E2E is powered by Playwright, Phase 1: the Vite frontend (`yarn dev`) runs in a real browser, and the Tauri backend is stubbed by injecting a fake `window.__TAURI_INTERNALS__` (see `e2e/ui/helpers/tauriMock.ts`) — **no Rust build required** to verify the UI.

```bash
# install Playwright browsers on first run
npx playwright install

# run all E2E
yarn test:e2e              # equivalent to npx playwright test

# custom port (CI, or when 1420 is already taken locally)
E2E_PORT=1430 yarn test:e2e
```

- Specs live in `e2e/ui/` (e.g. `terminal.spec.ts`, `connections.spec.ts`, `command-list.spec.ts`, `app-boot.spec.ts`).
- The backend stub lives in `e2e/ui/helpers/tauriMock.ts`: it returns fixed/parameterised responses keyed by the `invoke` command name, so frontend behaviour can be verified without a real SSH server / file server.

## Tech Stack

- **Frontend**: React 19 + TypeScript + xterm.js + Monaco editor + Vite + SCSS
- **Backend**: Tauri 2 + Rust (tokio) + russh / russh-sftp
- **SSH**: pure-Rust [`russh`](https://github.com/warp-tech/russh) async SSH client
- **IPC**: Tauri `invoke` commands + frontend polling for terminal output (Windows background-task workaround). Tauri events are used only for the few push notifications the UI cannot poll: `connection-closed`, `connection-suspect`, `connection-ok`, `transfer-progress`, `tunnel-changed`, `ai-term-mark`, `native-drag-drop`, `baud-detect-progress`.
- **Storage**: `window.json` (window geometry, opacity, recording and keepalive settings) plus an **encrypted** `connections.json` (connections and workspaces) + SQLite (`wrolp.db`, WAL) for recordings and command sets; encrypted secrets via an AES-256-GCM file vault (no OS keyring).

## Conventions

- Types shared with Rust use `#[serde(rename_all = "camelCase")]` on the Rust side and matching camelCase interfaces in `src/types.ts`.
- Frontend formatting is enforced by Prettier (`.prettierrc`: singleQuote, no semi, printWidth 100) — run `yarn format`.
- Backend commands live in focused submodules under `src-tauri/src/commands/` (e.g. `serial.rs`); a new command must also be registered in the `generate_handler!` list in `src-tauri/src/lib.rs`, and its frontend wrapper goes in `src/commands.ts`.

## License

Released under the [MIT License](./LICENSE). See [LICENSE](./LICENSE) for details.

## Acknowledgements

- [russh](https://github.com/warp-tech/russh) — pure-Rust async SSH client
- [Tauri](https://tauri.app/) — the app framework
- [React](https://react.dev/) — UI library
- [xterm.js](https://xtermjs.org/) — terminal rendering
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — code editor
- …and many other open-source libraries that make this project possible.

