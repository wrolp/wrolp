use super::*;
// ==================== AI → Terminal execution ====================
//
// By default `run_command` used to execute through a *separate* channel
// (`exec_on_handle` for SSH, `std::process::Command` for local). That is
// invisible to the user: nothing shows on screen, nothing enters the session
// recording, and the command does not share the interactive shell's cwd/env.
//
// The helpers below instead *type the command into the live shell*, exactly as
// if the user had typed it, and capture the resulting output by teeing the
// shell's output stream. See `task/plans/AI-TO-TERMINAL-PLAN.md`.

/// Which live shell backs a tab. Decides how input is written and where the
/// output capture sink lives.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LiveShell {
  /// Interactive SSH PTY (`AppState::sessions`).
  Ssh,
  /// Local PTY-backed process (`AppState::local_shells`).
  Local,
  /// Interactive Telnet session (`AppState::telnet_sessions`). Telnet has no
  /// PTY, but it is still a live bidirectional stream we can type into and read
  /// back, which is all the AI terminal path needs.
  Telnet,
}

/// Wait at most this long for the *first* byte of output after sending.
/// A command that produces nothing at all (e.g. `touch x`) ends here.
const AI_TERM_FIRST_BYTE_MS: u128 = 5_000;
/// Once output has started, treat the command as finished after this much
/// silence. A PTY gives us no end-of-command signal, so this is a heuristic.
const AI_TERM_QUIET_MS: u128 = 700;
/// Hard ceiling for a single AI-issued command.
const AI_TERM_MAX_MS: u128 = 60_000;
/// Poll interval of the capture loop.
const AI_TERM_POLL_MS: u64 = 50;
/// Cap on the captured output handed back to the model (keeps tokens sane).
const AI_TERM_MAX_OUTPUT: usize = 32 * 1024;

/// Whether `run_command` should route through the live terminal. Controlled by
/// the global AI setting; defaults to enabled when no config is loaded.
fn ai_run_in_terminal_enabled(state: &AppState) -> bool {
  state
    .ai_config
    .lock()
    .ok()
    .map(|c| c.as_ref().map_or(true, |c| c.run_in_terminal))
    .unwrap_or(true)
}

/// Detect whether `tab_id` has a live interactive shell we can type into.
fn live_shell_kind(state: &AppState, tab_id: u32) -> Option<LiveShell> {
  if let Ok(shells) = state.local_shells.lock() {
    if shells.contains_key(&tab_id) {
      return Some(LiveShell::Local);
    }
  }
  if let Ok(sessions) = state.sessions.lock() {
    if sessions
      .get(&tab_id)
      .and_then(|s| s.data_tx.as_ref())
      .is_some()
    {
      return Some(LiveShell::Ssh);
    }
  }
  // Telnet: the session entry exists only while the reader task is alive, and
  // `write_tx` is always present, so membership alone means "live".
  if let Ok(telnet) = state.telnet_sessions.lock() {
    if telnet.contains_key(&tab_id) {
      return Some(LiveShell::Telnet);
    }
  }
  None
}

/// Install an empty AI capture sink for `tab_id`.
///
/// Returns `false` if a sink is already installed, which means another AI
/// command is still running on this tab. Two commands typed into one shell
/// would interleave their output and neither result would be trustworthy, so
/// the caller must bail out instead of overwriting the sink.
fn ai_capture_start(state: &AppState, tab_id: u32, kind: LiveShell) -> bool {
  match kind {
    // Telnet tees into the same `ai_captures` map as SSH (see
    // `commands::telnet`), so both share this arm.
    LiveShell::Ssh | LiveShell::Telnet => match state.ai_captures.lock() {
      Ok(mut caps) => {
        if caps.contains_key(&tab_id) {
          return false;
        }
        caps.insert(tab_id, String::new());
        true
      }
      Err(_) => false,
    },
    LiveShell::Local => {
      // Clone the sink handle out so the `local_shells` guard is released
      // before we lock the sink itself (the reader thread holds the same Arc).
      let sink = match state.local_shells.lock() {
        Ok(shells) => shells.get(&tab_id).map(|sh| sh.ai_capture.clone()),
        Err(_) => None,
      };
      let Some(sink) = sink else { return false };
      let Ok(mut cap) = sink.lock() else { return false };
      if cap.is_some() {
        return false;
      }
      *cap = Some(String::new());
      true
    }
  }
}

/// Current size of the capture sink; used to detect "the stream went quiet".
fn ai_capture_len(state: &AppState, tab_id: u32, kind: LiveShell) -> usize {
  match kind {
    LiveShell::Ssh | LiveShell::Telnet => state
      .ai_captures
      .lock()
      .ok()
      .and_then(|caps| caps.get(&tab_id).map(|s| s.len()))
      .unwrap_or(0),
    LiveShell::Local => state
      .local_shells
      .lock()
      .ok()
      .and_then(|shells| {
        shells
          .get(&tab_id)
          .and_then(|sh| sh.ai_capture.lock().ok().map(|c| c.as_ref().map_or(0, |s| s.len())))
      })
      .unwrap_or(0),
  }
}

