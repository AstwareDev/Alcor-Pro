//! API keys live in Windows Credential Manager. No command returns a value to the webview;
//! `http.rs` reads them in-process and only for hosts bound to the secret name.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

type R<T> = Result<T, String>;

const SERVICE: &str = "AlcorPro";

/// Secret name -> hosts it may be sent to. `*.x` matches subdomains of `x` only.
const BUILTIN: &[(&str, &[&str])] = &[
    ("anthropic", &["api.anthropic.com"]),
    ("openai", &["api.openai.com"]),
    ("elevenlabs", &["api.elevenlabs.io"]),
    (
        "fal",
        &["fal.run", "queue.fal.run", "rest.alpha.fal.ai", "*.fal.media", "fal.media"],
    ),
    ("google", &["generativelanguage.googleapis.com"]),
    ("replicate", &["api.replicate.com"]),
    ("openrouter", &["openrouter.ai"]),
    // Prompt routing (Mercury Decide decision model).
    ("inception", &["api.inceptionlabs.ai"]),
    // Sound library search (token via `?token=`); previews come from public CDN hosts and need no key.
    ("freesound", &["freesound.org"]),
];

pub fn host_matches(pattern: &str, host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    match pattern.strip_prefix("*.") {
        Some(suffix) => host.len() > suffix.len() + 1 && host.ends_with(&format!(".{suffix}")),
        None => host == pattern,
    }
}

pub fn is_builtin_auth_host(host: &str) -> bool {
    BUILTIN
        .iter()
        .any(|(_, hosts)| hosts.iter().any(|p| host_matches(p, host)))
}

pub fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

fn valid_custom_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// id -> host (lowercase, with `:port` only when explicit and non-default).
#[derive(Clone, Default)]
pub struct CustomHosts(Arc<RwLock<HashMap<String, String>>>);

impl CustomHosts {
    fn get(&self, id: &str) -> Option<String> {
        self.0.read().ok()?.get(id).cloned()
    }

    pub fn is_auth_host(&self, host: &str) -> bool {
        self.0
            .read()
            .map(|m| m.values().any(|h| h == host))
            .unwrap_or(false)
    }
}

#[derive(Clone)]
pub struct Secrets {
    custom: CustomHosts,
    file: PathBuf,
}

impl Secrets {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join("custom_endpoints.json");
        let map: HashMap<String, String> = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let custom_names = map.keys().map(|id| format!("custom:{id}"));
        for name in BUILTIN.iter().map(|(n, _)| n.to_string()).chain(custom_names) {
            crate::rename_migration::migrate_secret(&name, SERVICE);
        }
        Self { custom: CustomHosts(Arc::new(RwLock::new(map))), file }
    }

    pub fn custom_hosts(&self) -> CustomHosts {
        self.custom.clone()
    }

    /// Hosts a secret may be sent to; errors for unknown names.
    pub fn allowed_hosts(&self, name: &str) -> R<Vec<String>> {
        if let Some((_, hosts)) = BUILTIN.iter().find(|(n, _)| *n == name) {
            return Ok(hosts.iter().map(|h| h.to_string()).collect());
        }
        if let Some(id) = name.strip_prefix("custom:") {
            return self
                .custom
                .get(id)
                .map(|h| vec![h])
                .ok_or_else(|| format!("unknown custom endpoint: {id}"));
        }
        Err(format!("unknown secret name: {name}"))
    }

    /// Name must be allowlisted; custom names need a registered endpoint.
    fn check_name(&self, name: &str) -> R<()> {
        self.allowed_hosts(name).map(|_| ())
    }

    pub fn read(&self, name: &str) -> R<String> {
        self.check_name(name)?;
        entry(name)?
            .get_password()
            .map_err(|e| match e {
                keyring::Error::NoEntry => format!("no API key stored for '{name}'"),
                _ => format!("credential store error for '{name}'"),
            })
    }

    fn save_custom(&self, map: &HashMap<String, String>) -> R<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }
}

fn entry(name: &str) -> R<keyring::Entry> {
    keyring::Entry::new(SERVICE, name).map_err(|_| "credential store unavailable".to_string())
}

fn present(name: &str) -> bool {
    entry(name).is_ok_and(|e| e.get_password().is_ok())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_set(
    state: tauri::State<'_, Secrets>,
    name: String,
    value: String,
) -> R<()> {
    state.check_name(&name)?;
    if value.is_empty() {
        return Err("empty secret".into());
    }
    blocking(move || {
        entry(&name)?
            .set_password(&value)
            .map_err(|_| "failed to store secret".to_string())
    })
    .await
}

#[tauri::command]
pub async fn secret_delete(state: tauri::State<'_, Secrets>, name: String) -> R<()> {
    // Allow deleting custom secrets whose endpoint was already removed.
    if !name.starts_with("custom:") {
        state.check_name(&name)?;
    }
    blocking(move || match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("failed to delete secret".to_string()),
    })
    .await
}

