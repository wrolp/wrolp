// Terminal output category highlighting — rules, built-in color schemes and the
// pure (non-streaming) colorizer. Everything in this file is side-effect free so
// it can be unit-tested without a Terminal.

export const ANSI_RESET = '\x1b[0m'

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CategoryKey =
  | 'ip'
  | 'mac'
  | 'uuid'
  | 'url'
  | 'email'
  | 'number'
  | 'version'
  | 'date'
  | 'time'
  | 'port'
  | 'path'
  | 'hash'
  | 'keywordError'
  | 'keywordWarn'
  | 'keywordInfo'
  | 'keywordOk'
  | 'tcpState'
  | 'varKey'

/** Engine tie-break order — most specific first (see plan §2.3). */
export const CATEGORY_ORDER: readonly CategoryKey[] = [
  'url',
  'email',
  'ip',
  'mac',
  'uuid',
  'path',
  'date',
  'time',
  'port',
  'hash',
  'keywordError',
  'keywordWarn',
  'keywordInfo',
  'tcpState',
  'keywordOk',
  'version',
  'varKey',
  'number',
]

/** Order used by the settings UI rows (reading-friendly, not matching order). */
export const DISPLAY_ORDER: readonly CategoryKey[] = [
  'ip',
  'mac',
  'uuid',
  'url',
  'email',
  'number',
  'version',
  'date',
  'time',
  'port',
  'path',
  'hash',
  'keywordError',
  'keywordWarn',
  'keywordInfo',
  'keywordOk',
  'tcpState',
  'varKey',
]

export interface CategoryMeta {
  /** i18n key prefix: `highlightRule${key}` is looked up by the settings page. */
  labelKey: string
  /** Short illustrative sample shown muted next to the rule row. */
  sample: string
}

export const CATEGORY_META: Record<CategoryKey, CategoryMeta> = {
  ip: { labelKey: 'highlightRuleIp', sample: '192.168.1.10 / fe80::1' },
  mac: { labelKey: 'highlightRuleMac', sample: 'aa:bb:cc:dd:ee:ff' },
  uuid: { labelKey: 'highlightRuleUuid', sample: '550e8400-e29b-41d4-a716-446655440000' },
  url: { labelKey: 'highlightRuleUrl', sample: 'https://example.com/a' },
  email: { labelKey: 'highlightRuleEmail', sample: 'user@example.com' },
  number: { labelKey: 'highlightRuleNumber', sample: '1024, 3.14, 500ms' },
  version: { labelKey: 'highlightRuleVersion', sample: 'v1.21.0 / go1.22.5 / 2.4.1-alpha' },
  date: { labelKey: 'highlightRuleDate', sample: '2026-09-08' },
  time: { labelKey: 'highlightRuleTime', sample: '14:30:22' },
  port: { labelKey: 'highlightRulePort', sample: ':8080' },
  path: { labelKey: 'highlightRulePath', sample: '/var/log/app.log' },
  hash: { labelKey: 'highlightRuleHash', sample: 'a3f8c1e / 0x1F' },
  keywordError: { labelKey: 'highlightRuleKeywordError', sample: 'error, failed' },
  keywordWarn: { labelKey: 'highlightRuleKeywordWarn', sample: 'warning, timeout' },
  keywordInfo: { labelKey: 'highlightRuleKeywordInfo', sample: 'INFO, DEBUG, TRACE' },
  keywordOk: { labelKey: 'highlightRuleKeywordOk', sample: 'OK, success' },
  tcpState: {
    labelKey: 'highlightRuleTcpState',
    sample: 'LISTENING · ESTABLISHED · TIME_WAIT · HTTP/1.1 200',
  },
  varKey: { labelKey: 'highlightRuleVarKey', sample: '$HOME · MODE=prod' },
}

// ---------------------------------------------------------------------------
// Built-in color schemes
// ---------------------------------------------------------------------------

export type BuiltinSchemeId = 'default' | 'nord' | 'solarized' | 'pastel'
export type SchemeId = BuiltinSchemeId | 'custom'

export interface HighlightScheme {
  id: BuiltinSchemeId
  colors: Record<CategoryKey, string>
}

