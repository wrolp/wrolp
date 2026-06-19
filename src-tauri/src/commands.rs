use super::ssh_session::{AppState, ConnectionConfig, SshSession, TerminalOutput};
use serde_json::json;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::Command;

// ==================== Data Persistence ====================

fn get_data_dir() -> Option<std::path::PathBuf> {
  dirs::config_dir().map(|p| p.join("ssh-terminal"))
}

fn get_connections_path() -> Option<std::path::PathBuf> {
  get_data_dir().map(|p| p.join("connections.json"))
}

#[tauri::command]
pub async fn list_connections(state: tauri::State<'_, AppState>) -> Result<String, String> {
  let connections = state.connections.lock().map_err(|e| e.to_string())?;
  Ok(serde_json::to_string(&*connections).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn save_connection(
  state: tauri::State<'_, AppState>,
  config: ConnectionConfig,
) -> Result<String, String> {
  {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let found = connections.iter_mut().find(|c| c.id == config.id);
    if let Some(existing) = found {
      *existing = config.clone();
    } else {
      connections.push(config.clone());
    }
  } // lock released here

  let path = get_connections_path();
  if let Some(ref path) = path {
    if let Some(parent) = path.parent() {
      let _ = tokio::fs::create_dir_all(parent).await;
    }
    let content = {
      let all_conns = state.connections.lock().map_err(|e| e.to_string())?;
      serde_json::to_string_pretty(&*all_conns).ok()
    };
    if let Some(content) = content {
      let _ = tokio::fs::write(path, content).await;
    }
  }
  Ok(serde_json::to_string(&config).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn delete_connection(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<bool, String> {
  let deleted = {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let len_before = connections.len();
    connections.retain(|c| c.id != id);
    connections.len() < len_before
  }; // lock released here

  if deleted {
    let path = get_connections_path();
    if let Some(ref path) = path {
      if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
      }
      let content = {
        let all_conns = state.connections.lock().map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&*all_conns).ok()
      };
      if let Some(content) = content {
        let _ = tokio::fs::write(path, content).await;
      }
    }
  }

  Ok(deleted)
}

// ==================== SSH Connection ====================

fn build_ssh_args(config: &ConnectionConfig) -> Vec<String> {
  let mut args = vec![];

  // Port
  if config.port != 22 {
    args.push("-p".to_string());
    args.push(config.port.to_string());
  }

  // Key
  if let Some(ref key_path) = config.key_path {
    args.push("-i".to_string());
    args.push(key_path.clone());
  }

  // Connection parameters
  args.push("-o".to_string());
  args.push("BatchMode=no".to_string());
  args.push("-o".to_string());
  args.push("ConnectTimeout=10".to_string());

  // Host key checking — auto-accept unknown host keys
  args.push("-o".to_string());
  args.push("StrictHostKeyChecking=accept-new".to_string());

  // user@host
  args.push(format!("{}@{}", config.username, config.host));

  args
}

fn build_ssh_cmd(config: &ConnectionConfig) -> Command {
  let mut cmd = Command::new("ssh");
  cmd.args(build_ssh_args(config));
  cmd.stdin(std::process::Stdio::piped());
  cmd.stdout(std::process::Stdio::piped());
  cmd.stderr(std::process::Stdio::piped());
  cmd
}

#[tauri::command]
pub async fn connect(
  _app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  config: ConnectionConfig,
  tab_id: String,
) -> Result<String, String> {
  let host = config.host.clone();
  let port = config.port;
  let username = config.username.clone();
  let password = config.password.clone();

  // Send connecting message
  {
    let tx = {
      let guard = state.output_tx.lock().map_err(|e| e.to_string())?;
      guard.clone()
    };
    if let Some(tx) = tx.as_ref() {
      let _ = tx
        .send(TerminalOutput {
          tab_id: tab_id.clone(),
          data: format!("Connecting to {}:{} as {}\n", host, port, username),
          title: String::new(),
        })
        .await;
    }
  }

  // Build and launch SSH process
  let mut cmd = build_ssh_cmd(&config);

  let mut process = match cmd.spawn() {
    Ok(p) => p,
    Err(e) => {
      return Err(format!("Failed to start SSH: {}", e));
    }
  };

  let stdin = process.stdin.take().ok_or("Failed to get stdin")?;
  let stdout = process.stdout.take().ok_or("Failed to get stdout")?;
  let stderr = process.stderr.take().ok_or("Failed to get stderr")?;

  let tab_id_clone = tab_id.clone();
  let output_tx = {
    let guard = state.output_tx.lock().map_err(|e| e.to_string())?;
    guard.clone()
  };

  // If password is set, delay writing to stdin (wait for SSH password prompt)
  // Note: stdin needs to be saved in session below, so wrap in Arc<Mutex> first for distribution to tasks
  let stdin_arc = Arc::new(tokio::sync::Mutex::new(Box::new(stdin) as Box<dyn tokio::io::AsyncWrite + Send + Unpin>));

  if let Some(ref pw) = password {
    let pw_bytes = format!("{}\n", pw).into_bytes();
    let stdin_for_pw = stdin_arc.clone();
    tauri::async_runtime::spawn(async move {
      // Wait 500ms for SSH process to initialize and emit password prompt
      tokio::time::sleep(std::time::Duration::from_millis(500)).await;
      let mut writer = stdin_for_pw.lock().await;
      let _ = writer.write_all(&pw_bytes).await;
      let _ = writer.flush().await;
    });
  }

  // Read stdout in background
  {
    let tx = output_tx.as_ref().cloned();
    tauri::async_runtime::spawn(async move {
      let mut reader = tokio::io::BufReader::new(stdout);
      let mut buf = Vec::new();
      loop {
        match reader.read_until(b'\n', &mut buf).await {
          Ok(0) => break, // EOF
          Ok(n) => {
            let text = String::from_utf8_lossy(&buf[..n]).to_string();
            buf.clear();
            if let Some(ref tx) = tx {
              let _ = tx
                .send(TerminalOutput {
                  tab_id: tab_id_clone.clone(),
                  data: text,
                  title: String::new(),
                })
                .await;
            }
          }
          Err(_) => break,
        }
      }
    });
  }

  // Read stderr in background
  {
    let tx = output_tx.as_ref().cloned();
    let tab_id_clone = tab_id.clone();
    tauri::async_runtime::spawn(async move {
      let mut reader = tokio::io::BufReader::new(stderr);
      let mut buf = Vec::new();
      loop {
        match reader.read_until(b'\n', &mut buf).await {
          Ok(0) => break,
          Ok(n) => {
            let text = String::from_utf8_lossy(&buf[..n]).to_string();
            buf.clear();
            if let Some(ref tx) = tx {
              let _ = tx
                .send(TerminalOutput {
                  tab_id: tab_id_clone.clone(),
                  data: format!("[stderr] {}", text),
                  title: String::new(),
                })
                .await;
            }
          }
          Err(_) => break,
        }
      }
    });
  }

  // Save session (reuse the same stdin_arc)
  let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
  let session = SshSession {
    tab_id: tab_id.clone(),
    config: config.clone(),
    process: Some(process),
    stdin: Some(stdin_arc),
    alive: true,
  };
  sessions.insert(tab_id.clone(), session);
  drop(sessions);

  Ok(json!({"status": "connected", "tab_id": tab_id}).to_string())
}

#[tauri::command]
pub async fn disconnect(state: tauri::State<'_, AppState>, tab_id: String) -> Result<bool, String> {
  let mut process_to_kill = None;
  {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&tab_id) {
      session.alive = false;
      process_to_kill = session.process.take();
    }
  } // Lock released here, no longer spans .await
  if let Some(ref mut process) = process_to_kill {
    let _ = process.kill().await;
  }
  Ok(true)
}

#[tauri::command]
pub async fn send_input(
  state: tauri::State<'_, AppState>,
  tab_id: String,
  data: String,
) -> Result<bool, String> {
  // Clone the Arc<Mutex<...>> out of the HashMap before releasing the lock
  let stdin_arc = {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&tab_id).ok_or("Session not found")?;
    session.stdin.as_ref()
      .ok_or("No stdin available")?
      .clone()
  };

  let bytes = data.into_bytes();
  let mut writer = stdin_arc.lock().await;
  writer.write_all(&bytes).await.map_err(|e| e.to_string())?;
  writer.flush().await.map_err(|e| e.to_string())?;
  Ok(true)
}

#[tauri::command]
pub async fn resize_terminal(
  _state: tauri::State<'_, AppState>,
  _tab_id: String,
  _cols: u32,
  _rows: u32,
) -> Result<bool, String> {
  Ok(true)
}