#[tauri::command]
pub async fn secret_has(state: tauri::State<'_, Secrets>, name: String) -> R<bool> {
    state.check_name(&name)?;
    blocking(move || Ok(present(&name))).await
}

#[tauri::command]
pub async fn secret_list_present(
    state: tauri::State<'_, Secrets>,
    names: Vec<String>,
) -> R<Vec<String>> {
    let names: Vec<String> = names
        .into_iter()
        .filter(|n| state.check_name(n).is_ok())
        .collect();
    blocking(move || Ok(names.into_iter().filter(|n| present(n)).collect())).await
}

#[derive(Serialize)]
pub struct CustomEndpoint {
    id: String,
    host: String,
}

fn host_of(base_url: &str) -> R<String> {
    let url = reqwest::Url::parse(base_url).map_err(|e| format!("invalid base URL: {e}"))?;
    let host = url.host_str().ok_or("base URL has no host")?.to_ascii_lowercase();
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_host(&host) => {}
        _ => return Err("base URL must be https (http only for localhost)".into()),
    }
    Ok(match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    })
}

#[tauri::command]
pub async fn custom_endpoint_set(
    state: tauri::State<'_, Secrets>,
    id: String,
    base_url: String,
) -> R<()> {
    if !valid_custom_id(&id) {
        return Err("id must be 1-48 chars of a-z, 0-9, '-' or '_'".into());
    }
    let host = host_of(&base_url)?;
    let mut map = state.custom.0.write().map_err(|e| e.to_string())?;
    let mut next = map.clone();
    next.insert(id, host);
    state.save_custom(&next)?;
    *map = next;
    Ok(())
}

#[tauri::command]
pub async fn custom_endpoint_remove(state: tauri::State<'_, Secrets>, id: String) -> R<()> {
    {
        let mut map = state.custom.0.write().map_err(|e| e.to_string())?;
        let mut next = map.clone();
        next.remove(&id);
        state.save_custom(&next)?;
        *map = next;
    }
    // Don't leave an unreachable key behind.
    blocking(move || {
        let _ = entry(&format!("custom:{id}")).and_then(|e| {
            e.delete_credential().map_err(|_| String::new())
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn custom_endpoint_list(state: tauri::State<'_, Secrets>) -> R<Vec<CustomEndpoint>> {
    let map = state.custom.0.read().map_err(|e| e.to_string())?;
    let mut out: Vec<_> = map
        .iter()
        .map(|(id, host)| CustomEndpoint { id: id.clone(), host: host.clone() })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_matching() {
        assert!(host_matches("*.fal.media", "v3.fal.media"));
        assert!(!host_matches("*.fal.media", "fal.media"));
        assert!(!host_matches("*.fal.media", "evilfal.media"));
        assert!(host_matches("fal.media", "FAL.media"));
        assert!(!host_matches("api.openai.com", "api.openai.com.evil.io"));
    }

    #[test]
    fn freesound_key_is_bound_to_its_api_host() {
        let s = Secrets { custom: CustomHosts::default(), file: PathBuf::new() };
        assert_eq!(s.allowed_hosts("freesound").unwrap(), vec!["freesound.org"]);
        assert!(is_builtin_auth_host("freesound.org"));
        assert!(!is_builtin_auth_host("cdn.freesound.org"));
    }

    #[test]
    fn names_and_hosts() {
        let s = Secrets { custom: CustomHosts::default(), file: PathBuf::new() };
        assert_eq!(s.allowed_hosts("openai").unwrap(), vec!["api.openai.com"]);
        assert!(s.allowed_hosts("bogus").is_err());
        assert!(s.allowed_hosts("custom:x").is_err());
        s.custom.0.write().unwrap().insert("x".into(), "llm.local".into());
        assert_eq!(s.allowed_hosts("custom:x").unwrap(), vec!["llm.local"]);
    }

    #[test]
    fn base_url_hosts() {
        assert_eq!(host_of("https://API.Example.com/v1").unwrap(), "api.example.com");
        assert_eq!(host_of("http://localhost:11434/v1").unwrap(), "localhost:11434");
        assert!(host_of("http://example.com").is_err());
    }
}
