use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(path: &Path) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Stage next to the destination so the final rename stays on one volume.
fn write_atomic(path: &Path, bytes: &[u8]) -> R<()> {
    let dir = path.parent().ok_or("path has no parent")?;
    fs::create_dir_all(dir).map_err(err(dir))?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(err(path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
}

fn entry(path: &Path) -> R<Entry> {
    let meta = fs::metadata(path).map_err(err(path))?;
    Ok(Entry {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        is_dir: meta.is_dir(),
        size: meta.len(),
        modified_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

#[tauri::command]
pub async fn fs_read_text(path: PathBuf) -> R<String> {
    blocking(move || fs::read_to_string(&path).map_err(err(&path))).await
}

#[tauri::command]
pub async fn fs_write_text(path: PathBuf, contents: String) -> R<()> {
    blocking(move || write_atomic(&path, contents.as_bytes())).await
}

#[tauri::command]
pub async fn fs_write_bytes(path: PathBuf, bytes: Vec<u8>) -> R<()> {
    blocking(move || write_atomic(&path, &bytes)).await
}

#[tauri::command]
pub async fn fs_exists(path: PathBuf) -> R<bool> {
    blocking(move || Ok(path.exists())).await
}

#[tauri::command]
pub async fn fs_stat(path: PathBuf) -> R<Option<Entry>> {
    blocking(move || {
        if path.exists() {
            entry(&path).map(Some)
        } else {
            Ok(None)
        }
    })
    .await
}

#[tauri::command]
pub async fn fs_list(path: PathBuf) -> R<Vec<Entry>> {
    blocking(move || {
        let mut out = Vec::new();
        for item in fs::read_dir(&path).map_err(err(&path))? {
            let item = item.map_err(err(&path))?;
            if let Ok(e) = entry(&item.path()) {
                out.push(e);
            }
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn fs_mkdir(path: PathBuf) -> R<()> {
    blocking(move || fs::create_dir_all(&path).map_err(err(&path))).await
}

/// Copies to a staged name first so a failed copy never leaves a partial destination.
#[tauri::command]
pub async fn fs_copy(from: PathBuf, to: PathBuf) -> R<()> {
    blocking(move || {
        let dir = to.parent().ok_or("path has no parent")?;
        fs::create_dir_all(dir).map_err(err(dir))?;
        let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
        let result = fs::copy(&from, &tmp).and_then(|_| fs::rename(&tmp, &to));
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result.map_err(err(&to))
    })
    .await
}

#[tauri::command]
pub async fn fs_rename(from: PathBuf, to: PathBuf) -> R<()> {
    blocking(move || fs::rename(&from, &to).map_err(err(&from))).await
}

#[tauri::command]
pub async fn fs_remove(path: PathBuf) -> R<()> {
    blocking(move || {
        if !path.exists() {
            return Ok(());
        }
        if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        }
        .map_err(err(&path))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    projects: String,
    app_data: String,
    cache: String,
    temp: String,
    downloads: String,
}

#[tauri::command]
pub fn app_paths(app: tauri::AppHandle) -> R<AppPaths> {
    use tauri::Manager;
    let p = app.path();
    let s = |r: tauri::Result<PathBuf>| r.map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string());
    let projects = p.document_dir().map(|d| d.join("Alcor Pro"));
    Ok(AppPaths {
        projects: s(projects)?,
        app_data: s(p.app_data_dir())?,
        cache: s(p.app_cache_dir())?,
        temp: s(p.temp_dir().map(|d| d.join("AlcorPro")))?,
        downloads: s(p.download_dir())?,
    })
}
