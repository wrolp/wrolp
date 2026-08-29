//! Command-level integration tests (Phase 2 of `task/plans/e2e-testing.md`,
//! 方案 C): drive the `#[tauri::command]` handlers directly with Tauri's mock
//! runtime (`tauri::test`) and an `AppState` bound to a throwaway temp dir, so
//! the tests never read or write the real `%APPDATA%\wrolp-terminal`.
//!
//! Run with: `cd src-tauri && cargo test`.

use crate::commands;
use crate::db::{self, CommandSetDto, CommandSnippetDto, GlobalVariable, RecordedEvent};
use crate::ssh_session::{ActiveRecording, AppState, ConnectionConfig};
use tauri::Manager;

/// A mock Tauri app plus the temp dir that backs its `AppState`.
struct TestApp {
  app: tauri::App<tauri::test::MockRuntime>,
  _dir: tempfile::TempDir,
}

impl TestApp {
  /// A fresh `State` handle. `tauri::State` is not `Copy`, so call this once
  /// per command invocation instead of holding a single handle across calls.
  fn state(&self) -> tauri::State<'_, AppState> {
    self.app.state::<AppState>()
  }
}

/// Build a mock Tauri app whose `AppState` persists everything (connections.json,
/// window.json, wrolp.db, vault.key) under a fresh temp dir.
fn build_test_app() -> TestApp {
  let dir = tempfile::tempdir().expect("create temp dir");
  let db = db::init_db(dir.path()).expect("init db");
  let state = AppState::new_with_base(db, Some(dir.path().to_path_buf()));
  let app = tauri::test::mock_builder()
    .manage(state)
    .build(tauri::test::mock_context(tauri::test::noop_assets()))
    .expect("build mock app");
  TestApp { app, _dir: dir }
}

fn conn(id: &str, name: &str) -> ConnectionConfig {
  ConnectionConfig {
    id: id.to_string(),
    name: name.to_string(),
    host: "10.0.0.1".to_string(),
    port: 22,
    username: "root".to_string(),
    password: None,
    key_path: None,
    passphrase: None,
    description: None,
    startup_dir: None,
    group: None,
    workspace_id: None,
    tunnels: vec![],
    // Serial-port fields (unused by these tests).
    kind: None,
    port_name: None,
    baud_rate: None,
    data_bits: None,
    stop_bits: None,
    parity: None,
    flow_control: None,
    // Telnet field (unused by these tests).
    auto_login: None,
  }
}

async fn list_conns(app: &TestApp) -> Vec<ConnectionConfig> {
  let json = crate::commands::list_connections(app.state())
    .await
    .expect("list_connections");
  serde_json::from_str(&json).expect("parse connections")
}

// ==================== Connections CRUD + persistence ====================

#[tokio::test]
async fn connections_crud_roundtrips_to_disk() {
  let app = build_test_app();

  assert!(list_conns(&app).await.is_empty());

  let mut c = conn("c1", "Web");
  c.group = Some("Prod".into());
  commands::save_connection(app.state(), c.clone()).await.expect("save");
  assert_eq!(list_conns(&app).await.len(), 1);

  // Persisted under the temp dir (not the real config dir).
  let persisted = std::fs::read_to_string(app._dir.path().join("connections.json")).expect("file");
  assert!(persisted.contains("Web"));
  assert!(persisted.contains("Prod"));

  // Update keeps a single entry.
  c.name = "Web Renamed".into();
  commands::save_connection(app.state(), c.clone()).await.expect("save update");
  let conns = list_conns(&app).await;
  assert_eq!(conns.len(), 1);
  assert_eq!(conns[0].name, "Web Renamed");

  assert!(commands::delete_connection(app.state(), c.id).await.expect("delete"));
  assert!(list_conns(&app).await.is_empty());
}

#[tokio::test]
async fn workspace_switch_filters_connections() {
  let app = build_test_app();

  let ws_id = commands::create_workspace(app.state(), "Work".into())
    .await
    .expect("create ws");
  commands::switch_workspace(app.state(), ws_id.clone()).await.expect("switch");

  let c = conn("c1", "OnlyInWork");
  commands::save_connection(app.state(), c).await.expect("save in Work");
  assert_eq!(list_conns(&app).await.len(), 1);

  // Back to default: the connection belongs to the other workspace.
  commands::switch_workspace(app.state(), "default".into())
    .await
    .expect("switch back");
  assert!(list_conns(&app).await.is_empty());

  // Default workspace cannot be deleted.
  let err = commands::delete_workspace(app.state(), "default".into())
    .await
    .expect_err("default workspace must be protected");
  assert!(err.contains("default"));
}

