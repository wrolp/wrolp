# SSH Terminal

Tauri 2 + React + TypeScript SSH Terminal Connection Tool

## Features

- SSH connection management (CRUD connection configs)
- Interactive terminal (xterm.js rendering)
- Persistent connection configs (JSON file)
- SSH key authentication support
- Password authentication support
- Multi-tab switching
- Dark theme

## System Dependencies

### Linux (Debian/Ubuntu)

```bash
sudo apt-get install -y pkg-config libdbus-1-dev libssl-dev libgtk-3-dev
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

Tauri development requires starting the frontend Vite dev server first, then launching the Tauri desktop app.

### Step 1: Start the frontend dev server

```bash
npm run dev
```

### Step 2: In another terminal window, start the Tauri app

```bash
npm run tauri dev
```

Tauri will automatically detect the frontend service at `http://localhost:1420` and load it.

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
│   │   ├── main.rs               # Tauri entry point
│   │   ├── lib.rs                # Module entry
│   │   ├── commands.rs           # Tauri command implementations
│   │   └── ssh_session.rs        # SSH session management
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # Tauri configuration
│   └── build.rs                  # Build script
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Tech Stack

- **Frontend**: React 19 + TypeScript + xterm.js + Vite
- **Backend**: Tauri 2 + Rust (tokio)
- **State Storage**: Local JSON file
- **SSH Implementation**: Calls system `ssh` binary (via tokio::process::Command)
