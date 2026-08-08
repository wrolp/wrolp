#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod docker_analysis;
mod docker_fs;
mod host_analysis;
mod remote_fs;
mod ssh_session;
mod vault;
mod ai;

use ssh_session::AppState;
use tauri::generate_handler;
use tauri::Manager;
// Tray-related imports (commented out along with the tray icon below)
// use tauri::menu::{MenuBuilder, MenuItemBuilder};
// use tauri::tray::TrayIconBuilder;
// use tauri::image::Image;

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      // Initialize SQLite database
      let data_dir = dirs::config_dir()
        .map(|p| p.join("wrolp-terminal"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
      let db_conn = db::init_db(&data_dir).unwrap_or_else(|e| {
        eprintln!("[db] init failed: {}, using in-memory fallback", e);
        // Fallback: try in-memory database so app still runs
        let conn = rusqlite::Connection::open_in_memory()
          .expect("Failed to open in-memory SQLite");
        conn.execute_batch(include_str!("schema.sql")).ok();
        std::sync::Arc::new(std::sync::Mutex::new(conn))
      });

      let state = AppState::new(db_conn);
      app.manage(state);

      // Spawn periodic recording flush task (every 5 seconds)
      {
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
          loop {
            interval.tick().await;
            if let Some(app_state) = app_handle.try_state::<AppState>() {
              commands::flush_all_recordings(&app_state);
            }
          }
        });
      }

      /*
      // ---- Tray icon (disabled) ----
      let show_item = MenuItemBuilder::with_id("show", "Show").build(app)?;
      let hide_item = MenuItemBuilder::with_id("hide", "Hide").build(app)?;
      let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
      let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&hide_item)
        .item(&quit_item)
        .build()?;

      let icon_bytes = include_bytes!("../icons/32x32.png");
      let _tray = TrayIconBuilder::new()
        .icon(Image::from_bytes(icon_bytes)?)
        .tooltip("Wrolp Terminal")
        .menu(&menu)
        .on_menu_event(move |app, event| {
          let id = event.id().as_ref();
          match id {
            "show" => {
              if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
            "hide" => {
              if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
              }
            }
            "quit" => {
              app.exit(0);
            }
            _ => {}
          }
        })
        .build(app)?;
      */

      // Restore window position/size from saved config before showing
      if let Some(window) = app.get_webview_window("main") {
        // Hide to tray instead of closing
        // let window_clone = window.clone();
        // window.on_window_event(move |event| {
        //   if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        //     api.prevent_close();
        //     let _ = window_clone.hide();
        //   }
        // });

        // Restore window geometry if saved. First verify the window rect
        // intersects any visible monitor; if it does not (e.g. it was on a
        // now-disconnected secondary display, or off-screen due to a DPI
        // offset), center the window instead, so it does not end up outside
        // the screen (a taskbar entry exists but nothing shows on the desktop).
        let config_path = commands::get_window_config_path();
        if let Some(ref path) = config_path {
          if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(config) = serde_json::from_str::<commands::WindowConfig>(&content) {
              if config.maximized {
                let _ = window.maximize();
              } else if config.x != i32::MAX {
                let w = if config.width > 0 { config.width } else { 1200u32 };
                let h = if config.height > 0 { config.height } else { 800u32 };
                let _ = window.set_size(tauri::PhysicalSize::new(w, h));
                let on_screen = window
                  .available_monitors()
                  .map(|monitors| {
                    monitors.iter().any(|m| {
                      let pos = m.position();
                      let size = m.size();
                      config.x < pos.x + size.width as i32
                        && config.x + w as i32 > pos.x
                        && config.y < pos.y + size.height as i32
                        && config.y + h as i32 > pos.y
                    })
                  })
                  .unwrap_or(false);
                if on_screen {
                  let _ = window.set_position(tauri::PhysicalPosition::new(config.x, config.y));
                } else {
                  let _ = window.center();
                }
              }
            }
          }
        }
        // Show the window (visible: false in tauri.conf.json), and make sure
        // it is unminimized and brought to the front.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }

      Ok(())
    })
    .invoke_handler(generate_handler![
      commands::list_connections,
      commands::save_connection,
      commands::delete_connection,
      commands::reorder_connections,
      commands::rename_group,
      commands::get_local_terminals,
      commands::save_local_terminals,
      commands::delete_group,
      commands::connect,
      commands::disconnect,
      commands::send_input,
      commands::resize_terminal,
      commands::poll_output,
      commands::open_local_shell,
      commands::local_send_input,
      commands::local_resize,
      commands::local_close,
      commands::get_local_shell_dirs,
      commands::clear_local_shell_dirs,
      commands::list_files,
      commands::download_file,
      commands::read_file_content,
      commands::write_file_content,
      commands::upload_file,
      commands::upload_file_bytes,
      commands::file_exists,
      commands::create_directory,
      commands::rename_file,
      commands::delete_file,
      commands::switch_sftp_user,
      commands::revert_sftp_user,
      commands::get_sftp_user,
      commands::pause_transfer,
      commands::resume_transfer,
      commands::poll_working_dir,
      commands::target_list_files,
      commands::target_file_exists,
      commands::target_create_directory,
      commands::target_rename_file,
      commands::target_delete_file,
      commands::target_read_file,
      commands::target_write_file,
      commands::target_download_file,
      commands::target_upload_file,
      commands::target_upload_file_bytes,
      commands::list_docker_containers,
      commands::save_window_config,
      commands::load_window_config,
      commands::save_layout,
      commands::load_layout,
      commands::list_sessions,
      commands::get_session_events,
      commands::delete_session,
      commands::delete_all_sessions,
      commands::rename_session,
      commands::extract_commands,
      commands::commit_command,
      commands::list_command_sets,
      commands::save_command_set,
      commands::delete_command_set,
      commands::list_ai_prompt_templates,
      commands::save_ai_prompt_template,
      commands::delete_ai_prompt_template,
      commands::list_hidden_builtin_templates,
      commands::hide_builtin_template,
      commands::restore_builtin_template,
      commands::get_auto_record,
      commands::set_auto_record,
      commands::set_recording_enabled,
      commands::get_recording_enabled,
      commands::analyze_host,
      commands::analyze_docker_container,
      commands::docker_container_logs,
      commands::restart_docker_container,
      commands::docker_logs_stream_start,
      commands::poll_docker_logs,
      commands::stop_docker_logs_stream,
      commands::command_help,
      commands::get_app_version,
      commands::open_config_dir,
      commands::load_ai_config,
      commands::save_ai_config,
      commands::encrypt_api_key,
      commands::decrypt_api_key,
      commands::list_ai_models,
      commands::ai_chat,
      commands::start_ai_chat_stream,
      commands::poll_ai_chunks,
      commands::start_ai_agent,
      commands::confirm_ai_tool,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
