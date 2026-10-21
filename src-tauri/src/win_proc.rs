//! Keep console children from flashing a window on Windows.
//!
//! The app is a `windows_subsystem = "windows"` binary (see `lib.rs`), so it owns
//! no console of its own. Windows therefore allocates a NEW console window for
//! every console program it spawns — `docker`, `wsl.exe`, `powershell.exe`,
//! `reg.exe`, `cmd.exe` — and that window is visible for as long as the child
//! lives: a black box that flashes once per spawn. The Docker probe alone runs two
//! (`docker --version`, then `docker version --format …`) on every launch.
//!
//! `CREATE_NO_WINDOW` runs the child with no console at all. A no-op elsewhere, so
//! call sites stay readable without a `#[cfg]` on each one.
//!
//! Deliberately NOT applied to `portable_pty` (ConPTY lays out its own hidden
//! pseudo-console) or to GUI children like `explorer.exe`.

/// `CREATE_NO_WINDOW` (winbase.h). Spelled out rather than taken from the
/// `windows` crate so this module needs no extra Win32 feature flags.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Turns a spawn into a hidden spawn. Implemented for both command types the
/// backend uses, so the call reads the same whether the command is async or not.
pub trait HideConsole {
  fn hide_console(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl HideConsole for std::process::Command {
  fn hide_console(&mut self) -> &mut Self {
    use std::os::windows::process::CommandExt;
    self.creation_flags(CREATE_NO_WINDOW)
  }
}

#[cfg(windows)]
impl HideConsole for tokio::process::Command {
  fn hide_console(&mut self) -> &mut Self {
    use std::os::windows::process::CommandExt;
    self.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    self
  }
}

#[cfg(not(windows))]
impl HideConsole for std::process::Command {
  fn hide_console(&mut self) -> &mut Self {
    self
  }
}

#[cfg(not(windows))]
impl HideConsole for tokio::process::Command {
  fn hide_console(&mut self) -> &mut Self {
    self
  }
}
