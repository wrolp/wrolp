// Device identity formatting (SSH-COMMAND-INDEX-COMPLETION-PLAN §2.A).
//
// The status bar has room for a hint of the identity, not the whole thing, and an
// OpenSSH SHA256 digest is 43 base64 characters. Collapsing it is safe because the
// chip answers "is this the machine I think it is", which the first few characters
// do — the tooltip carries the full value for anyone who means to compare it with
// `ssh-keygen -lf`.

/** `SHA256:abcdefgh…` → `SHA256:abcd…`. A fallback id (`local:box`) passes through. */
export function shortFingerprint(fingerprint: string): string {
  const m = /^(SHA256|SHA512):(.+)$/.exec(fingerprint)
  if (!m) return fingerprint
  return `${m[1]}:${m[2].slice(0, 4)}…`
}
