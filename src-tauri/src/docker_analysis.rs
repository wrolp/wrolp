//! Docker container analysis – one-click overview of everything inside a
//! container (OS, packages, tools, processes, ports, mounts, resources, env).
//!
//! Uses two layers of probing:
//! 1. `docker inspect` on the jump host → metadata (image, ports, mounts, env)
//! 2. `docker exec <container> sh -c '...'` → in-container probe (OS, pkgs,
//!    tools, processes, listening ports)
//! 3. `docker stats --no-stream` → resource usage (optional, may fail)
//!
//! All commands run through the existing SSH exec channel on the jump host,
//! reusing `exec_on_jump` from `docker_fs`.

use russh::client::Handle;
use serde::Serialize;
use std::collections::HashSet;

use crate::ssh_session::SshHandler;

// ---------------------------------------------------------------------------
// Data models (serialised to the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortMapping {
  pub container_port: String,       // "8080/tcp"
  pub host_ip: Option<String>,      // "0.0.0.0" (null if not published)
  pub host_port: Option<String>,    // "8080"    (null if not published)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountInfo {
  pub source: String,
  pub destination: String,
  pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
  pub key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
  pub pid: u32,
  pub user: String,
  pub cpu: String,
  pub mem: String,
  pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
  pub cpu_percent: String,
  pub mem_usage: String,
  pub mem_limit: String,
  pub net_io: String,
  pub block_io: String,
  pub pid_count: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
  pub name: String,
  pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
  pub name: String,
  pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerAnalysis {
  pub tab_id: u32,
  pub container_name: String,
  pub container_id: String,
  pub image: String,
  pub image_tag: String,
  pub state: String,
  pub created_at: String,

  // In-container OS info
  pub os: String,
  pub kernel: String,
  pub arch: String,
  pub hostname: String,

  // Packages & tools
  pub package_manager: String,
  pub packages: Vec<PackageInfo>,
  pub tools: Vec<ToolInfo>,

  // Docker-specific
  pub ports: Vec<PortMapping>,
  pub mounts: Vec<MountInfo>,
  pub env_keys: Vec<EnvEntry>,
  pub processes: Vec<ProcessInfo>,
  pub resource: Option<ResourceUsage>,

  pub analyzed_at: i64,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Run a command inside a Docker container via `docker exec`.
async fn exec_in_container(
  jump: &Handle<SshHandler>,
  container: &str,
  command: &str,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  let argv = vec![
    "docker".into(),
    "exec".into(),
    container.to_string(),
    "sh".into(),
    "-c".into(),
    command.to_string(),
  ];
  crate::docker_fs::exec_on_jump(jump, &argv, None).await
}

// ---------------------------------------------------------------------------
// Layer 1 – docker inspect (metadata, runs on jump host)
// ---------------------------------------------------------------------------

const INSPECT_DELIM_ID: &str = "__WROLP_DID__";
const INSPECT_DELIM_CREATED: &str = "__WROLP_DCREATED__";
const INSPECT_DELIM_IMAGE: &str = "__WROLP_DIMAGE__";
const INSPECT_DELIM_STATE: &str = "__WROLP_DSTATE__";
const INSPECT_DELIM_ENV: &str = "__WROLP_DENV__";
const INSPECT_DELIM_PORTS: &str = "__WROLP_DPORTS__";
const INSPECT_DELIM_MOUNTS: &str = "__WROLP_DMOUNTS__";

fn build_inspect_script(container: &str) -> String {
  format!(
    r#"
docker inspect {container} --format '
{INSPECT_DELIM_ID}{{{{.Id}}}}
{INSPECT_DELIM_CREATED}{{{{.Created}}}}
{INSPECT_DELIM_IMAGE}{{{{.Config.Image}}}}
{INSPECT_DELIM_STATE}{{{{.State.Status}}}}
{INSPECT_DELIM_ENV}{{{{range $i, $e := .Config.Env}}}}{{{{$e}}}}
{{{{end}}}}
{INSPECT_DELIM_PORTS}{{{{range $p, $c := .NetworkSettings.Ports}}}}{{{{printf "%s|%s|%s\n" $p (index $c 0).HostIp (index $c 0).HostPort}}}}
{{{{end}}}}
{INSPECT_DELIM_MOUNTS}{{{{range .Mounts}}}}{{{{printf "%s|%s|%s\n" .Source .Destination .Mode}}}}
{{{{end}}}}
' 2>/dev/null
"#,
    container = crate::docker_fs::shell_quote(container),
    INSPECT_DELIM_ID = INSPECT_DELIM_ID,
    INSPECT_DELIM_CREATED = INSPECT_DELIM_CREATED,
    INSPECT_DELIM_IMAGE = INSPECT_DELIM_IMAGE,
    INSPECT_DELIM_STATE = INSPECT_DELIM_STATE,
    INSPECT_DELIM_ENV = INSPECT_DELIM_ENV,
    INSPECT_DELIM_PORTS = INSPECT_DELIM_PORTS,
    INSPECT_DELIM_MOUNTS = INSPECT_DELIM_MOUNTS,
  )
}

fn parse_inspect_section<'a>(lines: &[&'a str], delim: &str) -> Vec<&'a str> {
  let mut result = Vec::new();
  let mut collecting = false;
  for line in lines {
    if line.trim() == delim {
      collecting = true;
      continue;
    }
    // Stop at the next delimiter
    for d in &[
      INSPECT_DELIM_ID, INSPECT_DELIM_CREATED, INSPECT_DELIM_IMAGE,
      INSPECT_DELIM_STATE, INSPECT_DELIM_ENV, INSPECT_DELIM_PORTS,
      INSPECT_DELIM_MOUNTS,
    ] {
      if line.trim() == *d {
        collecting = false;
        break;
      }
    }
    if collecting && !line.trim().is_empty() {
      result.push(line.trim());
    }
  }
  result
}

