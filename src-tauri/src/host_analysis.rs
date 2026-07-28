//! Remote host software/command analysis.
//!
//! Runs read-only probes over an existing SSH exec channel (reusing the
//! `exec_on_jump` pattern from `docker_fs.rs`) and returns structured results
//! to the frontend.  The entire probe set is bundled into a single shell script
//! to minimise round-trips over high-latency links.

use russh::client::Handle;
use russh::ChannelMsg;
use serde::Serialize;

use crate::ssh_session::SshHandler;

// ---------------------------------------------------------------------------
// Data models (serialised to the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
  pub name: String,
  pub version: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
  pub name: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAnalysis {
  pub tab_id: u32,
  pub os: String,
  pub kernel: String,
  pub arch: String,
  pub hostname: String,
  pub uptime: String,
  pub package_manager: String,
  pub packages: Vec<PackageInfo>,
  pub tools: Vec<ToolInfo>,
  pub analyzed_at: i64,
}

// ---------------------------------------------------------------------------
// Exec helper – run a command on an existing session handle
// ---------------------------------------------------------------------------

async fn exec_on_handle(
  handle: &Handle<SshHandler>,
  command: &str,
) -> Result<String, String> {
  if handle.is_closed() {
    return Err("Session connection is closed".into());
  }

  let mut channel = handle
    .channel_open_session()
    .await
    .map_err(|e| format!("Failed to open exec channel: {e}"))?;

  // Use a login shell so $PATH is properly initialised.
  let wrapped = format!(
    "sh -c {}",
    shell_quote(&format!(
      "bash -lc {} || sh -c {}",
      shell_quote(command),
      shell_quote(command),
    ))
  );
  channel
    .exec(true, wrapped)
    .await
    .map_err(|e| format!("Failed to exec: {e}"))?;

  let mut stdout = Vec::new();
  while let Some(msg) = channel.wait().await {
    match msg {
      ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
      ChannelMsg::ExtendedData { ext: 1, data } => {
        // stderr – append so caller sees errors too
        stdout.extend_from_slice(&data);
      }
      ChannelMsg::ExitStatus { .. } | ChannelMsg::Eof | ChannelMsg::Close => break,
      _ => {}
    }
  }
  String::from_utf8(stdout).map_err(|e| format!("Non-UTF-8 output: {e}"))
}

/// Minimal shell-quote: wrap in single quotes and escape any internal single quotes.
fn shell_quote(s: &str) -> String {
  let escaped = s.replace('\'', "'\\''");
  format!("'{}'", escaped)
}

// ---------------------------------------------------------------------------
// Probe script – bundled into a single shell script
// ---------------------------------------------------------------------------

const DELIM_OS: &str = "__WROLP_OS__";
const DELIM_KERNEL: &str = "__WROLP_KERNEL__";
const DELIM_PKG: &str = "__WROLP_PKG__";
const DELIM_TOOLS: &str = "__WROLP_TOOLS__";

const TOOL_LIST: &[&str] = &[
  "docker",
  "nginx",
  "mysql",
  "psql",
  "redis-cli",
  "git",
  "curl",
  "wget",
  "python3",
  "node",
  "kubectl",
  "tmux",
  "vim",
  "htop",
  "lsof",
  "tcpdump",
  "systemctl",
  "journalctl",
  "cargo",
  "go",
  "rustc",
  "gcc",
  "make",
  "perl",
  "ruby",
  "php",
  "java",
  "mvn",
  "pip3",
  "npm",
  "yarn",
  "docker-compose",
  "podman",
  "screen",
  "nano",
  "less",
  "jq",
  "awk",
  "sed",
  "grep",
  "find",
  "ssh",
  "scp",
  "rsync",
  "telnet",
  "nc",
  "ping",
  "traceroute",
  "dig",
  "nslookup",
];

