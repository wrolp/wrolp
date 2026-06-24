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
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