fn parse_single_value(lines: &[&str]) -> String {
  lines.first().map(|s| s.to_string()).unwrap_or_else(|| "unknown".into())
}

struct InspectMeta {
  container_id: String,
  created_at: String,
  image: String,
  image_tag: String,
  state: String,
  env_keys: Vec<EnvEntry>,
  ports: Vec<PortMapping>,
  mounts: Vec<MountInfo>,
}

fn parse_docker_inspect(output: &str, container_name: &str) -> InspectMeta {
  let lines: Vec<&str> = output.lines().collect();

  let id_lines = parse_inspect_section(&lines, INSPECT_DELIM_ID);
  let created_lines = parse_inspect_section(&lines, INSPECT_DELIM_CREATED);
  let image_lines = parse_inspect_section(&lines, INSPECT_DELIM_IMAGE);
  let state_lines = parse_inspect_section(&lines, INSPECT_DELIM_STATE);
  let env_lines = parse_inspect_section(&lines, INSPECT_DELIM_ENV);
  let port_lines = parse_inspect_section(&lines, INSPECT_DELIM_PORTS);
  let mount_lines = parse_inspect_section(&lines, INSPECT_DELIM_MOUNTS);

  let container_id = parse_single_value(&id_lines);
  let created_at = parse_single_value(&created_lines);
  let image_full = parse_single_value(&image_lines);
  let state = parse_single_value(&state_lines);

  // Split image name and tag
  let (image, image_tag) = if let Some(colon) = image_full.rfind(':') {
    (
      image_full[..colon].to_string(),
      image_full[colon + 1..].to_string(),
    )
  } else {
    (image_full.clone(), "latest".into())
  };
  let _ = container_name; // keep for future use

  // Sensitive key patterns — filter these out
  let sensitive: HashSet<&str> = [
    "PASSWORD", "PASSWD", "SECRET", "TOKEN", "KEY", "PRIVATE_KEY",
    "API_KEY", "AUTH", "CREDENTIAL", "CERT",
  ]
  .iter()
  .copied()
  .collect();

  let env_keys: Vec<EnvEntry> = env_lines
    .into_iter()
    .filter_map(|line| {
      let eq = line.find('=')?;
      let key = line[..eq].to_string();
      // Filter sensitive keys
      let upper = key.to_uppercase();
      if sensitive.iter().any(|s| upper.contains(s)) {
        return None;
      }
      Some(EnvEntry { key })
    })
    .collect();

  // Ports: "8080/tcp|0.0.0.0|8080" or just "8080/tcp" if not published
  let ports: Vec<PortMapping> = port_lines
    .into_iter()
    .filter_map(|line| {
      let parts: Vec<&str> = line.split('|').collect();
      if parts.is_empty() || parts[0].is_empty() {
        return None;
      }
      Some(PortMapping {
        container_port: parts[0].to_string(),
        host_ip: parts.get(1).filter(|s| !s.is_empty()).map(|s| s.to_string()),
        host_port: parts.get(2).filter(|s| !s.is_empty()).map(|s| s.to_string()),
      })
    })
    .collect();

  // Mounts: "source|destination|mode" (could be volume or bind)
  let mounts: Vec<MountInfo> = mount_lines
    .into_iter()
    .filter_map(|line| {
      let parts: Vec<&str> = line.split('|').collect();
      if parts.len() < 3 {
        return None;
      }
      Some(MountInfo {
        source: parts[0].to_string(),
        destination: parts[1].to_string(),
        mode: parts[2].to_string(),
      })
    })
    .collect();

  InspectMeta {
    container_id,
    created_at,
    image,
    image_tag,
    state,
    env_keys,
    ports,
    mounts,
  }
}

