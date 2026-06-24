#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod ssh_session;

use ssh_session::AppState;
use tauri::generate_handler;
use tauri::{Emitter, Manager};

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      let state = AppState::new();
      app.manage(state);

      // Capture drag-drop events at Rust level and emit to frontend
      let app_handle = app.handle().clone();

      // Get the main window
      if let Some(window) = app.get_webview_window("main") {
        // Use on_window_event to capture drag-drop
        window.on_window_event(move |event| {
          if let tauri::WindowEvent::DragDrop(drag_drop) = event {
            match &drag_drop {
              tauri::DragDropEvent::Over { position, .. } => {
                println!("[DragDrop] Over at {:?}", position);
                let _ = app_handle.emit("sftp-drag-over", ());
              }
              tauri::DragDropEvent::Leave => {
                println!("[DragDrop] Leave");
                let _ = app_handle.emit("sftp-drag-leave", ());
              }
              tauri::DragDropEvent::Drop { paths, .. } => {
                println!("[DragDrop] Drop: {:?}", paths);
                if !paths.is_empty() {
                  let path_vec: Vec<String> =
                    paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
                  let _ = app_handle.emit("sftp-file-drop", path_vec);
                }
              }
              _ => {}
            }
          }
        });
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
      commands::file_exists,
      commands::create_directory,
      commands::rename_file,
      commands::delete_file,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
