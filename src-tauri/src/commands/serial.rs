use super::*;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// `serialport::SerialPort` is not declared `Send`, but the underlying OS handle
/// (a `HANDLE` / `RawFd`) is genuinely thread-safe. Wrap it so it can be moved
/// into a dedicated reader thread.
struct SendPort {
  inner: Box<dyn serialport::SerialPort>,
}
unsafe impl Send for SendPort {}

fn default_baud() -> u32 {
  9600
}
fn default_data_bits() -> u8 {
  8
}
fn default_stop_bits() -> u8 {
  1
}

/// Configuration for opening a serial (COM) port. Sent by the frontend when the
/// user connects a "serial" tab. Mirrors the relevant fields of `ConnectionConfig`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
  pub id: String,
  pub name: String,
  #[serde(default)]
  pub port_name: String,
  #[serde(default = "default_baud")]
  pub baud_rate: u32,
  #[serde(default = "default_data_bits")]
  pub data_bits: u8,
  #[serde(default = "default_stop_bits")]
  pub stop_bits: u8,
  /// "none" | "odd" | "even"
  #[serde(default)]
  pub parity: String,
  /// "none" | "software" | "hardware"
  #[serde(default)]
  pub flow_control: String,
  #[serde(default)]
  pub group: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<String>,
}

/// A serial port discovered on the machine, with a device-manager-style
/// friendly description so the user can pick the right COMx without guessing.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortView {
  /// "COM3" / "/dev/ttyUSB0"
  pub name: String,
  /// Friendly description (manufacturer / product / type)
  pub description: String,
  /// "usb" | "bluetooth" | "pci" | "unknown"
  #[serde(default)]
  pub port_type: String,
}

/// Enumerate available serial ports with friendly names.
///
/// Uses `serialport::available_ports()` (cross-platform). On every OS the
/// `UsbPort` variant exposes `manufacturer` / `product` / `vid` / `pid`, which we
/// compose into a readable description — no extra platform dependency needed.
#[tauri::command]
pub async fn list_serial_ports() -> Result<Vec<SerialPortView>, String> {
  let ports = serialport::available_ports()
    .map_err(|e| format!("Failed to enumerate serial ports: {}", e))?;
  let mut out: Vec<SerialPortView> = ports
    .iter()
    .map(|p| {
      let (desc, ptype) = describe_port(p);
      SerialPortView {
        name: p.port_name.clone(),
        description: desc,
        port_type: ptype,
      }
    })
    .collect();
  out.sort_by(|a, b| a.name.cmp(&b.name));
  Ok(out)
}

fn describe_port(p: &serialport::SerialPortInfo) -> (String, String) {
  match &p.port_type {
    serialport::SerialPortType::UsbPort(u) => {
      let mut parts: Vec<String> = Vec::new();
      if let Some(m) = &u.manufacturer {
        parts.push(m.clone());
      }
      if let Some(pr) = &u.product {
        parts.push(pr.clone());
      }
      let desc = if parts.is_empty() {
        format!("USB Serial ({:04X}:{:04X})", u.vid, u.pid)
      } else {
        parts.join(" ")
      };
      (desc, "usb".to_string())
    }
    serialport::SerialPortType::BluetoothPort => {
      ("Bluetooth Serial".to_string(), "bluetooth".to_string())
    }
    serialport::SerialPortType::PciPort => {
      ("PCI Serial".to_string(), "pci".to_string())
    }
    serialport::SerialPortType::Unknown => (p.port_name.clone(), "unknown".to_string()),
  }
}

/// Parse the shared data-bits / stop-bits / parity / flow-control parameters
/// accepted by `connect_serial` and `detect_serial_baud`.
#[allow(clippy::type_complexity)]
fn parse_line_settings(
  data_bits: u8,
  stop_bits: u8,
  parity: &str,
  flow_control: &str,
) -> Result<
  (
    serialport::DataBits,
    serialport::StopBits,
    serialport::Parity,
    serialport::FlowControl,
  ),
  String,
