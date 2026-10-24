//! A pod's filesystem, read through `kubectl exec` (no sidecar, no sshd).
//!
//! Mirrors [`crate::docker_fs`]: the shared [`CmdFs`] turns directory listings, reads
//! and writes into POSIX commands, and this module's runner only decides *where* they
//! run — `kubectl exec` on a jump host's session, or on this machine. Paths stay
//! positional arguments of the `sh -c` script `CmdFs` builds, so they are never
//! interpolated into shell text.

use russh::client::Handle;
use std::sync::Arc;

use crate::cmd_fs::{CmdFs, Runner};
use crate::k8s_host::kubectl_argv;
use crate::ssh_session::SshHandler;

/// How a `kubectl exec` reaches its cluster.
pub(crate) enum K8sTransport {
  Jump(Arc<Handle<SshHandler>>),
  /// kubectl on this machine, resolved from the user's own kubeconfig.
  Local,
}

/// Runs commands inside a pod via `kubectl exec`.
pub(crate) struct K8sRunner {
  transport: K8sTransport,
  context: Option<String>,
  namespace: String,
  pod: String,
  container: Option<String>,
}

impl K8sRunner {
  /// `kubectl [--context C] -n NS exec <pod> [-c CONTAINER] [-i] -- <inner…>`
  fn argv(&self, interactive: bool, inner: &[String]) -> Vec<String> {
    let mut args = vec!["exec".to_string()];
    if interactive {
      args.push("-i".to_string());
    }
    args.push(self.pod.clone());
    if let Some(c) = self
      .container
      .as_deref()
      .map(str::trim)
      .filter(|c| !c.is_empty())
    {
      args.push("-c".to_string());
      args.push(c.to_string());
    }
    args.push("--".to_string());
    args.extend(inner.iter().cloned());
    kubectl_argv(self.context.as_deref(), Some(&self.namespace), false, &args)
  }
}

#[async_trait::async_trait]
impl Runner for K8sRunner {
  async fn run(
    &self,
    inner: &[String],
    stdin: Option<&[u8]>,
  ) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
    // `-i` only when stdin is actually fed: an interactive exec with no EOF would
    // sit waiting for input. Same rule as the Docker runner.
    let argv = self.argv(stdin.is_some(), inner);
    match &self.transport {
      K8sTransport::Jump(jump) => crate::docker_fs::exec_on_jump(jump, &argv, stdin).await,
      K8sTransport::Local => crate::k8s_host::exec_local_argv(&argv, stdin).await,
    }
  }
}

/// Build a pod filesystem backed by `kubectl exec` on the jump host.
pub(crate) fn new_pod_fs(
  jump: Arc<Handle<SshHandler>>,
  context: Option<String>,
  namespace: String,
  pod: String,
  container: Option<String>,
) -> CmdFs<K8sRunner> {
  CmdFs::new(
    K8sRunner {
      transport: K8sTransport::Jump(jump),
      context,
      namespace,
      pod,
      container,
    },
    false,
  )
}

/// Build a pod filesystem for a cluster reachable from **this machine**.
pub(crate) fn new_local_pod_fs(
  context: Option<String>,
  namespace: String,
  pod: String,
  container: Option<String>,
) -> CmdFs<K8sRunner> {
  CmdFs::new(
    K8sRunner {
      transport: K8sTransport::Local,
      context,
      namespace,
      pod,
      container,
    },
    false,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn runner(pod: &str, container: Option<&str>, context: Option<&str>) -> K8sRunner {
    K8sRunner {
      transport: K8sTransport::Local,
      context: context.map(str::to_string),
      namespace: "apps".to_string(),
      pod: pod.to_string(),
      container: container.map(str::to_string),
    }
  }

  #[test]
  fn the_exec_argv_puts_the_namespace_before_the_verb() {
    let argv = runner("web-0", None, Some("prod")).argv(
      false,
      &["sh".to_string(), "-c".to_string(), "ls".to_string()],
    );
    assert_eq!(
      argv,
      vec![
        "kubectl",
        "--context",
        "prod",
        "-n",
        "apps",
        "exec",
        "web-0",
        "--",
        "sh",
        "-c",
        "ls"
      ]
    );
  }

  #[test]
  fn a_multi_container_pod_names_its_container_and_stdin_adds_i() {
    let argv = runner("web-0", Some("sidecar"), None).argv(true, &["cat".to_string()]);
    assert_eq!(
      argv,
      vec!["kubectl", "-n", "apps", "exec", "-i", "web-0", "-c", "sidecar", "--", "cat"]
    );
  }

  #[test]
  fn the_blank_container_name_is_no_container_at_all() {
    let argv = runner("web-0", Some("  "), None).argv(false, &["pwd".to_string()]);
    assert!(!argv.iter().any(|a| a == "-c"), "{argv:?}");
  }
}
