//! Telnet client (RFC 854 + the common option negotiations).
//!
//! A self-contained implementation (no third-party telnet crate): a byte-level
//! IAC state machine strips negotiations out of the server stream, answers the
//! common options (ECHO / SGA / TERMINAL-TYPE / NAWS / LINEMODE) and pushes the
//! remaining clean bytes into `AppState.output_buffers` — the exact same poll
//! path SSH and serial use, so the frontend needs no new rendering logic.
//!
//! Outgoing data is IAC-escaped (a literal 0xFF is doubled) and bare CR is
//! expanded to CRLF, which is what the NVT expects for Enter.

use super::*;
use std::collections::HashMap;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

// --- Telnet protocol constants (RFC 854 / 855 / 857 / 858 / 1073 / 1079) -----

const IAC: u8 = 0xff;
const DONT: u8 = 0xfe;
const DO: u8 = 0xfd;
const WONT: u8 = 0xfc;
const WILL: u8 = 0xfb;
const SB: u8 = 0xfa; // start of subnegotiation
const SE: u8 = 0xf0; // end of subnegotiation

const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3; // suppress-go-ahead
const OPT_TTYPE: u8 = 24; // terminal-type
const OPT_NAWS: u8 = 31; // negotiate-about-window-size
const OPT_LINEMODE: u8 = 34;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

/// Reported as TERMINAL-TYPE so the remote terminfo / `$TERM` matches an xterm.
const TERM_TYPE: &str = "xterm-256color";
/// Bounded TCP connect so an unreachable host doesn't hang the UI forever.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Socket read buffer size.
const READ_BUF: usize = 4096;

// --- IAC state machine ------------------------------------------------------

/// What the parser produces while consuming the server stream.
pub enum IacEvent {
  /// Clean (IAC-stripped) bytes destined for the terminal.
  Data(Vec<u8>),
  /// Negotiation bytes that must be written back to the server.
  Send(Vec<u8>),
}

#[derive(Debug)]
enum State {
  /// Normal data.
  Data,
  /// Just consumed an IAC byte.
  Iac,
  /// Consumed IAC + one of WILL/WONT/DO/DONT; next byte is the option code.
  Cmd(u8),
  /// Consumed `IAC SB`; next byte is the subnegotiation option code.
  SubOpt,
  /// Inside a subnegotiation: option code + collected payload.
  Sub(u8, Vec<u8>),
  /// Inside a subnegotiation, just consumed IAC (could be SE or an escaped IAC).
  SubIac(u8, Vec<u8>),
}

/// Incremental Telnet IAC parser and negotiator.
///
/// Feeding bytes in order is required: the parser carries partial sequences
/// (a negotiation or subnegotiation can be split across TCP reads) across calls.
pub struct TelnetParser {
  state: State,
  /// Options we agreed to enable on OUR side (we answered WILL).
  us: HashMap<u8, bool>,
  /// Options the server agreed to enable (we answered DO).
  them: HashMap<u8, bool>,
  /// Live terminal geometry shared with the session, so `telnet_resize` keeps
  /// NAWS in sync if the server re-negotiates later.
  size: Arc<StdMutex<(u32, u32)>>,
  term_type: String,
}

impl TelnetParser {
  pub fn new(size: Arc<StdMutex<(u32, u32)>>) -> Self {
    Self {
      state: State::Data,
      us: HashMap::new(),
      them: HashMap::new(),
      size,
      term_type: TERM_TYPE.to_string(),
    }
  }

