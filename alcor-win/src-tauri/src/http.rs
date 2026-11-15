//! Provider HTTP for the webview. Secrets are injected here and never leave Rust.

use crate::secrets::{self, CustomHosts, Secrets};
use reqwest::{Client, Method, RequestBuilder, Response, Url, header::{HeaderName, HeaderValue}};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;

type R<T> = Result<T, String>;

const MAX_BODY: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    /// Caller-chosen id enabling `http_cancel`.
    request_id: Option<String>,
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<Body>,
    auth: Option<Auth>,
    timeout_ms: Option<u64>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Body {
    Text { value: String },
    Json { value: serde_json::Value },
    Bytes { value: Vec<u8> },
    File { path: PathBuf },
    Multipart { parts: Vec<Part> },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Part {
    name: String,
    filename: Option<String>,
    content_type: Option<String>,
    value: PartValue,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PartValue {
    Text { value: String },
    Bytes { value: Vec<u8> },
    File { path: PathBuf },
}

#[derive(Deserialize)]
struct Auth {
    secret: String,
    /// Header to carry the key; ignored when `query` is set.
    #[serde(default)]
    header: String,
    #[serde(default)]
    prefix: String,
    /// Send the key as this query parameter instead of a header.
    query: Option<String>,
}

#[derive(Serialize)]
pub struct FetchResponse {
    status: u16,
    headers: Vec<(String, String)>,
    #[serde(rename = "bodyText")]
    body_text: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamEvent {
    Status { status: u16, headers: Vec<(String, String)> },
    Chunk { text: String },
    Done,
    Error { message: String },
}

#[derive(Serialize, Clone)]
pub struct Progress {
    received: u64,
    total: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    path: String,
    bytes: u64,
    content_type: Option<String>,
}

pub struct Http {
    client: Client,
    inflight: Mutex<HashMap<String, CancellationToken>>,
}

struct Registration<'a> {
    id: Option<String>,
    http: &'a Http,
    token: CancellationToken,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let (Some(id), Ok(mut m)) = (&self.id, self.http.inflight.lock()) {
            m.remove(id);
        }
    }
}

impl Http {
    pub fn new(custom: CustomHosts) -> Self {
        // Redirects may only leave an authenticated API host for another host bound to the same
        // class of key; anything else is refused so injected headers cannot leak.
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 8 {
                return attempt.error("too many redirects");
            }
            let to = attempt.url();
            let from = attempt.previous().first().map(authority).unwrap_or_default();
            let sensitive = secrets::is_builtin_auth_host(&host_only(&from))
                || custom.is_auth_host(&from);
            let same = authority(to) == from;
            if to.scheme() == "https" && (same || !sensitive) {
                attempt.follow()
            } else {
                attempt.error("redirect blocked")
            }
        });
        let client = Client::builder()
            .user_agent("AlcorPro")
            .connect_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(2)
            .pool_idle_timeout(Duration::from_secs(30))
            .redirect(policy)
            .build()
            .expect("http client");
        Self { client, inflight: Mutex::new(HashMap::new()) }
    }

    fn register(&self, id: Option<&str>) -> R<Registration<'_>> {
        let token = CancellationToken::new();
        if let Some(id) = id {
            let mut m = self.inflight.lock().map_err(|e| e.to_string())?;
            if m.contains_key(id) {
                return Err(format!("request id already in use: {id}"));
            }
            m.insert(id.to_string(), token.clone());
        }
        Ok(Registration { id: id.map(str::to_string), http: self, token })
    }
}

fn authority(u: &Url) -> String {
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    }
}

fn host_only(authority: &str) -> String {
    match authority.rsplit_once(':') {
        Some((h, _)) => h.to_string(),
        None => authority.to_string(),
    }
}

fn net_err(e: reqwest::Error) -> String {
    use std::error::Error;
    let e = e.without_url();
    let mut s = format!("request failed: {e}");
    let mut src = e.source();
    while let Some(c) = src {
        s.push_str(&format!(": {c}"));
        src = c.source();
    }
    s
}

fn header_pairs(h: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    h.iter()
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect()
}

fn io_err(path: &std::path::Path, e: std::io::Error) -> String {
    format!("{}: {e}", path.display())
}

async fn file_body(path: &std::path::Path) -> R<(reqwest::Body, u64)> {
    let f = tokio::fs::File::open(path).await.map_err(|e| io_err(path, e))?;
    let len = f.metadata().await.map_err(|e| io_err(path, e))?.len();
    Ok((reqwest::Body::wrap_stream(ReaderStream::new(f)), len))
}

