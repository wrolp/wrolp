#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod ssh_session;

use ssh_session::AppState;
use tauri::generate_handler;
use tauri::Manager;

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      let state = AppState::new();
      app.manage(state);

      // Restore window position/size from saved config before showing
      if let Some(window) = app.get_webview_window("main") {
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
      commands::save_window_config,
      commands::load_window_config,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
