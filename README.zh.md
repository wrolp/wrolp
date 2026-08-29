# Wrolp Terminal

<p align="center">
  <img src="src-tauri/icons/512x512.png" alt="Wrolp Terminal" width="128" />
</p>

<p align="center">
  <strong>面向运维人员的桌面端 SSH 终端与服务器管理工具</strong>
</p>

<p align="center">
  <a href="https://github.com/wrolp/wrolp/releases"><img src="https://img.shields.io/github/v/release/wrolp/wrolp?style=flat-square" alt="Release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20Rust-ff4124?style=flat-square" alt="Built with Tauri" />
</p>

[English](./README.md) · [中文](#)

**Wrolp Terminal** 是基于 Tauri 2 + React 19 + TypeScript 的桌面终端客户端，支持 SSH、Telnet 与串口（COM）。原生后端使用 Rust 编写，通过纯 Rust 异步库 [`russh`](https://github.com/warp-tech/russh) 直连远程服务器。文件传输与远程编辑使用 `russh-sftp`。以 Windows 为主要目标平台 —— 发布打包目标仅为 MSI —— 但也可以在 Linux / macOS 上运行与开发。

> **说明**：本 README 记录的是代码当前的状态，而非路线图。如有出入，以代码为准。

## ✨ 功能亮点

- 🖥️ **多标签 SSH 终端** — 基于 xterm.js，支持密码 / 密钥认证与基于保活的连接状态指示
- 🔌 **Telnet 与串口（COM）** — 带 IAC 协商的纯 TCP 会话，以及支持波特率自动检测的串口
- 🔀 **SSH 隧道** — 按连接保存本地端口转发规则，可在侧栏启停
- 💻 **本地终端** — 在本机打开 Shell 并浏览本地文件，与远程标签并排使用
- 📂 **SFTP 文件管理** — 上传 / 下载支持暂停与续传，远程文件树浏览
- ✍️ **远程文件编辑器**（Monaco）— 自动识别 UTF-8 / GBK 编码
- 🔍 **Hex 与图片查看** — 以十六进制转储查看二进制文件，或直接预览图片
- 🎬 **会话录制** — 存入 SQLite，可在底部面板回放
- 🐳 **Docker 与主机分析** — 查看容器、流式日志、分析服务器
- 🤖 **AI 助手** — 支持工具调用 Agent 模式、多模态输入，API Key 加密存储
- 🪟 **浮动窗口与分栏布局** — 自由分割终端区域，并将面板弹出为独立浮动窗口
- 🪟 **精致体验** — 自定义标题栏、托盘图标、窗口状态记忆、自动更新

## 📸 截图

### 新建连接

<p align="center">
  <img src="docs/images/new-connection.png" alt="Wrolp Terminal - 新建连接对话框" width="720" />
</p>

### AI 助手

<p align="center">
  <img src="docs/images/use-ai.png" alt="Wrolp Terminal - AI 助手分析已连接服务器" width="720" />
</p>

## 功能特性

### SSH 终端
- **连接管理**：增删改查连接配置、分组、拖拽排序、重命名分组。可右键连接进行连接 / 编辑 / 删除与分栏打开（右 / 下）；删除使用应用内确认对话框（`ConfirmDialog`），而非浏览器的 `confirm()`。
- **交互式终端**：每个标签使用 xterm.js 渲染，支持多标签切换。
- **认证方式**：支持密码与 SSH 密钥认证。
- **PTY**：`xterm-256color` PTY + Shell，支持窗口大小调整。
- **连接健康状态**：SSH 层保活（间隔与最大重试次数，可在设置中配置）驱动标签状态点 —— 探测失败转黄（`connection-suspect`），重试耗尽转红（`connection-closed`）。通过 **重连** 按钮复用同一标签实例；通过过期的任务守卫（`session_id` 单调递增计数器）防止被取代的后台任务破坏状态。
- **工作目录同步**：SFTP 操作与在 Shell 中输入的 `cd` 保持同步（`poll_working_dir` 会在一次性 exec 通道上执行 `pwd`）。

### SSH 隧道

- 可在连接上保存本地端口转发规则（`TunnelConfig`），并在侧栏管理 —— 增、改、删、启动、停止。
- 每条规则显示其本地地址与远端目标，转发中会被标记为活动状态。
- 隧道启动、停止或异常退出时后端会发出 `tunnel-changed`，侧栏因此保持同步（标签断开后同样适用）。

### Telnet

- 纯 TCP 会话（`connect_telnet`），内置轻量 IAC 协商状态机（ECHO / SGA / TERMINAL-TYPE / NAWS）。
- 窗口尺寸变化通过 NAWS 子选项上报给服务端（Telnet 没有 PTY）。
- 可选的尽力而为自动登录，匹配 `login:` / `Password:` 提示符 —— **默认关闭**，因为 Telnet 不加密。

### 串口（COM）

- 枚举可用端口并显示友好名称（USB 厂商 / 产品名、VID:PID）；可从列表选择，也可手动输入端口名。
- 可配置波特率、数据位、停止位、校验位与流控；波特率也可从常用值下拉框中选取。
- **波特率自动检测**：UART 没有时钟线也没有协商机制，因此无法读取对端的真实速率。后端改为逐个探测常用速率，监听（对静默设备发送换行试探）并对收到的字节像终端文本的程度打分 —— 结果按置信度排序返回，并附带样本预览。

### SFTP 文件管理
- 远程文件树浏览器（侧边栏 `FilePanel`）。
- 列举 / 读取 / 写入 / 重命名 / 删除 / 新建目录。
- 上传与下载（文件或原始字节），支持**暂停 / 继续**，并通过 `transfer-progress` 事件上报进度。
- 切换 SFTP 操作用户（`switch_sftp_user` / `revert_sftp_user`），以其他账号身份操作。

### 远程文件编辑器
- 基于 Monaco 的远程文件内联编辑器，以分栏树面板或浮动窗口形式呈现。
- 编码自动检测：UTF-8 → GBK（`encoding_rs`）；非 UTF-8 文件会被标记，必须以相同字符集重新保存。

### 本地终端与本地文件
- 可将**本地 Shell** 作为顶层标签打开，也可在现有工作区内作为分栏面板打开（`openLocalShellTab` / `handleOpenLocalSplit`）；在本机运行原生 Shell。
- **本地文件浏览器**：通过同一套 `FilePanel` / `FileEditor` 界面在本机浏览与编辑文件。一个 `LocalFs`（`local_fs.rs`）实现了与 SFTP 相同的 `RemoteFs` trait，因此本地与远程目标共用同一套代码路径。在 Windows 上本地根目录映射到当前盘符的根。

### Hex 与图片查看器
- 在编辑器中打开的二进制文件可以十六进制转储方式查看（`hex_base64` + `HexViewer.tsx`）。
- 图片文件支持内联预览；后端通过 `image_mime` / `detect_image_mime` 上报 MIME 类型。

### 浮动窗口与分栏布局
- 终端区域采用**分栏树**布局（`splitTree.ts`）：标签可水平或垂直分割，每个叶节点显示终端、Docker 日志或已打开的文件编辑器。
- 任意面板都可**弹出**为浮动窗口（`floatPane` / `FloatingWindow.tsx`，`position: fixed`，z-index 从 1000 起）。终端浮动会从树中摘下该叶节点（会话保持存活）；文件编辑器 / Docker 日志的浮动以覆盖层形式渲染在依然挂载的 Shell 之上，关闭浮动时恢复 `shellView`。
- **按会话隔离的视图状态**（`shellView` / `activeEditorKey` 均为 `Record<number, ...>`）让每个标签打开的文件与 Docker 日志互不干扰 —— 在某个会话中打开的文件不会出现在另一个会话里。

### 会话录制
- 默认开启录制（可通过 `WROLP_RECORDING=0` / `false` 关闭）。
- 事件先缓存在内存中，每 5 秒及断开连接时刷入 SQLite 的 `session_events` 表。
- 两类事件：`input`（原始按键）与 `command`（回车时捕获的完整命令行，保留 Tab 补全文本）。
- 底部面板提供浏览器（`SessionListPanel` / `SessionViewer`），可删除 / 回放录制内容。

### 命令集
- 在 SQLite 中保存可复用的命令组（可选绑定到某个连接）。
- 通过底部面板的 `CommandSetPanel` 管理。

### Docker 与主机分析
- `analyze_host`：对连接中的服务器做只读分析（操作系统、内核、架构、软件包、已安装工具）。
- `analyze_docker_container` + `docker_container_logs`：检视容器并流式获取其日志（`docker_logs_stream_start` / `poll_docker_logs` / `stop_docker_logs_stream`）。
- **Docker 日志标签与浮动**：容器的日志可作为一个独立的日志标签打开，并弹出为浮动窗口。标签重连时会自动重新发送其 `postConnectCmd`（例如原始的 `docker exec`），从而让面板在重连后保持一致。
- `command_help`：查询连接服务器上某命令的帮助 / 手册文本。
- 相关 UI 面板：`DockerPanel`、`DockerLogViewer`、`DockerAnalysisPanel`、`HostAnalysisPanel`。

### AI 助手
- 聊天面板（`AiChatPanel`），含两种模式：
  - **对话**（非流式，`ai_chat_sync`）。
  - **智能体**（带工具调用的流式模式，`run_agent_stream`）—— 一个完整的智能体循环，可在连接的服务器上调用工具。
- **多模态输入**：可在消息中附加图片（后端通过 `openai_content` 接受结构化的多段 `content`），让模型能理解截图、示意图等。
- **模板与重发**：在图片按钮旁通过模板下拉框插入提示词；可**编辑并重新发送**任意历史消息（基于编辑后的内容重新运行）。
- **暂停**：通过 `cancel_ai_chat` 中止正在进行的对话 / 智能体生成，并从中断处继续。
- **多 API 端点**：可保存多个 `AiEndpointProfile`，各自拥有加密的 API Key、端点 URL、模型与系统提示词。可选择一个作为当前激活配置。旧版单端点配置会自动迁移。
- **模型获取**：`list_ai_models` 调用 `{endpoint}/v1/models` 填充模型下拉框；始终支持手动输入。
- **智能体工具**（分发到拥有 `AppState` 访问权限的 Rust 后端）：`run_command`、`analyze_server`、`list_directory`、`read_file`、`list_connections`、`search_help` 等。工具调用归组在其对应的助手消息下，以工具卡片形式展示，并带有生命周期事件（`pending` → `executing` → `done`/`error`）。助手消息中的 Bash 代码块提供一键**复制**按钮。
- **安全性**：API Key 通过 AES-256-GCM 文件保险库加密存储（`encrypt_api_key` / `decrypt_api_key`）。加密密钥为机器专属文件（`vault.key`），不使用操作系统密钥环。

### 窗口与系统集成
- 自定义标题栏（窗口 `decorations: false`）；窗口位置 / 尺寸 / 透明度持久化（`window.json`）。
- 关闭时隐藏、系统托盘图标、自动更新（GitHub Release 端点 —— 发布前需在 `tauri.conf.json` 中设置真实 `pubkey`）。
- 持久化的连接配置（`connections.json`，已加密 —— 同时保存工作区）与 SQLite 数据库（`wrolp.db`，WAL 模式）存放在 OS 配置目录下的 `wrolp-terminal/`。

## 系统依赖

### Linux（Debian / Ubuntu）

```bash
sudo apt-get install -y pkg-config libdbus-1-dev libssl-dev libgtk-3-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libwebkit2gtk-4.1-dev
```

### macOS / Windows

无需额外依赖。

## 安装

### 1. 安装 Rust 工具链

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. 安装前端依赖

已提交 `yarn.lock`，建议使用 `yarn`：

```bash
yarn        # 或：npm install
```

## 开发

```bash
yarn tauri dev      # 或：npm run tauri dev
```

Tauri 2 会在加载前端前，通过 `beforeDevCommand` 自动启动 Vite 开发服务器。

仅前端开发服务器（不含 Rust / SSH，适合界面开发）：

```bash
yarn dev
```

### 调试 Rust 后端

- **日志**：后端诊断信息通过 `eprintln!` 输出到 stderr（在 `yarn tauri dev` 终端中可见）。在需要处添加 `eprintln!("[module] ...")` 即可。
- **静态检查 / 测试**：
  ```bash
  cd src-tauri
  cargo check                 # 类型检查
  cargo build                 # 调试构建
  cargo clippy                # Lint
  cargo test                  # 运行全部 Rust 单元测试
  cargo run --bin ssh_test    # 独立的 russh 连通性探测（src/ssh_test.rs）
  ```
- **断点调试**：`.vscode/launch.json` 中的 `Debug Tauri (dev)`（需 CodeLLDB 扩展）会以 `RUST_BACKTRACE=1` 构建并启动二进制。注意它启动的是独立进程 —— 不要同时运行 `yarn tauri dev`。多数后端工作通常使用 `yarn tauri dev` 配合 `eprintln!` 日志即可。
- **注意事项**：终端输出通过轮询（`poll_output`）获取而非事件流；新增的 `#[tauri::command]` 需要重新构建后端（重启 `yarn tauri dev`）。

## 构建

```bash
yarn tauri build     # 或：npm run tauri build
```

输出目录：`src-tauri/target/release/bundle/`。打包目标仅 `["msi"]`。

### 清理重建

```bash
cd src-tauri && cargo clean && cd ..
# 然后：
yarn tauri build
```

## 测试

### Rust 单元测试与集成

```bash
cd src-tauri
cargo test                 # 运行全部 Rust 单元测试（local_fs、ai_term 等模块内的 #[cfg(test)]）
cargo run --bin ssh_test   # 独立的 russh 连通性探测二进制
```

- 后端单测分散在各模块内（如 `local_fs.rs`、`ai_term.rs`），用 `#[cfg(test)]` + `#[tokio::test]` 编写，覆盖纯逻辑（路径解析、协议编解码、RemoteFs 适配、配置校验等）。
- 新增涉及纯逻辑的功能时，优先补单测；涉及真实网络/进程的功能用 `ssh_test` 这类独立二进制做冒烟探测。

### 前端 E2E（Playwright + 模拟 IPC）

E2E 基于 Playwright，阶段一：在真实浏览器中运行 Vite 前端（`yarn dev`），通过注入假的 `window.__TAURI_INTERNALS__` 把 Tauri 后端打桩（见 `e2e/ui/helpers/tauriMock.ts`），**无需编译 Rust 即可验证 UI**。

```bash
# 首次运行需安装 Playwright 浏览器
npx playwright install

# 运行全部 E2E
yarn test:e2e              # 等价于 npx playwright test

# 指定端口（CI 或本机已占用默认 1420 时）
E2E_PORT=1430 yarn test:e2e
```

- 用例位于 `e2e/ui/`（如 `terminal.spec.ts`、`connections.spec.ts`、`command-list.spec.ts`、`app-boot.spec.ts`）。
- 后端打桩点位于 `e2e/ui/helpers/tauriMock.ts`：按 `invoke` 的命令名返回固定或参数化的响应，便于在无真实 SSH / 服务器的情况下验证前端行为。

## 技术栈

- **前端**：React 19 + TypeScript + xterm.js + Monaco 编辑器 + Vite + SCSS
- **后端**：Tauri 2 + Rust (tokio) + russh / russh-sftp
- **SSH**：纯 Rust 异步 SSH 客户端 [`russh`](https://github.com/warp-tech/russh)
- **IPC**：Tauri `invoke` 命令 + 前端轮询终端输出（Windows 后台线程的权宜之计）。Tauri 事件仅用于少数前端无法轮询的推送通知：`connection-closed`、`connection-suspect`、`connection-ok`、`transfer-progress`、`tunnel-changed`、`ai-term-mark`、`native-drag-drop`、`baud-detect-progress`。
- **存储**：`window.json`（窗口位置尺寸、透明度、录制与保活设置）以及**加密的** `connections.json`（连接与工作区）+ SQLite（`wrolp.db`，WAL）用于录制与命令集；机密通过 AES-256-GCM 文件保险库加密（不使用 OS 密钥环）。

## 约定

- 与 Rust 共享的类型在 Rust 侧使用 `#[serde(rename_all = "camelCase")]`，并在 `src/types.ts` 中使用对应的 camelCase 接口。
- 前端格式由 Prettier 强制约束（`.prettierrc`：singleQuote、no semi、printWidth 100）—— 运行 `yarn format`。
- 后端命令按职责拆分在 `src-tauri/src/commands/` 下的子模块中（如 `serial.rs`）；新增命令还要在 `src-tauri/src/lib.rs` 的 `generate_handler!` 列表中注册，前端包装函数放在 `src/commands.ts`。

## 致谢

- [russh](https://github.com/warp-tech/russh) —— 纯 Rust 异步 SSH 客户端
- [Tauri](https://tauri.app/) —— 应用框架
- [React](https://react.dev/) —— UI 库
- [xterm.js](https://xtermjs.org/) —— 终端渲染
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) —— 代码编辑器
- ……以及许多其他让本项目得以实现的开源库。