/// Remove the sink and return everything it captured.
fn ai_capture_finish(state: &AppState, tab_id: u32, kind: LiveShell) -> String {
  match kind {
    LiveShell::Ssh | LiveShell::Telnet => state
      .ai_captures
      .lock()
      .ok()
      .and_then(|mut caps| caps.remove(&tab_id))
      .unwrap_or_default(),
    LiveShell::Local => state
      .local_shells
      .lock()
      .ok()
      .and_then(|shells| {
        shells
          .get(&tab_id)
          .and_then(|sh| sh.ai_capture.lock().ok().and_then(|mut c| c.take()))
      })
      .unwrap_or_default(),
  }
}

/// Write `data` into the tab's live shell exactly as if the user had typed it.
fn type_into_shell(
  state: &AppState,
  tab_id: u32,
  kind: LiveShell,
  data: &str,
) -> Result<(), String> {
  match kind {
    LiveShell::Ssh => {
      let data_tx = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
          .get(&tab_id)
          .and_then(|s| s.data_tx.clone())
          .ok_or("Session not found")?
      };
      data_tx
        .send(data.as_bytes().to_vec())
        .map_err(|e| format!("Failed to send input: {}", e))
    }
    LiveShell::Local => {
      use std::io::Write;
      let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
      let sh = shells.get_mut(&tab_id).ok_or("Local shell not found")?;
      sh.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to local shell: {}", e))?;
      let _ = sh.writer.flush();
      Ok(())
    }
    LiveShell::Telnet => {
      // Telnet bytes must be IAC-escaped (a literal 0xFF is doubled) and a bare
      // CR expanded to CRLF — the NVT end-of-line — before they hit the wire.
      // `escape_input` already does both for ordinary user typing, so reuse it.
      let tx = {
        let sessions = state.telnet_sessions.lock().map_err(|e| e.to_string())?;
        sessions
          .get(&tab_id)
          .map(|s| s.write_tx.clone())
          .ok_or("Telnet session not found")?
      };
      tx.send(crate::commands::telnet::escape_input(data))
        .map_err(|e| format!("Failed to send input: {}", e))
    }
  }
}

/// Record an AI-issued command in the tab's active recording.
///
/// Uses the same `command` direction as a user-typed line but with an `[AI] `
/// prefix, so playback and `extract_commands` can tell them apart. There is no
/// double-recording risk: xterm's `onData` (which drives `commit_command`)
/// only fires for real keystrokes, never for input written from the backend.
fn record_ai_command(state: &AppState, tab_id: u32, command: &str) {
  if let Ok(mut recordings) = state.recordings.lock() {
    if let Some(rec) = recordings.get_mut(&tab_id) {
      if rec.recording_enabled {
        let seq = rec.seq_counter;
        rec.seq_counter += 1;
        let elapsed = rec.started_at.elapsed().as_millis() as u64;
        rec.events.push(db::RecordedEvent {
          seq,
          timestamp_ms: elapsed,
          direction: "command".to_string(),
          content: format!("{}{}", AI_COMMAND_PREFIX, command),
        });
      }
    }
  }
}

/// Marker prepended to `command` recording events issued by the assistant.
pub const AI_COMMAND_PREFIX: &str = "[AI] ";

/// Strip ANSI / VT escape sequences so the model sees plain text.
/// returns and backspaces, normalise line endings, drop trailing blank lines.
fn normalize_pty_text(raw: &str) -> String {
  let stripped = strip_ansi(raw).replace("\r\n", "\n");
  let mut lines: Vec<String> = Vec::new();
  for segment in stripped.split('\n') {
    // A bare CR rewrites the current line (progress bars, spinners): keep only
    // what was painted last.
    let visible = segment.rsplit('\r').next().unwrap_or(segment);
    let mut line = String::with_capacity(visible.len());
    for c in visible.chars() {
      if c == '\x08' {
        line.pop();
      } else {
        line.push(c);
      }
    }
    lines.push(line.trim_end().to_string());
  }
  while lines.last().map_or(false, |l| l.is_empty()) {
    lines.pop();
  }
  lines.join("\n")
}

/// Heuristic: does this look like a freshly drawn shell prompt rather than
/// command output? Only consulted for the very last captured line.
fn looks_like_prompt(line: &str) -> bool {
  let t = line.trim_end();
  if t.is_empty() || t.len() > 200 {
    return false;
  }
  // cmd.exe `C:\Users\me>` / PowerShell `PS C:\Users\me>`
  if t.ends_with('>') {
    return true;
  }
  matches!(t.chars().last(), Some('$') | Some('#') | Some('%'))
}

/// Remove the shell's echo of the command and the trailing prompt it redraws,
/// leaving just the command's own output.
///
/// `ended_without_newline` is the reliable prompt signal: a PTY leaves the
/// cursor parked after the prompt, so the final chunk has no trailing newline.
fn trim_echo_and_prompt(text: &str, command: &str, ended_without_newline: bool) -> String {
  let mut lines: Vec<&str> = text.lines().collect();
  while lines.first().map_or(false, |l| l.trim().is_empty()) {
    lines.remove(0);
  }
  // The first line is `<prompt><echoed command>` on the same row.
  let needle = command.trim();
  if !needle.is_empty() && lines.first().map_or(false, |l| l.trim_end().ends_with(needle)) {
    lines.remove(0);
  }
  while lines.last().map_or(false, |l| l.trim().is_empty()) {
    lines.pop();
  }
  if ended_without_newline && lines.last().map_or(false, |l| looks_like_prompt(l)) {
    lines.pop();
  }
  while lines.last().map_or(false, |l| l.trim().is_empty()) {
    lines.pop();
  }
  lines.join("\n")
}

