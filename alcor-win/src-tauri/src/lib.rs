mod builtin_keys;
mod export_file;
mod fsio;
mod http;
pub mod mcp;
mod rename_migration;
mod secrets;

use tauri::Manager;

/// Called from `main` before the webview exists.
pub fn migrate_renamed_app_dirs() {
    rename_migration::migrate_app_dirs();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Ok(documents) = app.path().document_dir() {
                rename_migration::migrate_project_registry(&documents);
            }
            let secrets = secrets::Secrets::load(app.path().app_data_dir()?);
            app.manage(http::Http::new(secrets.custom_hosts()));
            app.manage(secrets);
            app.manage(export_file::ExportFiles::default());
            app.manage(mcp::start(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fsio::fs_read_text,
            fsio::fs_write_text,
            fsio::fs_write_bytes,
            fsio::fs_exists,
            fsio::fs_stat,
            fsio::fs_list,
            fsio::fs_mkdir,
            fsio::fs_copy,
            fsio::fs_rename,
            fsio::fs_remove,
            fsio::app_paths,
            export_file::export_file_open,
            export_file::export_file_write,
            export_file::export_file_finish,
            export_file::export_file_abort,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_has,
            secrets::secret_builtin,
            secrets::secret_list_present,
            secrets::custom_endpoint_set,
            secrets::custom_endpoint_remove,
            secrets::custom_endpoint_list,
            http::http_fetch,
            http::http_fetch_bytes,
            http::http_stream,
            http::http_cancel,
            http::http_download,
            mcp::mcp_set_tools,
            mcp::mcp_set_instructions,
            mcp::mcp_respond,
            mcp::mcp_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
