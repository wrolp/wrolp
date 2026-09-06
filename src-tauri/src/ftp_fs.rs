//! FTP file-system backend: implements the shared `RemoteFs` trait over a
//! persistent FTP control connection (`suppaftp`). Used by the file panel when
//! an FTP connection tab is active — no terminal or shell is involved.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_trait::async_trait;
use suppaftp::tokio::{ImplAsyncFtpStream, TokioTlsStream};
use suppaftp::types::FtpError;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::remote_fs::RemoteFs;
use crate::ssh_session::{FileEntry, FileMeta};

/// One active FTP connection stored in `AppState.ftp_sessions`.
pub struct FtpSession {
  pub tab_id: u32,
  /// Boxed control connection. Both plain and TLS streams are erased behind
  /// `FtpStreamOps` so a single map entry can hold either transport.
  pub stream: Arc<AsyncMutex<Box<dyn FtpStreamOps + Send>>>,
}

impl FtpSession {
  pub fn new(tab_id: u32, stream: Box<dyn FtpStreamOps + Send>) -> Self {
    Self {
      tab_id,
      stream: Arc::new(AsyncMutex::new(stream)),
    }
  }
}

/// Object-safe view of the FTP operations the file system needs, implemented
/// for `ImplAsyncFtpStream<T>` (plain + TLS). Keeps the session map type
/// independent of the transport.
#[async_trait]
pub trait FtpStreamOps: Send {
  async fn list_dir(&mut self, path: &str) -> Result<Vec<FileEntry>, String>;
  async fn metadata(&mut self, path: &str) -> Result<FileMeta, String>;
  async fn read_file(&mut self, path: &str) -> Result<Vec<u8>, String>;
  async fn write_file(&mut self, path: &str, data: &[u8]) -> Result<(), String>;
  async fn create_dir(&mut self, path: &str) -> Result<(), String>;
  async fn rename(&mut self, from: &str, to: &str) -> Result<(), String>;
  async fn remove_file(&mut self, path: &str) -> Result<(), String>;
  async fn remove_dir(&mut self, path: &str) -> Result<(), String>;
  async fn quit(&mut self) -> Result<(), String>;
}

/// Helper: `&[u8]` reader used by `put_file` (which needs an `AsyncRead`).
struct SliceReader<'a> {
  data: &'a [u8],
  pos: usize,
}

impl AsyncRead for SliceReader<'_> {
  fn poll_read(
    mut self: Pin<&mut Self>,
    _cx: &mut Context<'_>,
    buf: &mut tokio::io::ReadBuf<'_>,
  ) -> Poll<io::Result<()>> {
    let n = buf.remaining().min(self.data.len() - self.pos);
    let chunk = &self.data[self.pos..self.pos + n];
    buf.put_slice(chunk);
    self.pos += n;
    Poll::Ready(Ok(()))
  }
}

fn ftp_err(e: FtpError) -> String {
  e.to_string()
}

fn join_remote(base: &str, name: &str) -> String {
  if base.is_empty() || base == "." || base == "/" {
    return format!("/{}", name.trim_start_matches('/'));
  }
  format!(
    "{}/{}",
    base.trim_end_matches('/'),
    name.trim_start_matches('/')
  )
}

/// Parse an RFC 3659 `mlsd` response line (facts; name).
fn parse_mlsd_line(line: &str) -> Option<(bool, u64, String, String)> {
  let line = line.trim_end_matches(['\r', '\n']);
  let (facts, name) = line.split_once(' ')?;
  let mut is_dir = false;
  let mut size: u64 = 0;
  let mut modified = String::new();
  for fact in facts.split(';') {
    let fact = fact.trim();
    if let Some(v) = fact.strip_prefix("type=") {
      is_dir = v == "dir" || v == "cdir" || v == "pdir";
    } else if let Some(v) = fact.strip_prefix("size=") {
      size = v.parse().unwrap_or(0);
    } else if let Some(v) = fact.strip_prefix("modify=") {
      // YYYYMMDDHHMMSS
      if v.len() >= 14 {
        let y = &v[0..4];
        let mo = &v[4..6];
        let d = &v[6..8];
        let h = &v[8..10];
        let mi = &v[10..12];
        let s = &v[12..14];
        modified = format!("{y}-{mo}-{d} {h}:{mi}:{s}");
      }
    }
  }
  let name = name.trim();
  if name.is_empty() {
    return None;
  }
  Some((is_dir, size, name.to_string(), modified))
}

/// Parse the typical Unix `ls -l` style LIST fallback. Best effort — newer
/// servers that support MLSD get the richer parser above.
fn parse_list_line(line: &str) -> Option<(bool, u64, String)> {
  let line = line.trim_end_matches(['\r', '\n']);
  if line.starts_with("total") || line.is_empty() {
    return None;
  }
  let first = line.chars().next()?;
  let is_dir = first == 'd';
  // Unix: perms links owner group size date time name...
  let toks: Vec<&str> = line.split_whitespace().collect();
  if is_dir {
    if toks.len() >= 4 {
      let name = toks[toks.len() - 1];
      return Some((true, 0, name.to_string()));
    }
  } else if first == '-' {
    if toks.len() >= 9 {
      let size: u64 = toks[4].parse().unwrap_or(0);
      let name = toks[9..].join(" ");
      return Some((false, size, name));
    }
    if toks.len() >= 5 {
      let name = toks[toks.len() - 1];
      return Some((false, 0, name.to_string()));
    }
  }
  None
}

