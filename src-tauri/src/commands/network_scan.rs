//! Network scanning: probe a target (CIDR / single IP / last-octet range) for
//! open SSH / Telnet services so the user can add connections in one click.
//!
//! Design notes (see `task/plans/NETWORK-SCAN-PLAN.md`):
//! - Plain TCP `connect` only — no raw sockets / ICMP / ARP, so it runs without
//!   admin rights on Windows / Linux / macOS.
//! - Explicitly triggered by the user; never scans automatically.
//! - Read-only: only captures the SSH banner / Telnet preamble, never attempts a
//!   login or collects credentials.
//! - Concurrency is bounded with a `tokio::sync::Semaphore` so a /24 does not
//!   exhaust file descriptors, and each probe respects a per-attempt timeout.

use super::*;
use std::net::{IpAddr, Ipv4Addr};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};

/// One probed `ip:port` pair returned by `scan_network`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
  pub ip: String,
  pub port: u16,
  /// Whether a TCP connection could be established.
  pub open: bool,
  /// Service identified from the first bytes: "ssh", "telnet" or "unknown".
  pub service: String,
  /// First line of the service banner (e.g. "SSH-2.0-OpenSSH_9.6").
  pub banner: Option<String>,
  /// Time to establish the TCP connection, in milliseconds.
  pub latency_ms: Option<u64>,
}

/// Request payload for `scan_network`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
  /// "192.168.1.0/24" | "10.0.0.5" | "192.168.1.10-192.168.1.20"
  pub target: String,
  /// Ports to probe; defaults to `[22]`.
  #[serde(default)]
  pub ports: Option<Vec<u16>>,
  /// Per-attempt connect timeout in ms; defaults to 600.
  #[serde(default)]
  pub timeout_ms: Option<u32>,
  /// Max concurrent probes; defaults to 200.
  #[serde(default)]
  pub concurrency: Option<usize>,
}

/// Absolute cap on probes per scan, so a typo like `0.0.0.0/0` cannot start a
/// multi-million-connection scan.
const MAX_PROBES: usize = 65_536;

/// Expand a target spec into the concrete list of IPs to probe.
///
/// Supported forms:
/// - single IP:        `10.0.0.5` (IPv4 or IPv6)
/// - CIDR:             `192.168.1.0/24` (IPv4)
/// - last-octet range: `192.168.1.10-192.168.1.20` (IPv4)
pub fn parse_target(target: &str) -> Result<Vec<IpAddr>, String> {
  let t = target.trim();
  if t.is_empty() {
    return Err("empty target".to_string());
  }
  if let Some((ip, mask)) = t.split_once('/') {
    return parse_cidr(ip.trim(), mask.trim());
  }
  if let Some((a, b)) = t.split_once('-') {
    return parse_range(a.trim(), b.trim());
  }
  let ip: IpAddr = t.parse().map_err(|_| format!("invalid IP address: {}", t))?;
  Ok(vec![ip])
}

fn parse_cidr(ip: &str, mask: &str) -> Result<Vec<IpAddr>, String> {
  let addr: Ipv4Addr = ip
    .parse()
    .map_err(|_| format!("invalid IPv4 address in CIDR: {}", ip))?;
  let prefix: u8 = mask
    .parse()
    .map_err(|_| format!("invalid CIDR prefix: /{}", mask))?;
  if prefix > 32 {
    return Err(format!("CIDR prefix out of range: /{}", prefix));
  }
  let host_bits = 32 - prefix;
  // u64 arithmetic avoids the shift overflow a `1u32 << 32` would hit for /0,
  // and lets us reject oversized targets before touching any addresses.
  let count = 1u64 << host_bits;
  if count > MAX_PROBES as u64 {
    return Err(format!(
      "CIDR /{} expands to {} addresses (max {})",
      prefix, count, MAX_PROBES
    ));
  }
  let base = u32::from(addr);
  let net = if prefix == 0 {
    0
  } else {
    base & (0xFFFF_FFFFu32 << host_bits)
  };
  let mut out = Vec::with_capacity(count as usize);
  for i in 0..count {
    out.push(IpAddr::V4(Ipv4Addr::from(net + i as u32)));
  }
  Ok(out)
}

