//! In-app HTTP(S) file server built on axum. Provides:
//!  - a browse/upload HTML page at `/` (hide upload form when read-only)
//!  - directory listings at any path (links use the token query when auth on)
//!  - file download streaming
//!  - `POST /upload` (multipart) and `PUT /upload/{*path}` (raw body)
//!  - optional token auth via `?token=` query or `X-Auth-Token` header
//!  - optional TLS using PEM cert/key files (via axum-server + rustls)
//!
//! The server never touches `RemoteFs`; it is a standalone local network file
//! share, typically used to hand files to a phone or another computer.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, put};
use axum::Router;
use rcgen::{CertificateParams, DnType, Ia5String, KeyPair, SanType};
use time::{Duration, OffsetDateTime};

use crate::ssh_session::{AppServerStatus, AppState};

/// Handle to the running HTTP server task.
pub struct HttpServerRuntime {
  pub port: u16,
  pub started_at_ms: u64,
  pub abort: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpServerArgs {
  pub root_dir: String,
  #[serde(default = "default_http_port")]
  pub port: u16,
  #[serde(default)]
  pub read_only: bool,
  #[serde(default)]
  pub require_auth: bool,
  #[serde(default)]
  pub token: Option<String>,
  #[serde(default)]
  pub enable_tls: bool,
  #[serde(default)]
  pub cert_path: Option<String>,
  #[serde(default)]
  pub key_path: Option<String>,
  #[serde(default = "default_max_upload")]
  pub max_upload_size: u64,
}

fn default_http_port() -> u16 {
  8000
}

fn default_max_upload() -> u64 {
  256 * 1024 * 1024
}

#[derive(Clone)]
struct Srv {
  root: PathBuf,
  read_only: bool,
  token: Option<String>,
  max_bytes: u64,
}

fn html_escape(s: &str) -> String {
  s.replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
}

fn mime_for(p: &Path) -> &'static str {
  match p
    .extension()
    .and_then(|e| e.to_str())
    .map(|e| e.to_ascii_lowercase())
  {
    Some(ext) if ext == "html" || ext == "htm" => "text/html; charset=utf-8",
    Some(ext) if ext == "css" => "text/css; charset=utf-8",
    Some(ext) if ext == "js" || ext == "mjs" => "text/javascript; charset=utf-8",
    Some(ext) if ext == "json" => "application/json; charset=utf-8",
    Some(ext) if ext == "txt" || ext == "md" || ext == "log" => "text/plain; charset=utf-8",
    Some(ext) if ext == "png" => "image/png",
    Some(ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
    Some(ext) if ext == "gif" => "image/gif",
    Some(ext) if ext == "svg" => "image/svg+xml",
    Some(ext) if ext == "webp" => "image/webp",
    Some(ext) if ext == "ico" => "image/x-icon",
    Some(ext) if ext == "pdf" => "application/pdf",
    Some(ext) if ext == "zip" => "application/zip",
    Some(ext) if ext == "gz" => "application/gzip",
    Some(ext) if ext == "tar" => "application/x-tar",
    Some(ext) if ext == "mp3" => "audio/mpeg",
    Some(ext) if ext == "mp4" => "video/mp4",
    _ => "application/octet-stream",
  }
}

/// Join a URL path relative to the server root safely.
fn safe_path(root: &Path, rel: &str) -> Option<PathBuf> {
  let mut parts: Vec<&str> = Vec::new();
  for seg in rel.split('/') {
    if seg.is_empty() || seg == "." {
      continue;
    }
    if seg == ".." {
      return None;
    }
    parts.push(seg);
  }
  let joined = parts.iter().fold(root.to_path_buf(), |acc, p| acc.join(p));
  Some(joined)
}

fn auth_ok(srv: &Srv, headers: &HeaderMap, query: &HashMap<String, String>) -> bool {
  match &srv.token {
    None => true,
    Some(tok) => {
      if let Some(h) = headers.get("x-auth-token").and_then(|v| v.to_str().ok()) {
        if h == tok {
          return true;
        }
      }
      query.get("token").map(|v| v == tok).unwrap_or(false)
    }
  }
}

fn auth_fail() -> Response {
  (
    StatusCode::UNAUTHORIZED,
    [(header::WWW_AUTHENTICATE, "Token realm=\"wrolp\"")],
    "401 Unauthorized: wrong or missing token",
  )
    .into_response()
}

fn page_html(srv: &Srv, rel: &str, entries: Vec<(bool, String, u64)>, token_q: &str) -> String {
  let mut rows = String::new();
  for (is_dir, name, size) in entries {
    let enc = html_escape(&name);
    if is_dir {
      rows.push_str(&format!(
        "<tr><td><a href=\"{}/{}{}\">📁 {}/</a></td><td></td></tr>",
        if rel.is_empty() { "" } else { rel },
        enc,
        token_q,
        enc
      ));
    } else {
      let sz = if size >= 1024 * 1024 {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
      } else if size >= 1024 {
        format!("{:.1} KB", size as f64 / 1024.0)
      } else {
        format!("{size} B")
      };
      rows.push_str(&format!(
        "<tr><td><a href=\"{}/{}{}\">📄 {}</a></td><td>{}</td></tr>",
        if rel.is_empty() { "" } else { rel },
        enc,
        token_q,
        enc,
        sz
      ));
    }
  }
  if rows.is_empty() {
    rows = "<tr><td colspan=2 class=empty>(empty directory)</td></tr>".to_string();
  }
  let up = if rel.is_empty() {
    String::new()
  } else {
    let parent = rel.rsplit_once('/').map(|(a, _)| a).unwrap_or("");
    format!(
      "<p><a href=\"/{}\">⬆ Parent directory</a></p>",
      if parent.is_empty() { "" } else { parent }
    )
  };
  let upload_form = if srv.read_only {
    "".to_string()
  } else {
    "<section class=card><h2>Upload files</h2><input type=file id=files multiple><button onclick=\"up()\">Upload</button><div id=log></div></section>"
      .to_string()
  };
  let root_name = html_escape(&srv.root.to_string_lossy());
  format!(
    "<!doctype html><html><head><meta charset=utf-8><title>wrolp File Share</title><style>
     body{{font-family:system-ui,Segoe UI,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;background:#0f1420;color:#e8eaf0}}
     a{{color:#7db3ff;text-decoration:none}} a:hover{{text-decoration:underline}}
     table{{width:100%;border-collapse:collapse}} td{{padding:6px 8px;border-bottom:1px solid #263}}
     .card{{background:#171d2e;border:1px solid #263047;border-radius:10px;padding:16px;margin-bottom:18px}}
     h1,h2{{margin-top:0}} .tag{{color:#9aa;font-size:.9rem}}
     .empty{{color:#667}} button{{margin-top:10px}}
     #log{{margin-top:8px;font-size:.85rem;color:#9c6}}
     </style></head><body>
     <div class=card><h1>📁 wrolp File Share</h1><div class=tag>Root: {root_name} · Path: /{rel}</div>{up}</div>
     {upload_form}
     <div class=card><h2>Files</h2><table>{rows}</table></div>
     <script>
     async function up(){{
       const f=document.getElementById('files').files;
       const log=document.getElementById('log'); log.textContent='';
       for(const file of f){{
         log.textContent='Uploading ' + file.name + ' …';
         const r=await fetch('/upload?token='+encodeURIComponent('__TOK__'),{{method:'POST',body:file,headers:{{'X-File-Name':encodeURIComponent(file.name)}}}});
         if(!r.ok){{log.textContent='Failed: '+file.name+' '+r.status;return}}
       }}
       log.textContent='✅ All uploads complete'; location.reload();
     }}
     </script></body></html>",
    root_name = root_name,
    rel = rel,
    up = up,
    upload_form = upload_form,
    rows = rows,
  )
  .replace("__TOK__", srv.token.as_deref().unwrap_or(""))
}

async fn handle_index(
  State(srv): State<Srv>,
  headers: HeaderMap,
  Query(query): Query<HashMap<String, String>>,
) -> Response {
  if !auth_ok(&srv, &headers, &query) {
    return auth_fail();
  }
  let token_q = srv
    .token
    .as_ref()
    .map(|t| format!("?token={}", urlencode(t)))
    .unwrap_or_default();
  let mut entries = Vec::new();
  if let Ok(rd) = std::fs::read_dir(&srv.root) {
    for e in rd.flatten() {
      let name = e.file_name().to_string_lossy().to_string();
      let is_dir = e.path().is_dir();
      let size = e.path().metadata().map(|m| m.len()).unwrap_or(0);
      entries.push((is_dir, name, size));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
  }
  Html(page_html(&srv, "", entries, &token_q)).into_response()
}

async fn handle_browse(
  State(srv): State<Srv>,
  headers: HeaderMap,
  Query(query): Query<HashMap<String, String>>,
  UrlPath(rel): UrlPath<String>,
) -> Response {
  if !auth_ok(&srv, &headers, &query) {
    return auth_fail();
  }
  let token_q = srv
    .token
    .as_ref()
    .map(|t| format!("?token={}", urlencode(t)))
    .unwrap_or_default();
  let Some(path) = safe_path(&srv.root, &rel) else {
    return (StatusCode::FORBIDDEN, "Forbidden").into_response();
  };
  let meta = match tokio::fs::metadata(&path).await {
    Ok(m) => m,
    Err(_) => return (StatusCode::NOT_FOUND, "Not found").into_response(),
  };
  if meta.is_dir() {
    let mut entries = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(&path).await {
      while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        let size = e.metadata().await.map(|m| m.len()).unwrap_or(0);
        entries.push((is_dir, name, size));
      }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    Html(page_html(&srv, &rel, entries, &token_q)).into_response()
  } else if meta.is_file() {
    match tokio::fs::read(&path).await {
      Ok(bytes) => {
        let mut resp = Response::new(Body::from(bytes));
        resp
          .headers_mut()
          .insert(header::CONTENT_TYPE, mime_for(&path).parse().unwrap());
        resp.headers_mut().insert(
          header::CONTENT_DISPOSITION,
          format!("inline; filename=\"{}\"", html_escape(&rel))
            .parse()
            .unwrap(),
        );
        resp
      }
      Err(e) => (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("read failed: {e}"),
      )
        .into_response(),
    }
  } else {
    (StatusCode::NOT_FOUND, "Not found").into_response()
  }
}

async fn handle_upload_put(
  State(srv): State<Srv>,
  headers: HeaderMap,
  Query(query): Query<HashMap<String, String>>,
  UrlPath(rel): UrlPath<String>,
  body: axum::body::Bytes,
) -> Response {
  if srv.read_only {
    return (StatusCode::FORBIDDEN, "server is read-only").into_response();
  }
  if !auth_ok(&srv, &headers, &query) {
    return auth_fail();
  }
  if body.len() as u64 > srv.max_bytes {
    return (
      StatusCode::PAYLOAD_TOO_LARGE,
      format!("file exceeds {}-byte upload limit", srv.max_bytes),
    )
      .into_response();
  }
  let Some(path) = safe_path(&srv.root, &rel) else {
    return (StatusCode::FORBIDDEN, "Forbidden path").into_response();
  };
  if let Some(parent) = path.parent() {
    if tokio::fs::create_dir_all(parent).await.is_err() {
      return (StatusCode::INTERNAL_SERVER_ERROR, "cannot create dir").into_response();
    }
  }
  match tokio::fs::write(&path, &body).await {
    Ok(()) => (StatusCode::OK, format!("{} bytes written", body.len())).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response(),
  }
}

async fn handle_upload_raw(
  State(srv): State<Srv>,
  headers: HeaderMap,
  Query(query): Query<HashMap<String, String>>,
  body: axum::body::Bytes,
) -> Response {
  if srv.read_only {
    return (StatusCode::FORBIDDEN, "server is read-only").into_response();
  }
  if !auth_ok(&srv, &headers, &query) {
    return auth_fail();
  }
  if body.len() as u64 > srv.max_bytes {
    return (
      StatusCode::PAYLOAD_TOO_LARGE,
      format!("file exceeds {}-byte upload limit", srv.max_bytes),
    )
      .into_response();
  }
  // Browser sends the file name either in the `X-File-Name` header or as a
  // `file` query parameter; both are URL-encoded.
  let raw = headers
    .get("x-file-name")
    .and_then(|v| v.to_str().ok())
    .map(|s| s.to_string())
    .or_else(|| query.get("file").cloned())
    .unwrap_or_else(|| format!("upload-{}.bin", crate::commands::now_ms()));
  let decoded = percent_decode(&raw);
  let name = decoded.rsplit('/').next().unwrap_or(&decoded).to_string();
  let Some(path) = safe_path(&srv.root, &name) else {
    return (StatusCode::FORBIDDEN, "Forbidden path").into_response();
  };
  if let Some(parent) = path.parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  match tokio::fs::write(&path, &body).await {
    Ok(()) => (StatusCode::OK, format!("{} bytes written", body.len())).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response(),
  }
}

fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let Ok(h) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
        if let Ok(v) = u8::from_str_radix(h, 16) {
          out.push(v);
          i += 3;
          continue;
        }
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn urlencode(s: &str) -> String {
  let mut out = String::new();
  for b in s.as_bytes() {
    match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
      _ => out.push_str(&format!("%{:02X}", b)),
    }
  }
  out
}

fn build_router(srv: Srv) -> Router {
  let mut r = Router::new()
    .route("/", get(handle_index))
    .route("/{*path}", get(handle_browse));
  if !srv.read_only {
    r = r
      .route("/upload/{*path}", put(handle_upload_put))
      .route("/upload", axum::routing::post(handle_upload_raw));
  }
  r.with_state(srv)
}

#[tauri::command]
pub async fn start_http_server(
  state: tauri::State<'_, AppState>,
  args: HttpServerArgs,
) -> Result<AppServerStatus, String> {
  {
    let guard = state.http_server.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
      return Err("HTTP server is already running. Stop it first.".into());
    }
  }
  let root = PathBuf::from(&args.root_dir);
  if !root.is_dir() {
    return Err(format!("Root directory does not exist: {}", root.display()));
  }
  if args.require_auth && args.token.as_deref().unwrap_or("").is_empty() {
    return Err("Token must be provided when authentication is enabled".into());
  }
  let token = if args.require_auth {
    args.token.clone()
  } else {
    None
  };
  let srv = Srv {
    root,
    read_only: args.read_only,
    token,
    max_bytes: args.max_upload_size,
  };
  let router = build_router(srv.clone());
  let addr = SocketAddr::from(([0, 0, 0, 0], args.port));
  let started_ms = crate::commands::now_ms();

  let handle = if args.enable_tls {
    let cert_path = args
      .cert_path
      .clone()
      .ok_or("certPath is required for HTTPS")?;
    let key_path = args
      .key_path
      .clone()
      .ok_or("keyPath is required for HTTPS")?;
    let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert_path, key_path)
      .await
      .map_err(|e| format!("Cannot load TLS certificate/key: {e}"))?;
    tauri::async_runtime::spawn(async move {
      let _ = axum_server::bind_rustls(addr, tls)
        .serve(router.into_make_service())
        .await;
    })
  } else {
    let listener = tokio::net::TcpListener::bind(addr)
      .await
      .map_err(|e| format!("Cannot bind port {}: {e}", args.port))?;
    tauri::async_runtime::spawn(async move {
      let _ = axum::serve(listener, router).await;
    })
  };

  state
    .http_server
    .lock()
    .map_err(|e| e.to_string())?
    .replace(HttpServerRuntime {
      port: args.port,
      started_at_ms: started_ms,
      abort: handle,
    });

  Ok(AppServerStatus {
    running: true,
    kind: if args.enable_tls { "https" } else { "http" }.into(),
    port: args.port,
    started_at_ms: started_ms,
  })
}

#[tauri::command]
pub async fn stop_http_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
  let runtime = state.http_server.lock().map_err(|e| e.to_string())?.take();
  if let Some(r) = runtime {
    r.abort.abort();
  }
  Ok(())
}

#[tauri::command]
pub async fn http_server_status(
  state: tauri::State<'_, AppState>,
) -> Result<AppServerStatus, String> {
  let g = state.http_server.lock().map_err(|e| e.to_string())?;
  Ok(match g.as_ref() {
    Some(r) => AppServerStatus {
      running: true,
      kind: "http".into(),
      port: r.port,
      started_at_ms: r.started_at_ms,
    },
    None => AppServerStatus {
      running: false,
      kind: "http".into(),
      port: 8000,
      started_at_ms: 0,
    },
  })
}

/// Paths of the certificate/key generated by `http_generate_cert`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedHttpCert {
  pub cert_path: String,
  pub key_path: String,
}

/// Generate a self-signed TLS certificate and private key under the app config
/// directory (`<config>/wrolp-terminal/certs/`), so HTTPS mode needs no
/// external PEM files. Existing files are overwritten on every call. Clients
/// will still warn about the self-signed certificate — that is expected and
/// can be bypassed; this only makes LAN sharing convenient.
#[tauri::command]
pub fn http_generate_cert(state: tauri::State<'_, AppState>) -> Result<GeneratedHttpCert, String> {
  let dir = crate::commands::data_dir_for(state.base_dir.as_deref())
    .ok_or_else(|| "cannot resolve the app config directory".to_string())?
    .join("certs");
  std::fs::create_dir_all(&dir)
    .map_err(|e| format!("cannot create cert dir {}: {e}", dir.display()))?;
  let cert_path = dir.join("https-selfsigned.crt");
  let key_path = dir.join("https-selfsigned.key");

  let mut params = CertificateParams::default();
  params
    .distinguished_name
    .push(DnType::CommonName, "wrolp-terminal HTTPS");
  params.subject_alt_names = vec![
    SanType::DnsName(Ia5String::try_from("localhost").expect("localhost is ASCII")),
    SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)),
    SanType::IpAddress(IpAddr::V6(Ipv6Addr::LOCALHOST)),
  ];
  let now = OffsetDateTime::now_utc();
  params.not_before = now - Duration::days(1);
  params.not_after = now + Duration::days(398);
  let key_pair = KeyPair::generate().map_err(|e| format!("key generation failed: {e}"))?;
  let cert = params
    .self_signed(&key_pair)
    .map_err(|e| format!("certificate generation failed: {e}"))?;
  std::fs::write(&cert_path, cert.pem()).map_err(|e| format!("cannot write certificate: {e}"))?;
  std::fs::write(&key_path, key_pair.serialize_pem())
    .map_err(|e| format!("cannot write private key: {e}"))?;

  Ok(GeneratedHttpCert {
    cert_path: cert_path.to_string_lossy().into_owned(),
    key_path: key_path.to_string_lossy().into_owned(),
  })
}