// ---------------------------------------------------------------------------
// Layer 2 & 3 – In-container probe + docker stats
// ---------------------------------------------------------------------------

const PROBE_DELIM_OS: &str = "__WROLP_COS__";
const PROBE_DELIM_KERNEL: &str = "__WROLP_CKERNEL__";
const PROBE_DELIM_PKG: &str = "__WROLP_CPKG__";
const PROBE_DELIM_TOOLS: &str = "__WROLP_CTOOLS__";
const PROBE_DELIM_PROCS: &str = "__WROLP_CPROCS__";
const PROBE_DELIM_PORTS: &str = "__WROLP_CPORTS__";

const CONTAINER_TOOL_LIST: &[&str] = &[
  "curl", "wget", "python3", "python", "node", "perl", "ruby", "php",
  "java", "git", "vim", "nano", "htop", "less", "jq", "awk", "sed",
  "grep", "find", "nc", "ping", "dig", "nslookup", "netstat", "ss",
  "lsof", "tcpdump", "strace", "gdb", "make", "gcc", "g++",
];

fn build_container_probe_script() -> String {
  let tool_cmds: String = CONTAINER_TOOL_LIST
    .iter()
    .map(|t| format!(
      "  command -v '{}' 1>/dev/null 2>&1 && echo '{}:OK' || echo '{}:NO'",
      t, t, t
    ))
    .collect::<Vec<_>>()
    .join("\n");

  format!(
    r#"echo '{PROBE_DELIM_OS}'
{{ . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; }} || echo "unknown"
echo '{PROBE_DELIM_KERNEL}'
uname -a
echo '{PROBE_DELIM_PKG}'
if command -v dpkg >/dev/null 2>&1; then
  dpkg -l 2>/dev/null | awk 'NR>5 {{print $2,$3}}'
elif command -v rpm >/dev/null 2>&1; then
  rpm -qa --queryformat '%{{NAME}} %{{VERSION}}\n' 2>/dev/null
elif command -v apk >/dev/null 2>&1; then
  apk info -v 2>/dev/null
elif command -v pacman >/dev/null 2>&1; then
  pacman -Q 2>/dev/null
fi
echo '{PROBE_DELIM_TOOLS}'
{tool_cmds}
echo '{PROBE_DELIM_PROCS}'
ps aux 2>/dev/null | awk 'NR>1 {{print $1,$2,$3,$4,$11}}' | head -n 20
echo '{PROBE_DELIM_PORTS}'
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "NONE"
"#,
    PROBE_DELIM_OS = PROBE_DELIM_OS,
    PROBE_DELIM_KERNEL = PROBE_DELIM_KERNEL,
    PROBE_DELIM_PKG = PROBE_DELIM_PKG,
    PROBE_DELIM_TOOLS = PROBE_DELIM_TOOLS,
    PROBE_DELIM_PROCS = PROBE_DELIM_PROCS,
    PROBE_DELIM_PORTS = PROBE_DELIM_PORTS,
    tool_cmds = tool_cmds,
  )
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

fn split_sections<'a>(output: &'a str, delimiters: &[&'a str]) -> Vec<(&'a str, Vec<&'a str>)> {
  let lines: Vec<&str> = output.lines().collect();
  let mut sections: Vec<(&str, Vec<&str>)> = Vec::new();
  let mut current_name = "";
  let mut current_lines: Vec<&str> = Vec::new();

  for line in &lines {
    let trimmed = line.trim();
    let mut is_delim = false;
    for d in delimiters {
      if trimmed == *d {
        if !current_name.is_empty() {
          sections.push((current_name, std::mem::take(&mut current_lines)));
        }
        current_name = d;
        is_delim = true;
        break;
      }
    }
    if !is_delim {
      current_lines.push(trimmed);
    }
  }
  if !current_name.is_empty() {
    sections.push((current_name, current_lines));
  }
  sections
}

fn find_sec<'a>(sections: &[(&'a str, Vec<&'a str>)], name: &str) -> Vec<&'a str> {
  sections
    .iter()
    .find(|(n, _)| *n == name)
    .map(|(_, lines)| lines.clone())
    .unwrap_or_default()
}

fn parse_os(lines: &[&str]) -> String {
  lines.iter().find(|l| !l.is_empty()).map(|s| s.to_string()).unwrap_or_else(|| "unknown".into())
}

fn parse_kernel(lines: &[&str]) -> (String, String, String) {
  let line = lines.first().unwrap_or(&"unknown");
  let parts: Vec<&str> = line.split_whitespace().collect();
  let kernel = parts.get(2).unwrap_or(&"unknown").to_string();
  let hostname = parts.get(1).unwrap_or(&"unknown").to_string();
  let arch = if parts.len() >= 14 {
    parts[parts.len() - 1].to_string()
  } else {
    "unknown".into()
  };
  (kernel, arch, hostname)
}

fn parse_packages(lines: &[&str]) -> (String, Vec<PackageInfo>) {
  let sample = lines.iter().copied().take(5).collect::<Vec<_>>().join(" ");
  let is_dpkg = sample.contains("ii ") || sample.contains("rc ");
  let manager = if is_dpkg {
    "dpkg"
  } else if lines.iter().any(|l| l.contains('/') && l.contains('-')) {
    "pacman"
  } else if lines.iter().any(|l| l.contains('-') && l.split('-').count() > 2) {
    "apk"
  } else {
    "rpm"
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
          })
        }
        "rpm" if parts.len() >= 1 => {
          let pkg = parts[0];
          let dash = pkg.rfind('-').unwrap_or(0);
          if dash > 0 {
            Some(PackageInfo {
              name: pkg[..dash].to_string(),
              version: pkg[dash + 1..].to_string(),
            })
          } else {
            Some(PackageInfo { name: pkg.to_string(), version: "?".into() })
          }
        }
        "apk" if parts.len() >= 2 => {
          Some(PackageInfo {
            name: parts[0].to_string(),
            version: parts[1].to_string(),
          })
        }
        "pacman" if parts.len() >= 2 => {
          Some(PackageInfo {
            name: parts[0].to_string(),
            version: parts[1].to_string(),
          })
        }
        _ => None,
      }
    })
    .collect();

  (manager.into(), packages)
}

