// Self-check for the editor's shell syntax highlighting (B57 + regressions).
//
// Run with:  node tests/check-shell-highlight.mjs
//
// Node >= 22.18 can import TypeScript directly (type stripping). shellLanguage.ts
// is a side-effect-free data module, so it loads without a DOM. The tokenizer we
// drive is Monaco's own MonarchTokenizer — the exact code the editor runs — fed
// with the language service / config service stubs its constructor expects.

import assert from 'node:assert/strict'
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js'
import { MonarchTokenizer } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js'
import { shellMonarchLanguage } from '../src/editor/shellLanguage.ts'

const noop = { dispose() {} }
const languageService = {
  onDidChange: () => noop,
  getLanguageIdByLanguageName: () => undefined,
  getLanguageIdByLanguageId: (id) => id,
  isRegisteredLanguageId: () => true,
  getConfigurationById: () => null,
}
const configService = {
  getValue: () => 200000, // editor.maxTokenizationLineLength — never bail out here
  onDidChangeConfiguration: () => noop,
}

const tokenizer = new MonarchTokenizer(
  languageService,
  null,
  'shell',
  compile('shell', shellMonarchLanguage),
  configService,
)

/** Segments of one line tokenized from the root state. */
function tokensOf(line) {
  return collect(line, tokenizer.getInitialState())
}

/** Segments of one line starting in `state`; each carries its own end state. */
function collect(line, state) {
  const res = tokenizer.tokenize(line, false, state)
  const toks = res.tokens
  return toks.map((t, i) => ({
    start: t.offset,
    end: i + 1 < toks.length ? toks[i + 1].offset : line.length,
    text: line.substring(t.offset, i + 1 < toks.length ? toks[i + 1].offset : line.length),
    // tokenPostfix: '.shell' is appended by Monaco — compare without it
    type: t.type.replace(/\.shell$/, ''),
    endState: res.endState,
  }))
}

/** Token type of the segment covering the first occurrence of `sub`. */
function typeOf(line, sub) {
  const at = line.indexOf(sub)
  assert.notEqual(at, -1, `fixture does not contain ${JSON.stringify(sub)}`)
  const hit = tokensOf(line).find((t) => t.start <= at && at < t.end)
  assert.ok(hit, `no token covers ${JSON.stringify(sub)} in ${JSON.stringify(line)}`)
  return hit.type
}

/** Text of every segment whose type is (or starts with) `type`. */
function joined(toks, type) {
  return toks
    .filter((t) => t.type === type || t.type.startsWith(type + '.'))
    .map((t) => t.text)
    .join('')
}

function textOfType(line, type) {
  return joined(tokensOf(line), type)
}

/** Segments per line, carrying state across lines exactly like Monaco does. */
function tokenizeAll(lines) {
  let state = tokenizer.getInitialState()
  return lines.map((l) => {
    const toks = collect(l, state)
    state = toks.length ? toks[toks.length - 1].endState : state
    return toks
  })
}

/** Does the line come back to root state (nothing left open)? */
function closesCleanly(line) {
  return stateAfter(line) === 'root'
}

/** Name of the state the line ends in — `root`, `heredoc.EOF`, `doubleQuoted`… */
function stateAfter(line) {
  const toks = tokensOf(line)
  return toks[toks.length - 1].endState.stack.state
}

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

const SED_CLASS = `valid_chars=$(printf '%s' "\${SYSTEM_NAME}" | sed -e 's/[][!#$%&()*;<=>?\\_\`{|}/[:space:]]/^/g;' )`
const FOLLOW_UP = `    if [ "\${SYSTEM_NAME}" != "\${valid_chars}"  ]; then`

check('a sed bracket class cannot open a runaway string', () => {
  // The `)` and `'` inside `[...]` used to end the substitution and leave the
  // tokenizer inside a string, which then coloured hundreds of lines.
  assert.equal(closesCleanly(SED_CLASS), true)
  assert.equal(typeOf(SED_CLASS, '[:space:]'), 'string')
  assert.equal(typeOf(SED_CLASS, '%s'), 'string')
  assert.equal(typeOf(SED_CLASS, 'printf'), 'type.identifier')
})

check('the line after it is shell again, not string', () => {
  assert.equal(typeOf(FOLLOW_UP, 'if'), 'keyword')
  assert.equal(typeOf(FOLLOW_UP, 'then'), 'keyword')
  // only the four quote characters themselves are string-coloured
  assert.equal(textOfType(FOLLOW_UP, 'string'), '""""')
  assert.equal(typeOf(FOLLOW_UP, '${SYSTEM_NAME}'), 'variable')
})

check('command substitution keeps shell highlighting', () => {
  const line = `    run_id=$(curl -s -H "Authorization: Bearer \${GITHUB_TOKEN}" "$url/x" | jq -r '.a | .b')`
  assert.equal(typeOf(line, 'curl'), 'type.identifier')
  assert.equal(typeOf(line, '-s'), 'attribute.name')
  assert.equal(typeOf(line, '.a | .b'), 'string')
  assert.equal(typeOf(line, 'Bearer'), 'string')
  assert.equal(closesCleanly(line), true)
})

check('a `)` inside a quoted word does not close the substitution', () => {
  const line = `x=$(echo "a)b" && echo "c")`
  assert.equal(typeOf(line, 'a)b'), 'string')
  assert.equal(textOfType(line, 'string'), '"a)b""c"')
  assert.equal(closesCleanly(line), true)
})

check('nested substitutions unwind one level at a time', () => {
  const line = `x=$(printf '%s\\n' $(seq 1 3) | head -n $(wc -l < f))`
  assert.equal(closesCleanly(line), true)
  assert.equal(typeOf(line, 'printf'), 'type.identifier')
  assert.equal(typeOf(line, 'seq'), 'type.identifier')
  assert.equal(typeOf(line, '%s\\n'), 'string')
})

