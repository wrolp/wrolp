//! TFTP client commands. Transfers run as background tokio tasks so the UI can
//! poll progress rows and cancel an in-flight transfer.

use std::net::SocketAddr;

use tauri::Manager;
use tokio::sync::oneshot;

use crate::ssh_session::{AppState, TransferRow};
use crate::tftp_proto;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpStartArgs {
  pub server_host: String,
  #[serde(default)]
  pub server_port: Option<u16>,
  pub remote_name: String,
  pub local_path: String,
  /// "download" | "upload"
  pub direction: String,
}

fn update_row(app: &tauri::AppHandle, id: u64, upd: impl FnOnce(&mut TransferRow)) {
  let st = app.state::<AppState>();
  let locked = st.tftp_transfers.lock();
  if let Ok(mut rows) = locked {
    if let Some(row) = rows.get_mut(&id) {
      upd(row);
    }
  }
}

async fn resolve_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
  let hp = format!("{host}:{port}");
  let mut it = tokio::net::lookup_host(hp.as_str())
    .await
    .map_err(|e| format!("Cannot resolve '{host}': {e}"))?;
  it.next().ok_or_else(|| format!("No address for '{host}'"))
}

#[tauri::command]
pub async fn tftp_start(
  state: tauri::State<'_, AppState>,
  app: tauri::AppHandle,
  args: TftpStartArgs,
) -> Result<TransferRow, String> {
  let remote = args.remote_name.trim().to_string();
  if remote.is_empty() || remote.contains("..") {
    return Err("Invalid remote file name".into());
  }
  if args.local_path.trim().is_empty() {
    return Err("Local path is required".into());
  }
  let server = resolve_addr(&args.server_host, args.server_port.unwrap_or(69)).await?;
  let direction = if args.direction == "upload" {
    "upload".to_string()
  } else {
    "download".to_string()
  };

  let id = state
    .next_tftp_id
    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
  let now = crate::commands::now_ms();
  let row = TransferRow {
    id,
    kind: "client".into(),
    name: remote.clone(),
    peer: server.to_string(),
    direction: direction.clone(),
    transferred: 0,
    total: 0,
    status: "running".into(),
    message: String::new(),
    started_ms: now,
    local_path: args.local_path.clone(),
  };
  state
    .tftp_transfers
    .lock()
    .map_err(|e| e.to_string())?
    .insert(id, row.clone());

  let (tx, rx) = oneshot::channel();
  state
    .tftp_cancels
    .lock()
    .map_err(|e| e.to_string())?
    .insert(id, tx);

  let local_path = std::path::PathBuf::from(&args.local_path);
  let app2 = app.clone();
  tauri::async_runtime::spawn(async move {
    let sock = match tftp_proto::bind_worker_socket(None).await {
      Ok(s) => s,
      Err(e) => {
        update_row(&app, id, |r| {
          r.status = "error".into();
          r.message = e;
        });
        return;
      }
    };
    let cancel = rx;
    let res = if direction == "download" {
      tftp_proto::client_download(
        &sock,
        server,
        &remote,
        &local_path,
        tftp_proto::DEFAULT_BLK,
        Some(cancel),
        |n| {
          update_row(&app, id, |r| {
            r.transferred = n;
            r.total = tftp_proto::file_size_hint(&local_path);
          });
        },
      )
      .await
    } else {
      let total = tftp_proto::file_size_hint(&local_path);
      update_row(&app, id, |r| r.total = total);
      tftp_proto::client_upload(
        &sock,
        server,
        &remote,
        &local_path,
        tftp_proto::DEFAULT_BLK,
        Some(cancel),
        |n| {
          update_row(&app, id, |r| r.transferred = n);
        },
      )
      .await
    };
    // Clean up cancel channel entry.
    let st = app2.state::<AppState>();
    if let Ok(mut cancels) = st.tftp_cancels.lock() {
      cancels.remove(&id);
    }
    match res {
      Ok(bytes) => update_row(&app, id, |r| {
        r.transferred = bytes;
        r.status = "done".into();
        r.message = format!("{bytes} bytes");
      }),
      Err(e) if e == "canceled" => update_row(&app, id, |r| {
        r.status = "canceled".into();
        r.message = "user canceled".into();
      }),
      Err(e) => update_row(&app, id, |r| {
        r.status = "error".into();
        r.message = e;
      }),
    }
  });

  Ok(row)
}

#[tauri::command]
pub async fn tftp_cancel(state: tauri::State<'_, AppState>, row_id: u64) -> Result<(), String> {
  let sender = state
    .tftp_cancels
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&row_id);
  if let Some(tx) = sender {
    let _ = tx.send(());
  }
  Ok(())
}

#[tauri::command]
pub async fn tftp_rows(
  state: tauri::State<'_, AppState>,
  kind: Option<String>,
) -> Result<Vec<TransferRow>, String> {
  let rows = state.tftp_transfers.lock().map_err(|e| e.to_string())?;
  let mut out: Vec<TransferRow> = match kind.as_deref() {
    Some("server") => rows
      .values()
      .filter(|r| r.kind == "server")
      .cloned()
      .collect(),
    Some("client") => rows
      .values()
      .filter(|r| r.kind == "client")
      .cloned()
      .collect(),
    _ => rows.values().cloned().collect(),
  };
  out.sort_by_key(|r| std::cmp::Reverse(r.id));
  Ok(out)
}

#[tauri::command]
pub async fn tftp_clear_rows(
  state: tauri::State<'_, AppState>,
  kind: Option<String>,
) -> Result<(), String> {
  let mut rows = state.tftp_transfers.lock().map_err(|e| e.to_string())?;
  match kind.as_deref() {
    Some(k) => rows.retain(|_, r| r.kind != k),
    None => rows.clear(),
  }
  Ok(())
}