export const BUILTIN_SCHEMES: readonly HighlightScheme[] = [
  {
    id: 'default',
    colors: {
      ip: '#56b6c2',
      mac: '#d55fde',
      // UUIDs reuse mac's pink-mauve: both are "identifier" tokens and rarely
      // appear on the same line as a MAC address.
      uuid: '#d55fde',
      url: '#61afef',
      email: '#c678dd',
      number: '#d19a66',
      // Version shares the number tone on purpose — it IS numeric data and the
      // two categories never fire on the same token (version wins over number).
      version: '#d19a66',
      date: '#98c379',
      time: '#e5c07b',
      // Port gets its own neutral gray, shared with NO other category (the old
      // red collided with keywordError and read like an error / a number).
      port: '#9a9a9a',
      path: '#67b7a3',
      hash: '#be5046',
      keywordError: '#e06c75',
      keywordWarn: '#e5c07b',
      // INFO/DEBUG/TRACE are "calm" informational levels: a soft periwinkle
      // distinct from error red, warn yellow and ok green.
      keywordInfo: '#7aa2f7',
      keywordOk: '#98c379',
      // TCP states & vars/keys are default OFF; scheme colors still exist so a
      // row always shows a stable swatch.
      tcpState: '#8fa8c9',
      varKey: '#c39ad8',
    },
  },
  {
    id: 'nord',
    colors: {
      ip: '#88c0d0',
      mac: '#d8dee9',
      uuid: '#b48ead',
      url: '#81a1c1',
      email: '#b48ead',
      number: '#d08770',
      version: '#d08770',
      date: '#a3be8c',
      time: '#ebcb8b',
      port: '#8a94a6',
      path: '#8fbcbb',
      hash: '#5e81ac',
      keywordError: '#bf616a',
      keywordWarn: '#ebcb8b',
      keywordInfo: '#81a1c1',
      keywordOk: '#a3be8c',
      tcpState: '#a3b6cc',
      varKey: '#c7a9dd',
    },
  },
  {
    id: 'solarized',
    colors: {
      ip: '#2aa198',
      mac: '#93a1a1',
      uuid: '#6c71c4',
      url: '#268bd2',
      email: '#6c71c4',
      number: '#cb4b16',
      version: '#cb4b16',
      date: '#859900',
      time: '#b58900',
      port: '#839496',
      path: '#42b983',
      hash: '#d33682',
      keywordError: '#dc322f',
      keywordWarn: '#b58900',
      keywordInfo: '#268bd2',
      keywordOk: '#859900',
      tcpState: '#586e75',
      varKey: '#6c71c4',
    },
  },
  {
    id: 'pastel',
    colors: {
      ip: '#8ad4c8',
      mac: '#f48fb1',
      uuid: '#ce93d8',
      url: '#8ab4f8',
      email: '#d7a8e0',
      number: '#f0b27a',
      version: '#f0b27a',
      date: '#a5d6a7',
      time: '#ffe082',
      port: '#a8a8a8',
      path: '#c5e1a5',
      hash: '#bcaaa4',
      keywordError: '#ef9a9a',
      keywordWarn: '#ffe082',
      keywordInfo: '#90caf9',
      keywordOk: '#a5d6a7',
      tcpState: '#8ec5d6',
      varKey: '#b39ddb',
    },
  },
]

const SCHEME_BY_ID = new Map<BuiltinSchemeId, HighlightScheme>(
  BUILTIN_SCHEMES.map((s) => [s.id, s]),
)

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface HighlightCategoryConfig {
  key: CategoryKey
  enabled: boolean
  /** '#rrggbb' hex. Converted to 24-bit SGR at render time. */
  color: string
}

/** A user-authored extra highlight rule (settings → custom regex rules). */
export interface CustomHighlightRule {
  id: string
  /** Display name; may be empty. */
  label: string
  /** JS RegExp source, matched against whole output chunks. */
  pattern: string
  /** '#rrggbb' hex. */
  color: string
  enabled: boolean
}

export interface HighlightConfig {
  version: 1
  /** Global master switch (default on). */
  enabled: boolean
  schemeId: SchemeId
  /** One entry per category, in CATEGORY_ORDER (engine priority). */
  rules: HighlightCategoryConfig[]
  /** User-authored regex rules; painted over built-ins (custom wins). */
  custom: CustomHighlightRule[]
}

