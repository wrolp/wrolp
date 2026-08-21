use super::*;

// ==================== SSH Tunnels (local port forwarding) ====================

/// Arguments for starting a new local port-forwarding tunnel.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTunnelArgs {
  /// The connected tab whose SSH session carries the tunnel.
  pub tab_id: u32,
  /// Connection id (for the sidebar tree display).
  pub connection_id: Option<String>,
  /// Saved tunnel-definition id this tunnel was started from (if any).
  pub config_id: Option<String>,
  /// Local bind host; defaults to "127.0.0.1".
  pub local_addr: Option<String>,
  pub local_port: u16,
  pub remote_host: String,
  pub remote_port: u16,
  pub name: Option<String>,
}

#[tauri::command]
pub async fn start_tunnel(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  args: StartTunnelArgs,
) -> Result<u32, String> {
  // Validate the carrier session and grab its shared handle.
  let handle = get_jump_handle(&state, args.tab_id)?;

  let local_addr_str = args.local_addr.clone().unwrap_or_else(|| "127.0.0.1".to_string());
  let local_sock: std::net::SocketAddr = format!("{}:{}", local_addr_str, args.local_port)
    .parse()
    .map_err(|e| format!("Invalid local address: {}", e))?;
  let listener = tokio::net::TcpListener::bind(local_sock)
    .await
    .map_err(|e| format!("Cannot bind {}: {}", local_sock, e))?;
  eprintln!(
    "[tunnel] tab={} bound {} -> {}:{} (listening)",
    args.tab_id, local_sock, args.remote_host, args.remote_port
  );

  let id = state.next_tunnel_id.fetch_add(1, Ordering::Relaxed) as u32;
  let tab_id = args.tab_id;
  let connection_id = args.connection_id.clone();
  let config_id = args.config_id.clone();
  let remote_host = args.remote_host.clone();
  let remote_port = args.remote_port as u32;
  let name = args.name.clone();
  let started_at = chrono::Utc::now().timestamp();
  let local_addr_str2 = local_sock.to_string();
  let runtime_local_addr = local_addr_str2.clone();
  let app2 = app.clone();
  let tid2 = id;

  // The accept loop: every inbound local connection opens a direct-tcpip
  // channel to remote_host:remote_port over the shared SSH session and pipes
  // bytes both ways. Tunnel bytes never touch the terminal output buffer.
  let accept_task = tokio::spawn(async move {
    let _listener = listener;
    loop {
      let (mut sock, _) = match _listener.accept().await {
        Ok(pair) => pair,
        Err(_) => break,
      };
      eprintln!("[tunnel] accepted local connection on {}", local_addr_str2);
      let handle = handle.clone();
      let app3 = app2.clone();
      let la = local_addr_str2.clone();
      let (rh, rp) = (remote_host.clone(), remote_port);
      tokio::spawn(async move {
        let channel = match handle
          .channel_open_direct_tcpip(&rh, rp, "127.0.0.1", 0)
          .await
        {
          Ok(c) => {
            eprintln!("[tunnel] direct-tcpip channel opened -> {}:{}", rh, rp);
            c
          }
          Err(e) => {
            eprintln!(
              "[tunnel] direct-tcpip open FAILED -> {}:{} : {}",
              rh, rp, e
            );
            let err_str = e.to_string();
            // AdministrativelyProhibited means the server forbids this
            // forward outright (AllowTcpForwarding no / PermitOpen limits).
            // Every later connection would fail identically, so auto-stop
            // the tunnel and surface a fix-it hint instead of leaving a
            // dead listener bound.
            let fatal = err_str.contains("AdministrativelyProhibited");
            let _ = app3.emit(
              "tunnel-error",
              serde_json::json!({
                "localAddr": la,
                "remoteHost": rh,
                "remotePort": rp,
                "error": err_str,
                "fatal": fatal,
              }),
            );
            if fatal {
              if let Some(st) = app3.try_state::<AppState>() {
                stop_tunnel_runtime(&st, tid2);
              }
              let _ = app3.emit("tunnel-changed", serde_json::json!({}));
            }
            return;
          }
        };
        let mut stream = channel.into_stream();
        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
        eprintln!("[tunnel] connection to {}:{} closed", rh, rp);
      });
    }
  });

  // Register the runtime so stop_tunnel / disconnect cleanup can abort it.
  {
    let mut tunnels = state.tunnels.lock().map_err(|e| e.to_string())?;
    tunnels.insert(
      id,
      crate::ssh_session::TunnelRuntime {
        id,
        tab_id,
        connection_id,
        config_id,
        local_addr: runtime_local_addr,
        remote_host: args.remote_host,
        remote_port,
        name,
        bytes: 0,
        started_at,
        abort: accept_task.abort_handle(),
      },
    );
  }

  let _ = app.emit("tunnel-changed", serde_json::json!({}));
  Ok(id)
}