/// Emit an `ai-term-mark` event so the frontend can colorize the AI-issued
/// command line (from `begin`) and its output (until `end`) on the live
/// terminal, and drive the execution-status badge (running → done/error).
/// `begin` is emitted *before* the command is typed so the frontend enters
/// command-highlight mode before the echo arrives over the PTY. `error` is
/// emitted when the command is rejected before/without typing (empty,
/// multi-line, already-running, or typing failure) — `elapsed_ms` is 0 and
/// `error` carries the message for the red badge.
fn emit_ai_term_mark(
  app: &tauri::AppHandle,
  tab_id: u32,
  kind: LiveShell,
  command: &str,
  mark: &str,
  seq: u64,
  timed_out: bool,
  truncated: bool,
  elapsed_ms: u64,
  error: Option<&str>,
) {
  let _ = app.emit(
    "ai-term-mark",
    serde_json::json!({
      "tabId": tab_id,
      "kind": match kind {
        LiveShell::Ssh => "ssh",
        LiveShell::Local => "local",
        LiveShell::Telnet => "telnet",
      },
      "command": command,
      "mark": mark,
      "seq": seq,
      "timedOut": timed_out,
      "truncated": truncated,
      "elapsedMs": elapsed_ms,
      "error": error,
    }),
  );
  eprintln!(
    "[ai-term-mark] tab={} kind={:?} mark={} seq={} err={:?} cmd={}",
    tab_id, kind, mark, seq, error, command
  );
}

/// Run `command` by typing it into the tab's live interactive shell and
/// capturing what the shell prints back.
///
/// The user sees the command and its output on screen in real time, it lands in
/// the session recording, and it inherits the shell's cwd / env / sudo state.
/// The trade-off is that a PTY exposes no exit code and no end-of-command
/// signal — completion is detected with a quiet-period heuristic.
async fn run_command_on_terminal(
  app: &tauri::AppHandle,
  state: &AppState,
  tab_id: u32,
  command: &str,
  kind: LiveShell,
) -> Result<String, String> {
  let cmd = command.trim_end_matches(['\r', '\n']).to_string();
  if cmd.trim().is_empty() {
    emit_ai_term_mark(app, tab_id, kind, command, "error", 0, false, false, 0, Some("Empty command"));
    return Err("Empty command".into());
  }
  // A multi-line command would be executed line by line by the shell and the
  // quiet heuristic cannot tell the pieces apart — reject it explicitly rather
  // than half-running it.
  if cmd.contains('\n') || cmd.contains('\r') {
    emit_ai_term_mark(app, tab_id, kind, &cmd, "error", 0, false, false, 0, Some("Multi-line commands cannot be typed into an interactive shell"));
    return Err("Multi-line commands cannot be typed into an interactive shell".into());
  }

  if !ai_capture_start(state, tab_id, kind) {
    emit_ai_term_mark(app, tab_id, kind, &cmd, "error", 0, false, false, 0, Some("Another AI command is already running on this terminal"));
    return Err("Another AI command is already running on this terminal".into());
  }

  // Allocate a per-tab monotonic sequence so the frontend can pair begin/end
  // and ignore stale events from a previous command.
  let seq = state.next_ai_term_seq.fetch_add(1, Ordering::SeqCst);

  // Signal the start *before* typing so the echo is already being colorized by
  // the time it lands in the output buffer.
  emit_ai_term_mark(app, tab_id, kind, &cmd, "begin", seq, false, false, 0, None);

  // Visual cue that the next echoed line came from the assistant. Written
  // WITHOUT a newline on purpose: the prompt is already drawn and the cursor
  // parked after it, so this only shifts the column. Injecting extra *rows*
  // desyncs ConPTY / readline repaints, which address the screen with absolute
  // cursor positioning.
  match kind {
    // Telnet output lands in `output_buffers` too, so it shares the SSH arm.
    LiveShell::Ssh | LiveShell::Telnet => {
      if let Ok(mut buffers) = state.output_buffers.lock() {
        buffers
          .entry(tab_id)
          .or_default()
          .push("\x1b[2m[AI]\x1b[0m ".to_string());
      }
    }
    LiveShell::Local => {
      // Same marker for local shells, pushed into the per-shell output queue
      // (the frontend drains it via poll_output and writes it to xterm, exactly
      // like the SSH buffer). Character-echoing shells (cmd) keep it on screen;
      // prompt-rewriting ones (PowerShell/PSReadLine) may repaint over it, in
      // which case the running/status badge still identifies the AI command.
      if let Ok(shells) = state.local_shells.lock() {
        if let Some(sh) = shells.get(&tab_id) {
          if let Ok(mut out) = sh.output.lock() {
            out.push("\x1b[2m[AI]\x1b[0m ".to_string());
          }
        }
      }
    }
  }

  if let Err(e) = type_into_shell(state, tab_id, kind, &format!("{}\r", cmd)) {
    let _ = ai_capture_finish(state, tab_id, kind);
    // Typing failed (e.g. shell vanished) — tell the frontend to reset so it
    // does not stay stuck in command-highlight mode, and show the error badge.
    emit_ai_term_mark(app, tab_id, kind, &cmd, "error", seq, false, false, 0, Some(&e));
    return Err(e);
  }
  record_ai_command(state, tab_id, &cmd);

  let start = std::time::Instant::now();
  let mut last_len = 0usize;
  let mut last_change = std::time::Instant::now();
  let mut timed_out = false;
  loop {
    tokio::time::sleep(std::time::Duration::from_millis(AI_TERM_POLL_MS)).await;
    let len = ai_capture_len(state, tab_id, kind);
    if len != last_len {
      last_len = len;
      last_change = std::time::Instant::now();
    }
    if last_len > 0 && last_change.elapsed().as_millis() >= AI_TERM_QUIET_MS {
      break;
    }
    if last_len == 0 && start.elapsed().as_millis() >= AI_TERM_FIRST_BYTE_MS {
      break;
    }
    if start.elapsed().as_millis() >= AI_TERM_MAX_MS {
      timed_out = true;
      break;
    }
  }

  let raw = ai_capture_finish(state, tab_id, kind);
  let ended_without_newline = !raw.trim_end_matches([' ', '\t']).ends_with('\n');
  let mut output = trim_echo_and_prompt(&normalize_pty_text(&raw), &cmd, ended_without_newline);

  let truncated = output.len() > AI_TERM_MAX_OUTPUT;
  if truncated {
    // Keep the tail: errors and summaries live at the end of most output.
    let cut = output.len() - AI_TERM_MAX_OUTPUT;
    let cut = output
      .char_indices()
      .map(|(i, _)| i)
      .find(|i| *i >= cut)
      .unwrap_or(0);
    output = format!("...[truncated]...\n{}", &output[cut..]);
  }

  // Signal the end so the frontend restores default colors and shows the
  // "done" badge. `timed_out` and `truncated` ride along for the frontend
  // (e.g. the AI chat result note).
  emit_ai_term_mark(
    app,
    tab_id,
    kind,
    &cmd,
    "end",
    seq,
    timed_out,
    truncated,
    start.elapsed().as_millis() as u64,
    None,
  );

  eprintln!(
    "[run_command_on_terminal] tab={} kind={:?} bytes={} timed_out={} cmd={}",
    tab_id,
    kind,
    raw.len(),
    timed_out,
    cmd
  );

  let mut note = String::from(
    "Executed in the user's live terminal (visible on screen and recorded). \
     Output was captured from the terminal stream, so there is no exit code \
     and the shell prompt/echo has been stripped heuristically.",
  );
  if timed_out {
    note.push_str(" WARNING: the command was still producing output when the capture window closed; the result is incomplete and the command may still be running.");
  }

  Ok(
    serde_json::json!({
      "ranOnTerminal": true,
      "tabId": tab_id,
      "shell": match kind {
        LiveShell::Ssh => "ssh",
        LiveShell::Local => "local",
        LiveShell::Telnet => "telnet",
      },
      "command": cmd,
      "output": output,
      "truncated": truncated,
      "timedOut": timed_out,
      "note": note,
    })
    .to_string(),
  )
}

