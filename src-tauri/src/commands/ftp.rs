//! FTP client connect/disconnect commands. A successful connect stores one
//! `FtpSession` per tab; the file panel then reaches it through the `RemoteFs`
//! `FtpFs` adapter (target kind `ftp`), so no terminal session is created.

use super::*;
use crate::ftp_fs::{FtpSession, FtpStreamOps};
use suppaftp::tokio::{
  AsyncFtpStream, AsyncNativeTlsConnector, AsyncNativeTlsStream, ImplAsyncFtpStream, TokioTlsStream,
};
use suppaftp::async_native_tls::TlsConnector;
use suppaftp::types::FileType;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectFtpArgs {
  pub host: String,
  #[serde(default)]
  pub port: Option<u16>,
  pub username: String,
  #[serde(default)]
  pub password: Option<String>,
  /// "none" | "explicit" | "implicit"
  #[serde(default)]
  pub encryption: Option<String>,
  pub tab_id: u32,
  #[serde(default)]
  pub skip_verify: Option<bool>,
}

async fn finish_login<T: TokioTlsStream + Send>(
  mut ftp: ImplAsyncFtpStream<T>,
  username: &str,
  password: Option<&str>,
) -> Result<ImplAsyncFtpStream<T>, String> {
  ftp
    .login(username, password.unwrap_or_default())
    .await
    .map_err(|e| format!("FTP login failed: {e}"))?;
  ftp
    .transfer_type(FileType::Image)
    .await
    .map_err(|e| format!("set binary mode failed: {e}"))?;
  Ok(ftp)
}

fn build_connector(skip_verify: bool) -> TlsConnector {
  let mut c = TlsConnector::new();
  if skip_verify {
    c = c.danger_accept_invalid_certs(true);
    c = c.danger_accept_invalid_hostnames(true);
  }
  c
}

async fn make_boxed(
  args: &ConnectFtpArgs,
) -> Result<Box<dyn FtpStreamOps + Send>, String> {
  let host = args.host.trim();
  let port = args.port.unwrap_or(21);
  let username = args.username.trim();
  let password = args.password.as_deref();
  let skip = args.skip_verify.unwrap_or(true);
  let connector = AsyncNativeTlsConnector::from(build_connector(skip));
  let addr = format!("{host}:{port}");

  let enc = args.encryption.as_deref().unwrap_or("none");
  let stream: Box<dyn FtpStreamOps + Send> = match enc {
    // Explicit FTPS: connect in plain text, then upgrade the control channel
    // with AUTH TLS. The transport is erased by the library, but it wants the
    // generic marker to equal the connector's stream type (`AsyncNativeTlsStream`).
    "explicit" => {
      let plain = ImplAsyncFtpStream::<AsyncNativeTlsStream>::connect(&addr)
        .await
        .map_err(|e| format!("FTP connect failed: {e}"))?;
      let secure = plain
        .into_secure(connector, host)
        .await
        .map_err(|e| format!("TLS upgrade failed: {e}"))?;
      Box::new(
        finish_login(secure, username, password)
          .await
          .map_err(|e| format!("{e} (explicit FTPS)"))?,
      )
    }
    "implicit" => {
      let secure = ImplAsyncFtpStream::<AsyncNativeTlsStream>::connect_secure_implicit(&addr, connector, host)
        .await
        .map_err(|e| format!("implicit FTPS connect failed: {e}"))?;
      Box::new(finish_login(secure, username, password).await?)
    }
    _ => {
      let plain = AsyncFtpStream::connect(&addr)
        .await
        .map_err(|e| format!("FTP connect failed: {e}"))?;
      Box::new(finish_login(plain, username, password).await?)
    }
  };
  Ok(stream)
}

#[tauri::command]
pub async fn connect_ftp(
  state: tauri::State<'_, AppState>,
  args: ConnectFtpArgs,
) -> Result<ConnectResult, String> {
  if args.host.trim().is_empty() {
    return Err("Host is required".into());
  }
  let stream = make_boxed(&args).await?;
  state
    .ftp_sessions
    .lock()
    .map_err(|e| e.to_string())?
    .insert(
      args.tab_id,
      FtpSession::new(args.tab_id, stream),
    );
  Ok(ConnectResult {
    status: "connected".into(),
    tab_id: args.tab_id,
  })
}

#[tauri::command]
pub async fn disconnect_ftp(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<(), String> {
  let session = state
    .ftp_sessions
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&tab_id);
  if let Some(s) = session {
    // Best effort: send QUIT, then drop (socket close).
    if let Ok(mut g) = s.stream.try_lock() {
      let _ = g.quit().await;
    }
  }
  Ok(())
}

/// Hold an `AsyncFtpStream` alive during login for FTPS connections — the TLS
/// handshake needs the transport generic to be concrete.
#[allow(dead_code)]
fn _assert_ftp_stream_send<T: TokioTlsStream + Send>() {}