  /// Consume a chunk of raw server bytes, appending the resulting events.
  pub fn feed(&mut self, bytes: &[u8], out: &mut Vec<IacEvent>) {
    let mut clean: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut state = std::mem::replace(&mut self.state, State::Data);

    for &b in bytes {
      let cur = std::mem::replace(&mut state, State::Data);
      match cur {
        State::Data => {
          if b == IAC {
            state = State::Iac;
          } else {
            clean.push(b);
          }
        }
        State::Iac => match b {
          IAC => {
            // Escaped literal 0xFF in the data stream.
            clean.push(IAC);
            state = State::Data;
          }
          SB => state = State::SubOpt,
          WILL | WONT | DO | DONT => state = State::Cmd(b),
          // Two-byte commands (NOP / DM / GA / AYT / …) carry no payload.
          _ => state = State::Data,
        },
        State::Cmd(cmd) => {
          // Flush pending data first so the terminal sees output in order.
          if !clean.is_empty() {
            out.push(IacEvent::Data(std::mem::take(&mut clean)));
          }
          state = State::Data;
          self.negotiate(cmd, b, out);
        }
        State::SubOpt => state = State::Sub(b, Vec::new()),
        State::Sub(opt, mut buf) => {
          if b == IAC {
            state = State::SubIac(opt, buf);
          } else {
            buf.push(b);
            state = State::Sub(opt, buf);
          }
        }
        State::SubIac(opt, mut buf) => {
          if b == SE {
            if !clean.is_empty() {
              out.push(IacEvent::Data(std::mem::take(&mut clean)));
            }
            state = State::Data;
            self.subnegotiate(opt, buf, out);
          } else if b == IAC {
            // Escaped literal IAC inside the subnegotiation payload.
            buf.push(IAC);
            state = State::Sub(opt, buf);
          } else {
            // Malformed stream — abandon the subnegotiation and resync.
            state = State::Data;
          }
        }
      }
    }

    self.state = state;
    if !clean.is_empty() {
      out.push(IacEvent::Data(clean));
    }
  }

  /// Options we offer unprompted right after connecting.
  ///
  /// Most telnetd implementations send `DO NAWS` / `DO TTYPE` themselves, but
  /// some never do — and without NAWS the remote keeps assuming the default
  /// 80x24, so full-screen programs wrap at the wrong column. Offering them
  /// ourselves is standard client behaviour (PuTTY does the same) and is
  /// harmless: a server that doesn't want an option simply answers `DONT`.
  pub fn initial_negotiation(&mut self) -> Vec<u8> {
    let mut out = Vec::new();
    for opt in [OPT_NAWS, OPT_TTYPE] {
      if self.us.get(&opt).copied() != Some(true) {
        self.us.insert(opt, true);
        out.push(IAC);
        out.push(WILL);
        out.push(opt);
      }
    }
    out
  }

  /// Answer a three-byte option command (`IAC <cmd> <opt>`).
  ///
  /// Replies are emitted once per state change, never repeatedly, so a chatty
  /// (or buggy) server can't drive us into a negotiation loop.
  fn negotiate(&mut self, cmd: u8, opt: u8, out: &mut Vec<IacEvent>) {
    match cmd {
      // The server offers to enable `opt` on ITS side.
      WILL => {
        let accept = matches!(opt, OPT_ECHO | OPT_SGA | OPT_TTYPE | OPT_NAWS);
        if self.them.get(&opt).copied() != Some(accept) {
          self.them.insert(opt, accept);
          out.push(IacEvent::Send(vec![
            IAC,
            if accept { DO } else { DONT },
            opt,
          ]));
        }
        if accept && opt == OPT_NAWS {
          out.push(IacEvent::Send(naws_bytes(self.size())));
        }
      }
      WONT => {
        if self.them.get(&opt).copied() != Some(false) {
          self.them.insert(opt, false);
          out.push(IacEvent::Send(vec![IAC, DONT, opt]));
        }
      }
      // The server asks US to enable `opt`.
      //
      // ECHO: xterm never echoes locally — the remote side must, so we refuse
      // (`WONT ECHO`); a well-behaved telnetd then offers `WILL ECHO` itself,
      // which the branch above accepts.
      // LINEMODE: we want character-at-a-time, so that is refused too.
      // Anything else we don't implement is refused as well.
      DO => {
        let accept = match opt {
          OPT_SGA | OPT_TTYPE | OPT_NAWS => true,
          OPT_ECHO | OPT_LINEMODE => false,
          _ => false,
        };
        if self.us.get(&opt).copied() != Some(accept) {
          self.us.insert(opt, accept);
          out.push(IacEvent::Send(vec![
            IAC,
            if accept { WILL } else { WONT },
            opt,
          ]));
        }
        // NAWS must always carry the current size once the server enables it,
        // even when the `WILL` above was a no-op (we may have offered it
        // proactively in `initial_negotiation`).
        if accept && opt == OPT_NAWS {
          out.push(IacEvent::Send(naws_bytes(self.size())));
        }
      }
      DONT => {
        if self.us.get(&opt).copied() != Some(false) {
          self.us.insert(opt, false);
          out.push(IacEvent::Send(vec![IAC, WONT, opt]));
        }
      }
      _ => {}
    }
  }

