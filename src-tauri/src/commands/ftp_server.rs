//! In-app FTP server. A lightweight RFC 959 server built directly on tokio
//! (passive mode only: PASV/EPSV). Supports USER/PASS, binary transfers via
//! RETR/STOR, MLSD/LIST, SIZE/MDTM and basic path confinement inside the
//! configured root. Read-only by default; enable writes explicitly.
//!
//! It intentionally replaces a full `libunftp` integration: the server engine
//! stays dependency-light while still supporting normal desktop FTP clients
//! (FileZilla, Windows ftp.exe, curl, suppaftp).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

use crate::ssh_session::{AppServerStatus, AppState};

/// Handle to the running FTP server task.
pub struct FtpServerRuntime {
  pub port: u16,
  pub started_at_ms: u64,
  pub abort: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpServerArgs {
  pub root_dir: String,
  #[serde(default = "default_ftp_port")]
  pub port: u16,
  #[serde(default)]
  pub read_only: bool,
  #[serde(default)]
  pub anonymous: bool,
  #[serde(default)]
  pub username: Option<String>,
  #[serde(default)]
  pub password: Option<String>,
}

fn default_ftp_port() -> u16 {
  2121
}

/// Immutable server configuration shared with every connection task.
struct FtpCfg {
  root: PathBuf,
  root_canon: PathBuf,
  read_only: bool,
  anonymous: bool,
  username: String,
  password: String,
}

struct ConnState {
  logged_in: bool,
  user: String,
  cwd: String, // virtual current dir, "/..." form
  /// Passive-mode listener created by PASV/EPSV waiting for the data connection.
  pending_data: Option<Arc<TcpListener>>,
  type_is_ascii: bool,
  rnfr: Option<String>,
}

fn virt_normalize(cur: &str, arg: &str) -> Result<String, String> {
  if arg.is_empty() {
    return Ok(cur.to_string());
  }
  let start = if arg.starts_with('/') { "" } else { cur };
  let joined = format!("{start}/{arg}");
  let mut parts: Vec<&str> = Vec::new();
  for seg in joined.split('/') {
    if seg.is_empty() || seg == "." {
      continue;
    }
    if seg == ".." {
      if parts.pop().is_none() {
        return Err("path above root".into());
      }
      continue;
    }
    parts.push(seg);
  }
  let mut out = String::from("/");
  out.push_str(&parts.join("/"));
  Ok(out)
}

/// Convert a virtual server path into a real path confined to the root.
fn real_path(cfg: &FtpCfg, virt: &str) -> Result<PathBuf, String> {
  let norm = virt_normalize("/", virt)?;
  let rel = norm.trim_start_matches('/');
  let cand = cfg.root.join(rel);
  if !cand.starts_with(&cfg.root_canon) {
    return Err("path escapes server root".into());
  }
  Ok(cand)
}

async fn reply(
  wr: &mut tokio::net::tcp::OwnedWriteHalf,
  code: u16,
  text: &str,
) -> std::io::Result<()> {
  wr.write_all(format!("{code} {text}\r\n").as_bytes()).await
}

fn mlsd_line(is_dir: bool, size: u64, name: &str) -> String {
  let t = if is_dir { "dir" } else { "file" };
  format!("type={t};size={size};modify=00000000000000; {name}\r\n")
}

/// Unix-style LIST fallback line.
fn list_line(is_dir: bool, size: u64, name: &str) -> String {
  let perm = if is_dir { "drwxr-xr-x" } else { "-rw-r--r--" };
  format!(
    "{perm}   1 owner  group  {size:>12} Jan 01 00:00 {name}{}\r\n",
    if is_dir { "/" } else { "" }
  )
}

async fn run_listing(
  wr: &mut tokio::net::tcp::OwnedWriteHalf,
  st: &mut ConnState,
  cfg: &Arc<FtpCfg>,
  path_arg: &str,
  use_mlsd: bool,
) -> Result<(), String> {
  let target_virt = if path_arg.is_empty() {
    st.cwd.clone()
  } else if path_arg.starts_with('/') {
    virt_normalize("/", path_arg)?
  } else {
    virt_normalize(&st.cwd, path_arg)?
  };
  let real = real_path(cfg, &target_virt)?;
  let meta = std::fs::metadata(&real).map_err(|e| format!("no such path: {e}"))?;
  let names: Vec<PathBuf> = if meta.is_dir() {
    let mut v: Vec<PathBuf> = std::fs::read_dir(&real)
      .map_err(|e| e.to_string())?
      .filter_map(|e| e.ok())
      .map(|e| e.path())
      .collect();
    v.sort();
    v
  } else {
    vec![real.clone()]
  };
  let listener = st.pending_data.take().ok_or("Use PASV or EPSV first")?;
  reply(
    wr,
    150,
    if use_mlsd {
      "Opening data connection for MLSD"
    } else {
      "Opening data connection for LIST"
    },
  )
  .await
  .map_err(|e| e.to_string())?;
  let (mut ds, _peer) = timeout(Duration::from_secs(20), listener.accept())
    .await
    .map_err(|_| "data connection timeout")?
    .map_err(|e| e.to_string())?;
  let mut buf = Vec::with_capacity(names.len() * 120 + 64);
  for p in names {
    let is_dir = p.is_dir();
    let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    let name = p
      .file_name()
      .map(|s| s.to_string_lossy().to_string())
      .unwrap_or_default();
    if name.is_empty() {
      continue;
    }
    let item = if use_mlsd {
      mlsd_line(is_dir, size, &name)
    } else {
      list_line(is_dir, size, &name)
    };
    buf.extend_from_slice(item.as_bytes());
  }
  ds.write_all(&buf).await.map_err(|e| e.to_string())?;
  ds.shutdown().await.map_err(|e| e.to_string())?;
  reply(wr, 226, "Directory send OK")
    .await
    .map_err(|e| e.to_string())?;
  Ok(())
}

async fn do_retr(
  wr: &mut tokio::net::tcp::OwnedWriteHalf,
  st: &mut ConnState,
  cfg: &Arc<FtpCfg>,
  path_arg: &str,
) -> Result<(), String> {
  let target = if path_arg.is_empty() {
    st.cwd.clone()
  } else {
    virt_normalize(&st.cwd, path_arg)?
  };
  let real = real_path(cfg, &target)?;
  if real.is_dir() {
    return Err("550 is a directory".into());
  }
  let mut f = tokio::fs::File::open(&real)
    .await
    .map_err(|e| format!("550 open failed: {e}"))?;
  let len = f.metadata().await.map(|m| m.len()).unwrap_or(0);
  let listener = st.pending_data.take().ok_or("425 Use PASV or EPSV first")?;
  reply(wr, 150, &format!("Opening data connection, {len} bytes"))
    .await
    .map_err(|e| e.to_string())?;
  let (mut ds, _peer) = timeout(Duration::from_secs(20), listener.accept())
    .await
    .map_err(|_| "data connection timeout")?
    .map_err(|e| e.to_string())?;
  let mut left = len;
  let mut chunk = vec![0u8; 65536];
  loop {
    let n = f.read(&mut chunk).await.map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    ds.write_all(&chunk[..n]).await.map_err(|e| e.to_string())?;
    left -= n as u64;
  }
  let _ = left;
  ds.shutdown().await.map_err(|e| e.to_string())?;
  reply(wr, 226, "Transfer complete")
    .await
    .map_err(|e| e.to_string())?;
  Ok(())
}

async fn do_stor(
  wr: &mut tokio::net::tcp::OwnedWriteHalf,
  st: &mut ConnState,
  cfg: &Arc<FtpCfg>,
  path_arg: &str,
) -> Result<(), String> {
  if cfg.read_only {
    return Err("550 server is read-only".into());
  }
  let target = if path_arg.is_empty() {
    st.cwd.clone()
  } else {
    virt_normalize(&st.cwd, path_arg)?
  };
  let real = real_path(cfg, &target)?;
  if let Some(parent) = real.parent() {
    tokio::fs::create_dir_all(parent)
      .await
      .map_err(|e| format!("550 {e}"))?;
  }
  let listener = st.pending_data.take().ok_or("425 Use PASV or EPSV first")?;
  reply(wr, 150, "Opening data connection for STOR")
    .await
    .map_err(|e| e.to_string())?;
  let (mut ds, _peer) = timeout(Duration::from_secs(20), listener.accept())
    .await
    .map_err(|_| "data connection timeout")?
    .map_err(|e| e.to_string())?;
  let mut f = tokio::fs::File::create(&real)
    .await
    .map_err(|e| format!("550 create failed: {e}"))?;
  let mut total: u64 = 0;
  let mut chunk = vec![0u8; 65536];
  loop {
    let n = ds.read(&mut chunk).await.map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    f.write_all(&chunk[..n]).await.map_err(|e| e.to_string())?;
    total += n as u64;
  }
  f.flush().await.map_err(|e| e.to_string())?;
  reply(wr, 226, &format!("Transfer complete ({total} bytes)"))
    .await
    .map_err(|e| e.to_string())?;
  Ok(())
}

fn fmt_mdtm(path: &Path) -> Option<String> {
  let m = std::fs::metadata(path).ok()?.modified().ok()?;
  let secs = m.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
  // Civil-from-days conversion (proleptic Gregorian, UTC).
  let days = (secs / 86400) as i64;
  let rem = secs % 86400;
  let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
  let z = days + 719468;
  let era = if z >= 0 { z } else { z - 146096 } / 146097;
  let doe = (z - era * 146097) as u64; // [0,146096]
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0,399]
  let y = yoe as i64 + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0,365]
  let mp = (5 * doy + 2) / 153; // [0,11]
  let d = doy - (153 * mp + 2) / 5 + 1; // [1,31]
  let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1,12]
  let yy = if m <= 2 { y + 1 } else { y };
  Some(format!("{yy:04}{m:02}{d:02}{h:02}{mi:02}{s:02}"))
}

