/**
 * Shell (sh/bash/zsh) tokenizer for the Monaco file editor.
 *
 * Monaco's built-in `shell` grammar is a Monarch approximation that breaks on
 * ordinary scripts (measured against monaco-editor 0.52.0, k3s-install.sh):
 * `$( ... )` pushes a state that paints everything until the first `)` as
 * `variable`, so a `)` inside a quoted word or a `[...]` class ends the
 * substitution early and the stray quote that follows then swallows the rest of
 * the file as `string` — 643 of its 1205 lines came back as one string run;
 * heredoc bodies are never tracked, so a unit file written with `cat <<EOF`
 * gets shell highlighting; and `#` becomes a comment even inside a word
 * (`echo $HOME/#backup`). This grammar replaces it — see `registerShell()` in
 * ./customLanguages.ts.
 *
 * Two Monarch quirks the rules below work around, worth knowing before editing:
 * a rule is matched against the *rest of the line*, so `^` inside an alternation
 * asserts nothing (it is always true) — comments therefore consume their leading
 * whitespace instead of using a lookbehind; and a rule whose source starts with
 * `^` is only tried at column 0.
 *
 * Side-effect free on purpose: `tests/check-shell-highlight.mjs` imports this
 * module and runs the real Monarch tokenizer over it under plain Node.
 */
import type { languages } from 'monaco-editor'

/** Control-flow and function words — the ones that structure a script. */
const controlKeywords = [
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'in',
  'function',
  'coproc',
  'time',
]

/** Commands handled by the shell itself (POSIX + bash special and regular). */
const builtins = [
  'alias',
  'bg',
  'break',
  'builtin',
  'caller',
  'cd',
  'command',
  'continue',
  'declare',
  'dirs',
  'disown',
  'echo',
  'enable',
  'eval',
  'exec',
  'exit',
  'export',
  'fc',
  'fg',
  'getopts',
  'hash',
  'help',
  'history',
  'jobs',
  'kill',
  'let',
  'local',
  'logout',
  'mapfile',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'read',
  'readarray',
  'readonly',
  'return',
  'set',
  'shift',
  'shopt',
  'source',
  'suspend',
  'test',
  'times',
  'trap',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
]

/** Externally invoked programs — coloured with the builtins for scanability. */
const commands = [
  'awk',
  'bash',
  'cat',
  'cc',
  'chgrp',
  'chmod',
  'chown',
  'chroot',
  'clear',
  'cp',
  'curl',
  'cut',
  'date',
  'df',
  'diff',
  'docker',
  'du',
  'env',
  'find',
  'gawk',
  'gcc',
  'git',
  'grep',
  'gunzip',
  'gzip',
  'head',
  'hg',
  'id',
  'install',
  'journalctl',
  'ln',
  'logger',
  'ls',
  'lsof',
  'make',
  'mkdir',
  'mktemp',
  'mount',
  'mv',
  'nc',
  'node',
  'nohup',
  'npm',
  'openssl',
  'ping',
  'ps',
  'rm',
  'rmdir',
  'sed',
  'seq',
  'service',
  'sh',
  'shred',
  'sleep',
  'sort',
  'ssh',
  'stat',
  'sudo',
  'svn',
  'systemctl',
  'tail',
  'tar',
  'tee',
  'telnet',
  'top',
  'touch',
  'tr',
  'umount',
  'uniq',
  'vi',
  'vim',
  'wall',
  'wc',
  'wget',
  'who',
  'xargs',
  'yes',
  'zsh',
]

