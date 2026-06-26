# SSH Terminal

Tauri 2 + React + TypeScript desktop SSH terminal client, using a pure Rust SSH library to connect directly to remote servers.

## Features

- SSH connection management (CRUD connection configs)
- Interactive terminal (xterm.js rendering)
- Persistent connection configs (JSON file)
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

No extra dependencies.

### Windows

No extra dependencies.

## Installation

### 1. Install Rust Toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. Install Frontend Dependencies

```bash
npm install
or
yarn
```

## Development

```bash
npm run tauri dev
or
yarn tauri dev
```

Tauri 2 auto-starts the Vite dev server via `beforeDevCommand` before loading the frontend.

## Build

```bash
npm run tauri build
or
yarn tauri build
```

Build output is located at `src-tauri/target/release/bundle/`.

### Clean Rebuild

When changing icons, Tauri config, or encountering cache issues, clean before rebuilding:

```bash
# Clean Rust build cache
cd src-tauri && cargo clean && cd ..

# Clean Tauri dev cache
rmdir /s /q src-tauri\target          # Windows
# rm -rf src-tauri/target              # macOS / Linux

# Rebuild
yarn tauri build
# or npm run tauri build
```

## Project Structure

```
├── src/                          # Frontend source
│   ├── App.tsx                   # Main app component
│   ├── main.tsx                  # Entry point
│   ├── types.ts                  # TypeScript type definitions
│   ├── commands.ts               # Tauri command wrappers
│   ├── styles/                   # SCSS styles
│   │   ├── index.scss            # Global base styles
│   │   ├── App.scss              # App layout & component styles
│   │   └── _variables.scss       # Shared variables (colors etc.)
│   └── components/
│       ├── ConnectionManager.tsx # Connection manager (sidebar)
│       └── Terminal.tsx          # xterm.js terminal component
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # App entry
│   │   ├── lib.rs                # Module entry & Tauri config
│   │   ├── commands.rs           # Tauri commands (SSH connect/disconnect/input/poll)
│   │   ├── ssh_session.rs        # SSH session state management
│   │   └── ssh_test.rs           # Standalone russh test binary
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # Tauri configuration
│   └── build.rs                  # Build script
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Tech Stack

- **Frontend**: React 19 + TypeScript + xterm.js + Vite + SCSS
- **Backend**: Tauri 2 + Rust (tokio) + russh
- **SSH Implementation**: Pure Rust [russh](https://github.com/warp-tech/russh) async SSH client library
- **IPC**: Tauri `invoke` commands + frontend polling (workaround for Tauri event system limitations in Windows background tasks)
- **State Storage**: Local JSON file
