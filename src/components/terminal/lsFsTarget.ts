import type { K8sExecTarget, TargetRef } from '../../types'

/**
 * Which filesystem the terminal's file features (ls click-to-open, the `cd`
 * directory dropdown, cwd verification, open-in-editor) should query.
 *
 * A nested shell — a container or a pod entered from this tab — must browse the
 * INNER host: a plain `local` target lists the Windows drives even though the
 * prompt says `root in /` (the docker-local bug), and a plain `session` target
 * resolves container/pod paths against the host's SFTP and fails.
 */
export interface LsFsTargetInput {
  /** The tab is a local PTY (local shell, local `docker exec`, local `kubectl exec`). */
  isLocal: boolean
  /** The local shell is a WSL distribution (implies `isLocal`). */
  isWsl: boolean
  tabId: number
  /** WSL distribution name; only meaningful when `isWsl`. */
  distro: string | null
  /** Container this session was opened into, or the user typed `docker exec` into. */
  dockerContainer: string | null
  /** Pod this session was opened into via `kubectl exec`, if any. */
  k8sExec: K8sExecTarget | null
}

export function resolveLsFsTarget(input: LsFsTargetInput): TargetRef {
  const { isLocal, isWsl, tabId, distro, dockerContainer, k8sExec } = input
  if (isLocal) {
    // A WSL tab must browse the DISTRIBUTION's filesystem — the plain `local`
    // target lists the Windows drives instead (the Files panel makes the same
    // distinction in App.tsx).
    if (isWsl) {
      // The `wsl` target's `distro` is optional-but-undefined-only; a null
      // distro means "the distribution's default".
      return { kind: 'wsl', tabId, distro: distro ?? undefined }
    }
    // A local `docker exec` shell (sidebar-opened or typed) browses the
    // CONTAINER's filesystem through the local docker CLI.
    if (dockerContainer) {
      return { kind: 'dockerLocal', container: dockerContainer }
    }
    // Same for a local `kubectl exec` shell: the pod's filesystem, via the
    // machine's own kubectl.
    if (k8sExec) {
      return {
        kind: 'k8sPod',
        host: { kind: 'local' },
        context: k8sExec.context ?? null,
        namespace: k8sExec.namespace,
        pod: k8sExec.pod,
        container: k8sExec.container ?? null,
      }
    }
    return { kind: 'local', tabId }
  }
  // Inside an SSH session the container/pod is reached through the host
  // session's docker/kubectl CLI; everything else uses the session's SFTP.
  if (dockerContainer) {
    return { kind: 'docker', jumpTabId: tabId, container: dockerContainer }
  }
  if (k8sExec) {
    return {
      kind: 'k8sPod',
      host: { kind: 'ssh', jumpTabId: tabId },
      context: k8sExec.context ?? null,
      namespace: k8sExec.namespace,
      pod: k8sExec.pod,
      container: k8sExec.container ?? null,
    }
  }
  return { kind: 'session', tabId }
}