> {
  let db = match data_bits {
    5 => serialport::DataBits::Five,
    6 => serialport::DataBits::Six,
    7 => serialport::DataBits::Seven,
    8 => serialport::DataBits::Eight,
    _ => return Err(format!("Invalid data bits: {} (expect 5-8)", data_bits)),
  };
  let sb = match stop_bits {
    1 => serialport::StopBits::One,
    2 => serialport::StopBits::Two,
    _ => return Err(format!("Invalid stop bits: {} (expect 1 or 2)", stop_bits)),
  };
  let par = match parity {
    "odd" => serialport::Parity::Odd,
    "even" => serialport::Parity::Even,
    "" | "none" => serialport::Parity::None,
    other => return Err(format!("Invalid parity: {} (expect none/odd/even)", other)),
  };
  let fc = match flow_control {
    "software" => serialport::FlowControl::Software,
    "hardware" => serialport::FlowControl::Hardware,
    "" | "none" => serialport::FlowControl::None,
    other => return Err(format!("Invalid flow control: {} (expect none/software/hardware)", other)),
  };
  Ok((db, sb, par, fc))
}

/// Open a serial port and start a reader thread that streams received bytes into
/// the shared poll buffer. Outgoing bytes are sent to that thread via `write_tx`.
///
/// The reader writes received bytes into `AppState.output_buffers[tab_id]`, which
/// `poll_output` already drains for the frontend — so no new frontend polling is
/// needed. `connection-closed` is emitted when the port is shut down or errors.
#[tauri::command]
pub async fn connect_serial(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  cfg: SerialConfig,
  tab_id: u32,
  _cols: u32,
  _rows: u32,
) -> Result<ConnectResult, String> {
  if cfg.port_name.trim().is_empty() {
    return Err("Serial port name is required".to_string());
  }

  let (data_bits, stop_bits, parity, flow_control) =
    parse_line_settings(cfg.data_bits, cfg.stop_bits, &cfg.parity, &cfg.flow_control)?;

  let mut raw_port = serialport::new(&cfg.port_name, cfg.baud_rate)
    .data_bits(data_bits)
    .stop_bits(stop_bits)
    .parity(parity)
    .flow_control(flow_control)
    .open()
    .map_err(|e| format!("Failed to open {}: {}", cfg.port_name, e))?;

  // Read timeout so the worker thread periodically checks the shutdown flag.
  let _ = raw_port.set_timeout(Duration::from_millis(200));
  let port = SendPort { inner: raw_port };

  // Clear stale output buffer for this tab from any previous session.
  if let Ok(mut buffers) = state.output_buffers.lock() {
    buffers.remove(&tab_id);
  }

  // If an existing serial session already occupies this tab, ask its thread to stop.
  {
    let sessions = state.serial_sessions.lock().map_err(|e| e.to_string())?;
    if let Some(old) = sessions.get(&tab_id) {
      old.shutdown.store(true, AtomicOrdering::SeqCst);
    }
  }

  let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
  let shutdown = Arc::new(AtomicBool::new(false));
  let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>();

  {
    let mut sessions = state.serial_sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
      tab_id,
      SerialSession {
        tab_id,
        port_name: cfg.port_name.clone(),
        shutdown: shutdown.clone(),
        write_tx: Some(write_tx),
        session_id,
      },
    );
  }

  // Inform the user which port/settings we connected with.
  {
    let parity_ch = match parity {
      serialport::Parity::Odd => 'O',
      serialport::Parity::Even => 'E',
      _ => 'N',
    };
    let fc = match flow_control {
      serialport::FlowControl::Software => " sw",
      serialport::FlowControl::Hardware => " hw",
      _ => "",
    };
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers.entry(tab_id).or_default().push(format!(
        "\x1b[33m=== Serial {} @ {} {}{}{}{} ===\x1b[0m\r\n",
        cfg.port_name, cfg.baud_rate, cfg.data_bits, parity_ch, cfg.stop_bits, fc
      ));
    }
  }

  // Spawn the blocking reader thread.
  let app_handle = app.clone();
  let tid = tab_id;
  let sid = session_id;
  let shutdown_flag = shutdown.clone();
  thread::spawn(move || {
    let state = app_handle.state::<AppState>();
    let mut port = port;
    let mut buf = [0u8; 1024];
    loop {
      if shutdown_flag.load(AtomicOrdering::SeqCst) {
        break;
      }
      // Drain any pending outgoing bytes.
      while let Ok(data) = write_rx.try_recv() {
        if port.inner.write_all(&data).is_err() {
          break;
        }
      }
      match port.inner.read(&mut buf) {
        Ok(0) => continue, // read timeout with no data
        Ok(n) => {
          let text = String::from_utf8_lossy(&buf[..n]);
          if let Ok(mut buffers) = state.output_buffers.lock() {
            buffers.entry(tid).or_default().push(text.to_string());
          }
        }
        Err(e) => {
          let kind = e.kind();
          if kind == std::io::ErrorKind::TimedOut || kind == std::io::ErrorKind::WouldBlock {
            continue;
          }
          if let Ok(mut buffers) = state.output_buffers.lock() {
            buffers
              .entry(tid)
              .or_default()
              .push(format!("\x1b[31m[serial] read error: {}\x1b[0m\r\n", e));
          }
          break;
        }
      }
    }

    // Cleanup + notify the frontend, but only if this session is still current.
    let is_ours = state
      .serial_sessions
      .lock()
      .map(|s| s.get(&tid).map_or(false, |sess| sess.session_id == sid))
      .unwrap_or(false);
    if is_ours {
      let _ = app_handle.emit("connection-closed", serde_json::json!({ "tabId": tid }));
      if let Ok(mut sessions) = state.serial_sessions.lock() {
        if let Some(s) = sessions.get_mut(&tid) {
          if s.session_id == sid {
            s.write_tx.take();
          }
        }
      }
    }
  });

  Ok(ConnectResult {
    status: "connected".into(),
    tab_id,
  })
}

