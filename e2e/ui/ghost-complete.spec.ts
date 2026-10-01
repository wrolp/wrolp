import { test, expect } from '@playwright/test'
import type { CommandHistoryEntry, CommandSetDto, CommandSnippetDto } from '../../src/types'
import {
  GHOST_MAX_ROWS,
  buildGhostPool,
  ghostRemainder,
  ghostWordRemainder,
  matchGhost,
  planGhostAccept,
} from '../../src/components/terminal/ghostComplete'

// What the ghost completion may offer, and what applying it costs the input line.
//
// The rule the whole module is built around: a candidate is only ever a longer
// version of what is already typed, and accepting it types the missing tail — so
// the shell's own line editor keeps every byte it echoed, and nothing is ever run.

const snippet = (command: string, over: Partial<CommandSnippetDto> = {}): CommandSnippetDto => ({
  id: command,
  command,
  alias: null,
  favorite: false,
  hidden: false,
  sortOrder: 0,
  connectionId: null,
  groupName: null,
  description: null,
  params: [],
  options: [],
  createdAt: '',
  updatedAt: '',
  ...over,
})

const set = (name: string, commands: string[], connectionId: string | null = null) =>
  ({
    id: name,
    name,
    connectionId,
    commands,
    createdAt: '',
    updatedAt: '',
  }) satisfies CommandSetDto

const history = (command: string) =>
  ({ command, tabType: 'terminal', host: 'demo.local', usedAtMs: 1 }) satisfies CommandHistoryEntry

test('the pool merges the histories and the library, newest and curated first', () => {
  const pool = buildGhostPool({
    snippets: [
      snippet('git status -sb', { alias: 'short status' }),
      // Invisible to the user, so invisible to the completion too.
      snippet('rm -rf /tmp/x', { hidden: true }),
      // A multi-line snippet would inject a whole script through the "insert"
      // path, so it never enters the pool at all.
      snippet('docker run -it alpine\necho bye'),
    ],
    sets: [set('lab', ['kubectl get pods', 'kubectl get pods -A'])],
    tabHistory: ['git commit -m x', 'git commit -m x', 'ls -la'],
    globalHistory: [
      { command: 'df -h', tabType: 'terminal', host: 'other', usedAtMs: 10 },
      // Same command already run here: the per-terminal entry wins, because the
      // pool is newest-first and never repeats a line.
      { command: 'git commit -m x', tabType: 'terminal', host: 'other', usedAtMs: 20 },
    ],
    connectionId: null,
  })
  expect(pool.map((c) => c.command)).toEqual([
    'git status -sb',
    'kubectl get pods',
    'kubectl get pods -A',
    'git commit -m x',
    'ls -la',
    'df -h',
  ])
  // The badge a row shows: whose command it is, and what the user calls it.
  expect(pool[0]).toEqual({ command: 'git status -sb', source: 'snippet', label: 'short status' })
  expect(pool[1]).toEqual({ command: 'kubectl get pods', source: 'set', label: 'lab' })
  expect(pool[3]).toEqual({ command: 'git commit -m x', source: 'history', label: '' })
})

test('a connection-scoped command is not offered on another connection', () => {
  const library = {
    snippets: [
      snippet('ipmitool chassis status', { connectionId: 'c2' }),
      snippet('uptime', { connectionId: null }),
    ],
    sets: [set('edge', ['snmpwalk -v2c public 1.1.1.1'], 'c2')],
  }
  // A local shell (no connection at all) sees everything general.
  expect(
    buildGhostPool({ ...library, tabHistory: [], globalHistory: [], connectionId: 'c1' }),
  ).toEqual([{ command: 'uptime', source: 'snippet', label: '' }])
  expect(
    buildGhostPool({ ...library, tabHistory: [], globalHistory: [], connectionId: 'c2' }),
  ).toHaveLength(3)
})

test('a candidate must extend what was typed, from its start', () => {
  const pool = buildGhostPool({
    snippets: [
      snippet('git status -sb'),
      snippet('git stash'),
      snippet('status'),
      snippet('git'),
      snippet('GIT LOG'),
    ],
    sets: [],
    tabHistory: [],
    globalHistory: [],
  })
  // `status` matches nothing here: completion is a prefix of the whole line, not a
  // substring, so a typed `git ` cannot be answered by a bare `status`.
  expect(matchGhost(pool, 'git s').map((c) => c.command)).toEqual(['git status -sb', 'git stash'])
  // Equal to the input ⇒ nothing left to add.
  expect(matchGhost(pool, 'git').map((c) => c.command)).not.toContain('git')
  // Case-insensitive reach, so `GIT l` still finds the library's `GIT LOG`.
  expect(matchGhost(pool, 'GIT l').map((c) => c.command)).toEqual(['GIT LOG'])
  expect(matchGhost(pool, '')).toEqual([])
})

test('the exact-typed prefix wins, then the curated command', () => {
  const pool = buildGhostPool({
    snippets: [snippet('git switch')],
    sets: [set('daily', ['git stash push'])],
    tabHistory: ['git status', 'git stage'],
    globalHistory: [],
  })
  // History (weight 1) beats nothing: a snippet (3) then a set (2) then history.
  expect(matchGhost(pool, 'git s').map((c) => c.command)).toEqual([
    'git switch',
    'git stash push',
    'git status',
    'git stage',
  ])
  // And a case-exact history hit is offered before a case-different curated one.
  const exact = buildGhostPool({
    snippets: [snippet('Git Switch')],
    sets: [],
    tabHistory: ['git switch main'],
    globalHistory: [],
  })
  expect(matchGhost(exact, 'git s').map((c) => c.command)).toEqual([
    'git switch main',
    'Git Switch',
  ])
})