#[cfg(test)]
mod ai_terminal_tests {
  use super::*;

  #[test]
  fn strips_csi_and_osc_sequences() {
    assert_eq!(strip_ansi("\x1b[32mgreen\x1b[0m"), "green");
    assert_eq!(strip_ansi("\x1b]0;window title\x07text"), "text");
    assert_eq!(strip_ansi("\x1b]0;title\x1b\\text"), "text");
    assert_eq!(strip_ansi("a\x1b[1;31mb\x1b[Kc"), "abc");
    assert_eq!(strip_ansi("plain"), "plain");
  }

  #[test]
  fn normalizes_carriage_returns_and_backspaces() {
    // A progress bar repaints the same row; only the final paint survives.
    assert_eq!(normalize_pty_text("10%\r55%\r100%\r\n"), "100%");
    assert_eq!(normalize_pty_text("abcX\x08\r\n"), "abc");
    assert_eq!(normalize_pty_text("one\r\ntwo\r\n\r\n\r\n"), "one\ntwo");
  }

  #[test]
  fn drops_command_echo_and_trailing_prompt() {
    let raw = "user@host:~$ ls -l\r\ntotal 0\r\n-rw-r--r-- 1 u u 0 a.txt\r\nuser@host:~$ ";
    let text = normalize_pty_text(raw);
    assert_eq!(
      trim_echo_and_prompt(&text, "ls -l", true),
      "total 0\n-rw-r--r-- 1 u u 0 a.txt"
    );
  }

  #[test]
  fn drops_cmd_exe_prompt() {
    let raw = "C:\\Users\\me>echo hi\r\nhi\r\n\r\nC:\\Users\\me>";
    let text = normalize_pty_text(raw);
    assert_eq!(trim_echo_and_prompt(&text, "echo hi", true), "hi");
  }

