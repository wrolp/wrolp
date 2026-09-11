use super::*;
// ==================== Local Shell (Local Terminal) ====================

/// Pick the default local shell command for the current platform.
fn default_local_shell() -> (String, Vec<String>) {
  if cfg!(windows) {
    // Default to cmd.exe on Windows
    ("cmd.exe".to_string(), vec![])
  } else {
    let s = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
    (s, vec![])
  }
}

/// True when the shell spec is the WSL launcher (preset `wsl`, or a path to
/// `wsl.exe`). Mirrors the frontend's `isWslShell`.
fn is_wsl_spec(spec: &str) -> bool {
  let s = spec.trim().to_ascii_lowercase();
  s == "wsl"
    || s.ends_with("/wsl")
    || s.ends_with("\\wsl")
    || s.ends_with("/wsl.exe")
    || s.ends_with("\\wsl.exe")
}

/// Resolve a shell specifier (preset name or arbitrary command/path) into a
/// (command, args) pair suitable for portable_pty's CommandBuilder.
///
/// Returns an error when a named shell cannot be located. We deliberately do
/// NOT fall back to a bare `bash` when Git Bash is missing: on Windows, `bash`
/// on PATH usually resolves to `C:\Windows\System32\bash.exe`, which is the WSL
/// launcher — silently spawning that would open WSL instead of failing loudly.
fn resolve_local_shell(
  spec: &str,
  distro: Option<&str>,
  cwd: Option<&str>,
) -> Result<(String, Vec<String>), String> {
  match spec {
    // Git Bash: locate the executable on the common install paths, then fall
    // back to Git for Windows' registered install path (covers installs in
    // custom directories, e.g. `D:\program\Git`).
    "gitbash" => {
      let mut candidates: Vec<std::path::PathBuf> = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
      ]
      .iter()
      .map(std::path::PathBuf::from)
      .collect();
      if let Some(dir) = git_for_windows_install_dir() {
        candidates.push(std::path::PathBuf::from(&dir).join("bin").join("bash.exe"));
        candidates
          .push(std::path::PathBuf::from(dir).join("usr").join("bin").join("bash.exe"));
      }
      for c in &candidates {
        if c.exists() {
          return Ok((c.to_string_lossy().into_owned(), vec!["--login".to_string()]));
        }
      }
      Err(
        "Git Bash not found. Install Git for Windows to the default location, or enter the full \
         path to bash.exe in the shell field (e.g. D:\\program\\Git\\bin\\bash.exe)."
          .to_string(),
      )
    }
    // WSL: `wsl.exe` has no `--login` flag (that's a bash option). Run bash as
    // a login+interactive shell inside the distro instead. A named distro is
    // selected with `-d` (empty = the system default distro) and the start
    // directory with `--cd` (a Linux path — the Windows process cwd is NOT
    // applied to WSL entries, see `open_local_shell`).
    "wsl" => {
      let mut args: Vec<String> = Vec::new();
      if let Some(d) = distro.map(str::trim).filter(|d| !d.is_empty()) {
        args.push("-d".to_string());
        args.push(d.to_string());
      }
      if let Some(c) = cwd.map(str::trim).filter(|c| !c.is_empty()) {
        args.push("--cd".to_string());
        args.push(c.to_string());
      }
      args.push("bash".to_string());
      args.push("-li".to_string());
      Ok(("wsl.exe".to_string(), args))
    }
    // Anything else (cmd, pwsh, powershell, bash, or an explicit path) is used as-is.
    other => Ok((other.to_string(), vec![])),
  }
}

/// Look up Git for Windows' registered install root (e.g. `D:\program\Git`).
///
/// The installer always writes `InstallPath` under `HKLM\SOFTWARE\GitForWindows`
/// (per-user installs under `HKCU`, and 32-bit Git on 64-bit Windows under the
/// corresponding `WOW6432Node` views). Reading it finds Git installed to
/// arbitrary directories the well-known paths miss.
fn git_for_windows_install_dir() -> Option<String> {
  #[cfg(windows)]
  {
    use std::process::Command;
    let roots = [
      r"HKLM\SOFTWARE\GitForWindows",
      r"HKCU\SOFTWARE\GitForWindows",
      r"HKLM\SOFTWARE\WOW6432Node\GitForWindows",
      r"HKCU\SOFTWARE\WOW6432Node\GitForWindows",
    ];
    for root in roots {
      // Absent keys are expected on many machines — skip and try the next root.
      let Ok(out) = Command::new("reg")
        .arg("query")
        .arg(root)
        .arg("/v")
        .arg("InstallPath")
        .output()
      else {
        continue;
      };
      if !out.status.success() {
        continue;
      }
      let text = String::from_utf8_lossy(&out.stdout);
      for line in text.lines() {
        if let Some(value) = reg_install_path_from_line(line) {
          return Some(value);
        }
      }
    }
    None
  }
  #[cfg(not(windows))]
  {
    None
  }
}

