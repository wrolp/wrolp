#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod ssh_session;

use ssh_session::AppState;
use tauri::generate_handler;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      let state = AppState::new();
      app.manage(state);

      // ---- Tray icon ----
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

      // Restore window position/size from saved config before showing
      if let Some(window) = app.get_webview_window("main") {
        // Hide to tray instead of closing
        let window_clone = window.clone();
        window.on_window_event(move |event| {
          if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_clone.hide();
          }
        });

        let config_path = commands::get_window_config_path();
        if let Some(ref path) = config_path {
          if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(config) = serde_json::from_str::<commands::WindowConfig>(&content) {
              if config.maximized {
                let _ = window.maximize();
              } else if config.x != i32::MAX {
                let _ = window.set_position(tauri::PhysicalPosition::new(config.x, config.y));
                let _ = window.set_size(tauri::PhysicalSize::new(config.width, config.height));
              }
            }
          }
        }
        let _ = window.show();
      }

      Ok(())
    })
    .invoke_handler(generate_handler![
      commands::list_connections,
      commands::save_connection,
      commands::delete_connection,
      commands::connect,
      commands::disconnect,
      commands::send_input,
      commands::resize_terminal,
      commands::poll_output,
      commands::list_files,
      commands::download_file,
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
      commands::save_window_config,
      commands::load_window_config,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