/** Categories that ship OFF — only enabled by the user on purpose (B-tier). */
const DEFAULT_OFF = new Set<CategoryKey>(['tcpState', 'varKey'])

export function cloneDefaultConfig(): HighlightConfig {
  const colors = SCHEME_BY_ID.get('default')!.colors
  return {
    version: 1,
    enabled: true,
    schemeId: 'default',
    rules: CATEGORY_ORDER.map((key) => ({
      key,
      enabled: !DEFAULT_OFF.has(key),
      color: colors[key],
    })),
    custom: [],
  }
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

const MAX_CUSTOM_RULES = 32
const MAX_CUSTOM_PATTERN_LEN = 300

/** Validate the persisted custom-rule array; drops structurally bad entries. */
function sanitizeCustomRules(raw: unknown): CustomHighlightRule[] {
  if (!Array.isArray(raw)) return []
  const out: CustomHighlightRule[] = []
  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_RULES) break
    const r = asRecord(item)
    if (!r) continue
    if (typeof r.pattern !== 'string' || r.pattern.length > MAX_CUSTOM_PATTERN_LEN) continue
    out.push({
      id: typeof r.id === 'string' && r.id.length <= 64 ? r.id : `c-${out.length}`,
      label: typeof r.label === 'string' ? r.label.slice(0, 80) : '',
      pattern: r.pattern,
      // Invalid regexes are kept for editing but simply never fire at compile.
      color: isHex(r.color) ? r.color.toLowerCase() : '#c3b8d8',
      enabled: r.enabled !== false,
    })
  }
  return out
}

/**
 * Sanitize anything read from localStorage into a valid HighlightConfig:
 * version bumps, missing/unknown categories, bad colors and unknown scheme ids
 * all fall back to safe defaults. Per-category custom colors are only honored
 * while schemeId === 'custom'.
 */
export function sanitizeConfig(raw: unknown): HighlightConfig {
  const fallback = cloneDefaultConfig()
  const rec = asRecord(raw)
  if (!rec) return fallback

  const schemeId: SchemeId =
    typeof rec.schemeId === 'string' &&
    (rec.schemeId === 'custom' || SCHEME_BY_ID.has(rec.schemeId as BuiltinSchemeId))
      ? (rec.schemeId as SchemeId)
      : 'default'

  const schemeColors =
    schemeId === 'custom'
      ? SCHEME_BY_ID.get('default')!.colors
      : SCHEME_BY_ID.get(schemeId as BuiltinSchemeId)!.colors
  const rawRules = Array.isArray(rec.rules) ? (rec.rules as unknown[]) : []
  const byKey = new Map<string, Record<string, unknown>>()
  for (const r of rawRules) {
    const rr = asRecord(r)
    if (rr && typeof rr.key === 'string') byKey.set(rr.key, rr)
  }

  const rules: HighlightCategoryConfig[] = CATEGORY_ORDER.map((key) => {
    const stored = byKey.get(key)
    let color = schemeColors[key]
    if (schemeId === 'custom' && stored && isHex(stored.color)) color = stored.color
    const enabled = stored ? stored.enabled !== false : !DEFAULT_OFF.has(key)
    return { key, enabled, color }
  })

  return {
    version: 1,
    enabled: rec.enabled !== false,
    schemeId,
    rules,
    custom: sanitizeCustomRules(rec.custom),
  }
}

/** Apply a built-in scheme: overwrite every category color, keep enablement. */
export function applyScheme(config: HighlightConfig, schemeId: BuiltinSchemeId): HighlightConfig {
  const scheme = SCHEME_BY_ID.get(schemeId)
  if (!scheme) return config
  return {
    ...config,
    schemeId,
    rules: config.rules.map((r) => ({ ...r, color: scheme.colors[r.key] })),
  }
}

/** Toggle the global master switch. */
export function setGlobalEnabled(config: HighlightConfig, enabled: boolean): HighlightConfig {
  return { ...config, enabled }
}

/** Toggle one category. */
export function setRuleEnabled(
  config: HighlightConfig,
  key: CategoryKey,
  enabled: boolean,
): HighlightConfig {
  return {
    ...config,
    rules: config.rules.map((r) => (r.key === key ? { ...r, enabled } : r)),
  }
}