fn parse_range(a: &str, b: &str) -> Result<Vec<IpAddr>, String> {
  let start: Ipv4Addr = a
    .parse()
    .map_err(|_| format!("invalid range start: {}", a))?;
  let end: Ipv4Addr = b
    .parse()
    .map_err(|_| format!("invalid range end: {}", b))?;
  let oa = start.octets();
  let ob = end.octets();
  if oa[0] != ob[0] || oa[1] != ob[1] || oa[2] != ob[2] {
    return Err("IP range must stay within one subnet (first three octets equal)".to_string());
  }
  let (lo, hi) = if oa[3] <= ob[3] { (oa[3], ob[3]) } else { (ob[3], oa[3]) };
  let mut out = Vec::with_capacity((hi - lo + 1) as usize);
  for i in lo..=hi {
    out.push(IpAddr::V4(Ipv4Addr::new(oa[0], oa[1], oa[2], i)));
  }
  Ok(out)
}

/// Probe a single `ip:port` and classify the service from the first bytes.
async fn probe(ip: IpAddr, port: u16, timeout_ms: u32) -> ScanResult {
  let start = std::time::Instant::now();
  let connect = timeout(Duration::from_millis(timeout_ms as u64), TcpStream::connect((ip, port)));
  match connect.await {
    Ok(Ok(mut stream)) => {
      let latency = start.elapsed().as_millis() as u64;
      // Read the first bytes to identify the service. SSH servers send their
      // banner immediately; telnet servers send an IAC negotiation preamble.
      let mut buf = [0u8; 256];
      let n = match timeout(Duration::from_millis(400), stream.read(&mut buf)).await {
        Ok(Ok(n)) => n.min(buf.len()),
        _ => 0,
      };
      let (service, banner) = classify(&buf[..n]);
      ScanResult {
        ip: ip.to_string(),
        port,
        open: true,
        service,
        banner,
        latency_ms: Some(latency),
      }
    }
    _ => ScanResult {
      ip: ip.to_string(),
      port,
      open: false,
      service: "unknown".to_string(),
      banner: None,
      latency_ms: None,
    },
  }
}

/// Classify a service from the bytes a server sent right after connect.
fn classify(bytes: &[u8]) -> (String, Option<String>) {
  if bytes.is_empty() {
    return ("unknown".to_string(), None);
  }
  // SSH: the RFC 4253 protocol identification line starts with "SSH-".
  if bytes.starts_with(b"SSH-") {
    return ("ssh".to_string(), Some(sanitize_banner(bytes)));
  }
  // Telnet: RFC 854 servers begin with an IAC (0xFF) negotiation preamble, and
  // the login prompt text that follows is another common tell.
  if bytes.contains(&0xFF) {
    let banner = sanitize_banner(bytes);
    return (
      "telnet".to_string(),
      if banner.is_empty() { None } else { Some(banner) },
    );
  }
  let text = String::from_utf8_lossy(bytes);
  let lower = text.to_ascii_lowercase();
  if lower.contains("login:")
    || lower.contains("password:")
    || lower.contains("username:")
    || lower.contains("user access verification")
  {
    return ("telnet".to_string(), Some(sanitize_banner(bytes)));
  }
  // Anything else is an unclassified service banner — surface it anyway.
  ("unknown".to_string(), Some(sanitize_banner(bytes)))
}

/// First line of the banner, printable chars only, capped in length.
fn sanitize_banner(bytes: &[u8]) -> String {
  let text = String::from_utf8_lossy(bytes);
  let first_line = text.lines().next().unwrap_or("");
  let cleaned: String = first_line
    .chars()
    .map(|c| if c.is_control() { ' ' } else { c })
    .collect();
  let trimmed = cleaned.trim();
  if trimmed.is_empty() {
    return String::new();
  }
  trimmed.chars().take(120).collect()
}

