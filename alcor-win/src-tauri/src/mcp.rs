//! MCP server (Streamable HTTP, JSON responses only). Tools live in the webview; this is a bridge.

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::{get, post},
};
use futures_util::stream::{self, Stream};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::{broadcast, oneshot};

pub const PORT: u16 = 19789;
const SUPPORTED: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
const RESOURCE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 256;
const SESSION_HEADER: &str = "mcp-session-id";

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Executes a tool somewhere and returns a complete MCP tool result (`{content, isError?}`).
pub trait Bridge: Send + Sync + 'static {
    fn call_tool(&self, name: String, arguments: Value) -> BoxFut<Value>;
    /// Called with the `clientInfo` of each `initialize` request (Swift: `MCPClientInfo`).
    fn client_initialized(&self, _client_info: Value) {}
    /// Text of a resource listed in `RESOURCES`, or `None` when it cannot be produced right now.
    fn read_resource(&self, _uri: String) -> BoxFut<Option<String>> {
        Box::pin(async { None })
    }
}

/// `(name, uri, description)` of the resources the editor serves (Swift `MCPService.registerResources`).
const RESOURCES: &[(&str, &str, &str)] = &[
    ("Video Models", "palmier://models/video", "Available AI video generation models and their capabilities"),
    ("Image Models", "palmier://models/image", "Available AI image generation models and their capabilities"),
];

pub struct McpState {
    bridge: Arc<dyn Bridge>,
    tools: RwLock<Vec<Value>>,
    instructions: RwLock<Option<String>>,
    sessions: Mutex<HashSet<String>>,
    /// Sessions whose GET stream already received the first `tools/list_changed` announcement.
    announced: Mutex<HashSet<String>>,
    list_changed: broadcast::Sender<()>,
}

const LIST_CHANGED: &str = r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#;

impl McpState {
    pub fn new(bridge: Arc<dyn Bridge>) -> Self {
        Self {
            bridge,
            tools: RwLock::new(Vec::new()),
            instructions: RwLock::new(None),
            sessions: Mutex::new(HashSet::new()),
            announced: Mutex::new(HashSet::new()),
            list_changed: broadcast::channel(16).0,
        }
    }

    /// Replaces the advertised tool list; a changed list is announced to every open GET stream.
    pub fn set_tools(&self, tools: Vec<Value>) {
        let changed = {
            let mut current = self.tools.write().unwrap_or_else(|e| e.into_inner());
            let changed = *current != tools;
            *current = tools;
            changed
        };
        if changed {
            let _ = self.list_changed.send(());
        }
    }

    pub fn set_instructions(&self, text: Option<String>) {
        *self.instructions.write().unwrap_or_else(|e| e.into_inner()) = text;
    }
}