/** Change one category's color; this turns the active scheme into 'custom'. */
export function setRuleColor(
  config: HighlightConfig,
  key: CategoryKey,
  color: string,
): HighlightConfig {
  if (!isHex(color)) return config
  return {
    ...config,
    schemeId: 'custom',
    rules: config.rules.map((r) => (r.key === key ? { ...r, color: color.toLowerCase() } : r)),
  }
}

export function isBuiltinSchemeId(v: string): v is BuiltinSchemeId {
  return SCHEME_BY_ID.has(v as BuiltinSchemeId)
}

/** Add or replace one user regex rule (matched by id). Pure. */
export function upsertCustomRule(
  config: HighlightConfig,
  rule: CustomHighlightRule,
): HighlightConfig {
  const exists = config.custom.some((c) => c.id === rule.id)
  return {
    ...config,
    custom: exists
      ? config.custom.map((c) => (c.id === rule.id ? rule : c))
      : [...config.custom, rule],
  }
}

/** Remove a user regex rule. */
export function removeCustomRule(config: HighlightConfig, id: string): HighlightConfig {
  return { ...config, custom: config.custom.filter((c) => c.id !== id) }
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'

// IPv6 (RFC-ish, incl. `::` compression and embedded IPv4). `%zone` is appended
// OUTSIDE the alternation so every compressed form can carry one (not just fe80:).
const IPV6 = [
  '(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}',
  '(?:[0-9a-f]{1,4}:){1,7}:',
  '(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}',
  '(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}',
  '(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}',
  '(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}',
  '(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}',
  '[0-9a-f]{1,4}:(?:(?::[0-9a-f]{1,4}){1,6})',
  ':(?:(?::[0-9a-f]{1,4}){1,7}|:)',
  `::(?:ffff(?::0{1,4})?:)?(?:${OCTET}\\.){3}${OCTET}`,
  `(?:[0-9a-f]{1,4}:){1,4}:(?:${OCTET}\\.){3}${OCTET}`,
].join('|')

const IPV4 = `${OCTET}(?:\\.${OCTET}){3}`

// Literal single patterns first (URL carries '/', so slashes are escaped).
const URL_RE = /(?:https?|ftp):\/\/[^\s<>"'`]+/gi
const EMAIL_RE = /(?<![\w.])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w-])/gi
// The trailing (?![0-9a-fA-F:]) on the IPv6 branch is what makes IPv6 extraction
// complete: an early short alternation branch (e.g. `(?:hex:){1,7}:` on
// `2001:db8::8a2e:…`) would otherwise win and stop at a prefix of the real
// address. Rejecting a following hex/colon makes the engine backtrack to the
// branch covering the whole token.
// The `:port` suffix is deliberately IPv4-only: with IPv6 it would greedily eat a
// digit-only trailing group (e.g. `…:fe8a:1234%15` → base + `:1234` as "port").
// An IPv4 match is allowed to end right before a `:` even without port digits, so
// `0.0.0.0:*` / `0.0.0.0:http` still highlight the address part.
// A `/prefix` (CIDR, e.g. `192.168.33.100/24`, `2001:db8::/64`) is swallowed as
// part of the address so the bare prefix never survives to be mis-colored as a
// number. Prefix length is validated per address family (v4 ≤ 32, v6 ≤ 128).
const IPV4_PREFIX = '(?:3[0-2]|[12]?\\d)'
const IPV6_PREFIX = '(?:12[0-8]|1[01]\\d|[1-9]?\\d)'
const IP_RE = new RegExp(
  `(?<![\\w.])` +
    `(?:(?:${IPV6})(?:%[0-9a-zA-Z._-]+)?(?:\\/${IPV6_PREFIX})?(?!\\.\\d)(?![0-9a-fA-F:])` +
    `|${IPV4}(?::\\d{1,5})?(?:\\/${IPV4_PREFIX})?(?!\\.\\d)(?![0-9a-fA-F]))`,
  'gi',
)
// MAC-48 / EUI-48: six bytes as `aa:bb:cc:dd:ee:ff`, `aa-bb-cc-dd-ee-ff` or Cisco
// `aabb.ccdd.eeff`. Must not be glued into a longer token: a MAC that is a prefix
// of an IPv6 address (`…:11:22`) or embedded in a word/hex run is rejected.
// A trailing '.' is allowed so sentence-final MACs still highlight.
const MAC_RE =
  /(?<![0-9A-Za-z:.-])(?:(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}|(?:[0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}|(?:[0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4})(?![0-9A-Za-z:-])/g
// UUID (8-4-4-4-12). Must not be glued to a word/hyphen run. Without its own
// rule a bare UUID gets smeared: the leading group reads as scientific notation
// (`550e8400` = 550×10⁸⁴⁰⁰) and the tail as plain numbers — both turn orange.
const UUID_RE =
  /(?<![0-9a-zA-Z-])(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9a-zA-Z-])/g
// Dotted version numbers (semver-ish): two or more numeric components, with the
// common attached `v`/`go` prefixes and an optional `-prerelease`/`+build`
// suffix. Runs before `number` so `2.4.1` colors as one unit, not as `2.4`.
// Pure decimals (`3.14`) lack the second dot and stay a number.
const VERSION_RE =
  /(?<![A-Za-z0-9])(?:[vV]|go)?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?![A-Za-z0-9])/g