fn parse_tools(lines: &[&str]) -> Vec<ToolInfo> {
  lines
    .iter()
    .filter_map(|line| {
      let line = line.trim();
      if line.is_empty() {
        return None;
      }
      let colon = line.rfind(':')?;
      let name = &line[..colon];
      let status = &line[colon + 1..];
      if status == "OK" {
        Some(ToolInfo { name: name.to_string(), path: None })
      } else {
        None
      }
    })
    .collect()
}

fn parse_processes(lines: &[&str]) -> Vec<ProcessInfo> {
  lines
    .iter()
    .filter_map(|line| {
      let line = line.trim();
      if line.is_empty() {
        return None;
      }
      let parts: Vec<&str> = line.split_whitespace().collect();
      if parts.len() < 5 {
        return None;
      }
      let pid: u32 = parts[1].parse().unwrap_or(0);
      if pid == 0 {
        return None;
      }
      Some(ProcessInfo {
        pid,
        user: parts[0].to_string(),
        cpu: parts[2].to_string(),
        mem: parts[3].to_string(),
        command: parts[4..].join(" "),
      })
    })
    .collect()
}

/// Build listening port list from ss/netstat output inside the container.
/// Returns a set of port strings like "80/tcp", "443/tcp" for cross-referencing
/// with docker inspect ports.
#[allow(dead_code)]
fn parse_listening_ports(lines: &[&str]) -> HashSet<String> {
  let mut ports = HashSet::new();
  for line in lines {
    let line = line.trim();
    if line.is_empty() || line == "NONE" {
      continue;
    }
    // Try ss output: "LISTEN 0 128 0.0.0.0:80 ..."
    // Or netstat: "tcp  0  0  0.0.0.0:80  0.0.0.0:*  LISTEN"
    for word in line.split_whitespace() {
      // Look for <addr>:<port> pattern
      if let Some(colon) = word.rfind(':') {
        let port_str = &word[colon + 1..];
        if port_str.parse::<u16>().is_ok() {
          // Guess protocol from context
          let proto = if line.to_lowercase().contains("tcp") { "tcp" } else { "tcp" };
          ports.insert(format!("{}/{}", port_str, proto));
        }
      }
    }
  }
  ports
}