#[tokio::test]
async fn reorder_and_group_rename_ungroup() {
  let app = build_test_app();

  let mut a = conn("a", "Alpha");
  a.group = Some("G1".into());
  let mut b = conn("b", "Beta");
  b.group = Some("G1".into());
  let mut c = conn("c", "Gamma");
  c.group = Some("G2".into());
  commands::save_connection(app.state(), a.clone()).await.unwrap();
  commands::save_connection(app.state(), b.clone()).await.unwrap();
  commands::save_connection(app.state(), c.clone()).await.unwrap();

  // Reorder: c, a, b.
  commands::reorder_connections(app.state(), vec!["c".into(), "a".into(), "b".into()], None)
    .await
    .expect("reorder");
  let order: Vec<String> = list_conns(&app).await.iter().map(|x| x.id.clone()).collect();
  assert_eq!(order, vec!["c", "a", "b"]);

  // Rename group G1 -> G1x; drag a into G2 via group_updates.
  assert!(
    commands::rename_group(app.state(), "G1".into(), "G1x".into())
      .await
      .expect("rename group")
  );
  let mut updates = std::collections::HashMap::new();
  updates.insert("a".to_string(), "G2".to_string());
  commands::reorder_connections(
    app.state(),
    vec!["c".into(), "b".into(), "a".into()],
    Some(updates),
  )
  .await
  .expect("reorder with group updates");
  let conns = list_conns(&app).await;
  assert_eq!(conns.iter().find(|x| x.id == "a").unwrap().group.as_deref(), Some("G2"));
  assert_eq!(conns.iter().find(|x| x.id == "b").unwrap().group.as_deref(), Some("G1x"));

  // delete_group ungroups every member.
  assert!(commands::delete_group(app.state(), "G2".into()).await.expect("delete group"));
  let conns = list_conns(&app).await;
  assert_eq!(conns.iter().find(|x| x.id == "a").unwrap().group, None);
  assert_eq!(conns.iter().find(|x| x.id == "c").unwrap().group, None);
}

// ==================== Window config / keepalive / auto-record ====================

#[tokio::test]
async fn window_config_roundtrip_and_keepalive_clamping() {
  let app = build_test_app();

  // Defaults.
  let k = commands::get_keepalive(app.state()).await.expect("get_keepalive");
  assert_eq!(k.interval, 30);
  assert_eq!(k.max, 3);
  assert!(!commands::get_auto_record(app.state()).await.expect("get_auto_record"));

  // Clamping: interval 5 -> 10, max 1 -> 2.
  commands::set_keepalive(app.state(), 5, 1).await.expect("set_keepalive");
  let k = commands::get_keepalive(app.state()).await.expect("get_keepalive");
  assert_eq!(k.interval, 10);
  assert_eq!(k.max, 2);

  commands::set_auto_record(app.state(), true).await.expect("set_auto_record");
  assert!(commands::get_auto_record(app.state()).await.expect("get_auto_record"));

  // save_window_config -> load_window_config round-trip.
  let cfg = commands::WindowConfig {
    x: 100,
    y: 200,
    width: 1200,
    height: 800,
    maximized: false,
    opacity: 0.9,
    ai_input_height: 150.0,
    collapsed_groups: vec!["g1".into()],
    auto_record_sessions: true,
    keepalive_interval: 42,
    keepalive_max: 7,
  };
  commands::save_window_config(app.state(), cfg.clone())
    .await
    .expect("save window config");
  let loaded = commands::load_window_config(app.state()).await.expect("load window config");
  assert_eq!(loaded.x, 100);
  assert_eq!(loaded.opacity, 0.9);
  assert_eq!(loaded.keepalive_interval, 42);
  assert_eq!(loaded.collapsed_groups, vec!["g1"]);
  // Same values surfaced through get_keepalive.
  let k = commands::get_keepalive(app.state()).await.expect("get_keepalive");
  assert_eq!(k.interval, 42);
  assert_eq!(k.max, 7);
}

// ==================== SQLite-backed CRUD (command snippets / sets / vars) ====================

#[tokio::test]
async fn command_snippets_crud() {
  let app = build_test_app();

  assert!(commands::list_command_snippets(app.state()).await.expect("list").is_empty());

  let snip = CommandSnippetDto {
    id: "snip1".into(),
    command: "docker ps".into(),
    alias: Some("containers".into()),
    favorite: true,
    hidden: false,
    sort_order: 1,
    created_at: "2026-08-28T00:00:00Z".into(),
    updated_at: "2026-08-28T00:00:00Z".into(),
  };
  let id = commands::save_command_snippet(app.state(), snip).await.expect("save");
  assert_eq!(id, "snip1");

  let list = commands::list_command_snippets(app.state()).await.expect("list");
  assert_eq!(list.len(), 1);
  assert_eq!(list[0].command, "docker ps");
  assert!(list[0].favorite);

  commands::delete_command_snippet(app.state(), "snip1".into())
    .await
    .expect("delete");
  assert!(commands::list_command_snippets(app.state()).await.expect("list").is_empty());
}