/// Checks scheme and host against the secret's allowlist, then returns the key.
fn authorize(secrets: &Secrets, url: &Url, auth: &Auth) -> R<String> {
    let allowed = secrets.allowed_hosts(&auth.secret)?;
    let auth_host = authority(url);
    let custom = auth.secret.starts_with("custom:");
    let loopback = secrets::is_loopback_host(url.host_str().unwrap_or(""));
    match url.scheme() {
        "https" => {}
        "http" if custom && loopback => {}
        _ => return Err("secrets are only sent over https".into()),
    }
    // Built-in hosts are matched without a port, so only the default port qualifies.
    let ok = if custom {
        allowed.contains(&auth_host)
    } else {
        url.port().is_none() && allowed.iter().any(|p| secrets::host_matches(p, &auth_host))
    };
    if !ok {
        return Err(format!(
            "secret '{}' may not be sent to host '{}'",
            auth.secret, auth_host
        ));
    }
    secrets.read(&auth.secret)
}

async fn build(http: &Http, secrets: &Secrets, req: HttpRequest) -> R<RequestBuilder> {
    let mut url = Url::parse(&req.url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("unsupported url scheme".into());
    }
    let method = Method::from_bytes(req.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("invalid method: {}", req.method))?;

    let mut headers = reqwest::header::HeaderMap::new();
    for (k, v) in &req.headers {
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|_| format!("invalid header name: {k}"))?;
        let value = HeaderValue::from_str(v).map_err(|_| format!("invalid header value for {k}"))?;
        headers.append(name, value);
    }

    if let Some(auth) = &req.auth {
        // Credential Manager access is quick; keep it off the async threads anyway.
        let (sec, u) = (secrets.clone(), url.clone());
        let a = Auth {
            secret: auth.secret.clone(),
            header: auth.header.clone(),
            prefix: auth.prefix.clone(),
            query: auth.query.clone(),
        };
        let key = tauri::async_runtime::spawn_blocking(move || authorize(&sec, &u, &a))
            .await
            .map_err(|e| e.to_string())??;
        match &auth.query {
            Some(q) => {
                url.query_pairs_mut().append_pair(q, &key);
            }
            None => {
                if auth.header.is_empty() {
                    return Err("auth needs a header or query name".into());
                }
                let name = HeaderName::from_bytes(auth.header.as_bytes())
                    .map_err(|_| "invalid auth header name".to_string())?;
                let mut value = HeaderValue::from_str(&format!("{}{}", auth.prefix, key))
                    .map_err(|_| "secret is not a valid header value".to_string())?;
                value.set_sensitive(true);
                headers.insert(name, value);
            }
        }
    }

    let mut b = http.client.request(method, url).headers(headers);
    b = match req.body {
        None => b,
        Some(Body::Text { value }) => b.body(value),
        Some(Body::Json { value }) => {
            let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
            if !req.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
                b = b.header("content-type", "application/json");
            }
            b.body(bytes)
        }
        Some(Body::Bytes { value }) => b.body(value),
        Some(Body::File { path }) => {
            let (body, len) = file_body(&path).await?;
            b.header(reqwest::header::CONTENT_LENGTH, len).body(body)
        }
        Some(Body::Multipart { parts }) => {
            let mut form = reqwest::multipart::Form::new();
            for p in parts {
                let mut part = match p.value {
                    PartValue::Text { value } => reqwest::multipart::Part::text(value),
                    PartValue::Bytes { value } => reqwest::multipart::Part::bytes(value),
                    PartValue::File { path } => {
                        let (body, len) = file_body(&path).await?;
                        reqwest::multipart::Part::stream_with_length(body, len)
                    }
                };
                if let Some(f) = p.filename {
                    part = part.file_name(f);
                }
                if let Some(ct) = p.content_type {
                    part = part.mime_str(&ct).map_err(|_| format!("invalid content type: {ct}"))?;
                }
                form = form.part(p.name, part);
            }
            b.multipart(form)
        }
    };
    Ok(b)
}

async fn send(b: RequestBuilder, token: &CancellationToken, timeout: Option<Duration>) -> R<Response> {
    let fut = async {
        match timeout {
            Some(d) => tokio::time::timeout(d, b.send())
                .await
                .map_err(|_| "request timed out".to_string())?
                .map_err(net_err),
            None => b.send().await.map_err(net_err),
        }
    };
    tokio::select! {
        _ = token.cancelled() => Err("cancelled".into()),
        r = fut => r,
    }
}