const DATE_RE = new RegExp(
  // Numeric: `2026-09-08`, `2026/09/08`, `2026年9月8日`.
  String.raw`(?<!\d)(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)(?!\d)|` +
    // C `date`/syslog style: `Wed Sep  9 10:46:20 2026` (%a %b %e %H:%M:%S %Y).
    // The day is space-padded to two columns for values < 10 (`Sep  9`), hence
    // the {1,2} space run before it. The whole token matches in ONE date-colored
    // run (weekday · month · day · time · year), so it reads as a unit.
    String.raw`(?<![0-9A-Za-z])(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(?:[1-9]|[12][0-9]|3[01]) +(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] +[12][0-9]{3}(?![0-9A-Za-z])`,
  'g',
)
const TIME_RE =
  /(?<!\d)(?:\d{1,2}):(?:\d{2})(?::(?:\d{2})(?:[.,]\d{1,3})?)?(?:\s?[APap]\.?[Mm]\.?)?(?![:\d])/g
const PORT_RE = /(?<!\d)(?<!:):\d{1,5}(?!\d)/g
// One character that may appear inside a path segment: anything but whitespace,
// quotes, backtick and the shell metacharacters that delimit a token.
const PATH_CHARS = String.raw`[^\s"'<>|&;():=\u0060]`
// Windows directory names that contain a space and are usually the LAST segment
// of a path, so the space is not followed by any separator: `C:\Program Files`,
// `C:\Program Files (x86)`, `C:\Documents and Settings`. Only the continuation
// (the text after the space) is listed — the leading word is already matched by
// the generic segment. An optional trailing `\rest` keeps
// `C:\Program Files (x86)\Git\bin` in a single token.
const WIN_SPACED_TAIL = String.raw`(?:Files(?: \(x86\))?|and Settings|Volume Information)(?:[\\/]${PATH_CHARS}*)?`
// A Windows drive-root path that tolerates spaces: `C:\Program Files\nodejs\node.exe`.
// A space is only absorbed when what follows still looks like part of a path —
// either it contains a separator, or it completes one of the known spaced
// directory names above. Without that guard a sentence such as
// `see C:\Users and then` would swallow `and then` into the path.
const WIN_PATH = String.raw`[A-Za-z]:[\\/](?=[^\s])${PATH_CHARS}+(?:[ ](?:${PATH_CHARS}*[\\/]${PATH_CHARS}*|${WIN_SPACED_TAIL}))*`
// A quoted path — the quotes are explicit delimiters, so spaces inside are
// unambiguous: `"C:\Program Files\Git\bin\git.exe"`, `'/var/my data/x'`.
const QUOTED_PATH = String.raw`(?:"(?:[A-Za-z]:[\\/]|\\\\|\/|~\/)[^"]*"|'(?:[A-Za-z]:[\\/]|\\\\|\/|~\/)[^']*')`
// UNC share prefix `\\host\share`: the host must be followed by another
// backslash and a non-empty rest — that mandatory second backslash is what keeps
// regex-class escapes in text (like `\d` or `\w`) from ever reading as a share.
const UNC_PREFIX = String.raw`\\\\[^\s\\"'<>|&;():=\u0060]+\\`
// Paths: quoted paths, Windows drive paths (spaces tolerated), UNC shares,
// `~/x`, `./x`, `../x` and `/x`.
const PATH_RE = new RegExp(
  String.raw`(?<![\w])(?:${QUOTED_PATH}|${WIN_PATH}|(?:${UNC_PREFIX}|~\/|\.\/|\.\.\/|\/)(?=[^\s])${PATH_CHARS}*)`,
  'g',
)
// Hash/hex only when it stands alone (whitespace on both sides), so substrings
// of words/paths (e.g. `xdeadbeef`, `0x1F,`) are not highlighted.
const HASH_RE = /(?<!\S)(?:0[xX][0-9a-fA-F]+|[0-9a-fA-F]{7,})(?!\S)/g
const NUMBER_RE =
  /(?<![\w.])(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?(?:ms|us|ns|s|min|h|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|%|px|em|rem|vh|vw|vmin|vmax|deg|Hz|kHz|MHz|GHz|k|M|G)?(?![A-Za-z0-9])/g

function wordPattern(words: readonly string[]): RegExp {
  // IMPORTANT: keep the word list a NON-capturing group. Each category's outer
  // wrapper adds exactly one group, so the combined-regex group index aligns
  // 1:1 with CATEGORY_ORDER (see categoryOf).
  return new RegExp(`(?<![\\w])(?:${words.join('|')})(?![\\w])`, 'gi')
}

const ERROR_WORDS = [
  'error',
  'err',
  'failed',
  'failure',
  'fail',
  'fatal',
  'denied',
  'refused',
  'rejected',
  'exception',
  'aborted',
  'panic',
  'invalid',
  'crash',
  'killed',
  'segfault',
] as const
const WARN_WORDS = [
  'warning',
  'warn',
  'timeout',
  'retry',
  'retrying',
  'deprecated',
  'unavailable',
  'degraded',
  'skipped',
  'stale',
  'expired',
  'caution',
] as const
const OK_WORDS = [
  'ok',
  'success',
  'successful',
  'done',
  'ready',
  'passed',
  'complete',
  'completed',
  'connected',
  'established',
  'upgraded',
] as const
// Calm/informational log levels — complements error/warn/ok with a neutral tier.
const INFO_WORDS = ['info', 'debug', 'trace', 'notice'] as const

const KEYWORD_ERROR_RE = wordPattern(ERROR_WORDS)
const KEYWORD_WARN_RE = wordPattern(WARN_WORDS)
const KEYWORD_INFO_RE = wordPattern(INFO_WORDS)
const KEYWORD_OK_RE = wordPattern(OK_WORDS)

// TCP/UDP connection states (netstat/ss output) plus HTTP status-line heads
// (`HTTP/1.1 200`). Both are default OFF — they read better than a plain
// number/keyword but are not worth imposing on output that merely mentions the
// words. `tcpState` sorts before keywordOk so `established` renders as a state
// token, not a success keyword. Word list keeps '-'/'_' spellings so netstat
// (FIN_WAIT_1), netstat -o (FIN_WAIT1) and `ss` (FIN-WAIT-1) all match.
const STATE_WORDS = [
  'listen',
  'listening',
  'established',
  'estab',
  'syn_sent',
  'syn_recv',
  'syn-sent',
  'syn-recv',
  'fin_wait_1',
  'fin_wait_2',
  'fin-wait-1',
  'fin-wait-2',
  'time_wait',
  'time-wait',
  'close_wait',
  'close-wait',
  'closing',
  'last_ack',
  'last-ack',
  'delete_wait',
  'delete-wait',
  'unconn',
] as const
const KEYWORD_TCP_STATE_RE = new RegExp(
  `HTTP\\/\\d(?:\\.\\d)?\\s+[1-5]\\d\\d(?![0-9])|(?<![\\w])(?:${STATE_WORDS.join('|')})(?![\\w])`,
  'gi',
)

// Environment variables (`$HOME`, `${APP_HOME}`) and assignment keys
// (`KEY=value`, matched without the `=`) — default OFF. The `$` form must not be
// glued to a word or another `$` (lookbehind), which also lets it sit right
// after `=` (`HOME=$HOME`) and after `@` in PowerShell. The key form is only
// anchored after whitespace / line start, so URL queries (`?a=b`) never match.
const VAR_KEY_RE =
  /(?<![$\w])\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)|(?<!\S)[A-Za-z_][A-Za-z0-9_]*(?==(?![=\s]))/g