/// Send raw bytes to an open serial port (forwarded to the reader thread).
#[tauri::command]
pub async fn serial_send_input(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  data: String,
) -> Result<bool, String> {
  let tx = {
    let sessions = state.serial_sessions.lock().map_err(|e| e.to_string())?;
    sessions
      .get(&tab_id)
      .and_then(|s| s.write_tx.clone())
      .ok_or("Serial session not found")?
  };
  tx.send(data.into_bytes())
    .map_err(|e| format!("Failed to write to serial port: {}", e))?;
  Ok(true)
}

// --- Baud-rate auto-detection ---------------------------------------------

/// Baud rates probed by `detect_serial_baud`, ascending. 74880 is the fixed
/// rate of the ESP8266 ROM boot log, hence its inclusion.
const BAUD_CANDIDATES: [u32; 12] = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600,
];

/// How long to listen on each candidate rate before moving on.
const DEFAULT_PROBE_MS: u64 = 700;

/// One probed baud rate, with a confidence score and a preview of what the
/// device actually sent while listening at that rate.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaudCandidate {
  pub baud_rate: u32,
  /// 0..1 confidence — how much the received bytes look like real terminal
  /// text rather than framing garbage.
  pub score: f64,
  /// Bytes received during the probe window.
  pub bytes: usize,
  /// Printable preview (non-printables replaced with '.'), truncated.
  pub sample: String,
}