/// Snapshot of all active tunnels (for the sidebar tree display).
#[tauri::command]
pub async fn list_tunnels(state: tauri::State<'_, AppState>) -> Result<Vec<TunnelInfo>, String> {
  let tunnels = state.tunnels.lock().map_err(|e| e.to_string())?;
  let mut out: Vec<TunnelInfo> = tunnels
    .iter()
    .map(|(id, t)| TunnelInfo {
      id: *id,
      tab_id: t.tab_id,
      connection_id: t.connection_id.clone(),
      config_id: t.config_id.clone(),
      local_addr: t.local_addr.clone(),
      remote_host: t.remote_host.clone(),
      remote_port: t.remote_port,
      name: t.name.clone(),
      bytes: t.bytes,
      active: true,
    })
    .collect();
  out.sort_by_key(|t| t.id);
  Ok(out)
}

/// Stop a tunnel: abort its accept task and drop the listener.
#[tauri::command]
pub async fn stop_tunnel(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  id: u32,
) -> Result<(), String> {
  let abort = {
    let mut tunnels = state.tunnels.lock().map_err(|e| e.to_string())?;
    tunnels.remove(&id).map(|t| t.abort)
  };
  if let Some(abort) = abort {
    abort.abort();
  }
  let _ = app.emit("tunnel-changed", serde_json::json!({}));
  Ok(())
}

/// Add a tunnel *definition* to a connection (persisted, not started).
#[tauri::command]
pub async fn add_tunnel(
  state: tauri::State<'_, AppState>,
  connection_id: String,
  config: crate::ssh_session::TunnelConfig,
) -> Result<(), String> {
  {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let found = connections.iter_mut().find(|c| c.id == connection_id);
    match found {
      Some(c) => c.tunnels.push(config),
      None => return Err("Connection not found".to_string()),
    }
  }
  persist_connections(&state).await?;
  Ok(())
}

/// Remove a saved tunnel definition from a connection. If a matching tunnel is
/// currently running it is stopped too.
#[tauri::command]
pub async fn remove_tunnel(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  connection_id: String,
  tunnel_id: String,
) -> Result<(), String> {
  {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let found = connections.iter_mut().find(|c| c.id == connection_id);
    match found {
      Some(c) => c.tunnels.retain(|t| t.id != tunnel_id),
      None => return Err("Connection not found".to_string()),
    }
  }
  // Stop any running tunnel started from this definition.
  let abort = {
    let mut tunnels = state.tunnels.lock().map_err(|e| e.to_string())?;
    let mut aborts: Vec<tokio::task::AbortHandle> = Vec::new();
    tunnels.retain(|_, t| {
      if t.connection_id.as_deref() == Some(connection_id.as_str())
        && t.config_id.as_deref() == Some(tunnel_id.as_str())
      {
        aborts.push(t.abort.clone());
        false
      } else {
        true
      }
    });
    aborts
  };
  for a in abort {
    a.abort();
  }
  let _ = app.emit("tunnel-changed", serde_json::json!({}));
  persist_connections(&state).await?;
  Ok(())
}

/// Update a saved tunnel definition on a connection (persisted, not restarted).
/// A running tunnel started from this definition keeps its current settings
/// until the user stops and starts it again.
#[tauri::command]
pub async fn update_tunnel(
  state: tauri::State<'_, AppState>,
  connection_id: String,
  tunnel_id: String,
  config: crate::ssh_session::TunnelConfig,
) -> Result<(), String> {
  {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let found = connections.iter_mut().find(|c| c.id == connection_id);
    match found {
      Some(c) => {
        let tun = c.tunnels.iter_mut().find(|t| t.id == tunnel_id);
        match tun {
          Some(t) => {
            t.name = config.name;
            t.local_addr = config.local_addr;
            t.local_port = config.local_port;
            t.remote_host = config.remote_host;
            t.remote_port = config.remote_port;
          }
          None => return Err("Tunnel not found".to_string()),
        }
      }
      None => return Err("Connection not found".to_string()),
    }
  }
  persist_connections(&state).await?;
  Ok(())
}