/**
 * Split a matched IPv4:port token (`0.0.0.0:135`, `192.168.1.10:8080`) so the
 * address and its port can carry different colors. IPv6 never matches: an IPv6
 * token may also end in `:digits` (its last hextet), which must stay address
 * color — the `^…$` dotted-decimal anchor rejects any IPv6 form.
 */
const IPV4_PORT_SPLIT_RE = new RegExp(`^(${IPV4}):(\\d{1,5})$`)

const CATEGORY_PATTERNS: Record<CategoryKey, RegExp> = {
  url: URL_RE,
  email: EMAIL_RE,
  ip: IP_RE,
  mac: MAC_RE,
  uuid: UUID_RE,
  path: PATH_RE,
  date: DATE_RE,
  time: TIME_RE,
  port: PORT_RE,
  hash: HASH_RE,
  keywordError: KEYWORD_ERROR_RE,
  keywordWarn: KEYWORD_WARN_RE,
  keywordInfo: KEYWORD_INFO_RE,
  tcpState: KEYWORD_TCP_STATE_RE,
  keywordOk: KEYWORD_OK_RE,
  version: VERSION_RE,
  varKey: VAR_KEY_RE,
  number: NUMBER_RE,
}

// ---------------------------------------------------------------------------
// Matching / colorizing
// ---------------------------------------------------------------------------

