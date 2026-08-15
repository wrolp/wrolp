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
  event_count     INTEGER DEFAULT 0
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
CREATE TABLE IF NOT EXISTS command_snippets (
  id         TEXT PRIMARY KEY,
  command    TEXT NOT NULL,
  alias      TEXT,
  favorite   INTEGER DEFAULT 0,
  hidden     INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
