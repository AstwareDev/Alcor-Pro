use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use alcor_pro_lib::mcp::{BoxFut, Bridge, McpState, error_result, router};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

struct Echo;

impl Bridge for Echo {
    fn call_tool(&self, name: String, arguments: Value) -> BoxFut<Value> {
        Box::pin(async move {
            if name == "fail" {
                return error_result("boom");
            }
            json!({ "content": [{ "type": "text", "text": format!("{name}:{arguments}") }] })
        })
    }
}

async fn post(
    app: &axum::Router,
    body: Value,
    extra: &[(&str, &str)],
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut req = Request::post("/mcp").header("content-type", "application/json");
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let res = app.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, headers, value)
}

fn app() -> (axum::Router, Arc<McpState>) {
    let state = Arc::new(McpState::new(Arc::new(Echo)));
    (router(state.clone()), state)
}

#[tokio::test]
async fn initialize_list_call() {
    let (app, state) = app();
    state.set_instructions(Some("be nice".into()));
    state.set_tools(vec![json!({ "name": "echo", "description": "d", "inputSchema": { "type": "object" } })]);

    let (st, h, v) = post(
        &app,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }),
        &[("origin", "http://localhost:5173")],
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(v["result"]["serverInfo"]["name"], "alcor-pro");
    assert_eq!(v["result"]["capabilities"]["tools"]["listChanged"], true);
    assert_eq!(v["result"]["instructions"], "be nice");
    let sid = h.get("mcp-session-id").unwrap().to_str().unwrap().to_string();

    let (st, _, _) = post(&app, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), &[("mcp-session-id", &sid)]).await;
    assert_eq!(st, StatusCode::ACCEPTED);

    let (_, _, v) = post(&app, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), &[("mcp-session-id", &sid)]).await;
    assert_eq!(v["result"]["tools"][0]["name"], "echo");

    let (_, _, v) = post(
        &app,
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "echo", "arguments": { "a": 1 } } }),
        &[("mcp-session-id", &sid)],
    )
    .await;
    assert_eq!(v["result"]["content"][0]["text"], r#"echo:{"a":1}"#);

    let (_, _, v) = post(&app, json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "nope" } }), &[]).await;
    assert_eq!(v["result"]["isError"], true);
    assert_eq!(v["result"]["content"][0]["text"], "Unknown tool: nope");
}

#[tokio::test]
async fn unsupported_version_falls_back_to_latest() {
    let (app, _) = app();
    let (_, _, v) = post(&app, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }), &[]).await;
    assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
}

#[tokio::test]
async fn no_tools_means_no_project() {
    let (app, _) = app();
    let (_, _, v) = post(&app, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "echo" } }), &[]).await;
    assert_eq!(v["result"]["isError"], true);
    assert!(v["result"]["content"][0]["text"].as_str().unwrap().contains("no open project"));
}

#[tokio::test]
async fn batch_ping_and_unknown_method() {
    let (app, _) = app();
    let (_, _, v) = post(
        &app,
        json!([
            { "jsonrpc": "2.0", "id": 1, "method": "ping" },
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
            { "jsonrpc": "2.0", "id": 2, "method": "bogus" }
        ]),
        &[],
    )
    .await;
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["result"], json!({}));
    assert_eq!(arr[1]["error"]["code"], -32601);
}

#[tokio::test]
async fn rejects_foreign_origin_host_and_unknown_session() {
    let (app, _) = app();
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    assert_eq!(post(&app, ping.clone(), &[("origin", "https://evil.example")]).await.0, StatusCode::FORBIDDEN);
    assert_eq!(post(&app, ping.clone(), &[("origin", "http://localhost.evil.example")]).await.0, StatusCode::FORBIDDEN);
    assert_eq!(post(&app, ping.clone(), &[("host", "evil.example:19789")]).await.0, StatusCode::FORBIDDEN);
    assert_eq!(post(&app, ping.clone(), &[("host", "127.0.0.1:19789"), ("origin", "http://127.0.0.1:3000")]).await.0, StatusCode::OK);
    assert_eq!(post(&app, ping, &[("mcp-session-id", "bogus")]).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_is_405_and_garbage_is_parse_error() {
    let (app, _) = app();
    let res = app.clone().oneshot(Request::get("/mcp").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    let res = app
        .oneshot(Request::post("/mcp").body(Body::from("{nope")).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn get_stream_announces_tool_list_once_per_session_then_on_change() {
    use futures_util::StreamExt;
    use std::time::Duration;

    let (app, state) = app();
    let (_, h, _) = post(
        &app,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": "t", "version": "0" } } }),
        &[],
    )
    .await;
    let sid = h.get("mcp-session-id").unwrap().to_str().unwrap().to_string();

    let attach = |app: axum::Router, sid: String| async move {
        let req = Request::get("/mcp")
            .header("accept", "text/event-stream")
            .header("mcp-session-id", sid)
            .body(Body::empty())
            .unwrap();
        app.oneshot(req).await.unwrap()
    };
    let res = attach(app.clone(), sid.clone()).await;
    assert_eq!(res.status(), StatusCode::OK);
    let mut stream = res.into_body().into_data_stream();
    let first = tokio::time::timeout(Duration::from_secs(5), stream.next()).await.unwrap().unwrap().unwrap();
    assert!(String::from_utf8_lossy(&first).contains("notifications/tools/list_changed"));

    // Announce is once per session: further requests touching the session add nothing.
    post(&app, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), &[("mcp-session-id", &sid)]).await;
    assert!(tokio::time::timeout(Duration::from_millis(300), stream.next()).await.is_err());

    // A changed tool list is announced to the open stream; an identical one is not.
    state.set_tools(vec![json!({ "name": "a", "inputSchema": { "type": "object" } })]);
    let again = tokio::time::timeout(Duration::from_secs(5), stream.next()).await.unwrap().unwrap().unwrap();
    assert!(String::from_utf8_lossy(&again).contains("notifications/tools/list_changed"));
    state.set_tools(vec![json!({ "name": "a", "inputSchema": { "type": "object" } })]);
    assert!(tokio::time::timeout(Duration::from_millis(300), stream.next()).await.is_err());

    // A second stream on the same session gets no immediate announcement.
    let res = attach(app.clone(), sid.clone()).await;
    let mut second = res.into_body().into_data_stream();
    assert!(tokio::time::timeout(Duration::from_millis(300), second.next()).await.is_err());
}

#[tokio::test]
async fn get_stream_needs_a_known_session_and_sse_accept() {
    let (app, _) = app();
    let bogus = Request::get("/mcp").header("accept", "text/event-stream").header("mcp-session-id", "nope").body(Body::empty()).unwrap();
    assert_eq!(app.clone().oneshot(bogus).await.unwrap().status(), StatusCode::NOT_FOUND);
    let (_, h, _) = post(&app, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }), &[]).await;
    let sid = h.get("mcp-session-id").unwrap().to_str().unwrap().to_string();
    let plain = Request::get("/mcp").header("mcp-session-id", sid).body(Body::empty()).unwrap();
    assert_eq!(app.clone().oneshot(plain).await.unwrap().status(), StatusCode::NOT_ACCEPTABLE);
    let res = app.oneshot(Request::get("/.well-known/oauth-protected-resource").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
