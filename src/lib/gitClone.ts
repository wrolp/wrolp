// Where a clone lands, derived from the URL.
//
// `git clone <url>` with no destination creates a folder named after the last
// path segment of the URL (`…/demo.git` → `demo`). The picker's destination field
// used to prefill the folder the user happened to be browsing, so a clone of
// `demo` landed *in* that folder and git failed with "already exists" (or nested
// the repository one level too deep). It now shows the same name git would use,
// and keeps following it until the user edits the field.

/** `git@host:group/repo.git` — a URL form where `:` separates host from path. */
const SCP_LIKE = /^[^/@:]+@[^/:]+:(.+)$/
/** `https://`, `ssh://`, `git+ssh://` — anything with an authority. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** The folder name a clone of `url` would create, or `null` when unknowable. */
export function projectNameFromUrl(url: string): string | null {
  const raw = url.trim()
  if (!raw) return null
  // `?ref=` / `#branch` are not part of the path.
  let path = raw.split(/[?#]/)[0]
  if (SCHEME.test(path)) {
    const rest = path.replace(SCHEME, '')
    const slash = rest.indexOf('/')
    // Host with no path: there is no repository name to take.
    if (slash < 0) return null
    path = rest.slice(slash)
  } else {
    const scp = path.match(SCP_LIKE)
    if (scp) path = scp[1]
  }
  // A local source may use either separator; trailing separators are not a name.
  path = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!path) return null
  const last = path.slice(path.lastIndexOf('/') + 1)
  const name = last.replace(/\.git$/i, '')
  return name || null
}

/**
 * The destination field's default: `parent`, then the project name.
 *
 * The separator follows `parent` — `D:\repos` joins with `\`, `/srv/repos` with
 * `/` — so the path stays valid on the host being cloned to.
 */
export function defaultCloneDest(parent: string, url: string): string {
  const dir = parent.trim()
  const name = projectNameFromUrl(url)
  if (!name) return dir
  if (!dir) return name
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}