/// Probe the target's ports for open services.
///
/// Results are streamed progressively as `scan-progress` events (`ScanResult`
/// payload) after a `scan-start` event carrying `{ total }`; the return value
/// holds the full list for callers that prefer a single round-trip.
#[tauri::command]
pub async fn scan_network(
  request: ScanRequest,
  app: tauri::AppHandle,
) -> Result<Vec<ScanResult>, String> {
  let ips = parse_target(&request.target)?;
  let ports = match request.ports {
    Some(ref p) if !p.is_empty() => p.clone(),
    _ => vec![22u16],
  };
  let timeout_ms = request.timeout_ms.unwrap_or(600).clamp(50, 10_000);
  let concurrency = request.concurrency.unwrap_or(200).clamp(1, 1_000);

  let total = ips.len().saturating_mul(ports.len());
  if total == 0 {
    return Ok(vec![]);
  }
  if total > MAX_PROBES {
    return Err(format!("scan would probe {} targets (max {})", total, MAX_PROBES));
  }

  let _ = app.emit("scan-start", serde_json::json!({ "total": total }));

  let sem = Arc::new(Semaphore::new(concurrency));
  let mut tasks = Vec::with_capacity(total);
  for ip in ips {
    for &port in &ports {
      // Bound the number of in-flight probes; the loop parks here when the
      // semaphore is exhausted until a spawned probe completes.
      let permit = sem.clone().acquire_owned().await.map_err(|e| e.to_string())?;
      let app2 = app.clone();
      tasks.push(tokio::spawn(async move {
        let _permit = permit;
        let result = probe(ip, port, timeout_ms).await;
        let _ = app2.emit("scan-progress", &result);
        result
      }));
    }
  }

  let mut results = Vec::with_capacity(tasks.len());
  for task in tasks {
    results.push(task.await.map_err(|e| e.to_string())?);
  }
  Ok(results)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ips(v: &[&str]) -> Vec<IpAddr> {
    v.iter().map(|s| s.parse().unwrap()).collect()
  }

  #[test]
  fn parse_single_ip() {
    assert_eq!(parse_target("10.0.0.5").unwrap(), ips(&["10.0.0.5"]));
    assert_eq!(parse_target("  ::1 ").unwrap(), ips(&["::1"]));
  }

  #[test]
  fn parse_cidr_24() {
    let out = parse_target("192.168.1.0/24").unwrap();
    assert_eq!(out.len(), 256);
    assert_eq!(out[0], "192.168.1.0".parse::<IpAddr>().unwrap());
    assert_eq!(out[255], "192.168.1.255".parse::<IpAddr>().unwrap());
  }

  #[test]
  fn parse_cidr_32_and_31() {
    assert_eq!(parse_target("10.0.0.7/32").unwrap(), ips(&["10.0.0.7"]));
    let out = parse_target("10.0.0.6/31").unwrap();
    assert_eq!(out, ips(&["10.0.0.6", "10.0.0.7"]));
  }

  #[test]
  fn parse_range() {
    let out = parse_target("192.168.1.10-192.168.1.20").unwrap();
    assert_eq!(out.len(), 11);
    assert_eq!(out[0], "192.168.1.10".parse::<IpAddr>().unwrap());
    assert_eq!(out[10], "192.168.1.20".parse::<IpAddr>().unwrap());
  }

  #[test]
  fn parse_range_reversed_is_normalized() {
    let out = parse_target("192.168.1.20-192.168.1.10").unwrap();
    assert_eq!(out.len(), 11);
    assert_eq!(out[0], "192.168.1.10".parse::<IpAddr>().unwrap());
  }

  #[test]
  fn parse_errors() {
    assert!(parse_target("").is_err());
    assert!(parse_target("not-an-ip").is_err());
    assert!(parse_target("10.0.0.0/33").is_err());
    assert!(parse_target("10.0.0.0/abc").is_err());
    assert!(parse_target("10.0.0.1-10.0.1.1").is_err()); // crosses subnet
  }

  #[test]
  fn cidr_too_large_is_rejected() {
    assert!(parse_target("0.0.0.0/0").is_err());
  }

  #[tokio::test]
  async fn probe_detects_ssh_banner() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
      if let Ok((mut sock, _)) = listener.accept().await {
        let _ = tokio::io::AsyncWriteExt::write_all(
          &mut sock,
          b"SSH-2.0-OpenSSH_9.6\r\n",
        )
        .await;
        tokio::time::sleep(Duration::from_millis(150)).await;
      }
    });

    let r = probe("127.0.0.1".parse().unwrap(), port, 1000).await;
    assert!(r.open);
    assert_eq!(r.service, "ssh");
    assert!(r.banner.as_deref().unwrap_or("").starts_with("SSH-2.0-"));
  }

  #[tokio::test]
  async fn probe_closed_port_is_not_open() {
    // Bind then drop — the port is guaranteed closed.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let r = probe("127.0.0.1".parse().unwrap(), port, 300).await;
    assert!(!r.open);
  }
}