  #[test]
  fn keeps_output_line_that_merely_looks_like_a_prompt() {
    // The stream ended with a newline, so the last line is real output, not a
    // freshly drawn prompt — it must survive.
    let text = normalize_pty_text("$ grep -c x f\r\ncount#\r\n");
    assert_eq!(trim_echo_and_prompt(&text, "grep -c x f", false), "count#");
  }

  #[test]
  fn handles_command_producing_no_output() {
    let text = normalize_pty_text("user@host:~$ touch a\r\nuser@host:~$ ");
    assert_eq!(trim_echo_and_prompt(&text, "touch a", true), "");
  }
}

/// Dangerous command substrings rejected outright when executed through tools.
fn is_dangerous_command(cmd: &str) -> bool {
  let lower = cmd.to_lowercase();
  const DANGEROUS: &[&str] = &[
    "rm -rf /",
    "mkfs",
    "dd if=",
    ":(){",
    "shutdown",
    "reboot",
    "init 0",
    "init 6",
    "> /dev/sda",
    "chmod -r 000",
  ];
  DANGEROUS.iter().any(|d| lower.contains(d))
}

/// Returns true when the command is a read-only / inspection command that is
/// safe to run in AI read-only mode. Used to hard-block modifying commands when
/// the assistant is started in read-only mode (`read_only == true`).
fn is_readonly_safe_command(cmd: &str) -> bool {
  let c = cmd.trim();
  // File-write redirections are never allowed in read-only mode.
  if c.contains(">>") || c.contains(" > ") {
    return false;
  }
  // Subcommands that may modify the system even though their base name is
  // otherwise harmless.
  const SVC_MODIFY: &[&str] = &[
    "start",
    "stop",
    "restart",
    "reload",
    "try-restart",
    "reload-or-restart",
    "isolate",
    "mask",
    "unmask",
    "enable",
    "disable",
    "reenable",
    "daemon-reexec",
    "daemon-reload",
    "default",
    "rescue",
    "halt",
    "poweroff",
    "reboot",
    "suspend",
    "hibernate",
  ];
  const PKG_MODIFY: &[&str] = &[
    "install",
    "remove",
    "purge",
    "erase",
    "upgrade",
    "update",
    "dist-upgrade",
    "full-upgrade",
    "autoremove",
    "clean",
    "autoclean",
    "reinstall",
    "downgrade",
    "add",
    "del",
    "build-dep",
    "mark",
    "reconfigure",
    "trigger",
    "--reinstall",
    "-f",
    "--fix-broken",
    "-y",
    "--assume-yes",
    "-R",
    "--resolvconf",
  ];
  const GIT_MODIFY: &[&str] = &[
    "commit",
    "push",
    "checkout",
    "reset",
    "rm",
    "mv",
    "add",
    "clone",
    "merge",
    "rebase",
    "cherry-pick",
    "revert",
    "clean",
    "tag",
    "branch",
    "stash",
    "am",
    "apply",
    "init",
    "pull",
  ];
  const DL_WRITE: &[&str] = &[
    "-o",
    "--output",
    "-O",
    "--remote-name",
    "-P",
    "--directory-prefix",
  ];

  for part in c.split(|ch| ch == ';' || ch == '&' || ch == '|' || ch == '\n') {
    let p = part
      .trim()
      .trim_start_matches(|ch| ch == '(' || ch == '{' || ch == '`' || ch == '\'' || ch == '"')
      .trim();
    if p.is_empty() || p.starts_with('#') {
      continue;
    }
    let tokens: Vec<&str> = p.split_whitespace().collect();
    if tokens.is_empty() {
      continue;
    }
    // Strip common command-prefix wrappers (sudo, env, time, ...).
    let mut idx = 0;
    while idx < tokens.len()
      && matches!(
        tokens[idx],
        "sudo" | "doas" | "env" | "time" | "nohup" | "nice" | "stdbuf" | "ionice" | "setsid"
      )
    {
      idx += 1;
    }
    if idx >= tokens.len() {
      return false;
    }
    let cmd_name = tokens[idx];

    // Command-specific subcommand guards.
    if cmd_name == "sed" && tokens[idx + 1..].iter().any(|t| t.starts_with("-i")) {
      return false; // in-place edit
    }
    if cmd_name == "find"
      && tokens[idx + 1..].iter().any(|t| {
        *t == "-delete" || *t == "-exec" || *t == "-execdir" || *t == "-ok" || *t == "-okdir"
      })
    {
      return false;
    }
    if matches!(cmd_name, "systemctl" | "service")
      && tokens[idx + 1..].iter().any(|t| SVC_MODIFY.contains(t))
    {
      return false;
    }
    if matches!(
      cmd_name,
      "apt"
        | "apt-get"
        | "apt-cache"
        | "dpkg"
        | "dpkg-query"
        | "rpm"
        | "yum"
        | "dnf"
        | "dnf4"
        | "pacman"
        | "microdnf"
        | "zypper"
        | "apk"
    ) && tokens[idx + 1..]
      .iter()
      .any(|t| PKG_MODIFY.contains(&t.trim_start_matches('-')))
    {
      return false;
    }
    if cmd_name == "git" && tokens[idx + 1..].iter().any(|t| GIT_MODIFY.contains(t)) {
      return false;
    }
    if matches!(cmd_name, "curl" | "wget") && tokens[idx + 1..].iter().any(|t| DL_WRITE.contains(t))
    {
      return false; // downloading to a file writes to disk
    }

    if !is_readonly_command_name(cmd_name) {
      return false;
    }
  }
  true
}