pub fn error_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn rpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_err(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_name(t: &Value) -> Option<&str> {
    t.get("name").and_then(Value::as_str)
}

async fn handle_message(state: &McpState, msg: Value) -> Option<Value> {
    let Some(obj) = msg.as_object() else {
        return Some(rpc_err(Value::Null, -32600, "Invalid Request"));
    };
    let id = obj.get("id").cloned();
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        // A client response to a server request (we send none) is simply acknowledged.
        let is_response = id.is_some() && (obj.contains_key("result") || obj.contains_key("error"));
        return if is_response { None } else { Some(rpc_err(id.unwrap_or(Value::Null), -32600, "Invalid Request")) };
    };
    let id = id?; // no id = notification
    let params = obj.get("params").cloned().unwrap_or(Value::Null);

    Some(match method {
        "initialize" => {
            if let Some(info) = params.get("clientInfo") {
                state.bridge.client_initialized(info.clone());
            }
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = SUPPORTED.iter().find(|v| **v == requested).unwrap_or(&SUPPORTED[0]);
            let mut result = json!({
                "protocolVersion": version,
                "capabilities": {
                    "tools": { "listChanged": true },
                    "resources": { "subscribe": false, "listChanged": false },
                },
                "serverInfo": { "name": "alcor-pro", "version": env!("CARGO_PKG_VERSION") },
            });
            if let Some(text) = state.instructions.read().unwrap_or_else(|e| e.into_inner()).clone() {
                result["instructions"] = Value::String(text);
            }
            rpc_ok(id, result)
        }
        "ping" => rpc_ok(id, json!({})),
        "tools/list" => {
            let tools = state.tools.read().unwrap_or_else(|e| e.into_inner()).clone();
            rpc_ok(id, json!({ "tools": tools }))
        }
        "resources/list" => {
            let resources: Vec<Value> = RESOURCES
                .iter()
                .map(|(name, uri, description)| {
                    json!({ "name": name, "uri": uri, "description": description, "mimeType": "application/json" })
                })
                .collect();
            rpc_ok(id, json!({ "resources": resources }))
        }
        "resources/read" => {
            let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                return Some(rpc_err(id, -32602, "Missing resource uri"));
            };
            if !RESOURCES.iter().any(|(_, known, _)| *known == uri) {
                return Some(rpc_ok(id, json!({ "contents": [{ "uri": uri, "text": format!("Unknown resource: {uri}") }] })));
            }
            match state.bridge.read_resource(uri.to_string()).await {
                Some(text) => rpc_ok(id, json!({ "contents": [{ "uri": uri, "mimeType": "application/json", "text": text }] })),
                None => rpc_err(id, -32603, "The editor could not provide this resource."),
            }
        }
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(rpc_err(id, -32602, "Missing tool name"));
            };
            let known = {
                let tools = state.tools.read().unwrap_or_else(|e| e.into_inner());
                if tools.is_empty() {
                    return Some(rpc_ok(
                        id,
                        error_result("The editor has no open project. Open or create a project in Alcor Pro first."),
                    ));
                }
                tools.iter().any(|t| tool_name(t) == Some(name))
            };
            if !known {
                // Swift answers an unknown name with an error tool result, not a protocol error.
                return Some(rpc_ok(id, error_result(&format!("Unknown tool: {name}"))));
            }
            let args = match params.get("arguments") {
                Some(Value::Null) | None => json!({}),
                Some(v) => v.clone(),
            };
            let result = state.bridge.call_tool(name.to_string(), args).await;
            rpc_ok(id, result)
        }
        _ => rpc_err(id, -32601, "Method not found"),
    })
}

fn host_is_loopback(h: &str) -> bool {
    let host = if let Some(rest) = h.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        h.rsplit_once(':').map_or(h, |(host, _)| host)
    };
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

fn origin_is_loopback(origin: &str) -> bool {
    origin
        .split_once("://")
        .is_some_and(|(_, rest)| host_is_loopback(rest.split('/').next().unwrap_or("")))
}

fn status(code: StatusCode, msg: &str) -> Response {
    (code, msg.to_string()).into_response()
}

fn json_response(v: &Value, session: Option<&str>) -> Response {
    let mut r = (StatusCode::OK, serde_json::to_vec(v).unwrap_or_default()).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(s) = session.and_then(|s| HeaderValue::from_str(s).ok()) {
        r.headers_mut().insert(HeaderName::from_static(SESSION_HEADER), s);
    }
    r
}

/// DNS-rebinding protection (browsers must not reach us via a foreign Origin or Host) and session check.
fn guard(state: &McpState, headers: &HeaderMap) -> Option<Response> {
    if let Some(o) = headers.get(header::ORIGIN)
        && !o.to_str().is_ok_and(origin_is_loopback)
    {
        return Some(status(StatusCode::FORBIDDEN, "forbidden origin"));
    }
    if let Some(h) = headers.get(header::HOST)
        && !h.to_str().is_ok_and(host_is_loopback)
    {
        return Some(status(StatusCode::FORBIDDEN, "forbidden host"));
    }
    if let Some(sid) = headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok())
        && !state.sessions.lock().is_ok_and(|s| s.contains(sid))
    {
        return Some(status(StatusCode::NOT_FOUND, "unknown session"));
    }
    None
}

