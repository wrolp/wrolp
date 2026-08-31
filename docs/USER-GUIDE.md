# Wrolp Terminal User Guide

> Operations manual for operators/admins. This document describes the currently implemented features and how to use them — it does not cover unimplemented plans.
>
> For a project overview and build instructions, see the root `README.md`.

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Connection Management](#2-connection-management)
3. [SSH Terminal](#3-ssh-terminal)
4. [Telnet](#4-telnet)
5. [Serial Port (COM)](#5-serial-port-com)
6. [SSH Tunnels](#6-ssh-tunnels)
7. [Local Terminal](#7-local-terminal)
8. [SFTP File Management](#8-sftp-file-management)
9. [Remote File Editor](#9-remote-file-editor)
10. [Hex & Image Viewer](#10-hex--image-viewer)
11. [Split Panes & Floating Windows](#11-split-panes--floating-windows)
12. [Session Recording](#12-session-recording)
13. [Command Sets](#13-command-sets)
14. [Floating Command Snippet List](#14-floating-command-snippet-list)
15. [Docker Containers & Logs](#15-docker-containers--logs)
16. [Host Analysis](#16-host-analysis)
17. [AI Assistant](#17-ai-assistant)
18. [Network Scan](#18-network-scan)
19. [Settings](#19-settings)
20. [Window, Tray & Updates](#20-window-tray--updates)
21. [Data & Security](#21-data--security)

---

## 1. Quick Start

### Installation

- **Windows**: download the `.msi` installer from the releases page and double-click to install (MSI is currently the only bundle target).
- **Linux / macOS**: build from source — see the "Build" section in `README`.

### First Launch

1. On launch you see the main window: connections list on the left, terminal area on the right, sessions/command-set/analysis panels at the bottom, and a custom titlebar on top.
2. Click **+** in the sidebar to add your first SSH connection (see [Connection Management](#2-connection-management)).
3. Double-click a connection (or right-click → **Connect**) to open a terminal session.

---

## 2. Connection Management

### Create / Edit a Connection

Click **+ New Connection** in the sidebar and fill in:

- **Name**: label shown in the connection list.
- **Host / Port / Username**: target. Port defaults to 22.
- **Auth method**: `Password` or `Private key`.
  - Private key: click **Browse** to pick a key file; an optional **passphrase** can be set.
  - Password: toggle **Show/Hide password**.
- **Startup directory**: optional, e.g. `/var/www` — the shell auto-`cd`s here after connect.
- **Group**: pick an existing group or **+ New group…**; leave empty for "Ungrouped".
- **Notes / Description**: optional.

### Connection List Actions

- **Connect**: double-click, or right-click → **Connect**.
- **Split open**: right-click → **Split Right** / **Split Down** to open the terminal in a new split pane.
- **Edit / Delete**: via the right-click menu. Deletions use an in-app confirmation dialog (not the browser `confirm`).
- **Group management**: groups support drag-to-reorder, rename, and delete; deleting a group moves its connections into "Ungrouped".
- **Drag to reorder**: drag a connection to reorder or move it across groups.

---

## 3. SSH Terminal

### Multi-tab

Each connection opens as an independent tab, rendered with xterm.js (`xterm-256color` PTY). Multiple tabs can be open and switched freely.

### Authentication

Password and SSH key authentication are supported.

### Connection Health Indicator

Each tab has a status dot driven by SSH-level keepalive:

- 🟢 Green: connection healthy.
- 🟡 Yellow (suspect): a keepalive probe failed; the connection appears stalled.
- 🔴 Red (closed): retries exhausted; the connection is torn down.

Keepalive interval and max retries are configurable in **Settings → General** (interval min 10s, retries min 2).

### Reconnect

After a disconnect, click **Reconnect** in the tab header to reuse the same tab instance — no need to create a new tab.

### Working Directory Sync

When you type `cd` in the shell, the SFTP file panel follows automatically (the backend probes `pwd` on a throwaway exec channel). Terminal and file browser stay in the same directory.

### Terminal Context Menu

Right-click in the terminal to:

- **Copy / Paste**.
- **Ask AI (selected text)**: send the selection to the AI assistant as context.
- **Add to Command List**: save the selected command into the floating snippet list.

---

## 4. Telnet

- Plain-TCP session (`connect_telnet`) with a lightweight built-in IAC negotiation state machine (ECHO / SGA / TERMINAL-TYPE / NAWS).
- Window resizes are reported to the server via the NAWS sub-option (Telnet has no PTY).
- **Auto-login**: optionally matches `login:` / `Password:` prompts. **Off by default** — Telnet is plaintext and not recommended on untrusted networks.

> Tip: prefer SSH over Telnet when you need encryption.

---

## 5. Serial Port (COM)

### Port Selection

- Available ports are enumerated with friendly names (USB manufacturer / product, VID:PID).
- Pick from the dropdown, or type a custom port name.

### Serial Parameters

Configurable: baud rate, data bits, stop bits, parity, flow control. Baud rate can also be picked from a dropdown of common values.

### Baud-rate Auto-detection

UART has no clock line and no negotiation, so the peer's real rate cannot be read directly. This feature:

1. Probes each common baud rate.
2. Nudges silent devices with a newline.
3. Scores how much the received bytes look like terminal text.
4. Returns candidates ranked by confidence, with a sample preview for you to confirm.

---

## 6. SSH Tunnels

Save local port-forwarding rules per connection and manage them from the sidebar.

### CRUD

Find the tunnel entry in the connection list to **Add / Edit / Delete** a tunnel. Each rule contains:

- **Local port**: the port your machine listens on.
- **Remote host / Remote port**: the target reached via SSH.

Each rule shows its local address and remote target, and is marked active while forwarding.

### Start / Stop

- **Start / Stop**: click the corresponding button in the sidebar.
- The sidebar auto-syncs when a tunnel starts, stops, or dies (even after the tab disconnects).

### Common Failures

If you see "server refused TCP forwarding", check the server's `sshd_config`:

1. `AllowTcpForwarding yes` (or `local`).
2. If `PermitOpen` is set, it must include the target `host:port`.
3. `systemctl restart sshd`, then start the tunnel again.

---

## 7. Local Terminal

Open a shell on your own machine, side by side with remote tabs.

### Add a Local Terminal

In the **Local** section of the sidebar, click **+** and fill in:

- **Name** (optional — defaults to the directory name).
- **Directory**: a local directory to start in.
- **Shell type**:
  - Command Prompt (cmd)
  - PowerShell (pwsh)
  - PowerShell (powershell)
  - Bash
  - WSL
  - Git Bash

### Local Terminal Actions

- **Open**: double-click to open as a top-level tab, or as a split pane in a workspace.
- **Open in File Manager**: right-click a local terminal entry to open its directory in the OS file manager (follows the terminal's live `cd`).
- **Duplicate tab**: right-click a split-pane tab to clone it into a new split.
- **Recent dirs**: recently visited directories are remembered; clear the history or remove individual entries.

> On Windows, the local file browser root maps to the current drive's root.

---

## 8. SFTP File Management

The **Files** panel in the sidebar provides a remote file tree and operations.

### Browsing

- Expand / collapse the tree; jump to **Parent / Home / Root**.
- **Jump to…**: type a path to go directly; the dropdown also offers local drives and common locations.
- **Set current dir as root**: virtually root the tree at the current directory.
- **Set current dir as SSH startup dir**: write the current path back to the connection's startup directory.
- **Shell sync**: enable/disable `cd` sync between terminal and file panel.

### File Operations

- New file / new folder, rename, delete.
- **Upload / Download**: single files and whole folders; **pause / resume** with progress.
- **Drag-and-drop upload**: drop local files or folders onto the panel.
- **Clipboard paste**: paste files from the clipboard; cross-directory copy/paste prompts on conflicts.
- **Custom create dialog**: an in-app dialog (not the native prompt) for creating files/folders.

### Transfer Management

- The transfer list shows in-progress and completed transfers; **Cancel transfer** is supported.
- Bulk deletes show progress (deleted N / M).

### Switch SFTP User

- **Switch SFTP User**: operate files as another account (`switch_sftp_user`).
- **Restore original user**: switch back.

### Jump / Docker Scenarios

The file panel also browses files in:

- **Local SSH sessions**
- **ProxyJump (jump host)**: reach the remote via the local machine.
- **Docker containers**: browse a container's filesystem.

---

## 9. Remote File Editor

- Monaco-based inline editor; opens as a split-pane or a floating window.
- **Encoding auto-detect**: UTF-8 → GBK. Non-UTF-8 files are flagged and must be re-saved in the same charset.
- **Unsaved-changes prompt**: closing a dirty editor asks **Save & Close** / **Discard**.
- **Language selection**: pick syntax highlighting manually (options sorted alphabetically).
- A max open size (MB) is configurable in Settings; oversized files cannot open in the built-in editor.

---

## 10. Hex & Image Viewer

- **Hex view**: binary files opened in the editor can be viewed as a hex dump.
- **Image preview**: image files preview inline (MIME auto-detected by the backend).

---

## 11. Split Panes & Floating Windows

### Split Layout

The terminal area is a split-tree: tabs can be split **horizontally / vertically**, and each leaf shows a terminal, a Docker log, or an open file editor.

### Floating Windows

- Any pane can be **popped out** into an independent floating window.
  - Terminal float: detaches the leaf from the tree (the session stays alive).
  - File-editor / Docker-log float: renders as an overlay above the still-mounted shell; closing the float restores the original view.
- Floating windows support **dock** (left/right/top/bottom) and **close**.

### Per-session Isolation

Open files and Docker logs are isolated per tab — files opened in session A do not appear in session B.

### Duplicate Tab

Right-click a split-pane tab → **Duplicate tab** to clone it into a new split (supports SSH, local shell, and Docker terminal sessions).

---

## 12. Session Recording

### Enabling

- **Auto-record** is on by default (starts when an SSH connection opens). Disable it in **Settings**, or toggle per-panel with the record button.
- Globally disable with the env var `WROLP_RECORDING=0` (or `false`).

### Content

- Events are buffered in memory and flushed to SQLite every 5s and on disconnect.
- Two event kinds: `input` (raw keystrokes) and `command` (full command line captured on Enter, preserving tab-completed text).

### Replay & Management

The **Recordings** panel at the bottom:

- Lists all session recordings (grouped by connection, with counts).
- **Replay**: watch in the replay area; supports **step forward / step back** and **end**.
- **Extract commands**: pull command lines out of a recording.
- **Delete**: single, or **Delete all sessions** (irreversible).

---

## 13. Command Sets

Save reusable command groups, optionally scoped to a connection, in SQLite.

### Create / Edit

The **Command Sets** panel at the bottom:

- **Name**: e.g. "Server health check".
- **Connection (optional)**: leave empty for "General" (visible to all connections).
- **Commands**: one per line, e.g.:
  ```
  ls -la
  df -h
  free -m
  ```

### Execute

- **Execute in active terminal**: sends the commands one by one to the current terminal (connect first).

---

## 14. Floating Command Snippet List

A floatable panel for saving and quickly sending single commands to the terminal.

### Add

- Select text in the terminal or AI chat → right-click **Add to Command List**.
- Or click **Add command** inside the panel; supports an **alias** (e.g. "Check disk usage" → `df -h`).

### Find & Organize

- **Search**: filter by keyword.
- **Favorite only**: show only favorites.
- **Show hidden**: reveal hidden snippets.
- Each snippet can be **favorite/unfavorite**, **hide/unhide**, **delete**.

### Variables

- Write variables in a command, e.g. `ssh {user}@{host}`.
- Before sending, a **Fill variables** dialog prompts for the current values.
- **Variable manager**: define global variables (name, default, description) reused across snippets. Variable names must start with a letter or underscore and contain only letters, digits, and underscores.

### Send

- Click a snippet to send it to the terminal (press Enter to execute).
- Panel opacity is adjustable.

---

## 15. Docker Containers & Logs

The **Docker** panel in the sidebar / bottom (requires a connected server with Docker).

### Container List

- Shows running containers by default; check **All** to include stopped ones.
- Per container: **Start / Stop / Restart / Delete** (delete only on stopped containers, irreversible).
- The list auto-refreshes after an action.

### Analyze Container

Right-click a running container → **Analyze container** to see:

- Overview (image, command, Compose project/service/config/workdir, etc.).
- Ports, mounts, environment, processes (PID / CPU% / MEM% / command).
- Resource usage (CPU, memory, network IO, block IO, PIDs).

### View Logs

- **View logs**: stream a container's logs; supports **auto-wrap / follow newest / tail N lines / refresh**.
- Logs can be opened as a dedicated **log tab** and **popped out** into a floating window.
- On reconnect, the original `docker exec` (or similar) command is re-sent automatically to keep the pane consistent.

### Enter Shell

Right-click a container → **Enter Shell** to get an interactive terminal in that container.

---

## 16. Host Analysis

The **Analysis** panel at the bottom (connect to a host first).

### Analyze Host

Click **Analyze Host** for a read-only overview:

- OS, kernel, architecture, hostname, package manager.
- Detected common tools (count + list).
- Installed packages (searchable; shows the first N of M).

### Command Help

- Look up a command's `--help` / man-page text **on that server** (`command_help`) — handy for offline hosts.

---

## 17. AI Assistant

Open via the **AI Chat** button in the titlebar or the tab. Two modes:

- **Chat**: non-streaming Q&A.
- **Agent**: streaming with tool-calling; can run read-only / restricted actions on connected servers.

### Configuration (Settings → AI)

- Save multiple **endpoints** (`AiEndpointProfile`), each with: API key, base URL, model, system prompt.
- Pick one as the **active endpoint**.
- **Fetch models**: pull the model list from `{endpoint}/v1/models` to populate the dropdown; manual entry is always available.
- API keys are encrypted at rest via an AES-256-GCM file vault (machine-specific `vault.key`; no OS keyring).

### Usage

- **Multimodal**: attach images to a message so the model can reason about screenshots/diagrams.
- **Templates**: built-in categories (Troubleshoot / Security / Backup & cron / Performance & network), plus custom templates (with categories, hide/restore).
- **Edit & re-send**: edit any past message and re-run it.
- **Stop**: abort an in-flight generation; resume from where it stopped.
- **Send to terminal**: Bash code blocks in assistant messages offer one-click **copy**, or **send to terminal** to execute.
- **Tool cards**: tool calls are grouped under their assistant message, with status `pending → executing → done/error`; expand to view args and results.
- **Sensitive-command confirmation**: destructive commands prompt **Allow / Deny** before executing.

### Behavior Toggles

- **Read-only mode**: when on, the AI defaults to running only view-type commands (status, logs, reads); mutating commands are blocked. Toggle "read-only / writable" at the top of the panel.
- **Run in terminal**: when on, AI commands are typed into the current terminal like manual input (visible, recorded, shares cwd/env/sudo). When off, they run silently in the background (exit code only). Falls back to silent execution when no active terminal exists.
- **Max rounds**: caps the number of "assistant reply + tool call" rounds in one agent loop (default 200; 0 = unlimited) to prevent loops.

### Terminal Integration

- Select text in the terminal → right-click **Ask AI (selected text)** to send it as context.
- Docker logs support **Ask AI (all logs)** or (selected text).

> If no AI endpoint is configured, you'll be prompted to configure one in Settings.

---

## 18. Network Scan

Open the dialog via the **Scan Network** button above the connection list to discover open SSH/Telnet services in a subnet and add them as connections.

### Inputs

- **Target**:
  - CIDR: `192.168.1.0/24`
  - Single IP: `10.0.0.5`
  - End-range: `192.168.1.10-192.168.1.20`
- **Ports**: comma-separated, e.g. `22,2222`.
- **Group (optional)**: which group scanned connections go into (can create a new one).
- **Advanced**: timeout (ms), concurrency.

### Scanning

- Click **Start Scan**; the progress bar shows "probed N/M".
- The results table lists only **open** ports: open marker, IP, port, service (SSH/Telnet/unknown), banner, latency.
- The table header is sticky; only the body scrolls.

### Add

- Each row has an **Add** button to create a connection from that host (reuses the new-connection flow).
- **Add All** imports every result at once.

> Only scan networks you are authorized to access.

---

## 19. Settings

Click the **Settings** icon in the titlebar.

### General

- **Window opacity**: main window transparency.
- **Max scrollback lines**: terminal scrollback (applies to new tabs).
- **Max openable file size (MB)**: files above this cannot open in the built-in editor.
- **Language**: UI language.
- **SSH keepalive interval (s)** / **SSH keepalive retries**.
- **Auto-record sessions**: toggle.
- **Docker logs**: auto-wrap, follow newest, max retained lines.
- **Updates**: check for updates, download & install.
- **About**: version/build info, **Open config directory**.

### AI

See [AI Assistant → Configuration](#17-ai-assistant).

---

## 20. Window, Tray & Updates

- **Custom titlebar**: minimize / maximize (restore) / always-on-top / settings.
- **Always-on-top**: toggle from the titlebar.
- **Opacity**: adjustable in Settings and persisted.
- **Tray icon**: closing the main window hides to tray by default (rather than quitting).
- **Window state persistence**: position, size, and opacity are restored after restart.
- **Auto-updater**: prompts to download & install when a new version is detected (a real pubkey must be configured before shipping — see `README`).

---

## 21. Data & Security

### Storage Location

All data lives under `wrolp-terminal/` in the OS config directory:

- `window.json`: window geometry, opacity, recording & keepalive settings.
- `connections.json`: connection and workspace configs (**encrypted**).
- `wrolp.db`: SQLite (WAL mode) for session recordings and command sets.
- `vault.key`: machine-specific encryption key file.

### Encryption

- Connection configs and AI API keys are encrypted via an **AES-256-GCM** file vault — **no OS keyring** is used.
- `vault.key` is therefore the decryption key: keep it together with your config when migrating/backing up; losing it means existing credentials cannot be decrypted.

### Recording & Privacy

- Session recording is on by default and captures keystrokes and commands. To opt out, disable "Auto-record sessions" in Settings, or set `WROLP_RECORDING=0` globally.
- Recording data is stored in the local SQLite database and is never uploaded anywhere.

---

> If the documentation disagrees with actual behavior, the app's behavior prevails (per the "trust the code" principle in `README`).
