-- Wrolp Terminal database schema
-- Used for session recording and command sets

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL,
  connection_name TEXT,
  tab_id          INTEGER,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_seconds INTEGER,
  title           TEXT,
  event_count     INTEGER DEFAULT 0,
  -- Snapshot of the connection's workspace/group at record time (nullable for
  -- legacy rows / failed lookups); folder layers 1-2 of the events file.
  workspace_id    TEXT,
  group_name      TEXT,
  -- Absolute path to the session's NDJSON events file; NULL = legacy data
  -- stored in `session_events`. New recordings only write to this file.
  events_file     TEXT
);

CREATE TABLE IF NOT EXISTS session_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  direction    TEXT NOT NULL,
  content      TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, seq);

CREATE TABLE IF NOT EXISTS command_sets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  connection_id TEXT,
  commands      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Single-command snippets for the floating command list. Clicking one sends
-- the text to the terminal WITHOUT executing it; `favorite` pins it as a
-- common command, `hidden` hides it from the default list.
-- `connection_id` scopes the snippet to one connection (NULL = general, shown
-- for every connection). `params` / `options` hold the per-command parameter
-- and toggleable-fragment definitions as JSON arrays. `group_name` is the
-- user-defined list group (NULL / '' = ungrouped); groups themselves have no
-- table — the name set is the labels on snippets plus a localStorage order list.
-- `description` is the free-form (possibly multi-line) note shown in the row's
-- hover tooltip and matched by the search box.
CREATE TABLE IF NOT EXISTS command_snippets (
  id            TEXT PRIMARY KEY,
  command       TEXT NOT NULL,
  alias         TEXT,
  favorite      INTEGER DEFAULT 0,
  hidden        INTEGER DEFAULT 0,
  sort_order    INTEGER DEFAULT 0,
  connection_id TEXT,
  params        TEXT,
  options       TEXT,
  group_name    TEXT,
  description   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Global variables shared by all command-list snippets. Commands reference them
-- as `${name}`; a variable with a non-empty default is substituted directly when
-- sending, otherwise the user fills it in a dialog.
CREATE TABLE IF NOT EXISTS global_variables (
  name          TEXT PRIMARY KEY,
  default_value TEXT NOT NULL DEFAULT '',
  description   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_prompt_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Built-in template keys the user has hidden (deleted); restore = remove row.
CREATE TABLE IF NOT EXISTS ai_hidden_builtin_templates (
  key TEXT PRIMARY KEY
);

-- Commands the user submitted, for the terminal pane's 历史 dropdown. The
-- per-terminal list is session state in the frontend; this table is the cross-tab,
-- cross-restart one. Re-running a command refreshes its row (UNIQUE on the text)
-- instead of adding a duplicate, and the table is trimmed to the newest rows.
CREATE TABLE IF NOT EXISTS command_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  command    TEXT NOT NULL UNIQUE,
  tab_type   TEXT NOT NULL DEFAULT '',
  host       TEXT NOT NULL DEFAULT '',
  used_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_command_history_used
  ON command_history (used_at_ms DESC);

-- Recently used saved connections — and local terminals — for the welcome page's
-- host card. One row per id, refreshed on every connect, and the table is trimmed
-- to the newest rows on write (like command_history above). A local terminal's id
-- is namespaced as `local:<entryId>` (see `db::local_recent_id`), because the two
-- id spaces are independent and a local entry may carry the same uuid as a host.
--
-- No workspace column: which workspace a row belongs to is resolved against the
-- live connection list at query time. Storing it would go stale the moment an
-- edit moved the connection to another workspace, and it is what lets a deleted
-- or moved connection drop out of the list with no cleanup step.
CREATE TABLE IF NOT EXISTS connection_recents (
  connection_id TEXT PRIMARY KEY,
  used_at_ms    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connection_recents_used
  ON connection_recents (used_at_ms DESC);

-- ==================== Device identity (SSH-COMMAND-INDEX-COMPLETION-PLAN §2.A) ====
--
-- One row per *device*, identified by the SHA256 fingerprint of the host key the
-- server presented (`SHA256:<base64>`, the same string `ssh-keygen -lf` prints, so
-- it can be compared by hand). Sessions are the thing that changes — a device is
-- stable across connections, users and ports, which is what makes "the commands
-- available on this machine" a question with an answer.
--
-- Non-SSH sessions have no host key, so they use a fallback identity in the same
-- column, prefixed by the source: `local:<hostname>`, `wsl:<distro>`,
-- `serial:<COM3>`, `telnet:<host:port>`. The `kind` column says which.
CREATE TABLE IF NOT EXISTS hosts (
  fingerprint TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  -- Address details as *seen*, for display and for spotting that two fingerprints
  -- are the same box. Not part of the identity: a moved host key keeps its row.
  host        TEXT NOT NULL DEFAULT '',
  port        INTEGER NOT NULL DEFAULT 0,
  username    TEXT NOT NULL DEFAULT '',
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  -- When the user cleared this device's command index. While it is newer than the
  -- index's own `collected_at`, the automatic collection stays off: clearing is a
  -- "forget what you learned about this box" action, and re-learning it on the very
  -- next connect would make the clear a no-op the user could not see the end of.
  commands_cleared_at INTEGER NOT NULL DEFAULT 0
);

-- Many-to-many: one saved connection can reach several devices (a load balancer,
-- a rebuilt box, a ProxyJump target), and several connections can reach one
-- device. `command_history`-style freshness: reconnecting refreshes `last_seen`
-- rather than adding rows.
CREATE TABLE IF NOT EXISTS connection_hosts (
  connection_id TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  last_seen     INTEGER NOT NULL,
  PRIMARY KEY (connection_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_connection_hosts_fp
  ON connection_hosts (fingerprint);

-- The device command index (plan §2.B): what can be run on that machine, as one
-- row per (device, command name) with the sources it came from (`path`, `builtin`,
-- `alias` — comma-joined when a name is more than one). Collected wholesale, so a
-- refresh replaces all of a device's rows at once; `collected_at` is per row only
-- because it makes "how old is this device's index" a one-row read.
--
-- No FOREIGN KEY onto `hosts`: the identity write is deliberately allowed to fail
-- without breaking anything, and an index row for an unrecorded device is harmless
-- whereas a rejected collection is a feature that silently never fills in.
-- No extra index either — the (fingerprint, command) primary key already indexes
-- the fingerprint prefix.
CREATE TABLE IF NOT EXISTS host_commands (
  fingerprint  TEXT NOT NULL,
  command      TEXT NOT NULL,
  sources      TEXT NOT NULL DEFAULT '',
  collected_at INTEGER NOT NULL,
  PRIMARY KEY (fingerprint, command)
);