/// Conservative allowlist of command names that are read-only / inspection only.
fn is_readonly_command_name(name: &str) -> bool {
  const READONLY: &[&str] = &[
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "grep",
    "egrep",
    "fgrep",
    "pgrep",
    "rg",
    "ag",
    "awk",
    "sed",
    "cut",
    "sort",
    "uniq",
    "wc",
    "tr",
    "nl",
    "od",
    "xxd",
    "hexdump",
    "strings",
    "base64",
    "sha256sum",
    "sha1sum",
    "md5sum",
    "sum",
    "cksum",
    "column",
    "expand",
    "unexpand",
    "ls",
    "ll",
    "pwd",
    "echo",
    "printf",
    "printenv",
    "env",
    "type",
    "which",
    "whereis",
    "command",
    "whoami",
    "id",
    "who",
    "w",
    "users",
    "last",
    "lastlog",
    "uptime",
    "date",
    "cal",
    "finger",
    "logname",
    "tty",
    "groups",
    "ps",
    "top",
    "htop",
    "free",
    "vmstat",
    "iostat",
    "mpstat",
    "sar",
    "df",
    "du",
    "find",
    "locate",
    "namei",
    "lsattr",
    "getfacl",
    "getfattr",
    "ifconfig",
    "ip",
    "ss",
    "netstat",
    "arp",
    "route",
    "ping",
    "ping6",
    "traceroute",
    "mtr",
    "dig",
    "nslookup",
    "host",
    "curl",
    "wget",
    "uname",
    "hostname",
    "lscpu",
    "lsblk",
    "lsusb",
    "lspci",
    "lsmod",
    "modinfo",
    "lsof",
    "fuser",
    "git",
    "systemctl",
    "service",
    "journalctl",
    "timedatectl",
    "localectl",
    "loginctl",
    "crontab",
    "getent",
    "sestatus",
    "getenforce",
    "apparmor_status",
    "apropos",
    "man",
    "whatis",
    "info",
    "history",
    "alias",
    "dpkg-query",
    "apt-cache",
    "apt",
    "apt-get",
    "rpm",
    "yum",
    "dnf",
    "dnf4",
    "pacman",
    "microdnf",
    "zypper",
    "apk",
  ];
  READONLY.contains(&name)
}

/// Dangerous command substrings rejected outright when executed through tools.

/// Execute a batch of tool calls (one agent round) using `AppState`.
/// Returns `(tool_call_id, result_json)` pairs. Each result is a JSON string
/// so the model can parse it; errors are embedded as `{"error": "..."}`.
pub(crate) async fn execute_ai_tools(
  app: &tauri::AppHandle,
  calls: Vec<crate::ai::OpenAiToolCall>,
  current_tab_id: Option<u32>,
  read_only: bool,
) -> Vec<crate::ai::ToolResult> {
  let state = app.state::<AppState>();
  let mut results: Vec<crate::ai::ToolResult> = Vec::new();

  for call in calls {
    let result = execute_one_tool(app, &state, &call, current_tab_id, false, read_only)
      .await
      .unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string());
    results.push((call.id, result));
  }
  results
}

/// Build a human-readable context block describing the shell tab's connected
/// server (or note that it is not connected). Used to enrich the system prompt.
pub(crate) fn build_current_server_context(app: &tauri::AppHandle, tab_id: u32) -> Option<String> {
  let state = app.state::<AppState>();
  // Local shell tab: describe it as a local machine shell (no SSH server).
  if let Ok(shells) = state.local_shells.lock() {
    if let Some(sh) = shells.get(&tab_id) {
      let cwd = sh.cwd.clone().unwrap_or_else(|| ".".to_string());
      let block = format!(
                "[Current Shell Context]\n\
                 This conversation is bound to LOCAL shell tab {tab_id} (a local terminal on this machine).\n\
                 Working directory: {cwd}\n\
                 Shell type: local (cmd/powershell/bash/wsl/git-bash)\n\
                 Note: commands you run here execute on the user's local machine, not a remote server.",
                tab_id = tab_id,
                cwd = cwd,
            );
      return Some(block);
    }
  }
  let sessions = state.sessions.lock().ok()?;
  let sess = sessions.get(&tab_id)?;
  let cfg = &sess.config;
  let status = if sess.data_tx.is_some() {
    "connected"
  } else {
    "disconnected"
  };
  let block = format!(
    "[Current Server Context]\n\
         This conversation is bound to shell tab {tab_id} (connection \"{name}\").\n\
         Host: {host}:{port}\n\
         Username: {username}\n\
         Status: {status}\n\
         Connection id: {cid}",
    tab_id = tab_id,
    name = cfg.name,
    host = cfg.host,
    port = cfg.port,
    username = cfg.username,
    status = status,
    cid = cfg.id,
  );
  Some(block)
}