/// Extract the install path from a single `reg query` output line such as
///
/// ```text
///     InstallPath    REG_SZ    D:\program\Git
/// ```
///
/// `reg` pads fields with whitespace, so the path — which may itself contain
/// spaces — is taken as everything after the value-type token (`REG_SZ` /
/// `REG_EXPAND_SZ`).
fn reg_install_path_from_line(line: &str) -> Option<String> {
  if !line.contains("InstallPath") {
    return None;
  }
  let after_type = line.split("REG_").nth(1)?;
  let value = after_type.splitn(2, char::is_whitespace).nth(1)?.trim();
  if value.is_empty() {
    None
  } else {
    Some(value.to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_reg_install_path_line() {
    // Standard output shape (fields padded with whitespace).
    assert_eq!(
      reg_install_path_from_line("    InstallPath    REG_SZ    D:\\program\\Git"),
      Some("D:\\program\\Git".to_string())
    );
    // Paths containing spaces survive (everything after the type token is kept).
    assert_eq!(
      reg_install_path_from_line("    InstallPath    REG_SZ    C:\\Program Files\\Git"),
      Some("C:\\Program Files\\Git".to_string())
    );
    // CRLF from reg.exe on Windows is trimmed too.
    assert_eq!(
      reg_install_path_from_line("    InstallPath    REG_EXPAND_SZ    D:\\Git\r"),
      Some("D:\\Git".to_string())
    );
  }

  #[test]
  fn ignores_unrelated_reg_lines() {
    assert_eq!(reg_install_path_from_line("HKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows"), None);
    assert_eq!(reg_install_path_from_line("ERROR: The system was unable to find"), None);
    assert_eq!(reg_install_path_from_line("    SomethingElse    REG_SZ    x"), None);
  }

  #[test]
  fn wsl_shell_args_carry_distro_and_start_dir() {
    let (cmd, args) = resolve_local_shell("wsl", Some("Ubuntu-22.04"), Some("/home/u")).unwrap();
    assert_eq!(cmd, "wsl.exe");
    assert_eq!(
      args,
      vec!["-d", "Ubuntu-22.04", "--cd", "/home/u", "bash", "-li"]
    );
  }

  #[test]
  fn wsl_shell_args_default_when_blank() {
    let (cmd, args) = resolve_local_shell("wsl", None, None).unwrap();
    assert_eq!(cmd, "wsl.exe");
    assert_eq!(args, vec!["bash", "-li"]);
    // A blank distro/start dir must not emit empty flags.
    let (_, args) = resolve_local_shell("wsl", Some("  "), Some("")).unwrap();
    assert_eq!(args, vec!["bash", "-li"]);
  }

  #[test]
  fn detects_wsl_specs() {
    assert!(is_wsl_spec("wsl"));
    assert!(is_wsl_spec("  WSL  "));
    assert!(is_wsl_spec(r"C:\Windows\System32\wsl.exe"));
    assert!(!is_wsl_spec("gitbash"));
    assert!(!is_wsl_spec("cmd"));
  }

  #[test]
  fn decodes_utf16le_with_bom() {
    let s = "Ubuntu-24.04\r\ndocker-desktop\r\n";
    let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
      bytes.extend_from_slice(&u.to_le_bytes());
    }
    assert_eq!(decode_wsl_output(&bytes), s);
  }

  #[test]
  fn decodes_utf16le_without_bom() {
    let mut bytes = Vec::new();
    for u in "Ubuntu-24.04\n".encode_utf16() {
      bytes.extend_from_slice(&u.to_le_bytes());
    }
    assert_eq!(decode_wsl_output(&bytes).trim(), "Ubuntu-24.04");
  }

  #[test]
  fn passes_utf8_through() {
    assert_eq!(decode_wsl_output(b"Ubuntu-24.04\n"), "Ubuntu-24.04\n");
    assert_eq!(decode_wsl_output(b""), "");
  }

  /// Real probe against the local machine's `wsl.exe`. Ignored by default so it
  /// never runs where WSL is absent: `cargo test --lib local_shell -- --ignored`.
  #[tokio::test]
  #[ignore = "requires a WSL installation"]
  async fn lists_real_wsl_distros() {
    let distros = list_wsl_distros().await.expect("list distros");
    eprintln!("wsl distros: {distros:?}");
    assert!(!distros.is_empty(), "expected at least one distro");
    assert!(distros
      .iter()
      .all(|d| !d.is_empty() && !d.contains('\u{feff}')));
  }
}

/// Open a local shell (PTY-backed local process) for the given tab.
#[tauri::command]
pub async fn open_local_shell(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  shell: Option<String>,
  distro: Option<String>,
  cwd: Option<String>,
  reuse_existing: bool,
  cols: u32,
  rows: u32,
) -> Result<(), String> {
  // Reuse path: if a live local shell already exists for this tab (e.g. the
  // terminal was floated and is now remounting), keep it — no process restart.
  if reuse_existing {
    let live = {
      let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
      if let Some(s) = shells.get_mut(&tab_id) {
        s.child.try_wait().map_or(false, |exited| exited.is_none())
      } else {
        false
      }
    };
    if live {
      eprintln!(
        "[open_local_shell] reusing live local shell for tab={}",
        tab_id
      );
      return Ok(());
    }
  }

  // Clear any stale output for this tab
  {
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers.remove(&tab_id);
    }
  }

  // Remove any existing local shell for this tab
  {
    let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
    shells.remove(&tab_id);
  }

  // An empty spec means "use the default shell" (e.g. the default Local-Terminal entry).
  let shell_spec = match shell {
    Some(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
    _ => None,
  };
  let shell_for_history = shell_spec.clone();

  // Per-tab output queue owned by this LocalShell. The reader thread holds an
  // `Arc` clone and writes here, so it never reaches back into the global
  // `AppState` (which behaves unreliably from a plain `std::thread`).
  //
  // IMPORTANT: do NOT push any banner/status text into this queue. ConPTY syncs
  // the screen with *absolute* cursor positioning (CUP) and assumes the
  // terminal's top-left corner is its own buffer origin. Any line we write
  // before the shell's own output shifts xterm down by that many rows while
  // ConPTY keeps addressing row 0 — which is exactly why typed input used to
  // land on the line *above* the prompt. Status goes to stderr instead.
  let output = Arc::new(StdMutex::new(Vec::<String>::new()));
  // Sink for AI-issued commands; `None` while no AI command is in flight.
  // Owned here (not in `AppState`) for the same reason as `output`.
  let ai_capture = Arc::new(StdMutex::new(None::<String>));

  // Create the PTY at the actual terminal size up front. If the size is left at
  // the default 80x24, the shell lays out its prompt/wrapping using the wrong
  // width and (on Windows ConPTY in particular) typed input ends up on the line
  // above the prompt. The frontend passes the real cols/rows from xterm's fit.
  let initial_cols = if cols == 0 { 80u16 } else { cols as u16 };
  let initial_rows = if rows == 0 { 24u16 } else { rows as u16 };

  // Offload everything that can block — shell resolution (the `gitbash` preset
  // may run `reg` to locate a custom Git install) and the Win32 ConPTY calls
  // (CreatePseudoConsole + CreateProcess) — to tokio's dedicated blocking
  // thread pool so they never tie up an async worker and stall other commands.
  let cwd_clone = cwd.clone();
  let (master, child) = tokio::task::spawn_blocking(
    move || -> Result<
      (
        Box<dyn portable_pty::MasterPty + Send>,
        Box<dyn portable_pty::Child + Send + Sync>,
      ),
      String,
    > {
      // Resolve the shell preset inside the blocking thread: for `gitbash` this
      // may query the registry when the well-known install paths are missing,
      // and an unresolved shell reports an error instead of silently launching
      // whatever `bash` resolves to on PATH (typically WSL's launcher on
      // Windows).
      let is_wsl = shell_spec.as_deref().map(is_wsl_spec).unwrap_or(false);
      let (shell_cmd, shell_args) = match shell_spec.as_deref() {
        Some(spec) => resolve_local_shell(spec, distro.as_deref(), cwd_clone.as_deref())?,
        None => default_local_shell(),
      };
      eprintln!(
        "[open_local_shell] starting '{}' (tab={})",
        shell_cmd, tab_id
      );

      let pty_system = portable_pty::native_pty_system();
      let pair = pty_system
        .openpty(portable_pty::PtySize {
          rows: initial_rows,
          cols: initial_cols,
          pixel_width: 0,
          pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

      let mut cmd = portable_pty::CommandBuilder::new(&shell_cmd);
      if !shell_args.is_empty() {
        cmd.args(&shell_args);
      }
      // An empty cwd means "use the default working directory". A WSL entry's
      // cwd is a *Linux* path (forwarded via `--cd` above), so it must not be
      // passed to CreateProcess as the Windows process cwd.
      if !is_wsl {
        if let Some(ref dir) = cwd_clone {
          if !dir.trim().is_empty() {
            cmd.cwd(dir);
          }
        }
      }
      cmd.env("TERM", "xterm-256color");

      let child = pair.slave.spawn_command(cmd).map_err(|e| {
        format!("Failed to spawn shell '{}': {}", shell_cmd, e)
      })?;

      // On some Windows builds ConPTY ignores the size passed to `openpty` and
      // only honors an explicit resize issued *after* the child is spawned.
      // Without this, cmd.exe lays out its prompt using the default 80x24 and
      // typed input then appears on the line above the prompt. Force the real
      // size now.
      let master = pair.master;
      eprintln!(
        "[open_local_shell] opening PTY for {} at {}x{}",
        shell_cmd, initial_cols, initial_rows
      );
      let _ = master.resize(portable_pty::PtySize {
        rows: initial_rows,
        cols: initial_cols,
        pixel_width: 0,
        pixel_height: 0,
      });
      eprintln!(
        "[open_local_shell] spawned '{}' ok (tab={})",
        shell_cmd, tab_id
      );
      Ok((master, child))
    },
  )
  .await
  .map_err(|e| format!("spawn_blocking join error: {}", e))??;

  let mut reader = master
    .try_clone_reader()
    .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

  let writer = master
    .take_writer()
    .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

  let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);

  // Register the shell so input/resize/close can find it
  {
    let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
    shells.insert(
      tab_id,
      LocalShell {
        tab_id,
        master,
        writer: Box::new(writer),
        child,
        session_id,
        cwd: cwd.clone(),
        output: output.clone(),
        ai_capture: ai_capture.clone(),
      },
    );
  }

  // Remember cwd in history (start of list, de-duplicated)
  {
    if let Some(ref dir) = cwd {
      if !dir.trim().is_empty() {
        record_local_shell_dir(&state, dir, shell_for_history.as_deref());
      }
    }
  }

  // Background reader thread: drain PTY output into this tab's own output queue.
  // We hold an `Arc` clone of `output`, so we never reach back into the global
  // `AppState` (which is unreliable from a plain `std::thread`). Each (re)open
  // creates a fresh `output` Arc, so a superseded thread simply writes to an
  // orphaned queue the frontend no longer reads from — no stale-data corruption.
  let reader_tab = tab_id;
  let reader_output = output.clone();
  let reader_ai_capture = ai_capture.clone();
  std::thread::spawn(move || {
    use std::io::Read;
    let mut buf = [0u8; 4096];
    loop {
      match reader.read(&mut buf) {
        Ok(0) => break, // EOF: process exited
        Ok(n) => {
          let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
          // Tee a copy to the AI sink first (the chunk is moved into the
          // frontend queue below). Only active while an AI command runs.
          if let Ok(mut cap) = reader_ai_capture.lock() {
            if let Some(sink) = cap.as_mut() {
              sink.push_str(&chunk);
            }
          }
          if let Ok(mut q) = reader_output.lock() {
            q.push(chunk);
          }
        }
        Err(_) => break,
      }
    }
    // Process exited — drop the shell registration and notify the frontend.
    if let Some(state) = app.try_state::<AppState>() {
      if let Ok(mut shells) = state.local_shells.lock() {
        shells.remove(&reader_tab);
      }
    }
    let _ = app.emit(
      "connection-closed",
      serde_json::json!({ "tabId": reader_tab }),
    );
  });

  Ok(())
}

/// Send input to a local shell.
#[tauri::command]
pub async fn local_send_input(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  data: String,
) -> Result<bool, String> {
  let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
  let shell = shells.get_mut(&tab_id).ok_or("Local shell not found")?;
  use std::io::Write;
  shell
    .writer
    .write_all(data.as_bytes())
    .map_err(|e| format!("Failed to write to local shell: {}", e))?;
  let _ = shell.writer.flush();
  Ok(true)
}

/// Resize a local shell PTY.
#[tauri::command]
pub async fn local_resize(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  cols: u32,
  rows: u32,
) -> Result<bool, String> {
  let shells = state.local_shells.lock().map_err(|e| e.to_string())?;
  let shell = shells.get(&tab_id).ok_or("Local shell not found")?;
  shell
    .master
    .resize(portable_pty::PtySize {
      rows: rows as u16,
      cols: cols as u16,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|e| format!("PTY resize failed: {}", e))?;
  Ok(true)
}

/// Close a local shell and return its last working directory (if known).
#[tauri::command]
pub async fn local_close(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<Option<String>, String> {
  let cwd = {
    let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
    match shells.remove(&tab_id) {
      Some(mut sh) => {
        let _ = sh.child.kill();
        sh.cwd.clone()
      }
      None => None,
    }
  };
  if let Some(ref dir) = cwd {
    record_local_shell_dir(&state, dir, None);
  }
  Ok(cwd)
}

/// Get the recorded working-directory history for local shells.
#[tauri::command]
pub async fn get_local_shell_dirs(
  state: tauri::State<'_, AppState>,
) -> Result<Vec<LocalShellDir>, String> {
  let dirs = state.local_shell_dirs.lock().map_err(|e| e.to_string())?;
  Ok(dirs.clone())
}

/// Remove a single entry (or all entries) from the local-shell directory history.
#[tauri::command]
pub async fn clear_local_shell_dirs(
  state: tauri::State<'_, AppState>,
  path: Option<String>,
) -> Result<(), String> {
  let mut dirs = state.local_shell_dirs.lock().map_err(|e| e.to_string())?;
  match path {
    Some(p) => dirs.retain(|d| d.path != p),
    None => dirs.clear(),
  }
  Ok(())
}

/// List installed WSL distributions for the local-terminal editor's distro
/// dropdown (`wsl.exe -l -q`). Returns an empty list when WSL is unavailable so
/// the frontend can fall back to a free-text field.
#[tauri::command]
pub async fn list_wsl_distros() -> Result<Vec<String>, String> {
  // WSL can be slow to answer on a cold start; keep it off the async runtime.
  let bytes = tokio::task::spawn_blocking(|| {
    std::process::Command::new("wsl.exe")
      .args(["-l", "-q"])
      .output()
      .ok()
      .map(|o| o.stdout)
  })
  .await
  .map_err(|e| format!("wsl distro listing task failed: {}", e))?;
  // `wsl.exe` missing (non-Windows / no WSL) is not an error — just no list.
  let Some(bytes) = bytes else {
    return Ok(Vec::new());
  };
  let text = decode_wsl_output(&bytes);
  let mut out: Vec<String> = Vec::new();
  for line in text.lines() {
    let name = line.trim().trim_start_matches('\u{feff}').trim();
    if !name.is_empty() && !out.iter().any(|d| d == name) {
      out.push(name.to_string());
    }
  }
  Ok(out)
}

/// Decode output captured from `wsl.exe`, which writes **UTF-16LE** when stdout
/// is a pipe (its console output is UTF-8). A plain `from_utf8` would yield
/// NUL-interleaved garbage, so detect the encoding and decode accordingly.
fn decode_wsl_output(bytes: &[u8]) -> String {
  let has_bom = bytes.starts_with(&[0xFF, 0xFE]);
  let nul_ratio = if bytes.is_empty() {
    0.0
  } else {
    bytes.iter().filter(|b| **b == 0).count() as f32 / bytes.len() as f32
  };
  if has_bom || nul_ratio > 0.125 {
    let mut units: Vec<u16> = bytes
      .chunks_exact(2)
      .map(|c| u16::from_le_bytes([c[0], c[1]]))
      .collect();
    if units.first() == Some(&0xFEFF) {
      units.remove(0);
    }
    String::from_utf16_lossy(&units)
  } else {
    String::from_utf8_lossy(bytes).into_owned()
  }
}

/// Helper: insert/update a directory in the MRU history (max 20 entries).
fn record_local_shell_dir(state: &AppState, path: &str, shell: Option<&str>) {
  let mut dirs = match state.local_shell_dirs.lock() {
    Ok(d) => d,
    Err(_) => return,
  };
  if let Some(existing) = dirs.iter_mut().find(|d| d.path == path) {
    existing.last_used = now_ms();
    if shell.is_some() {
      existing.shell = shell.map(|s| s.to_string());
    }
  } else {
    dirs.push(LocalShellDir {
      path: path.to_string(),
      shell: shell.map(|s| s.to_string()),
      last_used: now_ms(),
    });
  }
  dirs.sort_by(|a, b| b.last_used.cmp(&a.last_used));
  dirs.truncate(20);
}
