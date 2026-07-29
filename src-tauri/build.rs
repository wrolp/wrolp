use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
  Command::new("git")
    .args(args)
    .output()
    .ok()
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn main() {
  // Emit git info as cargo:rustc-env for the app version command
  if let Some(hash) = git(&["rev-parse", "--short", "HEAD"]) {
    println!("cargo:rustc-env=GIT_HASH={hash}");
  } else {
    println!("cargo:rustc-env=GIT_HASH=unknown");
  }

  if let Some(commit) = git(&["rev-parse", "HEAD"]) {
    println!("cargo:rustc-env=GIT_COMMIT={commit}");
  } else {
    println!("cargo:rustc-env=GIT_COMMIT=unknown");
  }

  if let Some(branch) = git(&["rev-parse", "--abbrev-ref", "HEAD"]) {
    println!("cargo:rustc-env=GIT_BRANCH={branch}");
  } else {
    println!("cargo:rustc-env=GIT_BRANCH=unknown");
  }

  let dirty = git(&["diff-index", "--quiet", "HEAD", "--"]);
  // diff-index --quiet returns exit code 0 (clean) or 1 (dirty)
  // our git() helper returns Some on success, None on failure
  let dirty_flag = match dirty {
    Some(_) => "false",
    None => "true",
  };
  println!("cargo:rustc-env=GIT_DIRTY={dirty_flag}");

  // Build timestamp (UTC Unix seconds)
  let build_time = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs().to_string())
    .unwrap_or_else(|_| "unknown".to_string());
  println!("cargo:rustc-env=BUILD_TIME={build_time}");

  tauri_build::build()
}
