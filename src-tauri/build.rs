use tauri::generate_handler;

fn main() {
    tauri::Builder::default()
        .invoke_handler(generate_handler![
            ssh_terminal::commands::list_connections,
            ssh_terminal::commands::save_connection,
            ssh_terminal::commands::delete_connection,
            ssh_terminal::commands::connect,
            ssh_terminal::commands::disconnect,
            ssh_terminal::commands::send_input,
            ssh_terminal::commands::resize_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