  /// Handle `IAC SB <opt> <payload…> IAC SE`.
  fn subnegotiate(&mut self, opt: u8, payload: Vec<u8>, out: &mut Vec<IacEvent>) {
    if opt == OPT_TTYPE && payload.first() == Some(&TTYPE_SEND) {
      let mut resp = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
      resp.extend_from_slice(self.term_type.as_bytes());
      resp.push(IAC);
      resp.push(SE);
      out.push(IacEvent::Send(resp));
    }
  }

  fn size(&self) -> (u32, u32) {
    match self.size.lock() {
      Ok(s) => *s,
      Err(poisoned) => *poisoned.into_inner(),
    }
  }
}

/// Build the NAWS subnegotiation for a window size (RFC 1073).
pub(crate) fn naws_bytes((cols, rows): (u32, u32)) -> Vec<u8> {
  let c = cols.min(u16::MAX as u32) as u16;
  let r = rows.min(u16::MAX as u32) as u16;
  vec![
    IAC,
    SB,
    OPT_NAWS,
    (c >> 8) as u8,
    (c & 0xff) as u8,
    (r >> 8) as u8,
    (r & 0xff) as u8,
    IAC,
    SE,
  ]
}

/// Escape user input for the Telnet data stream.
///
/// - A literal 0xFF is doubled, otherwise the server reads it as IAC.
/// - A bare CR becomes CRLF: the NVT end-of-line is CR LF and plenty of
///   telnetd implementations don't enable ICRNL on their pty, so a lone CR
///   would leave the cursor in column 0 instead of executing the line.
pub fn escape_input(data: &str) -> Vec<u8> {
  let bytes = data.as_bytes();
  let mut out = Vec::with_capacity(bytes.len() + 8);
  let mut i = 0;
  while i < bytes.len() {
    let b = bytes[i];
    if b == IAC {
      out.push(IAC);
      out.push(IAC);
    } else if b == b'\r' {
      let next = bytes.get(i + 1).copied();
      if next == Some(b'\n') || next == Some(0) {
        // Already a proper terminator — let the next iteration emit it.
        out.push(b);
      } else {
        out.push(b'\r');
        out.push(b'\n');
      }
    } else {
      out.push(b);
    }
    i += 1;
  }
  out
}

/// Incremental UTF-8 decoder: a TCP read can split a multi-byte character, so
/// an incomplete tail is carried into the next chunk instead of being rendered
/// as a replacement character.
struct Utf8Decoder {
  tail: Vec<u8>,
}

impl Utf8Decoder {
  fn new() -> Self {
    Self { tail: Vec::new() }
  }

  fn push(&mut self, bytes: &[u8]) -> String {
    self.tail.extend_from_slice(bytes);
    match std::str::from_utf8(&self.tail) {
      Ok(s) => {
        let out = s.to_string();
        self.tail.clear();
        out
      }
      Err(e) => {
        let valid = e.valid_up_to();
        let out = String::from_utf8_lossy(&self.tail[..valid]).into_owned();
        let mut rest: Vec<u8> = self.tail[valid..].to_vec();
        match e.error_len() {
          // Truncated multi-byte char — keep the tail for the next chunk.
          None => {}
          // Genuinely invalid sequence — drop the offending bytes to resync.
          Some(n) => {
            let n = n.min(rest.len());
            rest.drain(..n);
          }
        }
        self.tail = rest;
        out
      }
    }
  }
}

// --- Best-effort automatic login -------------------------------------------

