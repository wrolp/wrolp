//! Minimal TFTP (RFC 1350) engine used by both the in-app TFTP client and the
//! TFTP server. Supports the `blksize` option negotiation (RFC 2348), `octet`
//! mode only, packet timeouts and transfer cancellation via a oneshot.

use std::net::{IpAddr, SocketAddr};
use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

pub const RRQ: u16 = 1;
pub const WRQ: u16 = 2;
pub const DATA: u16 = 3;
pub const ACK: u16 = 4;
pub const ERROR: u16 = 5;
pub const OACK: u16 = 6;

/// Maximum block size we advertise / accept (65536 - 8 UDP overhead - 4 TFTP hdr).
pub const MAX_BLK: u16 = 65464;
pub const DEFAULT_BLK: u16 = 512;

const TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RETRY: u32 = 6;

fn be16(b: &[u8]) -> u16 {
  u16::from_be_bytes([b[0], b[1]])
}

fn put16(out: &mut Vec<u8>, v: u16) {
  out.extend_from_slice(&v.to_be_bytes());
}

pub fn build_error(code: u16, msg: &str) -> Vec<u8> {
  let mut out = Vec::with_capacity(4 + msg.len());
  put16(&mut out, ERROR);
  put16(&mut out, code);
  out.extend_from_slice(msg.as_bytes());
  out.push(0);
  out
}

pub fn build_ack(block: u16) -> Vec<u8> {
  let mut out = Vec::with_capacity(4);
  put16(&mut out, ACK);
  put16(&mut out, block);
  out
}

pub fn build_data(block: u16, payload: &[u8]) -> Vec<u8> {
  let mut out = Vec::with_capacity(4 + payload.len());
  put16(&mut out, DATA);
  put16(&mut out, block);
  out.extend_from_slice(payload);
  out
}

/// Option name/value pairs attached to a RRQ/WRQ (e.g. blksize, tsize).
pub type TftpOptions = Vec<(String, String)>;

/// Parse a RRQ/WRQ request packet into (opcode, filename, options).
pub fn parse_request(buf: &[u8]) -> Result<(u16, String, TftpOptions), (u16, String)> {
  if buf.len() < 4 {
    return Err((0, "TFTP packet too short".into()));
  }
  let op = be16(&buf[..2]);
  if op != RRQ && op != WRQ {
    return Err((0, "expected RRQ or WRQ".into()));
  }
  let body = &buf[2..];
  let mut parts = Vec::new();
  let mut start = 0usize;
  for (i, b) in body.iter().enumerate() {
    if *b == 0 {
      if i > start {
        parts.push(String::from_utf8_lossy(&body[start..i]).into_owned());
      }
      start = i + 1;
      if parts.len() >= 2 && i + 1 >= body.len() {
        break;
      }
      if parts.len() >= 2 {
        continue;
      }
    }
  }
  if parts.len() < 2 {
    return Err((0, "malformed request".into()));
  }
  let filename = parts.remove(0);
  let mode = parts.remove(0).to_ascii_lowercase();
  if mode != "octet" && mode != "netascii" {
    return Err((0, "unsupported transfer mode (only octet)".into()));
  }
  // Remaining parts are option name/value pairs.
  let mut opts = Vec::new();
  let mut i = 0;
  while i + 1 < parts.len() {
    opts.push((parts[i].clone(), parts[i + 1].clone()));
    i += 2;
  }
  Ok((op, filename, opts))
}

/// Reject ".." traversal and Windows-style separators in a file name coming
/// from the wire. Returns a safe relative path string.
pub fn sanitize_name(name: &str) -> Result<String, String> {
  let trimmed = name.replace('\\', "/");
  let mut parts = Vec::new();
  for seg in trimmed.split('/') {
    if seg.is_empty() || seg == "." {
      continue;
    }
    if seg == ".." {
      return Err("path traversal rejected".into());
    }
    parts.push(seg);
  }
  if parts.is_empty() {
    return Err("empty file name".into());
  }
  Ok(parts.join("/"))
}

/// Join the server root with a sanitized remote name and ensure the result
/// stays inside the root directory.
pub fn resolve_path(root: &Path, name: &str) -> Result<std::path::PathBuf, String> {
  let clean = sanitize_name(name)?;
  let joined = root.join(&clean);
  // Canonicalize parent (root must exist) then verify the child path prefix.
  let root_canon = std::fs::canonicalize(root).map_err(|e| format!("root: {e}"))?;
  let parent = joined
    .parent()
    .map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| root_canon.clone()));
  if let Some(p) = parent {
    if !p.starts_with(&root_canon) {
      return Err("path escapes server root".into());
    }
  }
  Ok(joined)
}

