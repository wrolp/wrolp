/**
 * Parse `ls` / `dir` terminal output into clickable entries (name + kind +
 * column + line) so the terminal can overlay clickable decorations.
 *
 * Scope: single-column `ls -l`-style output (`ls -l`/`ll`/`la`), Windows
 * `dir`, and plain multi-column / single-column `ls` (no `-l`). Plain `ls`
 * output carries no per-entry type info, so entries are tagged `unknown` and
 * the click handler resolves dir-vs-file at click time via a directory
 * listing. `ls -F`/`--classify` appends a type indicator (`/ @ * = |`) that
 * lets us infer the kind directly.
 */

export type LsEntryKind = 'dir' | 'file' | 'link' | 'unknown'
export type LsFormat = 'long' | 'dir' | 'multi' | 'multiF'

export interface LsEntry {
  name: string
  kind: LsEntryKind
  /** 0-based column of the name's first character within its line. */
  col: number
  /** Line index within the captured output block (0 = the echoed command). */
  line: number
}

/**
 * Recognize an `ls`-style listing command and return its output format, or
 * null if the command doesn't produce a parseable single-column listing.
 */
export function detectLsCommand(rawCmd: string): LsFormat | null {
  const tokens = rawCmd.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const prog = (tokens[0].split(/[\\/]/).pop() ?? tokens[0]).toLowerCase()

  // Windows `dir`. `/w`/`/b`/`/s` etc. change the layout — only handle plain `dir`.
  if (prog === 'dir') {
    if (tokens.slice(1).some((t) => t.startsWith('/'))) return null
    return 'dir'
  }

  if (!['ls', 'll', 'la', 'l', 'vdir'].includes(prog)) return null
  // `ll`/`la`/`l`/`vdir` are long-format (`ls -l`) aliases.
  if (prog !== 'ls') return 'long'

  const args = tokens.slice(1)
  // Globs / explicit path arguments make column positions unpredictable.
  for (const a of args) {
    if (!a.startsWith('-') && /[*?[\]{}]/.test(a)) return null
  }
  const flags = args.filter((a) => a.startsWith('-'))
  const hasLong = flags.some((a) => {
    if (a === '--format=long' || a === '--format=verbose') return true
    if (a.startsWith('--')) return false
    // Short flag cluster containing l/o/g (e.g. -l, -la, -al, -lh, -ltr).
    return /[log]/.test(a.slice(1))
  })
  if (hasLong) return 'long'
  // Reject -R/--recursive: its output interleaves subdirectory headers
  // (`./sub:`) which aren't file names and would parse as bogus entries.
  const hasRecursive = flags.some((a) => {
    if (a === '--recursive') return true
    if (a.startsWith('--')) return false
    return /R/.test(a.slice(1))
  })
  if (hasRecursive) return null
  // -F/--classify appends a type indicator to each name (/ @ * = |), which
  // lets us distinguish dirs/links/files even in multi-column output.
  const hasClassify = flags.some((a) => {
    if (a === '--classify' || a === '--indicator-style=slash') return true
    if (a.startsWith('--')) return false
    return /F/.test(a.slice(1))
  })
  return hasClassify ? 'multiF' : 'multi'
}

/**
 * Parse a captured `ls`-style output block (echo line included at index 0).
 * Non-entry lines (the echo, `total N`, headers, the trailing prompt) are
 * skipped. Returns [] when the block is too large to decorate safely.
 */
export function parseLsBlock(text: string, format: LsFormat, maxLines = 200): LsEntry[] {
  const lines = text.split('\n')
  if (lines.length > maxLines + 1) return []
  const out: LsEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (format === 'multi' || format === 'multiF') {
      for (const e of parseMultiLine(line, format === 'multiF')) out.push({ ...e, line: i })
    } else if (format === 'dir') {
      const entry = parseDirLine(line)
      if (entry) out.push({ ...entry, line: i })
    } else {
      const entry = parseLongLine(line)
      if (entry) out.push({ ...entry, line: i })
    }
  }
  return out
}