const LOGIN_PROMPTS: [&str; 5] = ["login:", "username:", "user:", "account:", "login as:"];
const PASSWORD_PROMPTS: [&str; 3] = ["password:", "passwd:", "password for"];
/// Only the tail of the stream can hold a login prompt.
const LOGIN_TAIL: usize = 512;

/// Telnet has no authentication protocol — the server just prints `login:` /
/// `Password:` on the stream. When the user opted in, we watch the tail of the
/// incoming text and inject the saved credentials.
///
/// Deliberately conservative: each credential is sent at most once and the
/// helper disarms itself after the password (or immediately when no password is
/// configured), so a hostile or unusual server can never trigger an injection
/// loop or leak credentials into an unexpected prompt.
struct AutoLogin {
  username: Vec<u8>,
  password: Option<Vec<u8>>,
  sent_user: bool,
  sent_pass: bool,
  tail: String,
}

impl AutoLogin {
  fn new(username: String, password: Option<String>, enabled: bool) -> Self {
    let name = username.trim().to_string();
    if !enabled || name.is_empty() {
      // Disarmed: every prompt check short-circuits.
      return Self {
        username: Vec::new(),
        password: None,
        sent_user: true,
        sent_pass: true,
        tail: String::new(),
      };
    }
    Self {
      username: format!("{}\r\n", name).into_bytes(),
      password: password.map(|p| format!("{}\r\n", p).into_bytes()),
      sent_user: false,
      sent_pass: false,
      tail: String::new(),
    }
  }

  /// Inspect newly arrived text; returns bytes to send back, if any.
  fn feed(&mut self, text: &str) -> Option<Vec<u8>> {
    if self.sent_pass {
      return None;
    }
    self.tail.push_str(text);
    if self.tail.len() > LOGIN_TAIL {
      let drop = self.tail.len() - LOGIN_TAIL;
      self.tail.drain(..drop);
    }
    let probe = self.tail.to_ascii_lowercase();
    let probe = probe.trim_end();

    if !self.sent_user {
      if LOGIN_PROMPTS.iter().any(|p| probe.ends_with(p)) {
        self.sent_user = true;
        return Some(self.username.clone());
      }
      return None;
    }
    match &self.password {
      Some(pass) if PASSWORD_PROMPTS.iter().any(|p| probe.ends_with(p)) => {
        self.sent_pass = true;
        Some(pass.clone())
      }
      // No password saved — stop watching rather than sending a blank line.
      None => {
        self.sent_pass = true;
        None
      }
      _ => None,
    }
  }
}

// --- Commands ---------------------------------------------------------------

/// Parameters for opening a Telnet session. Mirrors the fields the connection
/// manager collects for a "telnet" connection.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelnetConfig {
  pub id: String,
  pub name: String,
  pub host: String,
  #[serde(default = "default_telnet_port")]
  pub port: u16,
  pub username: String,
  #[serde(default)]
  pub password: Option<String>,
  /// Opt-in best-effort auto-login (`login:` / `Password:` prompt matching).
  /// Off unless the user explicitly enabled it — Telnet is plaintext, so
  /// credentials are never injected by default.
  #[serde(default)]
  pub auto_login: bool,
  #[serde(default)]
  pub group: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<String>,
}

fn default_telnet_port() -> u16 {
  23
}