export interface HlSegment {
  text: string
  color?: string
}

export interface HighlightEngine {
  enabled: boolean
  annotate(text: string): HlSegment[]
  colorize(text: string, base?: string): string
}

/** Cap per rule per chunk, so a pathological `\w+`-style regex cannot stall. */
const MAX_OVERLAY_MARKS = 4096

interface HlUnit {
  a: number
  b: number
  text: string
  color?: string
}

/**
 * Compile a rules snapshot into a reusable matcher. Built-in categories are
 * matched first; user `custom` regexes are then painted over the result, so a
 * custom hit (whole match) wins over any built-in token it overlaps. Invalid or
 * empty user patterns are skipped, never thrown.
 */
export function compileHighlighter(
  rules: HighlightCategoryConfig[],
  custom: readonly CustomHighlightRule[] = [],
): HighlightEngine {
  const active = new Map<CategoryKey, string>()
  for (const r of rules) if (r.enabled) active.set(r.key, r.color)
  const customRules: { re: RegExp; color: string }[] = []
  for (const c of custom) {
    const src = (c.pattern || '').trim()
    if (!src || !c.enabled) continue
    try {
      customRules.push({ re: new RegExp(src, 'g'), color: c.color })
    } catch {
      // Invalid user regex: the row stays editable, it just never fires.
    }
  }
  const enabled = active.size > 0 || customRules.length > 0
  const re = new RegExp(
    CATEGORY_ORDER.map((k) => `(${CATEGORY_PATTERNS[k].source})`).join('|'),
    'gi',
  )

  /** Built-in tokens as (start,end,color) units covering the whole text. */
  function builtinUnits(text: string): HlUnit[] {
    const units: HlUnit[] = []
    let last = 0
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const cat = categoryOf(m)
      if (!cat) {
        // Safety: never stall on a zero-width match.
        re.lastIndex = Math.max(re.lastIndex, m.index + 1)
        continue
      }
      const i = m.index
      if (i > last) units.push({ a: last, b: i, text: text.slice(last, i) })
      const full = m[0]
      let shown = full
      if (cat === 'url' || cat === 'path') shown = full.replace(/[.,;:!?)\]}]*$/, '')
      const color = active.get(cat)
      if (cat === 'ip') {
        // IPv4:port — color the address and the `:port` differently (when the
        // port rule is on). A pure IPv6 match never hits this branch.
        const pm = IPV4_PORT_SPLIT_RE.exec(full)
        if (pm) {
          const portColor = active.get('port')
          const ipPart = pm[1]
          const portPart = full.slice(ipPart.length)
          if (portColor && ipPart.length + portPart.length === full.length) {
            units.push({ a: i, b: i + ipPart.length, text: ipPart, color })
            units.push({
              a: i + ipPart.length,
              b: i + full.length,
              text: portPart,
              color: portColor,
            })
            last = i + full.length
            continue
          }
        }
      }
      const shownEnd = i + shown.length
      if (shown) units.push({ a: i, b: shownEnd, text: shown, color })
      const rest = full.slice(shown.length)
      if (rest) units.push({ a: shownEnd, b: i + full.length, text: rest })
      last = i + full.length
    }
    if (last < text.length) units.push({ a: last, b: text.length, text: text.slice(last) })
    return units
  }

  function annotate(text: string): HlSegment[] {
    if (!text) return []
    if (!enabled) return [{ text }]
    if (customRules.length === 0 && !/[A-Za-z0-9@:]/.test(text)) return [{ text }]
    let units = builtinUnits(text)
    if (customRules.length > 0) {
      for (const r of customRules) units = applyRuleMarks(units, text, r)
    }
    return mergePlainUnits(units)
  }

  function colorize(text: string, base = ''): string {
    return annotate(text)
      .map((s) => {
        if (!s.color) return s.text
        return `${ANSI_RESET}${toAnsiFg(s.color)}${s.text}${base || ANSI_RESET}`
      })
      .join('')
  }

  return { enabled, annotate, colorize }
}