// ---------------------------------------------------------------------------
// Layer 3 – docker stats
// ---------------------------------------------------------------------------

async fn get_docker_stats(
  jump: &Handle<SshHandler>,
  container: &str,
) -> Option<ResourceUsage> {
  let cmd = format!(
    "docker stats {} --no-stream --format '{{{{.CPUPerc}}}}|{{{{.MemUsage}}}}|{{{{.NetIO}}}}|{{{{.BlockIO}}}}|{{{{.PIDs}}}}' 2>/dev/null",
    crate::docker_fs::shell_quote(container)
  );
  let argv = vec!["sh".into(), "-c".into(), cmd];
  let result = crate::docker_fs::exec_on_jump(jump, &argv, None).await.ok()?;
  let output = String::from_utf8_lossy(&result.0).trim().to_string();
  if output.is_empty() {
    return None;
  }
  let parts: Vec<&str> = output.split('|').collect();
  if parts.len() < 5 {
    return None;
  }
  // MemUsage is "used / limit"
  let (mem_usage, mem_limit) = if parts[1].contains('/') {
    let mp: Vec<&str> = parts[1].split('/').map(|s| s.trim()).collect();
    (mp[0].to_string(), mp.get(1).unwrap_or(&"?").to_string())
  } else {
    (parts[1].trim().to_string(), "?".into())
  };
  Some(ResourceUsage {
    cpu_percent: parts[0].trim().to_string(),
    mem_usage,
    mem_limit,
    net_io: parts[2].trim().to_string(),
    block_io: parts[3].trim().to_string(),
    pid_count: parts[4].trim().to_string(),
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Full container analysis: docker inspect + in-container probe + docker stats.
pub async fn analyze_docker_container(
  jump: &Handle<SshHandler>,
  container_name: &str,
  tab_id: u32,
) -> Result<DockerAnalysis, String> {
  if jump.is_closed() {
    return Err("Jump host connection is closed".into());
  }

  // Layer 1 – docker inspect
  let inspect_script = build_inspect_script(container_name);
  let inspect_argv = vec!["sh".into(), "-c".into(), inspect_script];
  let (inspect_out, _, _) =
    crate::docker_fs::exec_on_jump(jump, &inspect_argv, None).await
      .map_err(|e| format!("docker inspect failed: {}", e))?;
  let inspect_text = String::from_utf8_lossy(&inspect_out);
  let inspect = parse_docker_inspect(&inspect_text, container_name);

  // Layer 2 – in-container probe
  let probe_script = build_container_probe_script();
  let (probe_out, probe_err, probe_status) =
    exec_in_container(jump, container_name, &probe_script).await?;
  let probe_text = String::from_utf8_lossy(&probe_out);
  let _ = (probe_err, probe_status);

  let delimiters = &[
    PROBE_DELIM_OS, PROBE_DELIM_KERNEL, PROBE_DELIM_PKG,
    PROBE_DELIM_TOOLS, PROBE_DELIM_PROCS, PROBE_DELIM_PORTS,
  ];
  let sections = split_sections(&probe_text, delimiters);

  let os = parse_os(&find_sec(&sections, PROBE_DELIM_OS));
  let (kernel, arch, hostname) = parse_kernel(&find_sec(&sections, PROBE_DELIM_KERNEL));
  let (package_manager, packages) = parse_packages(&find_sec(&sections, PROBE_DELIM_PKG));
  let tools = parse_tools(&find_sec(&sections, PROBE_DELIM_TOOLS));
  let processes = parse_processes(&find_sec(&sections, PROBE_DELIM_PROCS));

  let ports: Vec<PortMapping> = inspect.ports.clone();

  // Layer 3 – docker stats (optional, non-blocking)
  let resource = get_docker_stats(jump, container_name).await;

  Ok(DockerAnalysis {
    tab_id,
    container_name: container_name.to_string(),
    container_id: inspect.container_id,
    image: inspect.image,
    image_tag: inspect.image_tag,
    state: inspect.state,
    created_at: inspect.created_at,
    os,
    kernel,
    arch,
    hostname,
    package_manager,
    packages,
    tools,
    ports,
    mounts: inspect.mounts,
    env_keys: inspect.env_keys,
    processes,
    resource,
    analyzed_at: std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap_or_default()
      .as_millis() as i64,
  })
}