/// Next body chunk honouring cancel and an idle timeout.
async fn next_chunk(
    resp: &mut Response,
    token: &CancellationToken,
    idle: Option<Duration>,
) -> R<Option<bytes::Bytes>> {
    let fut = async {
        match idle {
            Some(d) => tokio::time::timeout(d, resp.chunk())
                .await
                .map_err(|_| "response timed out".to_string())?
                .map_err(net_err),
            None => resp.chunk().await.map_err(net_err),
        }
    };
    tokio::select! {
        _ = token.cancelled() => Err("cancelled".into()),
        r = fut => r,
    }
}

async fn read_capped(
    mut resp: Response,
    token: &CancellationToken,
    idle: Option<Duration>,
) -> R<Vec<u8>> {
    if resp.content_length().is_some_and(|n| n > MAX_BODY as u64) {
        return Err("response too large".into());
    }
    let mut out = Vec::new();
    while let Some(c) = next_chunk(&mut resp, token, idle).await? {
        if out.len() + c.len() > MAX_BODY {
            return Err("response too large".into());
        }
        out.extend_from_slice(&c);
    }
    Ok(out)
}

#[tauri::command]
pub async fn http_fetch(
    http: tauri::State<'_, Http>,
    secrets: tauri::State<'_, Secrets>,
    req: HttpRequest,
) -> R<FetchResponse> {
    let timeout = req.timeout_ms.map(Duration::from_millis);
    let reg = http.register(req.request_id.as_deref())?;
    let b = build(&http, &secrets, req).await?;
    let work = async {
        let resp = send(b, &reg.token, None).await?;
        let status = resp.status().as_u16();
        let headers = header_pairs(resp.headers());
        let body = read_capped(resp, &reg.token, None).await?;
        Ok(FetchResponse { status, headers, body_text: String::from_utf8_lossy(&body).into_owned() })
    };
    match timeout {
        Some(d) => tokio::time::timeout(d, work).await.map_err(|_| "request timed out".to_string())?,
        None => work.await,
    }
}

/// Raw body for 2xx; non-2xx is an error carrying the status and a short body excerpt.
#[tauri::command]
pub async fn http_fetch_bytes(
    http: tauri::State<'_, Http>,
    secrets: tauri::State<'_, Secrets>,
    req: HttpRequest,
) -> R<tauri::ipc::Response> {
    let timeout = req.timeout_ms.map(Duration::from_millis);
    let reg = http.register(req.request_id.as_deref())?;
    let b = build(&http, &secrets, req).await?;
    let work = async {
        let resp = send(b, &reg.token, None).await?;
        let status = resp.status();
        let body = read_capped(resp, &reg.token, None).await?;
        if !status.is_success() {
            let text = String::from_utf8_lossy(&body);
            let excerpt: String = text.chars().take(500).collect();
            return Err(format!("HTTP {}: {excerpt}", status.as_u16()));
        }
        Ok(tauri::ipc::Response::new(body))
    };
    match timeout {
        Some(d) => tokio::time::timeout(d, work).await.map_err(|_| "request timed out".to_string())?,
        None => work.await,
    }
}

/// Decodes UTF-8 across chunk boundaries; invalid bytes become U+FFFD.
#[derive(Default)]
struct Utf8Chunks {
    tail: Vec<u8>,
}

impl Utf8Chunks {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.tail.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest = &self.tail[..];
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    rest = &[];
                    break;
                }
                Err(e) => {
                    let (good, bad) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(good).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &bad[n..];
                        }
                        None => {
                            rest = bad;
                            break;
                        }
                    }
                }
            }
        }
        self.tail = rest.to_vec();
        out
    }

    fn finish(&mut self) -> String {
        if self.tail.is_empty() {
            String::new()
        } else {
            self.tail.clear();
            "\u{FFFD}".into()
        }
    }
}

async fn run_stream(
    resp: Response,
    token: &CancellationToken,
    idle: Option<Duration>,
    on_event: &Channel<StreamEvent>,
) -> R<()> {
    let mut resp = resp;
    on_event
        .send(StreamEvent::Status { status: resp.status().as_u16(), headers: header_pairs(resp.headers()) })
        .map_err(|e| e.to_string())?;
    let mut dec = Utf8Chunks::default();
    while let Some(c) = next_chunk(&mut resp, token, idle).await? {
        let text = dec.push(&c);
        if !text.is_empty() {
            on_event.send(StreamEvent::Chunk { text }).map_err(|e| e.to_string())?;
        }
    }
    let rest = dec.finish();
    if !rest.is_empty() {
        let _ = on_event.send(StreamEvent::Chunk { text: rest });
    }
    Ok(())
}