/** Repaint every unit overlapping [a,b) with `color` (custom rules win). */
function paintRange(units: HlUnit[], a: number, b: number, color: string): HlUnit[] {
  const out: HlUnit[] = []
  for (const u of units) {
    if (b <= u.a || a >= u.b) {
      out.push(u)
      continue
    }
    if (a > u.a) {
      out.push({ a: u.a, b: a, text: u.text.slice(0, a - u.a), color: u.color })
    }
    const from = Math.max(a, u.a)
    const to = Math.min(b, u.b)
    if (to > from) {
      out.push({ a: from, b: to, text: u.text.slice(from - u.a, to - u.a), color })
    }
    if (b < u.b) {
      out.push({ a: b, b: u.b, text: u.text.slice(b - u.a), color: u.color })
    }
  }
  return out
}

/** Collect one rule's matches over `text` and paint each into the unit list. */
function applyRuleMarks(
  units: HlUnit[],
  text: string,
  rule: { re: RegExp; color: string },
): HlUnit[] {
  rule.re.lastIndex = 0
  let applied = 0
  let m: RegExpExecArray | null
  while ((m = rule.re.exec(text))) {
    const a = m.index
    const b = a + m[0].length
    if (b <= a) {
      rule.re.lastIndex = Math.max(rule.re.lastIndex, a + 1)
      continue
    }
    units = paintRange(units, a, b, rule.color)
    if (++applied >= MAX_OVERLAY_MARKS) break
  }
  return units
}

function categoryOf(m: RegExpExecArray): CategoryKey | null {
  for (let i = 0; i < CATEGORY_ORDER.length; i++) {
    if (m[i + 1] !== undefined) return CATEGORY_ORDER[i]
  }
  return null
}

function mergePlainUnits(units: HlUnit[]): HlSegment[] {
  const out: HlSegment[] = []
  for (const u of units) {
    if (!u.text) continue
    const prev = out[out.length - 1]
    if (!u.color && prev && !prev.color) prev.text += u.text
    else out.push({ text: u.text, color: u.color })
  }
  return out
}

export function colorizeText(
  text: string,
  rules: HighlightCategoryConfig[],
  base = '',
  custom: readonly CustomHighlightRule[] = [],
): string {
  return compileHighlighter(rules, custom).colorize(text, base)
}

function toAnsiFg(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

/** Sample line exercising every category — used by the settings preview. */
export const HIGHLIGHT_SAMPLE =
  '2026-09-08 14:30:22 [INFO] deploy ok · 192.168.1.10:8080 · 192.168.33.0/24 · fe80::1%18 · ' +
  'aa:bb:cc:dd:ee:ff · 550e8400-e29b-41d4-a716-446655440000 · user@example.com · ' +
  'https://example.com/x?v=1 · /var/log/app.log · v1.21.0 · go1.22.5 · commit a3f8c1e · 0x1F · ' +
  '1.2ms · Wed Sep  9 10:46:20 2026 · C:\\Program Files\\nodejs\\node.exe · error: timeout'