/// Best-effort auto-detection of a serial device's baud rate.
///
/// UART is asynchronous — there is no clock line and no negotiation — so the
/// peer's rate can never be *read*. This command brute-forces the common rates
/// instead: for each one it opens the port, listens for `probe_ms`, and if the
/// device stayed silent nudges it with `\r\n` and listens again (most consoles
/// only print anything after receiving a newline). Each attempt is scored by
/// how much the received bytes look like terminal text.
///
/// The port must be free — the command fails when it is already open, including
/// by another serial tab in this app. Progress is emitted as
/// `baud-detect-progress` while the scan runs.
#[tauri::command]
pub async fn detect_serial_baud(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  port_name: String,
  data_bits: u8,
  stop_bits: u8,
  parity: String,
  flow_control: String,
  probe_ms: Option<u64>,
  send_probe_newline: Option<bool>,
) -> Result<Vec<BaudCandidate>, String> {
  if port_name.trim().is_empty() {
    return Err("Serial port name is required".to_string());
  }
  let (db, sb, par, fc) = parse_line_settings(data_bits, stop_bits, &parity, &flow_control)?;
  let probe = probe_ms.unwrap_or(DEFAULT_PROBE_MS).clamp(100, 5000);
  let nudge = send_probe_newline.unwrap_or(true);

  // A port we already hold would otherwise fail with a generic OS error.
  {
    let sessions = state.serial_sessions.lock().map_err(|e| e.to_string())?;
    if sessions.values().any(|s| s.port_name == port_name) {
      return Err(format!(
        "{} is already connected in another tab — disconnect it before running detection",
        port_name
      ));
    }
  }

  // The scan blocks for seconds, so keep it off the async runtime.
  tokio::task::spawn_blocking(move || {
    run_baud_detection(&app, &port_name, db, sb, par, fc, probe, nudge)
  })
  .await
  .map_err(|e| format!("Baud detection task failed: {}", e))?
}

fn run_baud_detection(
  app: &tauri::AppHandle,
  port_name: &str,
  data_bits: serialport::DataBits,
  stop_bits: serialport::StopBits,
  parity: serialport::Parity,
  flow_control: serialport::FlowControl,
  probe_ms: u64,
  nudge: bool,
) -> Result<Vec<BaudCandidate>, String> {
  let total = BAUD_CANDIDATES.len();
  let mut results: Vec<BaudCandidate> = Vec::with_capacity(total);
  let mut first_error: Option<String> = None;

  for (idx, baud) in BAUD_CANDIDATES.iter().enumerate() {
    let _ = app.emit(
      "baud-detect-progress",
      serde_json::json!({
        "portName": port_name,
        "baudRate": baud,
        "index": idx,
        "total": total,
      }),
    );

    let mut port = match serialport::new(port_name, *baud)
      .data_bits(data_bits)
      .stop_bits(stop_bits)
      .parity(parity)
      .flow_control(flow_control)
      .timeout(Duration::from_millis(150))
      .open()
    {
      Ok(p) => p,
      Err(e) => {
        if first_error.is_none() {
          first_error = Some(e.to_string());
        }
        results.push(BaudCandidate {
          baud_rate: *baud,
          score: 0.0,
          bytes: 0,
          sample: String::new(),
        });
        continue;
      }
    };

    // Bytes already sitting in the driver buffer were decoded at the *previous*
    // baud rate, so discard the first slice before scoring.
    let mut stale: Vec<u8> = Vec::new();
    read_window(&mut port, Duration::from_millis(100), &mut stale);

    let mut data: Vec<u8> = Vec::new();
    read_window(&mut port, Duration::from_millis(probe_ms), &mut data);
    if data.is_empty() && nudge {
      // Many consoles stay silent until they receive a newline.
      let _ = port.write_all(b"\r\n");
      let _ = port.flush();
      read_window(&mut port, Duration::from_millis(probe_ms), &mut data);
    }
    drop(port);

    results.push(BaudCandidate {
      baud_rate: *baud,
      score: score_sample(&data),
      bytes: data.len(),
      sample: preview_sample(&data, 96),
    });

    // Give the OS a moment to release the handle before reopening.
    thread::sleep(Duration::from_millis(60));
  }

  // Nothing could even be opened → surface the real cause (busy / missing
  // port) instead of an all-zero list that looks like "no data".
  if let Some(err) = first_error {
    if results.iter().all(|c| c.bytes == 0) {
      return Err(format!("Failed to open {}: {}", port_name, err));
    }
  }

  results.sort_by(|a, b| {
    b.score
      .partial_cmp(&a.score)
      .unwrap_or(std::cmp::Ordering::Equal)
  });
  Ok(results)
}

