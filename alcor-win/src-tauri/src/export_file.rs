//! Streaming, positional file writer for video export. The muxer seeks back to patch headers, so
//! writes carry an absolute offset; output goes to `<dest>.partial` and is renamed on finish.

use std::collections::HashMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::State;
use tauri::ipc::{InvokeBody, Request};

type R<T> = Result<T, String>;

struct Job {
    file: Arc<File>,
    partial: PathBuf,
    dest: PathBuf,
}

impl Job {
    /// fsync, then atomically move the partial over the destination.
    fn commit(self) -> R<()> {
        let Job { file, partial, dest } = self;
        let result = file.sync_all().and_then(|_| {
            drop(file);
            fs::rename(&partial, &dest)
        });
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result.map_err(|e| format!("{}: {e}", dest.display()))
    }
}

#[derive(Default)]
pub struct ExportFiles {
    next: AtomicU64,
    jobs: Mutex<HashMap<u64, Job>>,
}

fn partial_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".partial");
    dest.with_file_name(name)
}

#[cfg(windows)]
fn write_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<usize> {
    std::os::windows::fs::FileExt::seek_write(file, buf, offset)
}

#[cfg(unix)]
fn write_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::write_at(file, buf, offset)
}

fn write_all_at(file: &File, mut buf: &[u8], mut offset: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        let n = write_at(file, buf, offset)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        buf = &buf[n..];
        offset += n as u64;
    }
    Ok(())
}

impl ExportFiles {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Job>> {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn open(&self, dest: &Path) -> R<u64> {
        if let Some(dir) = dest.parent().filter(|d| !d.as_os_str().is_empty()) {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let partial = partial_path(dest);
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&partial)
            .map_err(|e| format!("{}: {e}", partial.display()))?;
        let handle = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock().insert(
            handle,
            Job { file: Arc::new(file), partial, dest: dest.to_path_buf() },
        );
        Ok(handle)
    }

    fn file(&self, handle: u64) -> R<Arc<File>> {
        self.lock()
            .get(&handle)
            .map(|j| j.file.clone())
            .ok_or_else(|| format!("unknown export handle {handle}"))
    }

    pub fn write(&self, handle: u64, offset: u64, bytes: &[u8]) -> R<()> {
        let file = self.file(handle)?;
        write_all_at(&file, bytes, offset).map_err(|e| format!("export write failed: {e}"))
    }

    fn take(&self, handle: u64) -> R<Job> {
        self.lock()
            .remove(&handle)
            .ok_or_else(|| format!("unknown export handle {handle}"))
    }

    #[cfg(test)]
    fn finish(&self, handle: u64) -> R<()> {
        self.take(handle)?.commit()
    }

    pub fn abort(&self, handle: u64) {
        if let Some(job) = self.lock().remove(&handle) {
            let Job { file, partial, .. } = job;
            drop(file);
            let _ = fs::remove_file(&partial);
        }
    }
}

#[tauri::command]
pub async fn export_file_open(state: State<'_, ExportFiles>, path: String) -> R<u64> {
    state.open(Path::new(&path))
}

fn header(request: &Request<'_>, name: &str) -> R<u64> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("missing or invalid {name} header"))
}

#[tauri::command]
pub async fn export_file_write(state: State<'_, ExportFiles>, request: Request<'_>) -> R<()> {
    let handle = header(&request, "x-handle")?;
    let offset = header(&request, "x-offset")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("export_file_write expects a raw body".into());
    };
    state.write(handle, offset, bytes)
}

#[tauri::command]
pub async fn export_file_finish(state: State<'_, ExportFiles>, handle: u64) -> R<()> {
    let job = state.take(handle)?;
    // fsync of a large file can take long: keep it off the async runtime thread.
    tauri::async_runtime::spawn_blocking(move || job.commit())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_file_abort(state: State<'_, ExportFiles>, handle: u64) -> R<()> {
    state.abort(handle);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "palmier-export-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn out_of_order_positional_writes_land_at_their_offsets() {
        let dir = temp_dir("write");
        let dest = dir.join("out.mp4");
        let files = ExportFiles::default();
        let h = files.open(&dest).unwrap();
        files.write(h, 8, b"world!!!").unwrap();
        files.write(h, 0, b"hello???").unwrap();
        files.write(h, 5, b", ").unwrap(); // overwrite earlier bytes, like a header patch
        assert!(dir.join("out.mp4.partial").exists());
        assert!(!dest.exists());
        files.finish(h).unwrap();
        assert!(!dir.join("out.mp4.partial").exists());
        assert_eq!(fs::read(&dest).unwrap(), b"hello, ?world!!!");
        assert!(files.write(h, 0, b"x").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finish_replaces_an_existing_destination() {
        let dir = temp_dir("replace");
        let dest = dir.join("out.mov");
        fs::write(&dest, b"old contents").unwrap();
        let files = ExportFiles::default();
        let h = files.open(&dest).unwrap();
        files.write(h, 0, b"new").unwrap();
        files.finish(h).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn abort_deletes_the_partial_and_keeps_the_destination() {
        let dir = temp_dir("abort");
        let dest = dir.join("out.webm");
        fs::write(&dest, b"keep me").unwrap();
        let files = ExportFiles::default();
        let h = files.open(&dest).unwrap();
        files.write(h, 0, b"partial data").unwrap();
        files.abort(h);
        assert!(!dir.join("out.webm.partial").exists());
        assert_eq!(fs::read(&dest).unwrap(), b"keep me");
        files.abort(h); // idempotent
        fs::remove_dir_all(dir).unwrap();
    }
}