#[tokio::test]
async fn command_sets_crud() {
  let app = build_test_app();

  let set = CommandSetDto {
    id: "set1".into(),
    name: "Deploy".into(),
    connection_id: Some("c1".into()),
    commands: vec!["git pull".into(), "npm run build".into()],
    created_at: "2026-08-28T00:00:00Z".into(),
    updated_at: "2026-08-28T00:00:00Z".into(),
  };
  commands::save_command_set(app.state(), set).await.expect("save set");

  // Scoped query returns it; other connections don't.
  let scoped = commands::list_command_sets(app.state(), Some("c1".into()))
    .await
    .expect("list scoped");
  assert_eq!(scoped.len(), 1);
  assert_eq!(scoped[0].commands.len(), 2);
  let other = commands::list_command_sets(app.state(), Some("other".into()))
    .await
    .expect("list other");
  assert!(other.is_empty());

  commands::delete_command_set(app.state(), "set1".into()).await.expect("delete");
  assert!(commands::list_command_sets(app.state(), None).await.expect("list all").is_empty());
}

#[tokio::test]
async fn global_variables_crud() {
  let app = build_test_app();

  let v = GlobalVariable {
    name: "host".into(),
    default_value: "web01".into(),
    description: None,
    created_at: "2026-08-28T00:00:00Z".into(),
    updated_at: "2026-08-28T00:00:00Z".into(),
  };
  commands::save_global_variable(app.state(), v).await.expect("save var");

  let list = commands::list_global_variables(app.state()).await.expect("list");
  assert_eq!(list.len(), 1);
  assert_eq!(list[0].name, "host");
  assert_eq!(list[0].default_value, "web01");

  commands::delete_global_variable(app.state(), "host".into())
    .await
    .expect("delete");
  assert!(commands::list_global_variables(app.state()).await.expect("list").is_empty());
}

// ==================== Session recording flush + command extraction ====================

#[tokio::test]
async fn session_recording_flush_and_extract_commands() {
  let app = build_test_app();

  // Seed the session row (recording was switched on, so the row exists).
  {
    let state = app.state();
    let conn = state.db.lock().expect("db lock");
    db::create_session(&conn, "s1", "c1", "Web", 1, "2026-08-28T00:00:00Z").expect("create");
  }

  // Populate an in-memory recording and flush it.
  {
    let state = app.state();
    let mut recordings = state.recordings.lock().expect("recordings lock");
    recordings.insert(
      1,
      ActiveRecording {
        session_id: "s1".into(),
        session_version: 1,
        connection_id: "c1".into(),
        connection_name: "Web".into(),
        started_at: std::time::Instant::now(),
        started_at_iso: "2026-08-28T00:00:00Z".into(),
        seq_counter: 3,
        events: vec![
          RecordedEvent { seq: 0, timestamp_ms: 0, direction: "command".into(), content: "ls -la".into() },
          RecordedEvent { seq: 1, timestamp_ms: 50, direction: "input".into(), content: "git status".into() },
          RecordedEvent { seq: 2, timestamp_ms: 120, direction: "command".into(), content: "git status".into() },
        ],
        recording_enabled: true,
        db_saved: true,
      },
    );
  }
  commands::flush_all_recordings(app.state().inner());

  // The disconnect path finalizes the session row (sets duration/event_count);
  // `list_sessions` filters on `event_count > 0`.
  {
    let state = app.state();
    let conn = state.db.lock().expect("db lock");
    let rec = state.recordings.lock().expect("recordings lock");
    commands::finalize_recording(&conn, rec.get(&1).expect("recording present"));
  }

  let sessions = commands::list_sessions(app.state(), None, None).await.expect("list sessions");
  assert_eq!(sessions.len(), 1);
  assert_eq!(sessions[0].event_count, 3);

  // extract_commands prefers precise "command" events and dedupes.
  let cmds = commands::extract_commands(app.state(), "s1".into()).await.expect("extract");
  assert_eq!(cmds, vec!["ls -la", "git status"]);

  let events = commands::get_session_events(app.state(), "s1".into()).await.expect("events");
  assert_eq!(events.len(), 3);
  assert_eq!(events[1].content, "git status");

  commands::delete_session(app.state(), "s1".into()).await.expect("delete session");
  assert!(commands::list_sessions(app.state(), None, None).await.expect("list").is_empty());
}

// ==================== poll_output buffer drain ====================

#[tokio::test]
async fn poll_output_drains_the_buffer() {
  let app = build_test_app();

  {
    let state = app.state();
    let mut buffers = state.output_buffers.lock().expect("buffers lock");
    buffers.insert(7, vec!["hello\r\n".to_string(), "world".to_string()]);
  }

  let chunks = commands::poll_output(app.state(), 7).await.expect("poll");
  assert_eq!(chunks, vec!["hello\r\n", "world"]);

  // Drained — next poll is empty.
  let chunks = commands::poll_output(app.state(), 7).await.expect("poll again");
  assert!(chunks.is_empty());
}
