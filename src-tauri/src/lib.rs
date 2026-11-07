//! wxchart-tauri 壳（Phase 2A · Tauri 2）。
//! 结构见 docs/01 §2：窗口/对话框/命令路由 + sidecar 管理 + 通道②事件。

mod commands;
mod error;
mod sidecar;
mod state;

pub use sidecar::SidecarManager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::scan_accounts,
            commands::load_data,
            commands::export_messages,
            commands::resolve_media,
            commands::open_path,
            commands::reveal_path,
        ])
        .setup(|app| {
            // sidecar 生命周期（docs/03 §3）：spawn → 5s ping 握手 → status 事件
            use tauri::Manager;
            let manager = SidecarManager::start(app.handle().clone());
            app.manage(manager);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building wxchart-tauri")
        .run(|app, event| {
            // 退出收尾：发 stop → 等 EOF/2s → 仍活则 kill（防僵尸）
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(manager) = app.try_state::<SidecarManager>() {
                    manager.shutdown_blocking();
                }
            }
        });
}