test('the list is capped, because it hangs over the terminal', () => {
  const pool = buildGhostPool({
    snippets: Array.from({ length: GHOST_MAX_ROWS + 6 }, (_, i) => snippet(`do thing ${i}`)),
    sets: [],
    tabHistory: [],
    globalHistory: [],
  })
  expect(matchGhost(pool, 'do ')).toHaveLength(GHOST_MAX_ROWS)
})

test('appending the tail is the rule, rewriting the line the exception', () => {
  expect(ghostRemainder('git s', 'git status -sb')).toBe('tatus -sb')
  // A case difference is NOT appendable: `GIT s` + `tatus` would leave
  // `GIT status` on the line, which a Linux shell refuses to run. The candidate
  // still gets listed, it just replaces the line on a pick.
  expect(ghostRemainder('GIT s', 'git status')).toBeNull()
  expect(ghostRemainder('git log', 'git status')).toBeNull()

  expect(planGhostAccept('git s', 'git status -sb', 'posix')).toBe('tatus -sb')
  // Nothing to append: readline gets Ctrl-A Ctrl-K, the same clear the `cd`
  // dropdown uses, then the whole command.
  expect(planGhostAccept('GIT s', 'git status', 'posix')).toBe('\x01\x0bgit status')
  expect(planGhostAccept('GIT s', 'git status', 'windows')).toBe('\x1bgit status')
})

test('a word accept takes one space-separated part, blanks travelling with what follows', () => {
  // The part ends at the next space; the press after it starts with that space, so
  // no press ever lands a bare space and looks like nothing happened.
  expect(ghostWordRemainder('git s', 'git status -sb')).toBe('tatus')
  expect(ghostWordRemainder('git status', 'git status -sb')).toBe(' -sb')
  expect(ghostWordRemainder('git status ', 'git status -sb')).toBe('-sb')
  expect(ghostWordRemainder('git status -s', 'git status -sb')).toBe('b')
  expect(ghostWordRemainder('git', 'git status')).toBe(' status')
  // A tail that is already one part is the same tail either mode offers.
  expect(ghostWordRemainder('git statu', 'git status')).toBe('s')
  // Same null as the whole tail when only the case differs.
  expect(ghostWordRemainder('GIT s', 'git status')).toBeNull()

  expect(planGhostAccept('git s', 'git status -sb', 'posix', 'word')).toBe('tatus')
  expect(planGhostAccept('git s', 'git status -sb', 'posix', 'all')).toBe('tatus -sb')
  // A case mismatch falls back to rewriting the whole line in both modes: part of a
  // command cannot be appended to a prefix whose casing is wrong.
  expect(planGhostAccept('GIT s', 'git status', 'posix', 'word')).toBe('\x01\x0bgit status')
})

test('the device index reaches the pool last and outranks nothing', () => {
  const pool = buildGhostPool({
    snippets: [snippet('kubectl get pods')],
    sets: [set('ops', ['docker compose up'])],
    tabHistory: ['git status'],
    globalHistory: [history('git commit')],
    hostIndex: ['git', 'gitk', 'github', 'du', ''],
  })
  const sources = Object.fromEntries(pool.map((c) => [c.command, c.source]))
  expect(sources).toEqual({
    'kubectl get pods': 'snippet',
    'docker compose up': 'set',
    'git status': 'history',
    'git commit': 'history',
    git: 'index',
    gitk: 'index',
    github: 'index',
    du: 'index',
  })

  // Ranked below everything else, so an installed binary never beats a command the
  // user actually meant. Among themselves the index keeps the DB's order.
  const matches = matchGhost(pool, 'gi')
  expect(matches.map((m) => m.command)).toEqual([
    'git status',
    'git commit',
    'git',
    'gitk',
    'github',
  ])
})

test('index names only complete the first word of a line', () => {
  // The index holds command names, not lines. Once the line has moved past the
  // first word, a name that merely shares its spelling must not be offered:
  // `git stat` + `gitk` would leave `gitk stat` on the line.
  const pool = buildGhostPool({
    snippets: [],
    sets: [],
    tabHistory: [],
    globalHistory: [],
    hostIndex: ['du', 'git-credential', 'gitk'],
  })
  // Order among equal-weight candidates is pool order, which for the index is the
  // DB's `ORDER BY command` — so the array below is written the way a read arrives.
  expect(matchGhost(pool, 'git').map((m) => m.command)).toEqual(['git-credential', 'gitk'])
  // Once the line is past its first word, a name that merely shares the spelling is
  // no candidate at all: completing `git stat` with `gitk` would leave `gitk stat`.
  expect(matchGhost(pool, 'git stat')).toEqual([])
  expect(matchGhost(pool, 'd').map((m) => m.command)).toEqual(['du'])
})

test('a command in both the history and the index keeps its history rank', () => {
  // Dedupe must favour the higher-weight source, or a run command would be
  // re-badged as "on this device" and drop behind its own siblings.
  const pool = buildGhostPool({
    snippets: [],
    sets: [],
    tabHistory: ['docker ps'],
    globalHistory: [],
    hostIndex: ['docker', 'docker-compose', 'docker'],
  })
  expect(pool.map((c) => `${c.command}:${c.source}`)).toEqual([
    'docker ps:history',
    'docker:index',
    'docker-compose:index',
  ])
})