/// Always resolves `Ok`; the outcome is delivered as `Done` or `Error` on the channel.
#[tauri::command]
pub async fn http_stream(
    http: tauri::State<'_, Http>,
    secrets: tauri::State<'_, Secrets>,
    req: HttpRequest,
    on_event: Channel<StreamEvent>,
) -> R<()> {
    let idle = req.timeout_ms.map(Duration::from_millis);
    let result = async {
        let reg = http.register(req.request_id.as_deref())?;
        let b = build(&http, &secrets, req).await?;
        let resp = send(b, &reg.token, idle).await?;
        run_stream(resp, &reg.token, idle, &on_event).await
    }
    .await;
    let _ = on_event.send(match result {
        Ok(()) => StreamEvent::Done,
        Err(message) => StreamEvent::Error { message },
    });
    Ok(())
}

#[tauri::command]
pub fn http_cancel(http: tauri::State<'_, Http>, request_id: String) -> bool {
    let token = http.inflight.lock().ok().and_then(|m| m.get(&request_id).cloned());
    token.map(|t| t.cancel()).is_some()
}

async fn download_to(
    resp: Response,
    stage: &std::path::Path,
    token: &CancellationToken,
    idle: Option<Duration>,
    on_progress: &Channel<Progress>,
) -> R<u64> {
    use tokio::io::AsyncWriteExt;
    let mut resp = resp;
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(stage).await.map_err(|e| io_err(stage, e))?;
    let mut received = 0u64;
    let mut last = Instant::now();
    let _ = on_progress.send(Progress { received, total });
    while let Some(c) = next_chunk(&mut resp, token, idle).await? {
        file.write_all(&c).await.map_err(|e| io_err(stage, e))?;
        received += c.len() as u64;
        if last.elapsed() >= Duration::from_millis(100) {
            last = Instant::now();
            let _ = on_progress.send(Progress { received, total });
        }
    }
    file.sync_all().await.map_err(|e| io_err(stage, e))?;
    let _ = on_progress.send(Progress { received, total });
    Ok(received)
}

#[tauri::command]
pub async fn http_download(
    http: tauri::State<'_, Http>,
    secrets: tauri::State<'_, Secrets>,
    req: HttpRequest,
    dest_path: PathBuf,
    on_progress: Channel<Progress>,
) -> R<DownloadResult> {
    let idle = req.timeout_ms.map(Duration::from_millis);
    let reg = http.register(req.request_id.as_deref())?;
    let dir = dest_path.parent().ok_or("destination has no parent")?.to_path_buf();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| io_err(&dir, e))?;
    let stage = dir.join(format!(
        ".{}.{}.part",
        dest_path.file_name().and_then(|n| n.to_str()).unwrap_or("download"),
        uuid::Uuid::new_v4().simple()
    ));
    let b = build(&http, &secrets, req).await?;
    let result = async {
        let resp = send(b, &reg.token, idle).await?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = download_to(resp, &stage, &reg.token, idle, &on_progress).await?;
        tokio::fs::rename(&stage, &dest_path).await.map_err(|e| io_err(&dest_path, e))?;
        Ok(DownloadResult { path: dest_path.to_string_lossy().into_owned(), bytes, content_type })
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&stage).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_chunks() {
        let s = "a€😀b";
        let bytes = s.as_bytes();
        for cut in 0..bytes.len() {
            let mut d = Utf8Chunks::default();
            let mut out = d.push(&bytes[..cut]);
            out.push_str(&d.push(&bytes[cut..]));
            out.push_str(&d.finish());
            assert_eq!(out, s, "cut at {cut}");
        }
    }

    #[test]
    fn utf8_invalid_bytes_replaced() {
        let mut d = Utf8Chunks::default();
        assert_eq!(d.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        assert_eq!(d.push(&[0xE2, 0x82]), "");
        assert_eq!(d.finish(), "\u{FFFD}");
    }

    #[test]
    fn authorize_rejects_bad_hosts() {
        let s = Secrets::load(std::env::temp_dir().join("palmier-test-none"));
        let a = |secret: &str| Auth { secret: secret.into(), header: "x".into(), prefix: String::new(), query: None };
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(authorize(&s, &u("http://api.openai.com/v1"), &a("openai")).unwrap_err().contains("https"));
        assert!(authorize(&s, &u("https://evil.com/v1"), &a("openai")).unwrap_err().contains("may not be sent"));
        assert!(authorize(&s, &u("https://api.openai.com:8443/"), &a("openai")).unwrap_err().contains("may not be sent"));
        assert!(authorize(&s, &u("https://api.openai.com/"), &a("nope")).unwrap_err().contains("unknown secret"));
    }
}
