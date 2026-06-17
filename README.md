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

## Installation

### System Dependencies (Linux)

```bash
sudo apt-get install -y pkg-config libdbus-1-dev libssl-dev libgtk-3-dev
```

### Install Rust Toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Install Frontend Dependencies

```bash
cd ssh-terminal
npm install
```

## Development

```bash
cd ssh-terminal
npm run tauri dev
```

## Build

```bash
cd ssh-terminal
npm run tauri build
```

## Project Structure

```
ssh-terminal/
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