/// Run a shell command on the LOCAL machine (for local-shell AI tabs).
/// Spawns the OS shell, captures combined stdout+stderr, and returns it as a
/// JSON string the AI agent can read. `cwd` is the local shell's working dir.
async fn run_local_command(command: String, cwd: Option<String>) -> Result<String, String> {
  let output = tokio::task::spawn_blocking(move || {
    #[cfg(windows)]
    let mut child = {
      let mut cmd = StdCommand::new("cmd.exe");
      cmd.args(["/c", &command]);
      cmd
    };
    #[cfg(not(windows))]
    let mut child = {
      let mut cmd = StdCommand::new("/bin/sh");
      cmd.args(["-c", &command]);
      cmd
    };
    if let Some(dir) = cwd.as_deref() {
      child.current_dir(dir);
    }
    child.stdout(std::process::Stdio::piped());
    child.stderr(std::process::Stdio::piped());
    child.output()
  })
  .await
  .map_err(|e| format!("Failed to spawn local command: {}", e))?
  .map_err(|e| format!("Failed to run local command: {}", e))?;

  let mut combined = String::new();
  combined.push_str(&String::from_utf8_lossy(&output.stdout));
  let stderr = String::from_utf8_lossy(&output.stderr);
  if !stderr.trim().is_empty() {
    if !combined.is_empty() && !combined.ends_with('\n') {
      combined.push('\n');
    }
    combined.push_str(&stderr);
  }
  // Truncate very large outputs to avoid blowing up the AI context.
  if combined.len() > 64 * 1024 {
    combined.truncate(64 * 1024);
    combined.push_str("\n... (output truncated to 64KB)");
  }
  let exit = output.status.code().unwrap_or(-1);
  Ok(
    serde_json::json!({
        "exitCode": exit,
        "output": combined,
    })
    .to_string(),
  )
}

