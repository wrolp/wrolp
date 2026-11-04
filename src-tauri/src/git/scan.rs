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

/// Hidden directories (`.git`, `.cache`, …) and build outputs are never worth
/// descending into: they are either not repositories or explode the walk.
pub fn skipped_dir(name: &str) -> bool {
  name.starts_with('.')
    || matches!(
      name,
      "node_modules" | "target" | "dist" | "build" | "out" | "vendor" | "venv" | "__pycache__"
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
  fn heavy_and_hidden_directories_are_skipped() {
    for name in [".git", ".cache", "node_modules", "target", "dist", "build", "venv"] {
      assert!(skipped_dir(name), "{name} should be skipped");
    }
    for name in ["src", "repo-a", "work_space", "tooling"] {
      assert!(!skipped_dir(name), "{name} should be walked");
    }
  }
}
