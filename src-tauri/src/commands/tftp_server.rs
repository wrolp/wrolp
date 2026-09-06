//! In-app TFTP server. Binds a UDP listener, parses RRQ/WRQ requests, and runs
//! each transfer in its own background task (each worker uses an ephemeral TID
//! socket, per RFC 1350). Transfer rows are shared with the client rows in
//! `AppState.tftp_transfers` and shown in the TFTP server panel.

use std::net::IpAddr;
use std::path::PathBuf;

use tauri::Manager;
use tokio::net::UdpSocket;
use tokio::sync::oneshot;

use crate::ssh_session::{AppState, AppServerStatus, TransferRow};
use crate::tftp_proto;

/// Handle to the running TFTP server task.
pub struct TftpServerRuntime {
  pub port: u16,
  pub started_at_ms: u64,
  pub abort: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpServerArgs {
  #[serde(default)]
  pub bind_ip: Option<String>,
  #[serde(default = "default_tftp_port")]
  pub port: u16,
  pub root_dir: String,
}

fn default_tftp_port() -> u16 {
  69
}

#[tauri::command]
pub async fn start_tftp_server(
  state: tauri::State<'_, AppState>,
  app: tauri::AppHandle,
  args: TftpServerArgs,
) -> Result<AppServerStatus, String> {
  {
    let guard = state.tftp_server.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
      return Err("TFTP server is already running. Stop it first.".into());
    }
  }
  let root = PathBuf::from(args.root_dir);
  if !root.is_dir() {
    return Err(format!("Root directory does not exist: {}", root.display()));
  }
  let bind_ip: IpAddr = match args.bind_ip.as_deref() {
    Some(ip) if !ip.trim().is_empty() => ip
      .trim()
      .parse()
      .map_err(|_| format!("Invalid bind address '{ip}'"))?,
    _ => "0.0.0.0".parse().unwrap(),
  };
  let addr = std::net::SocketAddr::new(bind_ip, args.port);
  let listener = UdpSocket::bind(addr)
    .await
    .map_err(|e| format!("Cannot bind {addr}: {e}"))?;
  let local_ip = listener.local_addr().map_err(|e| e.to_string())?.ip();

  let started_ms = crate::commands::now_ms();
  let handle = tauri::async_runtime::spawn(async move {
    let mut buf = [0u8; 516];
    loop {
      let (n, peer) = match listener.recv_from(&mut buf).await {
        Ok(x) => x,
        Err(_) => break,
      };
      let parsed = match tftp_proto::parse_request(&buf[..n]) {
        Ok(x) => x,
        Err(_) => continue,
      };
      let (op, filename, _opts) = parsed;
      let clean = match tftp_proto::sanitize_name(&filename) {
        Ok(c) => c,
        Err(e) => {
          let _ = listener
            .send_to(&tftp_proto::build_error(0, &e), peer)
            .await;
          continue;
        }
      };
      let path = match tftp_proto::resolve_path(&root, &clean) {
        Ok(p) => p,
        Err(e) => {
          let _ = listener.send_to(&tftp_proto::build_error(0, &e), peer).await;
          continue;
        }
      };
      if op == tftp_proto::RRQ && !path.exists() {
        let _ = listener
          .send_to(&tftp_proto::build_error(1, "file not found"), peer)
          .await;
        continue;
      }
      if op == tftp_proto::WRQ && path.is_dir() {
        let _ = listener
          .send_to(&tftp_proto::build_error(2, "cannot write to a directory"), peer)
          .await;
        continue;
      }

      // Register a transfer row + cancel slot, then run the worker.
      let st = app.state::<AppState>();
      let mut g = st.tftp_transfers.lock().unwrap();
      let id = st
        .next_tftp_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
      g.insert(
        id,
        TransferRow {
          id,
          kind: "server".into(),
          name: clean.clone(),
          peer: peer.to_string(),
          direction: if op == tftp_proto::RRQ { "send" } else { "recv" }.into(),
          transferred: 0,
          total: 0,
          status: "running".into(),
          message: String::new(),
          started_ms: crate::commands::now_ms(),
          local_path: path.to_string_lossy().to_string(),
        },
      );
      let (tx, rx) = oneshot::channel();
      st.tftp_cancels.lock().unwrap().insert(id, tx);

      let app2 = app.clone();
      let path2 = path.clone();
      tauri::async_runtime::spawn(async move {
        let wsock = match tftp_proto::bind_worker_socket(Some(local_ip)).await {
          Ok(s) => s,
          Err(e) => {
            let st = app2.state::<AppState>();
            st.tftp_cancels.lock().unwrap().remove(&id);
            {
              let mut rows = st.tftp_transfers.lock().unwrap();
              if let Some(r) = rows.get_mut(&id) {
                r.status = "error".into();
                r.message = e;
              }
            }
            return;
          }
        };
        let res = if op == tftp_proto::RRQ {
          tftp_proto::send_file(wsock, peer, &path2, tftp_proto::DEFAULT_BLK, Some(rx)).await
        } else {
          tftp_proto::receive_file(wsock, peer, &path2, tftp_proto::DEFAULT_BLK, Some(rx)).await
        };
        let st = app2.state::<AppState>();
        st.tftp_cancels.lock().unwrap().remove(&id);
        {
          let mut rows = st.tftp_transfers.lock().unwrap();
          if let Some(r) = rows.get_mut(&id) {
            match res {
              Ok(bytes) => {
                r.transferred = bytes;
                r.total = bytes;
                r.status = "done".into();
                r.message = format!("{bytes} bytes");
              }
              Err(e) if e == "canceled" => {
                r.status = "canceled".into();
                r.message = "user canceled".into();
              }
              Err(e) => {
                r.status = "error".into();
                r.message = e;
              }
            }
          }
        }
      });
    }
  });

  let runtime = TftpServerRuntime {
    port: args.port,
    started_at_ms: started_ms,
    abort: handle,
  };
  state
    .tftp_server
    .lock()
    .map_err(|e| e.to_string())?
    .replace(runtime);

  Ok(AppServerStatus {
    running: true,
    kind: "tftp".into(),
    port: args.port,
    started_at_ms: started_ms,
  })
}

#[tauri::command]
pub async fn stop_tftp_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
  let runtime = state.tftp_server.lock().map_err(|e| e.to_string())?.take();
  if let Some(r) = runtime {
    r.abort.abort();
    // Remove any lingering server rows.
    let mut rows = state.tftp_transfers.lock().map_err(|e| e.to_string())?;
    rows.retain(|_, r| r.kind != "server");
  }
  Ok(())
}

#[tauri::command]
pub async fn tftp_server_status(
  state: tauri::State<'_, AppState>,
) -> Result<AppServerStatus, String> {
  let g = state.tftp_server.lock().map_err(|e| e.to_string())?;
  Ok(match g.as_ref() {
    Some(r) => AppServerStatus {
      running: true,
      kind: "tftp".into(),
      port: r.port,
      started_at_ms: r.started_at_ms,
    },
    None => AppServerStatus {
      running: false,
      kind: "tftp".into(),
      port: 69,
      started_at_ms: 0,
    },
  })
}
