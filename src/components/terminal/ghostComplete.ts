// Ghost command completion — the pure half.
//
// The user types, and the tail of the likeliest command appears in grey after the
// caret (→ applies it); Tab opens the rest of the matches as a list. Candidates
// come from the three pools the app already owns: what has been run in this
// terminal, what has been run anywhere (the persisted history), and what the user
// added themselves (command snippets and command sets).
//
// This is §2.C of task/plans/SSH-COMMAND-INDEX-COMPLETION-PLAN.md restricted to
// those local pools — the plan's remote `$PATH` index (its P0/P1, device
// fingerprints and a `compgen` enumeration) is NOT part of it, so nothing here
// runs a command on the far side.
//
// Nothing in here touches xterm, React or IPC, so `e2e/ui/ghost-complete.spec.ts`
// can exercise every branch directly.
//
// NOTE: the `./cdSuggest.ts` import carries an explicit extension on purpose —
// Node's type-stripping resolver cannot follow extensionless TS specifiers
// (see the same note in that file). `import type` is erased before resolution, so
// the type-only imports below do not need it.

import type { CommandHistoryEntry, CommandSetDto, CommandSnippetDto } from '../../types'
import { clearLineBytes, type CdShellKind } from './cdSuggest.ts'

/** Where a candidate came from. Decides its rank and the badge on its row. */
export type GhostSource = 'history' | 'snippet' | 'set'

export interface GhostCandidate {
  /** The whole command line a pick leaves on the input line. */
  command: string
  source: GhostSource
  /** What the user calls it (snippet alias, set name); empty for history. */
  label: string
}

/** The highest number of candidates the list renders at once. */
export const GHOST_MAX_ROWS = 8

/**
 * A curated command outranks an incidental one: the library is what the user said
 * they meant to run, the history is only what happened to be run here (plan §2.B).
 */
const SOURCE_WEIGHT: Record<GhostSource, number> = { snippet: 3, set: 2, history: 1 }

/**
 * A candidate must land on the input line as one line. A snippet may hold several
 * (the paste pipeline would then have to be consulted), and anything with a
 * control byte could carry keystrokes we would be typing into the shell without
 * being asked for — so those never enter the pool at all.
 */
function isSinglePrintableLine(command: string): boolean {
  return command.length > 0 && !/[\x00-\x1f\x7f]/.test(command)
}

export interface GhostPoolInput {
  snippets: readonly CommandSnippetDto[]
  sets: readonly CommandSetDto[]
  /** This terminal's history, newest first. */
  tabHistory: readonly string[]
  /** The persisted cross-tab history, newest first. */
  globalHistory: readonly CommandHistoryEntry[]
  /** Scope for the two libraries: a `null` entry is general and always applies. */
  connectionId?: string | null
}

/**
 * The pools merged into one candidate list.
 *
 * The library goes first so a command the user both curated and ran keeps its
 * curated badge, and the two histories keep their newest-first order, which is the
 * tie-break among themselves. Everything else (the source weights) is applied by
 * `matchGhost`, so this order is only ever a tie-break.
 */
export function buildGhostPool(input: GhostPoolInput): GhostCandidate[] {
  const inScope = (connectionId: string | null | undefined) =>
    !connectionId || connectionId === input.connectionId
  const rows: GhostCandidate[] = []
  const seen = new Set<string>()
  const push = (command: string, source: GhostSource, label: string) => {
    const cmd = command.trim()
    if (!isSinglePrintableLine(cmd) || seen.has(cmd)) return
    seen.add(cmd)
    rows.push({ command: cmd, source, label })
  }
  for (const snippet of input.snippets) {
    if (snippet.hidden || !inScope(snippet.connectionId)) continue
    push(snippet.command, 'snippet', (snippet.alias ?? snippet.description ?? '').trim())
  }
  for (const set of input.sets) {
    if (!inScope(set.connectionId)) continue
    for (const command of set.commands) push(command, 'set', set.name)
  }
  for (const command of input.tabHistory) push(command, 'history', '')
  for (const entry of input.globalHistory) push(entry.command, 'history', '')
  return rows
}

/**
 * Candidates that start with what has been typed, best first: a case-exact prefix
 * before a case-insensitive one, then by source, then newest first.
 *
 * A candidate equal to the typed line is dropped — there is nothing left to add,
 * and offering it would paint grey over what is already there.
 */
export function matchGhost(
  pool: readonly GhostCandidate[],
  typed: string,
  limit = GHOST_MAX_ROWS,
): GhostCandidate[] {
  if (!typed) return []
  const lower = typed.toLowerCase()
  const scored: { candidate: GhostCandidate; exact: boolean; weight: number }[] = []
  for (const candidate of pool) {
    const { command } = candidate
    if (command.length <= typed.length) continue
    const exact = command.startsWith(typed)
    if (!exact && !command.toLowerCase().startsWith(lower)) continue
    scored.push({ candidate, exact, weight: SOURCE_WEIGHT[candidate.source] })
  }
  scored.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1
    return b.weight - a.weight
  })
  return scored.slice(0, limit).map((s) => s.candidate)
}

/** How far one accept goes. */
export type GhostAcceptMode = 'word' | 'all'

/**
 * The grey tail to paint after the caret, or `null` when the candidate cannot be
 * reached by typing alone — which is any case difference: `GIT s` + `tatus` is
 * `GIT status`, and a Linux shell would refuse that command. Such a candidate is
 * still worth listing (its row shows the whole command), it just gets rewritten
 * into the line on a pick rather than appended.
 */
export function ghostRemainder(typed: string, command: string): string | null {
  if (command.length <= typed.length) return null
  if (!command.startsWith(typed)) return null
  return command.slice(typed.length)
}

/**
 * Just the nearest space-separated part of the tail — what one → takes in `word`
 * mode.
 *
 * Leading blanks travel with the part behind them, so walking the tail of
 * `git s` → `git status -sb` yields `tatus`, then ` -sb`, then nothing: every
 * press lands a whole word, and none lands a bare space the user cannot see
 * happening.
 */
export function ghostWordRemainder(typed: string, command: string): string | null {
  const rest = ghostRemainder(typed, command)
  if (!rest) return rest
  const blanks = /^\s+/.exec(rest)?.[0].length ?? 0
  const cut = rest.indexOf(' ', blanks)
  return cut < 0 ? rest : rest.slice(0, cut)
}

/**
 * The bytes that put `command` on the input line.
 *
 * Typing just the missing tail is preferred: the shell's own line editor keeps
 * every byte it already echoed, so nothing about the caret or the history search
 * is disturbed. Only a case mismatch (`git STAT` → `git status`) needs the line
 * wiped first — `clearLineBytes` is the same rule the `cd` dropdown uses.
 *
 * `word` takes only the nearest part of that tail; a pick from the candidate list
 * always means `all`, because there the whole command is the thing that was
 * chosen.
 */
export function planGhostAccept(
  typed: string,
  command: string,
  shell: CdShellKind,
  mode: GhostAcceptMode = 'all',
): string {
  const rest = mode === 'word' ? ghostWordRemainder(typed, command) : ghostRemainder(typed, command)
  if (rest !== null) return rest
  return `${clearLineBytes(shell)}${command}`
}
