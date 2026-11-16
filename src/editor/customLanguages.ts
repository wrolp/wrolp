/**
 * Custom Monarch tokenizers for languages not built into Monaco.
 * Registered at app startup via this file.
 */
import * as monaco from 'monaco-editor'
import { shellMonarchLanguage } from './shellLanguage'

/**
 * Register Monarch-based language definitions before any editor instance is created.
 * Must be called once, early — we call it in the monacoSetup module.
 */
export function registerCustomLanguages(): void {
  registerNginx()
  registerProperties()
  registerSshConfig()
  registerIni()
  registerMakefile()
  registerDockerfileComments()
  registerShell()
}

// ── SHELL ──────────────────────────────────────────────────────────────────

/**
 * Replace Monaco's built-in `shell` tokenizer with ./shellLanguage.ts. The
 * built-in one paints everything inside `$( ... )` as a variable and lets a
 * stray quote run away through the rest of the file; `setMonarchTokensProvider`
 * swaps the provider for the already-registered language, so the file-name →
 * language mapping and the editor's bracket/auto-close behaviour stay as-is.
 */
function registerShell(): void {
  monaco.languages.setMonarchTokensProvider('shell', shellMonarchLanguage)
}

// ── NGINX ──────────────────────────────────────────────────────────────────

function registerNginx(): void {
  monaco.languages.register({ id: 'nginx' })
  // Without a comment token the editor's Ctrl+/ (`editor.action.commentLine`)
  // has nothing to insert.
  monaco.languages.setLanguageConfiguration('nginx', { comments: { lineComment: '#' } })

  // Combine all known nginx directives into one flat list for the regex.
  // The first group are block-openers (transition to afterContext to capture {).
  const blockOpeners =
    'server|location|http|events|upstream|if(?=\\s*\\()|stream|mail|map|limit_except|types|geo|split_clients'
  const directives =
    'return|rewrite|set|add_header|proxy_pass|proxy_set_header|proxy_redirect|' +
    'proxy_http_version|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout|' +
    'listen|server_name|root|index|try_files|error_page|access_log|error_log|' +
    'ssl|ssl_certificate|ssl_certificate_key|ssl_protocols|ssl_ciphers|' +
    'auth_basic|auth_basic_user_file|include|default_type|default|sendfile|tcp_nopush|tcp_nodelay|' +
    'keepalive_timeout|client_max_body_size|gzip|gzip_types|gzip_comp_level|gzip_min_length|' +
    'worker_processes|worker_connections|worker_rlimit_nofile|pid|user|daemon|master_process|' +
    'limit_req|limit_req_zone|limit_conn|limit_conn_zone|' +
    'proxy_buffering|proxy_buffer_size|proxy_buffers|proxy_busy_buffers_size|' +
    'fastcgi_pass|fastcgi_param|fastcgi_index|uwsgi_pass|uwsgi_param|scgi_pass|' +
    'map_hash_bucket_size|resolver|resolver_timeout|log_format|log_not_found|' +
    'charset|charset_types|etag|expires|add_after_body|add_before_body|' +
    'internal|satisfy|real_ip_header|set_real_ip_from'

  monaco.languages.setMonarchTokensProvider('nginx', {
    ignoreCase: true,
    defaultToken: '',
    tokenizer: {
      root: [
        // comment
        [/#.*$/, 'comment'],
        // variable $host, $uri, etc.
        [/\$\w+/, 'variable'],
        // numbers with optional suffix
        [/\b\d+(\.\d+)?[kmg]?\b/i, 'number'],
        // quoted strings
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        // block-openers: transition to afterContext to look for {
        [new RegExp(`\\b(${blockOpeners})\\b`, 'i'), { token: 'keyword', next: '@afterContext' }],
        // regular directives
        [new RegExp(`\\b(${directives})\\b`, 'i'), 'keyword'],
        // braces / semicolons
        [/[{};]/, 'delimiter'],
        // paths
        [/\/[^\s{;]*/, 'string'],
      ],
      afterContext: [
        // If we hit ; without finding { → treat as directive, return to root
        [/;/, { token: 'delimiter', next: '@pop' }],
        // safety: unexpected } also pops
        [/\}/, { token: 'delimiter', next: '@pop' }],
        // comment
        [/#.*$/, 'comment'],
        // opening brace → back to root
        [/\{/, { token: 'delimiter', next: '@pop' }],
        // quoted strings in context header
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        // variable
        [/\$\w+/, 'variable'],
        // regex after location/if (~ ... before {)
        [/~[^\s{;]+/, 'regexp'],
        // paths (e.g. location /api/ {)
        [/\/[^\s{;]+/, 'string'],
        // numbers
        [/\b\d+(\.\d+)?[kmg]?\b/i, 'number'],
        // consume anything else tokenless — MUST exclude { ; } so those rules can fire
        [/[^{};]+/, ''],
      ],
    },
  })
}

// ── PROPERTIES (.properties / .env) ────────────────────────────────────────

function registerProperties(): void {
  monaco.languages.register({ id: 'properties' })
  // `#` is the primary comment marker; `.properties` also accepts `!`, but a
  // language configuration can name only one line comment.
  monaco.languages.setLanguageConfiguration('properties', { comments: { lineComment: '#' } })
  monaco.languages.setMonarchTokensProvider('properties', {
    ignoreCase: true,
    tokenizer: {
      root: [
        // comment (# or ! at start of line or after whitespace)
        [/^[ \t]*[#!].*$/, 'comment'],
        // inline comment after value
        [/[#!].*$/, 'comment'],
        // section headers like [section]
        [/^\[.*\]$/, 'type'],
        // key with separator (=, :, space) — captures key and separator
        [/^[ \t]*([\w.\-]+)([ \t]*[=:][ \t]*)/, ['key', 'delimiter']],
        // value continuation line (starts with whitespace after a previous key=value)
        [/^[ \t]+\S.*$/, 'string'],
        // multi-line continuation (backslash at end of line)
        [/\\[ \t]*$/, 'delimiter'],
        // bare value for lines that are just content
        [/^[ \t]*[\w.\-]+[ \t]+/, 'string'],
        // numbers
        [/\b\d+(\.\d+)?\b/, 'number'],
        // variable placeholders like ${var}
        [/\$\{[^}]+\}/, 'variable'],
      ],
    },
  })
}

// ── SSH CONFIG (ssh_config / sshd_config) ──────────────────────────────────

/**
 * OpenSSH config syntax: one directive per line (`Keyword value`, `=` optional),
 * `#` comments and `%h`-style value tokens. The files carry no extension, and
 * neither Monaco nor the terminal tokenizer has this language built in.
 */
function registerSshConfig(): void {
  monaco.languages.register({ id: 'sshconfig' })
  monaco.languages.setLanguageConfiguration('sshconfig', { comments: { lineComment: '#' } })
  const keywords =
    'Host|Match|Include|HostName|User|Port|IdentityFile|CertificateFile|ProxyJump|ProxyCommand|' +
    'ForwardAgent|ForwardX11|ForwardX11Trusted|IdentitiesOnly|AddKeysToAgent|UseKeychain|' +
    'StrictHostKeyChecking|UserKnownHostsFile|GlobalKnownHostsFile|HashKnownHosts|CheckHostIP|' +
    'PasswordAuthentication|PubkeyAuthentication|KbdInteractiveAuthentication|' +
    'ChallengeResponseAuthentication|HostbasedAuthentication|GSSAPIAuthentication|' +
    'GSSAPICleanupCredentials|KerberosAuthentication|PermitRootLogin|PermitEmptyPasswords|UsePAM|' +
    'MaxAuthTries|MaxSessions|MaxStartups|LoginGraceTime|UseDNS|IgnoreRhosts|' +
    'AllowUsers|DenyUsers|AllowGroups|DenyGroups|AllowAgentForwarding|AllowTcpForwarding|' +
    'GatewayPorts|X11Forwarding|X11UseLocalhost|PermitTunnel|PermitOpen|ClearAllForwardings|' +
    'ExitOnForwardFailure|LocalForward|RemoteForward|DynamicForward|' +
    'ServerAliveInterval|ServerAliveCountMax|ClientAliveInterval|ClientAliveCountMax|TCPKeepAlive|' +
    'ConnectionAttempts|ConnectTimeout|Compression|LogLevel|SyslogFacility|Subsystem|' +
    'AcceptEnv|SetEnv|SendEnv|Banner|PrintMotd|PrintLastLog|AuthorizedKeysFile|' +
    'AuthorizedPrincipalsFile|Ciphers|MACs|KexAlgorithms|HostKeyAlgorithms|HostKey|' +
    'AddressFamily|ListenAddress|PidFile|Protocol|ControlMaster|ControlPath|ControlPersist|' +
    'CanonicalizeHostname|CanonicalDomains|CanonicalizeFallbackLocal|CanonicalizePermittedCNAMEs|' +
    'RekeyLimit|IPQoS|VersionAddendum'
  monaco.languages.setMonarchTokensProvider('sshconfig', {
    ignoreCase: true,
    defaultToken: '',
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [new RegExp(`^[ \\t]*(${keywords})\\b`), 'keyword'],
        // Any other leading word is still a directive — future OpenSSH options
        // should read as keys rather than values.
        [/^[ \t]*[A-Za-z][\w-]*/, 'key'],
        [/%[a-zA-Z]/, 'variable'],
        [/\b\d+\b/, 'number'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/=/, 'delimiter'],
        // Values: paths, host patterns, algorithm lists — one run to the next blank.
        [/[^\s#=]+/, 'string'],
      ],
    },
  })
}

// ── INI ────────────────────────────────────────────────────────────────────

/**
 * Replace Monaco's built-in ini tokenizer. It only recognises a `^\w+=` key:
 * `key: value` (accepted by many INI readers), dotted/dashed keys and the
 * leading indentation other tools emit (`[user]` then a tabbed `name = …` in a
 * .gitconfig) all fell through, and an unquoted value was never tokenised at
 * all — the line rendered as one colour. This provider keeps the built-in
 * language configuration (comments, brackets, Ctrl+/) and only swaps tokenizing.
 */
function registerIni(): void {
  monaco.languages.setMonarchTokensProvider('ini', {
    defaultToken: '',
    tokenizer: {
      root: [
        // Indentation is its own token so the key below matches after it.
        [/[ \t]+/, ''],
        [/[#;].*$/, 'comment'],
        [/\[[^\]]*\]/, 'metatag'],
        // `key = value`, `key: value`, `key=value`, dotted or dashed. The
        // lookahead is what keeps a bare value word from reading as a key.
        [/[\w.-]+(?=[ \t]*[=:])/, 'key'],
        [/[ \t]*[=:][ \t]*/, 'delimiter'],
        [/\b(?:true|false|yes|no|on|off)\b/i, 'keyword'],
        [/\b\d+(?:\.\d+)?\b/, 'number'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/'(?:[^'\\]|\\.)*'/, 'string'],
        // Unquoted value text: a different colour from the key on the same line.
        [/[^#;\s][^#;]*/, 'string'],
      ],
    },
  })
}

// ── MAKEFILE ──────────────────────────────────────────────────────────────

/**
 * Monaco ships no Makefile language, yet the picker offers it. Registering the
 * id makes that choice real and gives Ctrl+/ the `#` it needs; tokenising is
 * left to the default (plain) tokenizer.
 */
function registerMakefile(): void {
  monaco.languages.register({ id: 'makefile' })
  monaco.languages.setLanguageConfiguration('makefile', { comments: { lineComment: '#' } })
}

// ── DOCKERFILE COMMENTS ───────────────────────────────────────────────────

/**
 * Monaco's built-in dockerfile configuration declares brackets and auto-close
 * pairs but NO comment tokens, so Ctrl+/ did nothing in a Dockerfile. Re-state
 * the built-in parts alongside `#` (a language configuration replaces, not
 * merges).
 */
function registerDockerfileComments(): void {
  monaco.languages.setLanguageConfiguration('dockerfile', {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  })
}

// ── TYPE HELPERS ───────────────────────────────────────────────────────────

declare module 'monaco-editor' {
  namespace languages {
    interface ILanguageExtensionPoint {
      id: string
      extensions?: string[]
      filenames?: string[]
      filenamePatterns?: string[]
      aliases?: string[]
      mimetypes?: string[]
      firstLine?: string
    }
  }
}