/// Read whatever arrives within `window`, appending to `out`.
fn read_window(port: &mut Box<dyn serialport::SerialPort>, window: Duration, out: &mut Vec<u8>) {
  let deadline = Instant::now() + window;
  let mut buf = [0u8; 512];
  // Bounded iterations: the deadline drives termination, the cap is only a
  // guard against a driver that returns instantly with 0 bytes.
  for _ in 0..1024 {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
      break;
    }
    // Re-arm the read timeout in slices so the deadline is honoured.
    if port.set_timeout(remaining.min(Duration::from_millis(120))).is_err() {
      break;
    }
    match port.read(&mut buf) {
      Ok(0) => continue,
      Ok(n) => {
        out.extend_from_slice(&buf[..n]);
        if out.len() >= 4096 {
          break;
        }
      }
      Err(e)
        if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock =>
      {
        continue;
      }
      Err(_) => break,
    }
  }
}

/// Score 0..1: how much `data` looks like terminal text received at the
/// correct rate. A wrong rate produces framing garbage — 0x00/0xFF floods,
/// high bytes, or one byte repeated over and over — which is punished here.
fn score_sample(data: &[u8]) -> f64 {
  if data.is_empty() {
    return 0.0;
  }
  let total = data.len() as f64;
  let mut printable = 0usize;
  let mut wordish = 0usize; // letters/digits: real text, not just punctuation
  let mut bad = 0usize; // 0x00 / 0xFF, the classic mis-sampled signature
  let mut counts = [0usize; 256];

  for &b in data {
    counts[b as usize] += 1;
    match b {
      b'\r' | b'\n' | b'\t' | b'\x0c' | 0x20..=0x7e => printable += 1,
      0x00 | 0xff => bad += 1,
      _ => {}
    }
    if b.is_ascii_alphanumeric() {
      wordish += 1;
    }
  }

  let print_ratio = printable as f64 / total;
  let word_ratio = wordish as f64 / total;
  let bad_ratio = bad as f64 / total;

  // One byte dominating the stream means the sampler is not aligned with the
  // bit stream (the classic wall of 'U', 0x00 or 0xFF).
  let dominant = counts.iter().cloned().max().unwrap_or(0) as f64 / total;
  let repetition_penalty = if dominant > 0.7 { (dominant - 0.7) * 2.0 * 0.5 } else { 0.0 };

  let mut score = print_ratio * 0.7 + word_ratio * 0.3;
  score -= bad_ratio * 0.8;
  score -= repetition_penalty;
  if data.iter().any(|&b| b == b'\n' || b == b'\r') {
    score += 0.05; // line-oriented console output
  }
  score += marker_bonus(data);

  // Too few bytes to judge → damp the score so the user is not misled.
  let coverage = (total / 24.0).min(1.0);
  (score * coverage).clamp(0.0, 1.0)
}

/// Bonus for well-known console/device markers — a very strong hint that the
/// rate is correct (e.g. `login:`, NMEA `$GP…`, u-boot, ESP boot banner).
fn marker_bonus(data: &[u8]) -> f64 {
  let text = String::from_utf8_lossy(data).to_ascii_lowercase();
  const MARKERS: &[&str] = &[
    "login:",
    "password:",
    "username:",
    // NMEA GPS sentences
    "$gp",
    "$gn",
    "$gl",
    "$ga",
    "u-boot",
    "uboot",
    "autoboot",
    "hit any key",
    "press any key",
    "grub",
    "root@",
    "busybox",
    // ESP8266 / ESP32 ROM boot banners
    "rst cause",
    "ets jan",
    "ets_task",
    "esp8266",
    "esp32",
    "bootloader",
  ];
  if MARKERS.iter().any(|m| text.contains(m)) {
    0.25
  } else {
    0.0
  }
}

/// Printable preview of a probe sample; non-printables collapse to '.'.
fn preview_sample(data: &[u8], max: usize) -> String {
  let mut s = String::with_capacity(max.min(data.len()));
  for &b in data.iter().take(max) {
    match b {
      b'\r' | b'\n' | b'\t' => s.push(' '),
      0x20..=0x7e => s.push(b as char),
      _ => s.push('.'),
    }
  }
  s.trim().to_string()
}