export const shellMonarchLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.shell',
  ignoreCase: false,

  brackets: [
    { token: 'delimiter.bracket', open: '{', close: '}' },
    { token: 'delimiter.square', open: '[', close: ']' },
    { token: 'delimiter.parenthesis', open: '(', close: ')' },
  ],

  keywords: controlKeywords,
  builtins,
  commands,

  tokenizer: {
    root: [
      // shebang
      [/^#!.*$/, 'metatag'],
      { include: '@whitespace' },

      // parameter expansions and command substitutions
      [/\$\(\(/, { token: 'variable', next: '@arithmetic' }],
      [/\$\(/, { token: 'variable', next: '@commandSub' }],
      [/\$\{/, { token: 'variable', next: '@parameter' }],
      [/\$[a-zA-Z_][a-zA-Z0-9_]*/, 'variable'],
      [/\$\d+/, 'variable.predefined'],
      [/\$[*@#?$!0_-]/, 'variable'],
      // $'…' honours backslash escapes, $"…" is a locale string
      [/\$'/, { token: 'string.quote', next: '@escapedString' }],
      [/\$"/, { token: 'string.quote', next: '@doubleQuoted' }],

      // quoting
      [/'/, { token: 'string.quote', next: '@singleQuoted' }],
      [/"/, { token: 'string.quote', next: '@doubleQuoted' }],
      [/`/, { token: 'string.quote', next: '@backticked' }],

      // heredoc — the tail of the opening line is consumed by this rule so the
      // body starts on the next line, and `$S2` resolves to the delimiter that
      // group 5 puts into the pushed state's name (see `heredoc` below). The
      // state change rides on the word group: Monarch drops the action of a
      // group that matched nothing, and the tail is empty most of the time.
      [
        /(<<)(-?)([ \t]*)(['"]?)([a-zA-Z_]\w*)(\4)([^\n]*)$/,
        [
          'delimiter',
          'delimiter',
          '',
          '',
          { token: 'string.heredoc.delimiter', next: '@heredoc.$5' },
          '',
          '',
        ],
      ],
      // here-string: `<<<word`
      [/<<<[ \t]*\S+/, 'string'],

      // I/O and control operators: `|`, `&&`, `||`, `;;`, `>`, `<`, `&`
      [/[|&;<>]+/, 'delimiter'],

      // option word: `-n`, `-eq`, `--force`
      [/--?[a-zA-Z][a-zA-Z0-9_-]*/, 'attribute.name'],

      // assignment target: `VAR=`, `VAR+=`
      [/[a-zA-Z_]\w*(?=\+?=)/, 'variable'],

      [/[{}[\]()]/, '@brackets'],
      [/==|!=|=~/, 'delimiter'],

      [/\d[\d_.:-]*/, 'number'],
      [/\\./, 'string.escape'],
      [
        /[a-zA-Z_][a-zA-Z0-9_]*(?:[.-][a-zA-Z0-9_]+)*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@builtins': 'type.identifier',
            '@commands': 'type.identifier',
            '@default': 'identifier',
          },
        },
      ],
    ],

    whitespace: [
      // A `#` is a comment only at line start or after whitespace, never inside
      // a word (`$HOME/#backup`), so the whitespace is matched along with it.
      [/^#.*$/, 'comment'],
      [/([ \t]+)(#.*)$/, ['white', 'comment']],
      [/[ \t]+/, 'white'],
    ],

    singleQuoted: [
      [/'/, { token: 'string.quote', next: '@pop' }],
      [/[^']+/, 'string'],
    ],

    escapedString: [
      [/\\./, 'string.escape'],
      [/'/, { token: 'string.quote', next: '@pop' }],
      [/[^'\\]+/, 'string'],
    ],

    doubleQuoted: [
      [/"/, { token: 'string.quote', next: '@pop' }],
      [/\\["\\$`]/, 'string.escape'],
      [/\$\(\(/, { token: 'variable', next: '@arithmetic' }],
      [/\$\(/, { token: 'variable', next: '@commandSub' }],
      [/\$\{/, { token: 'variable', next: '@parameter' }],
      [/\$[a-zA-Z_][a-zA-Z0-9_]*/, 'variable'],
      [/\$[*@#?$!0_-]/, 'variable'],
      [/[^"'$\\]+/, 'string'],
      [/./, 'string'],
    ],

    backticked: [
      [/`/, { token: 'string.quote', next: '@pop' }],
      [/\\[\\`$]/, 'string.escape'],
      [/\$\(/, { token: 'variable', next: '@commandSub' }],
      [/\$\{/, { token: 'variable', next: '@parameter' }],
      [/\$[a-zA-Z_][a-zA-Z0-9_]*/, 'variable'],
      [/[^`\\$]+/, 'string'],
      [/./, 'string'],
    ],

    // A substitution keeps full shell highlighting. `(` pushes another level so
    // a `)` inside a quoted word cannot close it by accident.
    commandSub: [
      [/\(/, { token: 'delimiter.parenthesis', next: '@commandSub' }],
      [/\)/, { token: 'variable', next: '@pop' }],
      { include: '@root' },
    ],

    parameter: [
      [/\}/, { token: 'variable', next: '@pop' }],
      [/\$\{/, { token: 'variable', next: '@parameter' }],
      [/\$\(/, { token: 'variable', next: '@commandSub' }],
      [/[#?!:&|+*/=^-]/, 'delimiter'],
      [/[^}$#?!:&|+*/=^-]+/, 'variable'],
    ],

    arithmetic: [
      [/\)\)/, { token: 'variable', next: '@pop' }],
      [/\$\(/, { token: 'variable', next: '@commandSub' }],
      [/\$\{/, { token: 'variable', next: '@parameter' }],
      [/\$[a-zA-Z_][a-zA-Z0-9_]*/, 'variable'],
      [/[ \t]+/, 'white'],
      [/\d+/, 'number'],
      [/[+\-*/%<>=!&|^~?:,]+/, 'delimiter'],
      [/[a-zA-Z_]\w*/, 'identifier'],
    ],

    // Reached through `heredoc.<delimiter>`, so `$S2` is that delimiter. Rules
    // are looked up on the parent state, which is why this one is spelled out.
    heredoc: [
      [/^[ \t]*\$S2[ \t]*$/, { token: 'string.heredoc.delimiter', next: '@pop' }],
      [/.*$/, 'string.heredoc'],
    ],
  },
}
