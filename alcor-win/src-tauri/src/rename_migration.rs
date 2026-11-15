//! One-time move of user data from the pre-rename identity (Palmier Pro for Windows) to Alcor Pro.
//! Runs before the webview starts so WebView2 storage (layout, chat settings) is picked up from the new folder.

use std::path::{Path, PathBuf};

const OLD_IDENTIFIER: &str = "io.palmier.pro.win";
const NEW_IDENTIFIER: &str = "io.alcor.pro";
const OLD_KEYRING_SERVICE: &str = "PalmierPro";

/// Moves `%APPDATA%` / `%LOCALAPPDATA%` app folders when only the old one exists. Rename only: same volume, atomic.
pub fn migrate_app_dirs() {
    for var in ["APPDATA", "LOCALAPPDATA"] {
        let Some(base) = std::env::var_os(var).map(PathBuf::from) else { continue };
        move_if_absent(&base.join(OLD_IDENTIFIER), &base.join(NEW_IDENTIFIER));
    }
}

fn move_if_absent(old: &Path, new: &Path) {
    if old.is_dir() && !new.exists() {
        if let Err(e) = std::fs::rename(old, new) {
            eprintln!("rename migration: {} -> {}: {e}", old.display(), new.display());
        }
    }
}

/// Copies the project registry so the home screen keeps listing existing projects; projects stay where they are.
pub fn migrate_project_registry(documents: &Path) {
    let old = documents.join("Palmier Pro").join("project-registry.json");
    let new_dir = documents.join("Alcor Pro");
    let new = new_dir.join("project-registry.json");
    if old.is_file() && !new.exists() {
        let _ = std::fs::create_dir_all(&new_dir);
        if let Err(e) = std::fs::copy(&old, &new) {
            eprintln!("rename migration: registry: {e}");
        }
    }
}

/// Moves a stored API key from the old Credential Manager service when the new one has none.
pub fn migrate_secret(name: &str, new_service: &str) {
    let (Ok(old), Ok(new)) = (
        keyring::Entry::new(OLD_KEYRING_SERVICE, name),
        keyring::Entry::new(new_service, name),
    ) else {
        return;
    };
    if new.get_password().is_ok() {
        return;
    }
    if let Ok(value) = old.get_password() {
        if new.set_password(&value).is_ok() {
            let _ = old.delete_credential();
        }
    }
}
