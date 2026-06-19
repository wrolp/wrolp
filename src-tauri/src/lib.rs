#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod ssh_session;

use ssh_session::AppState;
use tauri::generate_handler;
use tauri::Emitter;
use tauri::Manager;

pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      let state = AppState::new();

      // Take receiver and move into async block
      let app_handle = app.handle().clone();
      let rx = {
        let mut guard = state.output_rx.lock().unwrap();
        guard.take()
      };
      if let Some(mut rx) = rx {
        tauri::async_runtime::spawn(async move {
          while let Some(output) = rx.recv().await {
            let _ = app_handle.emit("ssh://output", &output);
          }
        });
      }

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
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