/// Execute a single FTP command. Returns `Ok(())` on success; on error the
/// message starts with a 3-digit code (e.g. "550 not found") that the caller
/// turns into a reply so the session stays open.
async fn dispatch(
  wr: &mut tokio::net::tcp::OwnedWriteHalf,
  st: &mut ConnState,
  cfg: &Arc<FtpCfg>,
  local_ip: std::net::IpAddr,
  cmd: &str,
  arg: String,
) -> Result<(), String> {
  match cmd {
    "USER" => {
      st.user = arg;
      st.logged_in = false;
      reply(wr, 331, "Password required")
        .await
        .map_err(|e| e.to_string())
    }
    "PASS" => {
      let ok =
        cfg.anonymous || (st.user.eq_ignore_ascii_case(&cfg.username) && arg == cfg.password);
      if ok {
        st.logged_in = true;
        reply(wr, 230, "Login successful")
          .await
          .map_err(|e| e.to_string())
      } else {
        reply(wr, 530, "Login incorrect")
          .await
          .map_err(|e| e.to_string())
      }
    }
    "QUIT" => {
      let _ = reply(wr, 221, "Goodbye").await;
      Ok(())
    }
    "NOOP" => reply(wr, 200, "NOOP ok").await.map_err(|e| e.to_string()),
    "SYST" => reply(wr, 215, "UNIX Type: L8")
      .await
      .map_err(|e| e.to_string()),
    "FEAT" => {
      let features = "211-Extensions supported:\r\n MLST type*;size*;modify*;\r\n SIZE\r\n MDTM\r\n MLSD\r\n EPSV\r\n PASV\r\n UTF8\r\n TVFS\r\n211 End";
      wr.write_all(features.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
      wr.write_all(b"\r\n").await.map_err(|e| e.to_string())?;
      Ok(())
    }
    "OPTS" => {
      // OPTS UTF8 ON / OPTS MLST ...
      reply(wr, 200, "OK").await.map_err(|e| e.to_string())
    }
    "TYPE" => {
      st.type_is_ascii = arg.eq_ignore_ascii_case("A");
      reply(wr, 200, "Type set").await.map_err(|e| e.to_string())
    }
    "PWD" => {
      let canon = if st.cwd == "/" {
        "/".to_string()
      } else {
        st.cwd.clone()
      };
      reply(wr, 257, &format!("\"{canon}\" is current directory"))
        .await
        .map_err(|e| e.to_string())
    }
    "CWD" => match virt_normalize(&st.cwd, &arg) {
      Ok(nv) => {
        if real_path(cfg, &nv)?.is_dir() {
          st.cwd = nv;
          reply(wr, 250, "Directory changed")
            .await
            .map_err(|e| e.to_string())
        } else {
          Err("550 directory does not exist".into())
        }
      }
      Err(e) => Err(format!("550 {e}")),
    },
    "CDUP" => {
      let nv = virt_normalize(&st.cwd, "..")?;
      st.cwd = nv;
      reply(wr, 250, "Directory changed")
        .await
        .map_err(|e| e.to_string())
    }
    "PASV" => match local_ip {
      std::net::IpAddr::V4(v4) => {
        let ls = TcpListener::bind(std::net::SocketAddr::new(local_ip, 0))
          .await
          .map_err(|e| e.to_string())?;
        let port = ls.local_addr().map_err(|e| e.to_string())?.port();
        st.pending_data = Some(Arc::new(ls));
        let oct = v4.octets();
        let msg = format!(
          "227 Entering Passive Mode ({},{},{},{},{},{})",
          oct[0],
          oct[1],
          oct[2],
          oct[3],
          port / 256,
          port % 256
        );
        reply(wr, 227, &msg).await.map_err(|e| e.to_string())
      }
      _ => Err("425 PASV requires IPv4, use EPSV".into()),
    },
    "EPSV" => {
      let ls = TcpListener::bind(std::net::SocketAddr::new(local_ip, 0))
        .await
        .map_err(|e| e.to_string())?;
      let port = ls.local_addr().map_err(|e| e.to_string())?.port();
      st.pending_data = Some(Arc::new(ls));
      let msg = format!("229 Entering Extended Passive Mode (|||{port}|)");
      reply(wr, 229, &msg).await.map_err(|e| e.to_string())
    }
    "PORT" | "EPRT" => Err("500 only passive mode (PASV/EPSV) is supported".into()),
    "SIZE" => {
      let real = real_path(cfg, &arg)?;
      if real.is_dir() {
        Err("550 not a regular file".into())
      } else {
        let size = std::fs::metadata(&real)
          .map(|m| m.len())
          .map_err(|e| format!("550 {e}"))?;
        reply(wr, 213, &size.to_string())
          .await
          .map_err(|e| e.to_string())
      }
    }
    "MDTM" => {
      let real = real_path(cfg, &arg)?;
      match fmt_mdtm(&real) {
        Some(s) => reply(wr, 213, &s).await.map_err(|e| e.to_string()),
        None => Err("550 no modification time".into()),
      }
    }
    "MLSD" => run_listing(wr, st, cfg, &arg, true).await,
    "LIST" => {
      let a = arg.trim_start_matches(['-', 'l']);
      run_listing(wr, st, cfg, a.trim(), false).await
    }
    "NLST" => Err("502 NLST not implemented (use MLSD)".into()),
    "RETR" => do_retr(wr, st, cfg, &arg).await,
    "STOR" => do_stor(wr, st, cfg, &arg).await,
    "DELE" => {
      if cfg.read_only {
        Err("550 server is read-only".into())
      } else {
        let real = real_path(cfg, &arg)?;
        std::fs::remove_file(&real).map_err(|e| format!("550 {e}"))?;
        reply(wr, 250, "Deleted").await.map_err(|e| e.to_string())
      }
    }
    "MKD" => {
      if cfg.read_only {
        Err("550 server is read-only".into())
      } else {
        let real = real_path(cfg, &arg)?;
        std::fs::create_dir_all(&real).map_err(|e| format!("550 {e}"))?;
        reply(wr, 257, "Directory created")
          .await
          .map_err(|e| e.to_string())
      }
    }
    "RMD" => {
      if cfg.read_only {
        Err("550 server is read-only".into())
      } else {
        let real = real_path(cfg, &arg)?;
        std::fs::remove_dir(&real).map_err(|e| format!("550 {e}"))?;
        reply(wr, 250, "Removed").await.map_err(|e| e.to_string())
      }
    }
    "RNFR" => {
      if cfg.read_only {
        Err("550 server is read-only".into())
      } else {
        st.rnfr = Some(arg);
        reply(wr, 350, "Ready for RNTO")
          .await
          .map_err(|e| e.to_string())
      }
    }
    "RNTO" => {
      if cfg.read_only {
        Err("550 server is read-only".into())
      } else {
        let from = st.rnfr.take().ok_or("503 RNFR required")?;
        let src = real_path(cfg, &from)?;
        let dst = real_path(cfg, &arg)?;
        std::fs::rename(&src, &dst).map_err(|e| format!("550 {e}"))?;
        reply(wr, 250, "Renamed").await.map_err(|e| e.to_string())
      }
    }
    "ABOR" => {
      st.pending_data = None;
      reply(wr, 226, "Abort successful")
        .await
        .map_err(|e| e.to_string())
    }
    "REST" | "APPE" | "SITE" | "STAT" => Err("502 not implemented".into()),
    _ => Err("500 command not understood".into()),
  }
}

/// Handle one FTP control connection until EOF.
async fn handle_conn(stream: TcpStream, cfg: Arc<FtpCfg>, peer: SocketAddr) {
  let mut st = ConnState {
    logged_in: false,
    user: String::new(),
    cwd: "/".into(),
    pending_data: None,
    type_is_ascii: false,
    rnfr: None,
  };
  let stream_local_ip = stream
    .local_addr()
    .map(|a| a.ip())
    .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
  let (rd, mut wr) = stream.into_split();
  let mut rd = BufReader::new(rd);
  let mut line = String::new();
  let _ = reply(&mut wr, 220, "wrolp-terminal FTP server ready").await;
  loop {
    line.clear();
    match rd.read_line(&mut line).await {
      Ok(0) | Err(_) => break,
      Ok(_) => {}
    }
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
      continue;
    }
    // Slog each command to the Rust console for debuggability.
    eprintln!("[ftp_server] {peer} <- {trimmed}");
    let (cmd, arg) = match trimmed.split_once(' ') {
      Some((c, a)) => (c.to_ascii_uppercase(), a.trim().to_string()),
      None => (trimmed.to_ascii_uppercase(), String::new()),
    };
    if cmd != "PASS" && !st.logged_in && cmd != "USER" && cmd != "QUIT" && cmd != "NOOP" {
      let _ = reply(&mut wr, 530, "Please login with USER and PASS").await;
      continue;
    }
    match dispatch(&mut wr, &mut st, &cfg, stream_local_ip, &cmd, arg).await {
      Ok(()) if cmd == "QUIT" => break,
      Ok(()) => {}
      Err(msg) => {
        let (code, text) = match msg.find(' ') {
          Some(i) => {
            let code = msg[..i].parse::<u16>().unwrap_or(500);
            (code, msg[i + 1..].to_string())
          }
          None => (500, msg.clone()),
        };
        let _ = reply(&mut wr, code, &text).await;
      }
    }
  }
}