check('inline comments colour after code', () => {
  assert.equal(typeOf('echo hi # greet', '# greet'), 'comment')
  assert.equal(typeOf('# whole line', '# whole line'), 'comment')
  assert.equal(typeOf('  # indented', '# indented'), 'comment')
})

check('a `#` inside a word is not a comment', () => {
  assert.notEqual(typeOf('echo $HOME/#backup', '#backup'), 'comment')
  assert.notEqual(typeOf('curl -H "X#1: y" u', '#1: y'), 'comment')
})

check('the shebang is a metatag, not a comment', () => {
  assert.equal(typeOf('#!/bin/sh', '#!/bin/sh'), 'metatag')
})

check('double quotes still expand parameters', () => {
  const line = `echo "touch \${BIN_DIR}/k3s-ro-test && rm -rf \${BIN_DIR}/x"`
  assert.equal(typeOf(line, '${BIN_DIR}'), 'variable')
  assert.equal(typeOf(line, '&&'), 'string')
  assert.equal(closesCleanly(line), true)
})

check('single quotes expand nothing', () => {
  const line = `printf '%s' '$NOT_A_VAR'`
  assert.equal(textOfType(line, 'variable'), '')
  assert.equal(closesCleanly(line), true)
})

check('heredoc body is string and ends at its delimiter', () => {
  const lines = [`cat <<EOF > "$file"`, 'unit line one', 'ExecStart=/bin/true', 'EOF', 'echo after']
  const perLine = tokenizeAll(lines)
  // the tail of the opening line is NOT part of the body…
  assert.equal(joined(perLine[0], 'string'), 'EOF')
  // …the body is, and it stops at the delimiter line…
  assert.equal(joined(perLine[2], 'string'), 'ExecStart=/bin/true')
  assert.equal(perLine[3][0].type, 'string.heredoc.delimiter')
  // …so the next line is code again.
  assert.equal(joined(perLine[4], 'type.identifier'), 'echo')
})

check('a dash heredoc ends on an indented delimiter', () => {
  const perLine = tokenizeAll(['cat <<-EOT', '\tbody line', '\tEOT', 'echo after'])
  assert.equal(joined(perLine[1], 'string'), '\tbody line')
  assert.equal(perLine[2][0].type, 'string.heredoc.delimiter')
  assert.equal(joined(perLine[3], 'type.identifier'), 'echo')
})

check('quoted and dash heredoc markers all open a body', () => {
  assert.equal(stateAfter('cat <<EOT'), 'heredoc.EOT')
  assert.equal(stateAfter(`cat <<'EOT'`), 'heredoc.EOT')
  assert.equal(stateAfter('cat <<"EOT"'), 'heredoc.EOT')
  assert.equal(stateAfter('cat <<-EOT'), 'heredoc.EOT')
  // a here-string is one word, not a body
  assert.equal(closesCleanly('cat <<<inline'), true)
})

check('arithmetic and parameter expansions close', () => {
  assert.equal(closesCleanly('(( i = 0 ))'), true)
  assert.equal(closesCleanly('echo $((i + 1))'), true)
  assert.equal(closesCleanly('echo ${VAR:-$(cmd)}'), true)
  assert.equal(typeOf('echo ${VAR:-fallback}', 'VAR'), 'variable')
})

check('option words and assignment targets are distinguishable', () => {
  const line = `INSTALL_K3S_TYPE=notify # comment`
  assert.equal(typeOf(line, 'INSTALL_K3S_TYPE'), 'variable')
  assert.equal(typeOf('if [ -n "$X" ]; then', '-n'), 'attribute.name')
  assert.equal(typeOf('systemctl --now enable x', '--now'), 'attribute.name')
})

check('builtins, commands and control words colour; other words do not', () => {
  assert.equal(typeOf('set -e', 'set'), 'type.identifier')
  assert.equal(typeOf('a | grep b', 'grep'), 'type.identifier')
  assert.equal(typeOf('if read -r x; then', 'if'), 'keyword')
  assert.equal(typeOf('k3s-ro-test is a word', 'k3s-ro-test'), 'identifier')
  assert.equal(typeOf('SOME_VAR=1', 'SOME_VAR'), 'variable')
})

check('awkward lines neither throw nor leave the state stack open', () => {
  // A Monarch error kills tokenizing for the rest of the model, so a grammar
  // bug here would look like "the file has no colours below this line".
  const corpus = [
    '',
    '   ',
    '#',
    '#!/bin/sh',
    'x=$(',
    ')',
    `y="unbalanced`,
    `"`,
    `echo 'don''t'`,
    'echo "a # b" # c',
    "IFS=$'\\n\\t'",
    'cat <<',
    'EOF',
    'case "$1" in',
    '  a|b) echo one ;;',
    '  *) : ;;',
    'esac',
    '(( i = 0 )) && echo $((i + 1))',
    `trap "rm -f -- '$file'" EXIT INT QUIT PIPE`,
    '[[ -n ${x-} && ${y} ]]',
    'printf "%(%Y-%m-%d)T\\n" -1',
    'a=(1 2 3) b=${a[@]} c=${#a[@]}',
    'while read -r l; do :; done < <(gen)',
    '{ echo x; } | { read y; echo $y; }',
    'echo \\',
    'quoted',
    '  # trailing backslash above',
  ]
  const perLine = tokenizeAll(corpus)
  assert.equal(perLine.length, corpus.length)
  // The corpus ends balanced: an open quote or substitution must not survive
  // the lines that close it.
  assert.equal(perLine[perLine.length - 1].at(-1).endState.stack.state, 'root')
})

console.log(`\n${checks} checks, 0 failed`)