async fn post_mcp(State(state): State<Arc<McpState>>, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(rejected) = guard(&state, &headers) {
        return rejected;
    }

    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        let e = rpc_err(Value::Null, -32700, "Parse error");
        let mut r = json_response(&e, None);
        *r.status_mut() = StatusCode::BAD_REQUEST;
        return r;
    };

    let is_init = |m: &Value| m.get("method").and_then(Value::as_str) == Some("initialize");
    let session = match &parsed {
        Value::Object(_) if is_init(&parsed) => {
            let id = uuid::Uuid::new_v4().to_string();
            if let Ok(mut s) = state.sessions.lock() {
                if s.len() >= MAX_SESSIONS {
                    s.clear();
                    if let Ok(mut a) = state.announced.lock() {
                        a.clear();
                    }
                }
                s.insert(id.clone());
            }
            Some(id)
        }
        _ => None,
    };

    let out = match parsed {
        Value::Array(items) if items.is_empty() => Some(rpc_err(Value::Null, -32600, "Invalid Request")),
        Value::Array(items) => {
            let mut results = Vec::new();
            for m in items {
                if let Some(r) = handle_message(&state, m).await {
                    results.push(r);
                }
            }
            (!results.is_empty()).then_some(Value::Array(results))
        }
        single => handle_message(&state, single).await,
    };
    match out {
        Some(v) => json_response(&v, session.as_deref()),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn delete_mcp(State(state): State<Arc<McpState>>, headers: HeaderMap) -> Response {
    if let (Some(sid), Ok(mut s)) = (
        headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()),
        state.sessions.lock(),
    ) {
        s.remove(sid);
        if let Ok(mut a) = state.announced.lock() {
            a.remove(sid);
        }
    }
    StatusCode::OK.into_response()
}

/// Server-to-client stream. Each session is told once, right after its stream attaches, that the tool list may have
/// changed (so proxied clients refetch across app restarts); later list changes go to every open stream.
async fn get_mcp(State(state): State<Arc<McpState>>, headers: HeaderMap) -> Response {
    if let Some(rejected) = guard(&state, &headers) {
        return rejected;
    }
    let Some(sid) = headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()) else {
        return method_not_allowed().await;
    };
    let accepts_sse = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/event-stream"));
    if !accepts_sse {
        return status(StatusCode::NOT_ACCEPTABLE, "expected Accept: text/event-stream");
    }
    let first = state.announced.lock().map(|mut a| a.insert(sid.to_string())).unwrap_or(false);
    Sse::new(list_changed_stream(first, state.list_changed.subscribe())).into_response()
}

fn list_changed_stream(
    announce_now: bool,
    rx: broadcast::Receiver<()>,
) -> impl Stream<Item = Result<Event, std::convert::Infallible>> {
    stream::unfold((announce_now, rx), |(pending, mut rx)| async move {
        if pending {
            return Some((Ok(Event::default().data(LIST_CHANGED)), (false, rx)));
        }
        match rx.recv().await {
            Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
                Some((Ok(Event::default().data(LIST_CHANGED)), (false, rx)))
            }
            Err(broadcast::error::RecvError::Closed) => None,
        }
    })
}

async fn oauth_protected_resource() -> Response {
    let body = format!("{{\"resource\":\"http://127.0.0.1:{PORT}\"}}");
    let mut r = (StatusCode::OK, body).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

async fn method_not_allowed() -> Response {
    let mut r = StatusCode::METHOD_NOT_ALLOWED.into_response();
    r.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST, DELETE"));
    r
}

pub fn router(state: Arc<McpState>) -> Router {
    Router::new()
        .route("/mcp", post(post_mcp).delete(delete_mcp).get(get_mcp))
        .route("/", post(post_mcp).delete(delete_mcp).get(get_mcp))
        .route("/.well-known/oauth-protected-resource", get(oauth_protected_resource))
        .with_state(state)
}

// ---- Tauri integration ----

#[derive(Serialize, Clone)]
pub struct McpStatus {
    running: bool,
    port: u16,
    error: Option<String>,
}

/// Delivers calls to the webview as `mcp://call` (tools) and `mcp://resource` events and awaits `mcp_respond`.
struct TauriBridge {
    app: tauri::AppHandle,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

struct PendingGuard<'a>(&'a TauriBridge, &'a str);

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut p) = self.0.pending.lock() {
            p.remove(self.1);
        }
    }
}

impl Bridge for Arc<TauriBridge> {
    fn client_initialized(&self, client_info: Value) {
        use tauri::Emitter;
        let _ = self.app.emit_to("main", "mcp://client", client_info);
    }