pub(crate) async fn execute_one_tool(
  app: &tauri::AppHandle,
  state: &tauri::State<'_, AppState>,
  call: &crate::ai::OpenAiToolCall,
  current_tab_id: Option<u32>,
  force: bool,
  read_only: bool,
) -> Result<String, String> {
  let args: serde_json::Value =
    serde_json::from_str(&call.arguments).unwrap_or(serde_json::Value::Null);
  let tool = call.name.as_str();

  let outcome: Result<String, String> = match tool {
    "run_command" => {
      // The model is told "pass 0 to run on the local machine", which would
      // bypass the terminal entirely. When this conversation is bound to a
      // shell tab we prefer typing into that terminal (so the user sees it and
      // the AI-status badge shows): fall back to the bound tab whenever the
      // model's tabId is missing / 0 / not attached to any live shell.
      let args_tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
      let tab_id = match args_tab_id {
        Some(t) if live_shell_kind(state, t).is_some() => t,
        _ => current_tab_id
          .filter(|t| live_shell_kind(state, *t).is_some())
          .unwrap_or(args_tab_id.unwrap_or(0)),
      };
      let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'command'")?
        .to_string();
      // Read-only mode: hard-block any command that is not a read-only /
      // inspection command. This is independent of `force` (confirmation) —
      // in read-only mode modifying commands may never run, even if the user
      // would otherwise approve a sensitive one.
      if read_only && !is_readonly_safe_command(&command) {
        return Ok(
          serde_json::json!({
              "error": "Blocked: the AI assistant is in read-only mode and may only run \
                        read-only / inspection commands. Disable read-only mode to run \
                        modifying commands."
          })
          .to_string(),
        );
      }
      // Sensitive / destructive commands are NOT silently blocked. Instead
      // we return a needs-confirmation marker so the agent loop pauses and
      // the frontend can ask the user whether to proceed. `force` is set by
      // `confirm_ai_tool` once the user has approved execution.
      if is_dangerous_command(&command) && !force {
        return Ok(
          serde_json::json!({ "needsConfirmation": true, "command": command }).to_string(),
        );
      }
      // Preferred path: type the command into the tab's live terminal so the
      // user sees it happen, it lands in the session recording, and it shares
      // the shell's cwd / env / sudo state. Falls back to the silent exec path
      // below when the tab has no live shell or the feature is disabled.
      if ai_run_in_terminal_enabled(state) {
        if let Some(kind) = live_shell_kind(state, tab_id) {
          match run_command_on_terminal(app, state, tab_id, &command, kind).await {
            Ok(out) => return Ok(out),
            Err(e) => {
              // Never fail the tool call on a typing/capture problem — degrade
              // to the silent exec path so the agent can still make progress.
              eprintln!(
                "[run_command] terminal execution failed for tab {tab_id} ({e}); \
                 falling back to silent execution"
              );
            }
          }
        }
      }
      // Local shell tab: run the command on the local machine.
      let local_cwd = {
        match state.local_shells.lock() {
          Ok(g) => g.get(&tab_id).map(|sh| sh.cwd.clone()).unwrap_or(None),
          Err(_) => None,
        }
      };
      if local_cwd.is_some() {
        let output = run_local_command(command, local_cwd).await?;
        return Ok(output);
      }
      // Remote shell: execute via the SSH jump handle.
      match crate::remote_fs::get_jump_handle(state, tab_id) {
        Ok(handle) => {
          let output = crate::host_analysis::exec_on_handle(&*handle, &command).await?;
          Ok(output)
        }
        // The tab isn't bound to any shell (e.g. a standalone AI tab):
        // fall back to running the command on the LOCAL machine so the
        // agent is still useful without an SSH connection.
        Err(e) => {
          eprintln!(
            "[run_command] no remote handle for tab {tab_id} ({}); falling back to LOCAL execution",
            e
          );
          let mut output = run_local_command(command, None).await?;
          // Wrap so the model knows the result came from the local machine.
          let v: serde_json::Value =
            serde_json::from_str(&output).unwrap_or(serde_json::json!({ "output": output }));
          let note = "NOTE: this command ran on the USER'S LOCAL MACHINE (no remote shell was attached to this tab).";
          output = serde_json::json!({ "ranOnLocal": true, "note": note, "exitCode": v["exitCode"].as_i64().unwrap_or(-1), "output": v["output"].as_str().unwrap_or("") }).to_string();
          Ok(output)
        }
      }
    }
    "analyze_server" => {
      let tab_id = args
        .get("tabId")
        .and_then(|v| v.as_u64())
        .ok_or("Missing 'tabId'")? as u32;
      let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
      let analysis = crate::host_analysis::analyze_host(&*handle, tab_id).await?;
      Ok(serde_json::to_string(&analysis).map_err(|e| e.to_string())?)
    }
    "list_directory" => {
      let tab_id = args
        .get("tabId")
        .and_then(|v| v.as_u64())
        .ok_or("Missing 'tabId'")? as u32;
      let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path'")?
        .to_string();
      let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
      let output = crate::host_analysis::exec_on_handle(
        &*handle,
        &format!("ls -la --time-style=long-iso {}", shell_quote_arg(&path)),
      )
      .await?;
      Ok(output)
    }
    "read_file" => {
      let tab_id = args
        .get("tabId")
        .and_then(|v| v.as_u64())
        .ok_or("Missing 'tabId'")? as u32;
      let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path'")?
        .to_string();
      let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
      let output = crate::host_analysis::exec_on_handle(
        &*handle,
        // Truncate to 64KB to avoid huge payloads
        &format!("head -c 65536 {}", shell_quote_arg(&path)),
      )
      .await?;
      Ok(output)
    }
    "list_connections" => {
      let connections = state.connections.lock().map_err(|e| e.to_string())?;
      let slim: Vec<serde_json::Value> = connections
        .iter()
        .map(|c| {
          serde_json::json!({
              "id": c.id,
              "name": c.name,
              "host": c.host,
              "port": c.port,
              "username": c.username,
              "group": c.group,
          })
        })
        .collect();
      Ok(serde_json::to_string(&slim).map_err(|e| e.to_string())?)
    }
    "search_help" => {
      let tab_id = args
        .get("tabId")
        .and_then(|v| v.as_u64())
        .ok_or("Missing 'tabId'")? as u32;
      let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'command'")?
        .to_string();
      let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
      let help = crate::host_analysis::command_help(&*handle, &command).await?;
      Ok(help)
    }
    "get_current_server" => {
      // Returns info about the server this conversation is bound to, without
      // needing the model to supply a tabId.
      let tab_id = current_tab_id.ok_or(
        "No shell tab is bound to this AI conversation. Open the AI chat from a shell tab first.",
      )?;
      // Local shell tab: report it as a local machine shell.
      {
        let shells = state.local_shells.lock().map_err(|e| e.to_string())?;
        if let Some(sh) = shells.get(&tab_id) {
          let info = serde_json::json!({
              "tabId": tab_id,
              "type": "local",
              "workingDirectory": sh.cwd.clone().unwrap_or_else(|| ".".to_string()),
              "status": "connected",
          });
          return Ok(serde_json::to_string(&info).map_err(|e| e.to_string())?);
        }
      }
      let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
      match sessions.get(&tab_id) {
        Some(sess) => {
          let cfg = &sess.config;
          let info = serde_json::json!({
              "tabId": tab_id,
              "connectionId": cfg.id,
              "connectionName": cfg.name,
              "host": cfg.host,
              "port": cfg.port,
              "username": cfg.username,
              "status": if sess.data_tx.is_some() { "connected" } else { "disconnected" },
          });
          Ok(serde_json::to_string(&info).map_err(|e| e.to_string())?)
        }
        // No shell is bound to this tab (standalone AI tab, or the SSH
        // session is gone). Report a LOCAL context instead of erroring
        // so the agent knows it should run commands on the local machine.
        None => {
          let info = serde_json::json!({
              "tabId": tab_id,
              "type": "local",
              "host": "localhost",
              "status": "connected",
              "note": "This tab is not bound to any remote server; commands will run on the USER'S LOCAL MACHINE.",
          });
          Ok(serde_json::to_string(&info).map_err(|e| e.to_string())?)
        }
      }
    }
    other => Err(format!("Unknown tool: {}", other)),
  };

  match outcome {
    Ok(text) => {
      let truncated = if text.chars().count() > 16000 {
        let mut s: String = text.chars().take(16000).collect();
        s.push_str("\n... [truncated]");
        s
      } else {
        text
      };
      Ok(serde_json::json!({ "output": truncated }).to_string())
    }
    Err(e) => Ok(serde_json::json!({ "error": e }).to_string()),
  }
}