#[async_trait]
impl<T> FtpStreamOps for ImplAsyncFtpStream<T>
where
  T: TokioTlsStream + Send + 'static,
{
  async fn list_dir(&mut self, path: &str) -> Result<Vec<FileEntry>, String> {
    let list_path = if path.is_empty() || path == "." {
      None
    } else {
      Some(path)
    };
    let raw: Vec<String> = match self.mlsd(list_path).await {
      Ok(r) => r,
      Err(_) => self
        .list(list_path)
        .await
        .map_err(|e| format!("MLSD/LIST failed: {e}"))?,
    };
    let mut out = Vec::with_capacity(raw.len());
    for line in raw {
      if let Some((is_dir, size, name, modified)) = parse_mlsd_line(&line) {
        out.push(FileEntry {
          name: name.clone(),
          path: join_remote(path, &name),
          is_dir,
          size,
          mode: String::new(),
          modified,
        });
      } else if let Some((is_dir, size, name)) = parse_list_line(&line) {
        out.push(FileEntry {
          name: name.clone(),
          path: join_remote(path, &name),
          is_dir,
          size,
          mode: String::new(),
          modified: String::new(),
        });
      }
    }
    Ok(out)
  }

  async fn metadata(&mut self, path: &str) -> Result<FileMeta, String> {
    let size = self.size(path).await.ok().unwrap_or(0) as u64;
    let modified = self
      .mdtm(path)
      .await
      .map(|d| d.to_string())
      .unwrap_or_default();
    Ok(FileMeta {
      path: path.to_string(),
      is_dir: false,
      size,
      mode: String::new(),
      modified,
    })
  }

  async fn read_file(&mut self, path: &str) -> Result<Vec<u8>, String> {
    self
      .transfer_type(suppaftp::types::FileType::Image)
      .await
      .map_err(ftp_err)?;
    let mut stream = self.retr_as_stream(path).await.map_err(ftp_err)?;
    let mut bytes = Vec::new();
    stream
      .read_to_end(&mut bytes)
      .await
      .map_err(|e| format!("read data stream: {e}"))?;
    self.finalize_retr_stream(stream).await.map_err(ftp_err)?;
    Ok(bytes)
  }

  async fn write_file(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
    self
      .transfer_type(suppaftp::types::FileType::Image)
      .await
      .map_err(ftp_err)?;
    let mut rd = SliceReader { data, pos: 0 };
    self.put_file(path, &mut rd).await.map_err(ftp_err)?;
    Ok(())
  }

  async fn create_dir(&mut self, path: &str) -> Result<(), String> {
    self.mkdir(path).await.map_err(ftp_err)
  }

  async fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
    self.rename(from, to).await.map_err(ftp_err)
  }

  async fn remove_file(&mut self, path: &str) -> Result<(), String> {
    self.rm(path).await.map_err(ftp_err)
  }

  async fn remove_dir(&mut self, path: &str) -> Result<(), String> {
    self.rmdir(path).await.map_err(ftp_err)
  }

  async fn quit(&mut self) -> Result<(), String> {
    self.quit().await.map_err(ftp_err)
  }
}

/// `RemoteFs` adapter: every operation locks the shared FTP stream once.
#[derive(Clone)]
pub struct FtpFs {
  stream: Arc<AsyncMutex<Box<dyn FtpStreamOps + Send>>>,
}

impl FtpFs {
  pub fn new(stream: Arc<AsyncMutex<Box<dyn FtpStreamOps + Send>>>) -> Self {
    Self { stream }
  }
}

#[async_trait]
impl RemoteFs for FtpFs {
  async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, String> {
    let mut g = self.stream.lock().await;
    g.list_dir(path).await
  }

  async fn metadata(&self, path: &str) -> Result<FileMeta, String> {
    let mut g = self.stream.lock().await;
    g.metadata(path).await
  }

  async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
    let mut g = self.stream.lock().await;
    g.read_file(path).await
  }

  async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), String> {
    let mut g = self.stream.lock().await;
    g.write_file(path, data).await
  }

  async fn create_dir(&self, path: &str) -> Result<(), String> {
    let mut g = self.stream.lock().await;
    g.create_dir(path).await
  }

  async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
    let mut g = self.stream.lock().await;
    g.rename(from, to).await
  }

  async fn remove_file(&self, path: &str) -> Result<(), String> {
    let mut g = self.stream.lock().await;
    g.remove_file(path).await
  }

  async fn remove_dir(&self, path: &str) -> Result<(), String> {
    let mut g = self.stream.lock().await;
    g.remove_dir(path).await
  }
}
