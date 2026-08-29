use super::*;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

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

  let data_bits = match cfg.data_bits {
    5 => serialport::DataBits::Five,
    6 => serialport::DataBits::Six,
    7 => serialport::DataBits::Seven,
    8 => serialport::DataBits::Eight,
    _ => return Err(format!("Invalid data bits: {} (expect 5-8)", cfg.data_bits)),
  };
  let stop_bits = match cfg.stop_bits {
    1 => serialport::StopBits::One,
    2 => serialport::StopBits::Two,
    _ => return Err(format!("Invalid stop bits: {} (expect 1 or 2)", cfg.stop_bits)),
  };
  let parity = match cfg.parity.as_str() {
    "odd" => serialport::Parity::Odd,
    "even" => serialport::Parity::Even,
    "" | "none" => serialport::Parity::None,
    other => return Err(format!("Invalid parity: {} (expect none/odd/even)", other)),
  };
  let flow_control = match cfg.flow_control.as_str() {
    "software" => serialport::FlowControl::Software,
    "hardware" => serialport::FlowControl::Hardware,
    "" | "none" => serialport::FlowControl::None,
    other => return Err(format!("Invalid flow control: {} (expect none/software/hardware)", other)),
  };

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