fn read_block(buf: &[u8]) -> Result<(u16, u16, &[u8]), String> {
  if buf.len() < 4 {
    return Err("short DATA packet".into());
  }
  let op = be16(buf);
  let block = be16(&buf[2..4]);
  if op != DATA {
    return Err("expected DATA".into());
  }
  Ok((op, block, &buf[4..]))
}

/// Best-effort file size hint for progress (used by clients when the server
/// does not expose a total; TFTP has no size in RRQ unless tsize is answered).
pub fn file_size_hint(path: &Path) -> u64 {
  std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

async fn recv_packet(
  sock: &UdpSocket,
  peer: &SocketAddr,
  buf: &mut [u8],
  cancel: &mut Option<oneshot::Receiver<()>>,
) -> Result<(usize, SocketAddr), String> {
  loop {
    let fut = sock.recv_from(buf);
    let res = if let Some(rx) = cancel {
      let rx_ref = rx;
      tokio::pin!(rx_ref);
      tokio::select! {
        r = fut => r.map_err(|e| e.to_string()),
        _ = &mut rx_ref => return Err("canceled".into()),
      }
    } else {
      fut.await.map_err(|e| e.to_string())
    };
    let (n, from) = res?;
    // Ignore stray packets from unexpected peers.
    if &from == peer {
      return Ok((n, from));
    }
  }
}

async fn send_with_timeout(
  sock: &UdpSocket,
  peer: &SocketAddr,
  packet: &[u8],
) -> Result<(), String> {
  timeout(TIMEOUT, sock.send_to(packet, peer))
    .await
    .map_err(|_| "send timeout".to_string())?
    .map_err(|e| e.to_string())?;
  Ok(())
}

fn err_msg(buf: &[u8]) -> Option<String> {
  if buf.len() >= 4 && be16(buf) == ERROR {
    let body = &buf[4..];
    let msg = String::from_utf8_lossy(body)
      .trim_end_matches('\0')
      .to_string();
    Some(if msg.is_empty() {
      "TFTP error".into()
    } else {
      msg
    })
  } else {
    None
  }
}

/// Send a local file to `peer` (server side of an RRQ).
pub async fn send_file(
  sock: UdpSocket,
  peer: SocketAddr,
  file: &Path,
  blk: u16,
  mut cancel: Option<oneshot::Receiver<()>>,
) -> Result<u64, String> {
  let mut f = tokio::fs::File::open(file)
    .await
    .map_err(|e| format!("open '{}': {e}", file.display()))?;
  let mut buf = vec![0u8; blk as usize];
  let mut block: u16 = 0;
  let mut total: u64 = 0;
  loop {
    let n = f.read(&mut buf).await.map_err(|e| format!("read: {e}"))?;
    if n == 0 {
      return Ok(total);
    }
    block = block.wrapping_add(1);
    let packet = build_data(block, &buf[..n]);
    let mut sent = false;
    for _ in 0..MAX_RETRY {
      if let Some(rx) = cancel.as_mut() {
        use tokio::sync::oneshot::error::TryRecvError;
        if !matches!(rx.try_recv(), Err(TryRecvError::Empty)) {
          return Err("canceled".into());
        }
      }
      send_with_timeout(&sock, &peer, &packet).await?;
      // Wait for the ACK of this block.
      let mut rbuf = [0u8; 65536];
      let recv = timeout(TIMEOUT, sock.recv_from(&mut rbuf)).await;
      match recv {
        Ok(Ok((n, from))) if from == peer => {
          if let Some(m) = err_msg(&rbuf[..n]) {
            return Err(m);
          }
          let op = be16(&rbuf[..n.min(4)]);
          let ack_block = if n >= 4 { be16(&rbuf[2..4]) } else { 0 };
          if op == ACK && ack_block == block {
            sent = true;
            break;
          }
          if op == ACK {
            // Duplicate/stale ACK (for the previous block): ignore.
            continue;
          }
        }
        Ok(Ok(_)) => continue,
        _ => {}
      }
    }
    if !sent {
      return Err("no ACK after retries".into());
    }
    total += n as u64;
    if n < blk as usize {
      return Ok(total);
    }
  }
}

/// Receive a file upload from `peer` (server side of a WRQ).
pub async fn receive_file(
  sock: UdpSocket,
  peer: SocketAddr,
  file: &Path,
  blk: u16,
  mut cancel: Option<oneshot::Receiver<()>>,
) -> Result<u64, String> {
  if let Some(parent) = file.parent() {
    tokio::fs::create_dir_all(parent)
      .await
      .map_err(|e| format!("create dir: {e}"))?;
  }
  let mut f = tokio::fs::File::create(file)
    .await
    .map_err(|e| format!("create '{}': {e}", file.display()))?;
  // Send an ACK for block 0 to invite the first data block.
  send_with_timeout(&sock, &peer, &build_ack(0)).await?;
  let mut total: u64 = 0;
  loop {
    let mut buf = [0u8; 65536];
    let (n, from) = recv_packet(&sock, &peer, &mut buf, &mut cancel).await?;
    let _ = from;
    if let Some(m) = err_msg(&buf[..n]) {
      return Err(m);
    }
    if n < 4 || be16(&buf) != DATA {
      continue;
    }
    let block = be16(&buf[2..4]);
    let payload = &buf[4..n];
    if payload.len() < blk as usize {
      // Last block — write then ACK and finish.
      f.write_all(payload).await.map_err(|e| e.to_string())?;
      f.flush().await.map_err(|e| e.to_string())?;
      send_with_timeout(&sock, &peer, &build_ack(block)).await?;
      total += payload.len() as u64;
      return Ok(total);
    }
    f.write_all(payload).await.map_err(|e| e.to_string())?;
    total += payload.len() as u64;
    send_with_timeout(&sock, &peer, &build_ack(block)).await?;
  }
}

/// Receive from `peer`, retransmitting `resend` (if any) on each timeout.
/// Cancels via the optional oneshot channel.
async fn recv_retry(
  sock: &UdpSocket,
  peer: &SocketAddr,
  buf: &mut [u8],
  cancel: &mut Option<oneshot::Receiver<()>>,
  resend: &[u8],
) -> Result<(usize, SocketAddr), String> {
  for _ in 0..MAX_RETRY {
    let fut = timeout(TIMEOUT, sock.recv_from(buf));
    let r = if let Some(rx) = cancel.as_mut() {
      tokio::pin!(rx);
      tokio::select! {
        r = fut => r,
        _ = rx => return Err("canceled".into()),
      }
    } else {
      fut.await
    };
    match r {
      Ok(Ok((n, from))) if &from == peer => return Ok((n, from)),
      Ok(Ok(_)) => {
        let _ = send_with_timeout(sock, peer, resend).await;
        continue;
      }
      Ok(Err(e)) => return Err(e.to_string()),
      Err(_) => {
        let _ = send_with_timeout(sock, peer, resend).await;
      }
    }
  }
  Err("no response after retries".into())
}

/// Client side of a download (RRQ → data blocks → local file).
pub async fn client_download(
  sock: &UdpSocket,
  server: SocketAddr,
  remote: &str,
  local: &Path,
  blk: u16,
  mut cancel: Option<oneshot::Receiver<()>>,
  on_progress: impl Fn(u64),
) -> Result<u64, String> {
  if let Some(parent) = local.parent() {
    tokio::fs::create_dir_all(parent)
      .await
      .map_err(|e| e.to_string())?;
  }
  let mut req = Vec::new();
  put16(&mut req, RRQ);
  req.extend_from_slice(remote.as_bytes());
  req.push(0);
  req.extend_from_slice(b"octet");
  req.push(0);
  if blk != DEFAULT_BLK {
    req.extend_from_slice(b"blksize");
    req.push(0);
    req.extend_from_slice(blk.to_string().as_bytes());
    req.push(0);
  }
  send_with_timeout(sock, &server, &req).await?;

  let mut eff_blk = blk;
  let mut negotiated = false;
  let mut f = tokio::fs::File::create(local)
    .await
    .map_err(|e| format!("create '{}': {e}", local.display()))?;
  let mut total: u64 = 0;
  loop {
    let mut buf = [0u8; 65536];
    let (n, from) = recv_retry(sock, &server, &mut buf, &mut cancel, &req).await?;
    if let Some(m) = err_msg(&buf[..n]) {
      return Err(m);
    }
    if n < 4 {
      continue;
    }
    let op = be16(&buf[..2]);
    if op == OACK && !negotiated {
      let body = &buf[2..];
      let text = String::from_utf8_lossy(body);
      for pair in text.split('\0') {
        let mut it = pair.splitn(2, '=');
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
          if k.eq_ignore_ascii_case("blksize") {
            if let Ok(b) = v.trim().parse::<u16>() {
              eff_blk = b.clamp(8, MAX_BLK);
            }
          }
        }
      }
      send_with_timeout(sock, &from, &build_ack(0)).await?;
      negotiated = true;
      continue;
    }
    if op == DATA {
      let (_, block, payload) = read_block(&buf[..n])?;
      f.write_all(payload).await.map_err(|e| e.to_string())?;
      total += payload.len() as u64;
      on_progress(total);
      send_with_timeout(sock, &from, &build_ack(block)).await?;
      if payload.len() < eff_blk as usize {
        f.flush().await.map_err(|e| e.to_string())?;
        return Ok(total);
      }
    }
  }
}

