/**
 * Custom Monarch tokenizers for languages not built into Monaco.
 * Registered at app startup via this file.
 */
import * as monaco from "monaco-editor"

/**
 * Register Monarch-based language definitions before any editor instance is created.
 * Must be called once, early — we call it in the monacoSetup module.
 */
export function registerCustomLanguages(): void {
  registerNginx()
  registerProperties()
}

// ── NGINX ──────────────────────────────────────────────────────────────────

function registerNginx(): void {
  monaco.languages.register({ id: "nginx" })

  // Combine all known nginx directives into one flat list for the regex.
  // The first group are block-openers (transition to afterContext to capture {).
  const blockOpeners = "server|location|http|events|upstream|if(?=\\s*\\()|stream|mail|map|limit_except|types|geo|split_clients"
  const directives = "return|rewrite|set|add_header|proxy_pass|proxy_set_header|proxy_redirect|"
    + "proxy_http_version|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout|"
    + "listen|server_name|root|index|try_files|error_page|access_log|error_log|"
    + "ssl|ssl_certificate|ssl_certificate_key|ssl_protocols|ssl_ciphers|"
    + "auth_basic|auth_basic_user_file|include|default_type|default|sendfile|tcp_nopush|tcp_nodelay|"
    + "keepalive_timeout|client_max_body_size|gzip|gzip_types|gzip_comp_level|gzip_min_length|"
    + "worker_processes|worker_connections|worker_rlimit_nofile|pid|user|daemon|master_process|"
    + "limit_req|limit_req_zone|limit_conn|limit_conn_zone|"
    + "proxy_buffering|proxy_buffer_size|proxy_buffers|proxy_busy_buffers_size|"
    + "fastcgi_pass|fastcgi_param|fastcgi_index|uwsgi_pass|uwsgi_param|scgi_pass|"
    + "map_hash_bucket_size|resolver|resolver_timeout|log_format|log_not_found|"
    + "charset|charset_types|etag|expires|add_after_body|add_before_body|"
    + "internal|satisfy|real_ip_header|set_real_ip_from"

  monaco.languages.setMonarchTokensProvider("nginx", {
    ignoreCase: true,
    defaultToken: "",
    tokenizer: {
      root: [
        // comment
        [/#.*$/, "comment"],
        // variable $host, $uri, etc.
        [/\$\w+/, "variable"],
        // numbers with optional suffix
        [/\b\d+(\.\d+)?[kmg]?\b/i, "number"],
        // quoted strings
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        // block-openers: transition to afterContext to look for {
        [
          new RegExp(`\\b(${blockOpeners})\\b`, "i"),
          { token: "keyword", next: "@afterContext" },
        ],
        // regular directives
        [
          new RegExp(`\\b(${directives})\\b`, "i"),
          "keyword",
        ],
        // braces / semicolons
        [/[{};]/, "delimiter"],
        // paths
        [/\/[^\s{;]*/, "string"],
      ],
      afterContext: [
        // If we hit ; without finding { → treat as directive, return to root
        [/;/, { token: "delimiter", next: "@pop" }],
        // safety: unexpected } also pops
        [/\}/, { token: "delimiter", next: "@pop" }],
        // comment
        [/#.*$/, "comment"],
        // opening brace → back to root
        [/\{/, { token: "delimiter", next: "@pop" }],
        // quoted strings in context header
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        // variable
        [/\$\w+/, "variable"],
        // regex after location/if (~ ... before {)
        [/~[^\s{;]+/, "regexp"],
        // paths (e.g. location /api/ {)
        [/\/[^\s{;]+/, "string"],
        // numbers
        [/\b\d+(\.\d+)?[kmg]?\b/i, "number"],
        // consume anything else tokenless — MUST exclude { ; } so those rules can fire
        [/[^{};]+/, ""],
      ],
    },
  })
}

// ── PROPERTIES (.properties / .env) ────────────────────────────────────────

function registerProperties(): void {
  monaco.languages.register({ id: "properties" })
  monaco.languages.setMonarchTokensProvider("properties", {
    ignoreCase: true,
    tokenizer: {
      root: [
        // comment (# or ! at start of line or after whitespace)
        [/^[ \t]*[#!].*$/, "comment"],
        // inline comment after value
        [/[#!].*$/, "comment"],
        // section headers like [section]
        [/^\[.*\]$/, "type"],
        // key with separator (=, :, space) — captures key and separator
        [/^[ \t]*([\w.\-]+)([ \t]*[=:][ \t]*)/, ["key", "delimiter"]],
        // value continuation line (starts with whitespace after a previous key=value)
        [/^[ \t]+\S.*$/, "string"],
        // multi-line continuation (backslash at end of line)
        [/\\[ \t]*$/, "delimiter"],
        // bare value for lines that are just content
        [/^[ \t]*[\w.\-]+[ \t]+/, "string"],
        // numbers
        [/\b\d+(\.\d+)?\b/, "number"],
        // variable placeholders like ${var}
        [/\$\{[^}]+\}/, "variable"],
      ],
    },
  })
}

// ── TYPE HELPERS ───────────────────────────────────────────────────────────

declare module "monaco-editor" {
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
