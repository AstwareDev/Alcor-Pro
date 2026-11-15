// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    alcor_pro_lib::migrate_renamed_app_dirs();
    alcor_pro_lib::run()
}
