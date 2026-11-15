//! Bounds for the repository scan (`git_scan_repos`).
//!
//! A scan walks the host's directory tree, which can be arbitrarily large — and
//! over SSH every level costs a round trip. Depth, directory count and wall time
//! are all capped, and build-output directories are skipped, so the walk stays a
//! convenience rather than a hang.

use std::time::Duration;

/// How deep below the starting folder the walk may go.
pub const MAX_SCAN_DEPTH: u32 = 4;
/// Directory listings allowed per scan (a listing is one round trip over SSH).
pub const MAX_SCAN_DIRS: usize = 400;
/// Wall-clock budget; whatever was found is returned when it runs out.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(6);

/// The panel offers 1–4; anything else is clamped rather than rejected so a
/// stale frontend cannot make the walk unbounded.
pub fn checked_depth(depth: u32) -> u32 {
  depth.clamp(1, MAX_SCAN_DEPTH)
}

/// Directories that are never worth descending into *on their own account*.
///
/// Hidden directories are deliberately **not** filtered by name: dot-directories
/// hold real repositories (`~/.dotfiles`, `~/.config/nvim`, …) and skipping every
/// one of them hid them from the scan. Only two kinds are still skipped:
///
///   * `.git` itself — its contents are repository metadata, never a repository
///     to open, and walking it would burn the whole directory budget;
///   * tool/package caches, which are large, git-less, and would otherwise eat
///     the directory budget before the walk reaches anything useful.
///
/// Build outputs are skipped for the same budget reason.
pub fn skipped_dir(name: &str) -> bool {
  matches!(
    name,
    // Build outputs of the ecosystems this app is used with.
    "node_modules"
      | "target"
      | "dist"
      | "build"
      | "out"
      | "vendor"
      | "venv"
      | "__pycache__"
      // Repository metadata: descending cannot find a repository.
      | ".git"
      | ".svn"
      | ".hg"
      // Package-manager / tool caches: large, git-less.
      | ".cache"
      | ".cargo"
      | ".rustup"
      | ".npm"
      | ".pnpm-store"
      | ".yarn"
      | ".gradle"
      | ".m2"
      | ".nuget"
      | ".conda"
      | ".vscode-server"
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn depth_is_clamped_into_the_supported_range() {
    assert_eq!(checked_depth(0), 1);
    assert_eq!(checked_depth(2), 2);
    assert_eq!(checked_depth(99), MAX_SCAN_DEPTH);
  }

  #[test]
  fn heavy_and_metadata_directories_are_skipped() {
    for name in [
      ".git",
      ".svn",
      ".cache",
      ".cargo",
      "node_modules",
      "target",
      "dist",
      "build",
      "venv",
    ] {
      assert!(skipped_dir(name), "{name} should be skipped");
    }
    for name in ["src", "repo-a", "work_space", "tooling"] {
      assert!(!skipped_dir(name), "{name} should be walked");
    }
  }

  #[test]
  fn hidden_directories_are_walked_so_dot_repositories_are_found() {
    // `~/.dotfiles` and `~/.config/nvim` are ordinary repositories that live in
    // a dot-directory; skipping all hidden names hid both from the scan.
    for name in [".dotfiles", ".config", ".local", ".emacs.d", ".tmux"] {
      assert!(!skipped_dir(name), "{name} should be walked");
    }
  }
}