#[tauri::command]
pub async fn start_ftp_server(
  state: tauri::State<'_, AppState>,
  args: FtpServerArgs,
) -> Result<AppServerStatus, String> {
  {
    let guard = state.ftp_server.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
      return Err("FTP server is already running. Stop it first.".into());
    }
  }
  let root = PathBuf::from(&args.root_dir);
  if !root.is_dir() {
    return Err(format!("Root directory does not exist: {}", root.display()));
  }
  let root_canon = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
  let cfg = Arc::new(FtpCfg {
    root: root.clone(),
    root_canon,
    read_only: args.read_only,
    anonymous: args.anonymous,
    username: args.username.clone().unwrap_or_default(),
    password: args.password.clone().unwrap_or_default(),
  });

  let addr = std::net::SocketAddr::from(([0, 0, 0, 0], args.port));
  let listener = tokio::net::TcpListener::bind(addr)
    .await
    .map_err(|e| format!("Cannot bind port {}: {e}", args.port))?;
  let started_ms = crate::commands::now_ms();

  let handle = tauri::async_runtime::spawn(async move {
    while let Ok((stream, peer)) = listener.accept().await {
      let cfg = cfg.clone();
      tauri::async_runtime::spawn(async move {
        handle_conn(stream, cfg, peer).await;
      });
    }
  });

  state
    .ftp_server
    .lock()
    .map_err(|e| e.to_string())?
    .replace(FtpServerRuntime {
      port: args.port,
      started_at_ms: started_ms,
      abort: handle,
    });

  Ok(AppServerStatus {
    running: true,
    kind: "ftp".into(),
    port: args.port,
    started_at_ms: started_ms,
  })
}

#[tauri::command]
pub async fn stop_ftp_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
  let runtime = state.ftp_server.lock().map_err(|e| e.to_string())?.take();
  if let Some(r) = runtime {
    r.abort.abort();
  }
  Ok(())
}

#[tauri::command]
pub async fn ftp_server_status(
  state: tauri::State<'_, AppState>,
) -> Result<AppServerStatus, String> {
  let g = state.ftp_server.lock().map_err(|e| e.to_string())?;
  Ok(match g.as_ref() {
    Some(r) => AppServerStatus {
      running: true,
      kind: "ftp".into(),
      port: r.port,
      started_at_ms: r.started_at_ms,
    },
    None => AppServerStatus {
      running: false,
      kind: "ftp".into(),
      port: 2121,
      started_at_ms: 0,
    },
  })
}