fn build_probe_script() -> String {
  // Build the tool-check loop body
  let tool_cmds: String = TOOL_LIST
    .iter()
    .map(|t| format!("  command -v '{}' 2>/dev/null && echo '{}:OK:${{?}}' || echo '{}:NO'", t, t, t))
    .collect::<Vec<_>>()
    .join("\n");

  format!(
    r#"echo '{DELIM_OS}'
{{ . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; }} || echo "unknown"
echo '{DELIM_KERNEL}'
uname -a
echo '{DELIM_PKG}'
if command -v dpkg >/dev/null 2>&1; then
  dpkg -l 2>/dev/null | awk 'NR>5 {{print $2,$3}}'
elif command -v rpm >/dev/null 2>&1; then
  rpm -qa --queryformat '%{{NAME}} %{{VERSION}}\n' 2>/dev/null
elif command -v apk >/dev/null 2>&1; then
  apk info -v 2>/dev/null
elif command -v pacman >/dev/null 2>&1; then
  pacman -Q 2>/dev/null
fi
echo '{DELIM_TOOLS}'
{tool_cmds}
"#,
    DELIM_OS = DELIM_OS,
    DELIM_KERNEL = DELIM_KERNEL,
    DELIM_PKG = DELIM_PKG,
    DELIM_TOOLS = DELIM_TOOLS,
    tool_cmds = tool_cmds,
  )
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

fn parse_os_section(lines: &[&str]) -> String {
  lines
    .iter()
    .find(|l| !l.is_empty())
    .map(|s| s.to_string())
    .unwrap_or_else(|| "unknown".into())
}

fn parse_kernel_section(lines: &[&str]) -> (String, String, String, String) {
  let line = lines.first().unwrap_or(&"unknown");
  let parts: Vec<&str> = line.split_whitespace().collect();
  let kernel = parts.get(2).unwrap_or(&"unknown").to_string();
  let hostname = parts.get(1).unwrap_or(&"unknown").to_string();
  let arch = if parts.len() >= 14 {
    parts[parts.len() - 1].to_string()
  } else {
    "unknown".into()
  };
  (kernel, hostname, parts.get(0).unwrap_or(&"unknown").to_string(), arch)
}

fn parse_package_manager(lines: &[&str]) -> (String, Vec<PackageInfo>) {
  // Detect package manager from the raw data format
  let sample = lines.iter().copied().take(5).collect::<Vec<_>>().join(" ");
  let is_dpkg = sample.contains("ii ") || sample.contains("rc ");
  let is_rpm = sample.contains(".rpm") || lines.iter().any(|l| l.contains('-') && l.split_whitespace().count() >= 2);
  let is_apk = lines.iter().any(|l| l.contains('-') && l.split('-').count() > 2);
  let is_pacman = lines.iter().any(|l| l.contains('/') && l.contains('-'));

  let manager = if is_dpkg {
    "dpkg"
  } else if is_rpm {
    "rpm"
  } else if is_apk {
    "apk"
  } else if is_pacman {
    "pacman"
  } else {
    "unknown"
  };

  let packages: Vec<PackageInfo> = lines
    .iter()
    .filter(|l| !l.is_empty())
    .filter_map(|l| {
      let parts: Vec<&str> = l.split_whitespace().collect();
      match manager {
        "dpkg" if parts.len() >= 2 && (parts[0] == "ii" || parts[0] == "rc") => {
          Some(PackageInfo {
            name: parts[1].to_string(),
            version: parts.get(2).unwrap_or(&"?").to_string(),
            description: None,
          })
        }
        "rpm" if parts.len() >= 1 => {
          let pkg = parts[0];
          let dash = pkg.rfind('-').map(|i| i).unwrap_or(0);
          if dash > 0 {
            Some(PackageInfo {
              name: pkg[..dash].to_string(),
              version: pkg[dash + 1..].to_string(),
              description: None,
            })
          } else {
            Some(PackageInfo {
              name: pkg.to_string(),
              version: "?".into(),
              description: None,
            })
          }
        }
        "apk" if parts.len() >= 2 => {
          Some(PackageInfo {
            name: parts[0].to_string(),
            version: parts[1].to_string(),
            description: None,
          })
        }
        "pacman" if parts.len() >= 2 => {
          Some(PackageInfo {
            name: parts[0].to_string(),
            version: parts[1].to_string(),
            description: None,
          })
        }
        _ => None,
      }
    })
    .collect();

  (manager.into(), packages)
}



/// Parse the combined probe output into a `HostAnalysis`.
fn parse_probe_output(tab_id: u32, output: &str) -> HostAnalysis {
  let sections: Vec<&str> = output.split('\n').collect();

  let mut os_lines = Vec::new();
  let mut kernel_lines = Vec::new();
  let mut pkg_lines = Vec::new();
  let mut tool_lines = Vec::new();

  let mut current_section: Option<&str> = None;
  for line in &sections {
    let trimmed = line.trim();
    match trimmed {
      DELIM_OS => {
        current_section = Some("os");
        continue;
      }
      DELIM_KERNEL => {
        current_section = Some("kernel");
        continue;
      }
      DELIM_PKG => {
        current_section = Some("pkg");
        continue;
      }
      DELIM_TOOLS => {
        current_section = Some("tools");
        continue;
      }
      _ => {}
    }
    match current_section {
      Some("os") => os_lines.push(trimmed),
      Some("kernel") => kernel_lines.push(trimmed),
      Some("pkg") => pkg_lines.push(trimmed),
      Some("tools") => tool_lines.push(trimmed),
      _ => {}
    }
  }

  let os = parse_os_section(&os_lines);
  let (kernel, hostname, _arch_raw, arch) = parse_kernel_section(&kernel_lines);
  let (package_manager, packages) = parse_package_manager(&pkg_lines);

  // Tools: re-parse with proper "found" detection
  let mut tools = Vec::new();
  for line in &tool_lines {
    let line = line.trim();
    if line.is_empty() {
      continue;
    }
    let colon = line.rfind(':');
    if let Some(pos) = colon {
      let name = &line[..pos];
      let status = &line[pos + 1..];
      if status == "OK" {
        // Try to find the path from the preceding output (the `command -v` output)
        // We don't have it here, so mark as "found"
        tools.push(ToolInfo {
          name: name.to_string(),
          path: None,
        });
      }
    }
  }

  // Uptime: parse from uname -a (the 4th/5th field after kernel)
  let uptime = kernel_lines
    .first()
    .map(|l| {
      let parts: Vec<&str> = l.split_whitespace().collect();
      if parts.len() >= 5 {
        format!("{} {}", parts[3], parts[4])
      } else {
        "?".into()
      }
    })
    .unwrap_or_else(|| "?".into());

  HostAnalysis {
    tab_id,
    os,
    kernel,
    arch,
    hostname,
    uptime,
    package_manager,
    packages,
    tools,
    analyzed_at: std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap_or_default()
      .as_millis() as i64,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Run a full host analysis on the given tab's SSH session.
pub async fn analyze_host(
  handle: &Handle<SshHandler>,
  tab_id: u32,
) -> Result<HostAnalysis, String> {
  let script = build_probe_script();
  let output = exec_on_handle(handle, &script).await?;
  Ok(parse_probe_output(tab_id, &output))
}

/// Run `--help` (or `man`) for a single command and return the first ~50 lines.
pub async fn command_help(
  handle: &Handle<SshHandler>,
  command: &str,
) -> Result<String, String> {
  // Basic safety: only allow alphanumeric, dash, underscore, slash, dot
  if !command
    .chars()
    .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '/' || c == '.')
  {
    return Err("Invalid command name".into());
  }

  // Try --help first, fall back to man | head
  let help_cmd = format!("{} --help 2>&1 | head -n 60", command);
  let result = exec_on_handle(handle, &help_cmd).await?;
  if !result.trim().is_empty() && !result.contains("No help") && !result.contains("not found") {
    return Ok(result);
  }

  let man_cmd = format!("man {} 2>&1 | head -n 60", command);
  let result = exec_on_handle(handle, &man_cmd).await?;
  if !result.trim().is_empty() && !result.contains("No manual entry") {
    return Ok(result);
  }

  Err(format!("No help available for '{}'", command))
}
