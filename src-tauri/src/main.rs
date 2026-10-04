#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod hub;

fn main() {
    tauri::Builder::default()
        .manage(hub::Hub::default())
        .invoke_handler(tauri::generate_handler![hub::hub_start, hub::hub_stop, hub::hub_reply])
        .run(tauri::generate_context!())
        .expect("error while running farmPLAN Tobacco");
}