    fn read_resource(&self, uri: String) -> BoxFut<Option<String>> {
        let this = self.clone();
        Box::pin(async move {
            use tauri::{Emitter, Manager};
            this.app.get_webview_window("main")?;
            let id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();
            this.pending.lock().ok()?.insert(id.clone(), tx);
            let _guard = PendingGuard(&this, &id);
            this.app.emit_to("main", "mcp://resource", json!({ "id": id, "uri": uri })).ok()?;
            match tokio::time::timeout(RESOURCE_TIMEOUT, rx).await {
                Ok(Ok(Value::String(text))) => Some(text),
                _ => None,
            }
        })
    }

    fn call_tool(&self, name: String, arguments: Value) -> BoxFut<Value> {
        let this = self.clone();
        Box::pin(async move {
            use tauri::{Emitter, Manager};
            if this.app.get_webview_window("main").is_none() {
                return error_result("The editor window is not ready.");
            }
            let id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();
            match this.pending.lock() {
                Ok(mut p) => p.insert(id.clone(), tx),
                Err(_) => return error_result("Internal error."),
            };
            let _guard = PendingGuard(&this, &id);
            let payload = json!({ "id": id, "name": name, "arguments": arguments });
            if this.app.emit_to("main", "mcp://call", payload).is_err() {
                return error_result("Could not reach the editor window.");
            }
            match tokio::time::timeout(CALL_TIMEOUT, rx).await {
                Ok(Ok(v)) if v.is_object() => v,
                Ok(Ok(v)) => json!({ "content": [{ "type": "text", "text": v.to_string() }] }),
                Ok(Err(_)) => error_result("The editor dropped the request."),
                Err(_) => error_result("The tool call timed out after 10 minutes."),
            }
        })
    }
}

pub struct Mcp {
    state: Arc<McpState>,
    bridge: Arc<TauriBridge>,
    status: Mutex<McpStatus>,
}

/// Binds 127.0.0.1:19789 and serves in the background. A busy port is reported, not fatal.
pub fn start(app: &tauri::AppHandle) -> Mcp {
    let bridge = Arc::new(TauriBridge { app: app.clone(), pending: Mutex::new(HashMap::new()) });
    let state = Arc::new(McpState::new(Arc::new(bridge.clone())));
    let mut status = McpStatus { running: false, port: PORT, error: None };
    let bound = std::net::TcpListener::bind(("127.0.0.1", PORT)).and_then(|l| {
        l.set_nonblocking(true)?;
        Ok(l)
    });
    match bound {
        Ok(listener) => {
            status.running = true;
            let app_router = router(state.clone());
            tauri::async_runtime::spawn(async move {
                if let Ok(l) = tokio::net::TcpListener::from_std(listener) {
                    let _ = axum::serve(l, app_router).await;
                }
            });
        }
        Err(e) => status.error = Some(format!("could not bind 127.0.0.1:{PORT}: {e}")),
    }
    Mcp { state, bridge, status: Mutex::new(status) }
}

#[tauri::command]
pub fn mcp_set_tools(mcp: tauri::State<'_, Mcp>, tools: Vec<Value>) -> Result<(), String> {
    if tools.iter().any(|t| tool_name(t).is_none()) {
        return Err("every tool needs a string `name`".into());
    }
    mcp.state.set_tools(tools);
    Ok(())
}

#[tauri::command]
pub fn mcp_set_instructions(mcp: tauri::State<'_, Mcp>, text: Option<String>) {
    mcp.state.set_instructions(text);
}

#[tauri::command]
pub fn mcp_respond(mcp: tauri::State<'_, Mcp>, id: String, result: Value) -> Result<(), String> {
    let tx = mcp.bridge.pending.lock().map_err(|e| e.to_string())?.remove(&id);
    tx.ok_or_else(|| format!("no pending call: {id}"))?
        .send(result)
        .map_err(|_| "call is no longer waiting".to_string())
}

#[tauri::command]
pub fn mcp_status(mcp: tauri::State<'_, Mcp>) -> McpStatus {
    mcp.status.lock().map(|s| s.clone()).unwrap_or(McpStatus {
        running: false,
        port: PORT,
        error: Some("status unavailable".into()),
    })
}