/**
 * Parse one plain `ls` line (multi-column or single-column, no `-l`). Each
 * whitespace-separated token is a name. With `-F`/`--classify` (`classify =
 * true`), a trailing indicator reveals the kind:
 *   `/` → dir, `@` → link, `*`/`=`/`|` → file.
 * Without `-F` the kind is `unknown` and resolved at click time.
 *
 * Names containing spaces can't be reliably split this way — GNU `ls` quotes
 * such names (single quotes / `"` / `?` escapes) when output is to a terminal,
 * but untangling that is deferred; the common case (no spaces) is handled.
 */
function parseMultiLine(line: string, classify: boolean): Omit<LsEntry, 'line'>[] {
  const out: Omit<LsEntry, 'line'>[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const raw = m[0]
    let name = raw
    let kind: LsEntryKind = 'unknown'
    if (classify && /[@*=|/]$/.test(raw) && raw.length > 1) {
      const ind = raw[raw.length - 1]
      name = raw.slice(0, -1)
      kind = ind === '/' ? 'dir' : ind === '@' ? 'link' : 'file'
    }
    if (!name) continue
    out.push({ name, kind, col: m.index })
  }
  return out
}

/** Parse one `ls -l`/`ll`/`la` line (Unix long format). */
function parseLongLine(line: string): Omit<LsEntry, 'line'> | null {
  const t = line.replace(/\s+$/, '')
  if (!t) return null
  const first = t[0]
  let kind: LsEntryKind
  if (first === 'd') kind = 'dir'
  else if (first === 'l') kind = 'link'
  else if (first === '-') kind = 'file'
  else return null // header / error / `total N` / prompt — not an entry

  // The name begins after the 8th whitespace-separated field
  // (mode links user group size month day time).
  const m = /^\S+\s+(\S+\s+){7}/.exec(t)
  if (!m) return null
  const nameStart = m[0].length
  let name = t.slice(nameStart)
  if (kind === 'link') {
    const arrow = name.indexOf(' -> ')
    if (arrow > 0) name = name.slice(0, arrow)
  }
  name = name.replace(/\s+$/, '')
  if (!name) return null
  return { name, kind, col: nameStart }
}

/** Parse one Windows `dir` line. */
function parseDirLine(line: string): Omit<LsEntry, 'line'> | null {
  const t = line.replace(/\s+$/, '')
  if (!t) return null
  // Entries look like: `MM/DD/YYYY  HH:MM AM  <DIR>          name`
  // or                 `MM/DD/YYYY  HH:MM AM      1,234  name`
  const m = /^(\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?\s+)(<DIR>|\d[\d,]*)\s+(.+)$/i.exec(
    t,
  )
  if (!m) return null
  const kind: LsEntryKind = m[2].toUpperCase() === '<DIR>' ? 'dir' : 'file'
  const name = m[3]
  if (!name) return null
  return { name, kind, col: t.length - name.length }
}

/**
 * Best-effort extraction of the working directory from a local shell prompt
 * (for local shells, where there is no `pwd` query command). Returns null when
 * the prompt doesn't encode a recognisable path.
 */
export function extractCwdFromPrompt(prompt: string): string | null {
  const p = prompt.trim()
  if (!p) return null
  // PowerShell: `PS C:\Users\me>` / `PS /home/me>`
  if (/^PS\s+.+>$/.test(p)) {
    const inner = p
      .replace(/^PS\s+/, '')
      .replace(/>\s*$/, '')
      .trim()
    return inner || null
  }
  // cmd.exe: `C:\Users\me>` / `D:\>` (no leading prompt decoration)
  if (/^[A-Za-z]:\\[^\n]*>$/.test(p)) {
    return p.replace(/>\s*$/, '').trim() || null
  }
  // bash/zsh: `user@host:~/dir$` / `user@host:/abs/path$` / `~/dir#`
  const m = /^[^$#%]*[:](.+)[$#%]\s*$/.exec(p)
  if (m) {
    const dir = m[1].trim()
    return dir || null
  }
  return null
}