/// Abort every tunnel carried by `tab_id`'s SSH session (called on disconnect).
pub fn cleanup_tunnels_for_tab(state: &AppState, tab_id: u32) {
  if let Ok(mut tunnels) = state.tunnels.lock() {
    let aborts: Vec<_> = tunnels
      .iter()
      .filter(|(_, t)| t.tab_id == tab_id)
      .map(|(id, t)| (*id, t.abort.clone()))
      .collect();
    for (id, abort) in aborts {
      abort.abort();
      tunnels.remove(&id);
    }
  }
}

/// Abort a single tunnel runtime by id (auto-stop when the server refuses
/// forwarding, e.g. AdministrativelyProhibited).
pub fn stop_tunnel_runtime(state: &AppState, id: u32) {
  if let Ok(mut tunnels) = state.tunnels.lock() {
    if let Some(t) = tunnels.remove(&id) {
      t.abort.abort();
    }
  }
}

/// Reads the list of file paths currently copied to the Windows clipboard
/// (CF_HDROP), i.e. files copied with Ctrl+C in Explorer. Used by the file
/// panel's "Paste" context-menu action. Returns an empty vec when the clipboard
/// holds no files or is temporarily locked by another application.
#[cfg(target_os = "windows")]
fn read_clipboard_files() -> Vec<String> {
  use std::ffi::c_void;
  use std::ptr;

  const CF_HDROP: u32 = 15;
  const DROP_FILE_LIST: u32 = 0xFFFF_FFFF; // DragQueryFileW ifile == 0xFFFFFFFF => file count

  #[link(name = "user32")]
  unsafe extern "system" {
    fn OpenClipboard(h_wnd_new_owner: *mut c_void) -> i32;
    fn CloseClipboard() -> i32;
    fn GetClipboardData(u_format: u32) -> *mut c_void;
  }

  #[link(name = "shell32")]
  unsafe extern "system" {
    fn DragQueryFileW(h_drop: *mut c_void, i_file: u32, lpsz_file: *mut u16, cch: u32) -> u32;
  }

  let mut files = Vec::new();
  unsafe {
    if OpenClipboard(ptr::null_mut()) == 0 {
      // Clipboard locked by another process — nothing we can do right now.
      return files;
    }
    let hdrop = GetClipboardData(CF_HDROP);
    if !hdrop.is_null() {
      let count = DragQueryFileW(hdrop, DROP_FILE_LIST, ptr::null_mut(), 0);
      for i in 0..count {
        let len = DragQueryFileW(hdrop, i, ptr::null_mut(), 0);
        let mut buf = vec![0u16; len as usize + 1];
        let copied = DragQueryFileW(hdrop, i, buf.as_mut_ptr(), buf.len() as u32);
        buf.truncate(copied as usize);
        files.push(String::from_utf16_lossy(&buf));
      }
    }
    CloseClipboard();
  }
  files
}

/// Returns the list of local file paths copied to the system clipboard, used
/// by the file panel's "Paste" context-menu action. Windows-only: reads
/// CF_HDROP; other platforms return an empty list.
#[tauri::command]
pub fn get_clipboard_files() -> Vec<String> {
  #[cfg(target_os = "windows")]
  {
    read_clipboard_files()
  }
  #[cfg(not(target_os = "windows"))]
  {
    Vec::new()
  }
}

/// Lists the local drive letters ("C:/", "D:/", ...) so the file panel's
/// location dropdown can offer Windows drives when browsing the local machine.
#[cfg(target_os = "windows")]
fn list_local_drives_impl() -> Vec<String> {
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetLogicalDrives() -> u32;
  }
  let mut drives = Vec::new();
  unsafe {
    let mask = GetLogicalDrives();
    for i in 0..26 {
      if mask & (1u32 << i) != 0 {
        let letter = (b'A' + i as u8) as char;
        drives.push(format!("{}:/", letter));
      }
    }
  }
  drives
}

/// Local drive letters for the file panel's location dropdown (Windows only;
/// empty on other platforms).
#[tauri::command]
pub fn list_local_drives() -> Vec<String> {
  #[cfg(target_os = "windows")]
  {
    list_local_drives_impl()
  }
  #[cfg(not(target_os = "windows"))]
  {
    Vec::new()
  }
}