/// Open a Telnet session and stream it into the shared poll buffer.
#[tauri::command]
pub async fn connect_telnet(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  cfg: TelnetConfig,
  tab_id: u32,
  cols: u32,
  rows: u32,
) -> Result<ConnectResult, String> {
  let host = cfg.host.trim().to_string();
  if host.is_empty() {
    return Err("Host is required".to_string());
  }
  let port = if cfg.port == 0 {
    default_telnet_port()
  } else {
    cfg.port
  };
  let addr = format!("{}:{}", host, port);

  let stream = match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr)).await {
    Ok(Ok(s)) => s,
    Ok(Err(e)) => return Err(format!("Failed to connect to {}: {}", addr, e)),
    Err(_) => return Err(format!("Connection to {} timed out", addr)),
  };

  // Drop output left over from a previous session on this tab.
  if let Ok(mut buffers) = state.output_buffers.lock() {
    buffers.remove(&tab_id);
  }

  // Ask any previous session on this tab to stop first.
  {
    let mut sessions = state.telnet_sessions.lock().map_err(|e| e.to_string())?;
    if let Some(old) = sessions.get_mut(&tab_id) {
      if let Some(tx) = old.shutdown_tx.take() {
        let _ = tx.send(());
      }
    }
  }

  let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
  let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
  let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
  let size = Arc::new(StdMutex::new((cols, rows)));

  {
    let mut sessions = state.telnet_sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
      tab_id,
      TelnetSession {
        tab_id,
        write_tx: write_tx.clone(),
        size: size.clone(),
        shutdown_tx: Some(shutdown_tx),
        session_id,
      },
    );
  }

  // Tell the user what we connected to (also proves the socket is alive even
  // when the server stays silent until the first negotiation).
  {
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers.entry(tab_id).or_default().push(format!(
        "\x1b[33m=== Telnet {} ({}x{}) ===\x1b[0m\r\n",
        addr, cols, rows
      ));
    }
  }

  let app_handle = app.clone();
  let login = AutoLogin::new(cfg.username.clone(), cfg.password.clone(), cfg.auto_login);
  tokio::spawn(async move {
    let (mut read_half, mut write_half) = stream.into_split();
    let mut parser = TelnetParser::new(size);
    let mut decoder = Utf8Decoder::new();
    let mut login = login;
    let mut shutdown_rx = shutdown_rx;
    let mut buf = [0u8; READ_BUF];
    let mut events: Vec<IacEvent> = Vec::new();

    // Offer window-size / terminal-type up front (see `initial_negotiation`).
    // A failure here still falls through to the loop so cleanup runs and the
    // frontend gets its `connection-closed` event.
    let greeting = parser.initial_negotiation();
    let io_ok = if greeting.is_empty() {
      true
    } else {
      write_half.write_all(&greeting).await.is_ok()
    };

    'session: loop {
      if !io_ok {
        break 'session;
      }
      tokio::select! {
        _ = &mut shutdown_rx => break 'session,

        res = read_half.read(&mut buf) => {
          match res {
            Ok(0) => break 'session, // EOF — server closed the connection
            Ok(n) => {
              events.clear();
              parser.feed(&buf[..n], &mut events);
              for ev in events.drain(..) {
                match ev {
                  IacEvent::Send(bytes) => {
                    if write_half.write_all(&bytes).await.is_err() {
                      break 'session;
                    }
                  }
                  IacEvent::Data(bytes) => {
                    let text = decoder.push(&bytes);
                    if !text.is_empty() {
                      push_output(&app_handle, tab_id, &text);
                      if let Some(resp) = login.feed(&text) {
                        let _ = write_half.write_all(&resp).await;
                      }
                    }
                  }
                }
              }
            }
            Err(e) => {
              push_output(
                &app_handle,
                tab_id,
                &format!("\x1b[31m[telnet] read error: {}\x1b[0m\r\n", e),
              );
              break 'session;
            }
          }
        }

        got = write_rx.recv() => {
          match got {
            Some(data) => {
              if write_half.write_all(&data).await.is_err() {
                break 'session;
              }
            }
            // All senders dropped — the session was removed from state.
            None => break 'session,
          }
        }
      }
    }

    // Only the current session may clean up and notify the frontend, so a
    // superseded task from an earlier reconnect can't close the new session.
    let is_ours = match app_handle.try_state::<AppState>() {
      Some(st) => match st.telnet_sessions.lock() {
        Ok(m) => m.get(&tab_id).map_or(false, |s| s.session_id == session_id),
        Err(_) => false,
      },
      None => false,
    };
    if is_ours {
      if let Some(st) = app_handle.try_state::<AppState>() {
        if let Ok(mut sessions) = st.telnet_sessions.lock() {
          sessions.remove(&tab_id);
        }
      }
      let _ = app_handle.emit("connection-closed", serde_json::json!({ "tabId": tab_id }));
    }
  });

  Ok(ConnectResult {
    status: "connected".into(),
    tab_id,
  })
}

