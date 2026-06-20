# SSH Terminal

Tauri 2 + React + TypeScript desktop SSH terminal client, using pure Rust SSH library to directly connect to remote servers.

## Features

- SSH connection management (CRUD connection config)
- Interactive terminal (xterm.js rendering)
- Connection config persistence (JSON file)
- Password authentication support
- Key authentication support (SSH key)
- Multi-tab switching
- Dark theme

## System Dependencies

### Linux (Debian/Ubuntu)

```bash
sudo apt-get install -y pkg-config libdbus-1-dev libssl-dev libgtk-3-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libwebkit2gtk-4.1-dev
```

### macOS

No additional dependencies required.

### Windows

No additional dependencies required.

## Installation

### 1. Install Rust Toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. Install Frontend Dependencies

```bash
npm install
```

## Development

```bash
npm run tauri dev
```

Tauri 2 auto-starts the Vite dev server via `beforeDevCommand` then loads the frontend.

## Build

```bash
npm run tauri build
```

Build output is located at `src-tauri/target/release/bundle/`.

## Project Structure

```
├── src/                          # Frontend source
│   ├── App.tsx                   # Main app component
│   ├── App.css                   # Main styles
│   ├── main.tsx                  # Entry point
│   ├── index.css                 # Global styles
│   ├── types.ts                  # TypeScript type definitions
│   ├── commands.ts               # Tauri command wrappers
│   └── components/
│       ├── ConnectionManager.tsx # Connection manager (sidebar)
│       └── Terminal.tsx          # xterm.js terminal component
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # App entry point
│   │   ├── lib.rs                # Module entry & Tauri config
│   │   ├── commands.rs           # Tauri commands (SSH connect/disconnect/input/polling)
│   │   ├── ssh_session.rs        # SSH session state management
│   │   └── ssh_test.rs           # Standalone russh test binary
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # Tauri config
│   └── build.rs                  # Build script
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Tech Stack

- **Frontend**: React 19 + TypeScript + xterm.js + Vite
- **Backend**: Tauri 2 + Rust (tokio) + russh
- **SSH**: Pure Rust [russh](https://github.com/warp-tech/russh) async SSH client library
- **IPC**: Tauri `invoke` commands + frontend polling (bypasses Tauri event system restriction for Windows background tasks)
- **State storage**: Local JSON file