/// Client side of an upload (WRQ → ACK/OACK → data blocks).
pub async fn client_upload(
  sock: &UdpSocket,
  server: SocketAddr,
  remote: &str,
  local: &Path,
  blk: u16,
  mut cancel: Option<oneshot::Receiver<()>>,
  on_progress: impl Fn(u64),
) -> Result<u64, String> {
  let mut req = Vec::new();
  put16(&mut req, WRQ);
  req.extend_from_slice(remote.as_bytes());
  req.push(0);
  req.extend_from_slice(b"octet");
  req.push(0);
  if blk != DEFAULT_BLK {
    req.extend_from_slice(b"blksize");
    req.push(0);
    req.extend_from_slice(blk.to_string().as_bytes());
    req.push(0);
  }
  send_with_timeout(sock, &server, &req).await?;

  let mut eff_blk = blk;
  let mut negotiated = false;
  let mut f = tokio::fs::File::open(local)
    .await
    .map_err(|e| format!("open '{}': {e}", local.display()))?;
  let mut sent: u64 = 0;
  let mut last_pkt = Vec::new();
  loop {
    let mut rbuf = [0u8; 65536];
    let resend = if negotiated {
      last_pkt.as_slice()
    } else {
      req.as_slice()
    };
    let (n, from) = recv_retry(sock, &server, &mut rbuf, &mut cancel, resend).await?;
    if let Some(m) = err_msg(&rbuf[..n]) {
      return Err(m);
    }
    if n < 4 {
      continue;
    }
    let op = be16(&rbuf[..2]);
    if op == OACK && !negotiated {
      let body = &rbuf[2..];
      let text = String::from_utf8_lossy(body);
      for pair in text.split('\0') {
        let mut it = pair.splitn(2, '=');
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
          if k.eq_ignore_ascii_case("blksize") {
            if let Ok(b) = v.trim().parse::<u16>() {
              eff_blk = b.clamp(8, MAX_BLK);
            }
          }
        }
      }
      negotiated = true;
      // Send first data block.
      let mut buf = vec![0u8; eff_blk as usize];
      let n2 = f.read(&mut buf).await.map_err(|e| e.to_string())?;
      last_pkt = build_data(1, &buf[..n2]);
      send_with_timeout(sock, &from, &last_pkt).await?;
      sent += n2 as u64;
      on_progress(sent);
      if n2 == 0 {
        return Ok(0);
      }
      continue;
    }
    // A server may answer ACK(0) without negotiating options — start sending.
    if op == ACK && !negotiated {
      negotiated = true;
      let mut buf = vec![0u8; eff_blk as usize];
      let n2 = f.read(&mut buf).await.map_err(|e| e.to_string())?;
      last_pkt = build_data(1, &buf[..n2]);
      send_with_timeout(sock, &from, &last_pkt).await?;
      sent += n2 as u64;
      on_progress(sent);
      if n2 == 0 {
        return Ok(sent);
      }
      continue;
    }
    if op == ACK {
      let ack_block = be16(&rbuf[2..4]);
      // Determine last sent block number from last_pkt.
      let last_block = if last_pkt.len() >= 4 {
        be16(&last_pkt[2..4])
      } else {
        0
      };
      if ack_block != last_block {
        continue;
      }
      if last_pkt.len() == 4 {
        // A zero-length DATA was the final block.
        return Ok(sent);
      }
      let mut buf = vec![0u8; eff_blk as usize];
      let n2 = f.read(&mut buf).await.map_err(|e| e.to_string())?;
      let next_block = last_block.wrapping_add(1);
      last_pkt = build_data(next_block, &buf[..n2]);
      send_with_timeout(sock, &from, &last_pkt).await?;
      sent += n2 as u64;
      on_progress(sent);
      if n2 == 0 {
        return Ok(sent);
      }
      if n2 < eff_blk as usize {
        // Wait for its ack; next loop will return when acked.
      }
    }
  }
}

/// Bind a UDP socket for a transfer worker. If `bind_ip` is given the socket
/// binds to that address so the peer receives a stable TID address; otherwise
/// it binds 0.0.0.0.
pub async fn bind_worker_socket(bind_ip: Option<IpAddr>) -> Result<UdpSocket, String> {
  let addr: SocketAddr = match bind_ip {
    Some(ip) => SocketAddr::new(ip, 0),
    None => "0.0.0.0:0".parse().unwrap(),
  };
  UdpSocket::bind(addr).await.map_err(|e| e.to_string())
}