/// Send user input to a Telnet session (IAC-escaped, CR expanded to CRLF).
#[tauri::command]
pub async fn telnet_send_input(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  data: String,
) -> Result<bool, String> {
  let tx = {
    let sessions = state.telnet_sessions.lock().map_err(|e| e.to_string())?;
    sessions
      .get(&tab_id)
      .map(|s| s.write_tx.clone())
      .ok_or_else(|| "Telnet session not found".to_string())?
  };
  tx.send(escape_input(&data))
    .map_err(|e| format!("Failed to send input: {}", e))?;
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn parser() -> TelnetParser {
    TelnetParser::new(Arc::new(StdMutex::new((80, 24))))
  }

  /// Feed `bytes` and split the results into clean data + replies to send back.
  fn run(p: &mut TelnetParser, bytes: &[u8]) -> (Vec<u8>, Vec<Vec<u8>>) {
    let mut events = Vec::new();
    p.feed(bytes, &mut events);
    let mut data = Vec::new();
    let mut replies = Vec::new();
    for ev in events {
      match ev {
        IacEvent::Data(d) => data.extend_from_slice(&d),
        IacEvent::Send(s) => replies.push(s),
      }
    }
    (data, replies)
  }

  #[test]
  fn plain_data_passes_through_unchanged() {
    let mut p = parser();
    let (data, replies) = run(&mut p, b"hello\r\n$ ");
    assert_eq!(data, b"hello\r\n$ ");
    assert!(replies.is_empty());
  }

  #[test]
  fn escaped_iac_becomes_a_literal_0xff() {
    let mut p = parser();
    let (data, _) = run(&mut p, &[b'a', IAC, IAC, b'b']);
    assert_eq!(data, vec![b'a', 0xff, b'b']);
  }

  #[test]
  fn two_byte_commands_are_dropped() {
    // NOP (0xF1) and GA (0xF9) consume no payload and produce no data.
    let mut p = parser();
    let (data, replies) = run(&mut p, &[b'x', IAC, 0xf1, b'y']);
    assert_eq!(data, b"xy");
    assert!(replies.is_empty());
  }

  #[test]
  fn server_will_echo_is_accepted() {
    // The remote must echo: xterm shows only what it is told to write.
    let mut p = parser();
    let (_, replies) = run(&mut p, &[IAC, WILL, OPT_ECHO]);
    assert_eq!(replies, vec![vec![IAC, DO, OPT_ECHO]]);
  }

  #[test]
  fn server_do_echo_is_refused() {
    // We never echo locally, so `DO ECHO` gets `WONT`; the server then offers
    // `WILL ECHO`, which we accept (see `server_will_echo_is_accepted`).
    let mut p = parser();
    let (_, replies) = run(&mut p, &[IAC, DO, OPT_ECHO]);
    assert_eq!(replies, vec![vec![IAC, WONT, OPT_ECHO]]);
  }

  #[test]
  fn server_do_linemode_is_refused() {
    // Character-at-a-time is what a terminal emulator wants.
    let mut p = parser();
    let (_, replies) = run(&mut p, &[IAC, DO, OPT_LINEMODE]);
    assert_eq!(replies, vec![vec![IAC, WONT, OPT_LINEMODE]]);
  }

  #[test]
  fn server_do_naws_announces_the_window_size() {
    let mut p = parser();
    let (_, replies) = run(&mut p, &[IAC, DO, OPT_NAWS]);
    // Two separate writes: accept the option, then report the geometry.
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0], vec![IAC, WILL, OPT_NAWS]);
    // The NAWS payload carries cols/rows big-endian (80x24 here).
    assert_eq!(replies[1], naws_bytes((80, 24)));
    assert_eq!(replies[1], vec![IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]);
  }

  #[test]
  fn terminal_type_request_is_answered() {
    let mut p = parser();
    let (_, replies) = run(&mut p, &[IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
    let mut expected = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
    expected.extend_from_slice(TERM_TYPE.as_bytes());
    expected.extend_from_slice(&[IAC, SE]);
    assert_eq!(replies, vec![expected]);
  }

  #[test]
  fn repeated_negotiation_is_not_answered_again() {
    let mut p = parser();
    let (_, first) = run(&mut p, &[IAC, WILL, OPT_SGA]);
    assert_eq!(first, vec![vec![IAC, DO, OPT_SGA]]);
    // A chatty or buggy server must not be able to drive us into a loop.
    let (_, second) = run(&mut p, &[IAC, WILL, OPT_SGA]);
    assert!(second.is_empty());
  }

  #[test]
  fn negotiation_split_across_reads_is_reassembled() {
    let mut p = parser();
    let (d1, r1) = run(&mut p, &[IAC]);
    assert_eq!(d1, b"");
    assert!(r1.is_empty());
    let (_, r2) = run(&mut p, &[WILL, OPT_SGA]);
    assert_eq!(r2, vec![vec![IAC, DO, OPT_SGA]]);

    // Same for a subnegotiation split in the middle of the payload.
    let mut p = parser();
    run(&mut p, &[IAC, SB, OPT_TTYPE]);
    let (_, replies) = run(&mut p, &[TTYPE_SEND, IAC, SE]);
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0][1], SB);
  }

  #[test]
  fn data_and_negotiation_keep_their_order() {
    let mut p = parser();
    let mut events = Vec::new();
    p.feed(b"before", &mut events);
    p.feed(&[IAC, WILL, OPT_SGA], &mut events);
    p.feed(b"after", &mut events);
    let mut data = Vec::new();
    let mut replies = Vec::new();
    for ev in events {
      match ev {
        IacEvent::Data(d) => data.extend_from_slice(&d),
        IacEvent::Send(s) => replies.push(s),
      }
    }
    assert_eq!(data, b"beforeafter");
    assert_eq!(replies, vec![vec![IAC, DO, OPT_SGA]]);
  }

  #[test]
  fn initial_negotiation_offers_naws_and_ttype() {
    let mut p = parser();
    let greeting = p.initial_negotiation();
    assert_eq!(greeting, vec![IAC, WILL, OPT_NAWS, IAC, WILL, OPT_TTYPE]);
    // Offering them records our side, so the server's `DO NAWS` only has to
    // carry the size (no duplicate WILL).
    let (_, replies) = run(&mut p, &[IAC, DO, OPT_NAWS]);
    assert_eq!(replies, vec![naws_bytes((80, 24))]);
  }

  #[test]
  fn escape_input_expands_bare_cr_to_crlf() {
    assert_eq!(escape_input("ls\r"), vec![b'l', b's', b'\r', b'\n']);
    // An existing CRLF / CR NUL must not gain a second newline.
    assert_eq!(escape_input("ls\r\n"), vec![b'l', b's', b'\r', b'\n']);
    assert_eq!(escape_input("ls\r\0"), vec![b'l', b's', b'\r', 0]);
    // Mid-string CRs are expanded too, trailing text preserved.
    assert_eq!(escape_input("a\rb"), vec![b'a', b'\r', b'\n', b'b']);
    assert_eq!(escape_input("hi"), vec![b'h', b'i']);
  }

  #[test]
  fn utf8_split_across_reads_is_not_corrupted() {
    let mut dec = Utf8Decoder::new();
    let bytes = "héllo→".as_bytes();
    let mid = bytes.iter().position(|b| b & 0xc0 == 0xc0).unwrap();
    let mut out = String::new();
    out.push_str(&dec.push(&bytes[..mid + 1])); // truncated multi-byte char
    out.push_str(&dec.push(&bytes[mid + 1..]));
    assert_eq!(out, "héllo→");
  }
}

/// Push received text into the frontend poll buffer (and the AI capture sink).
fn push_output(app: &tauri::AppHandle, tab_id: u32, text: &str) {
  if text.is_empty() {
    return;
  }
  if let Some(state) = app.try_state::<AppState>() {
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers.entry(tab_id).or_default().push(text.to_string());
    }
    // Tee a *copy* for an in-flight AI-issued command, never a move — the
    // frontend still drains `output_buffers` via `poll_output`.
    if let Ok(mut caps) = state.ai_captures.lock() {
      if let Some(buf) = caps.get_mut(&tab_id) {
        buf.push_str(text);
      }
    }
  }
}
