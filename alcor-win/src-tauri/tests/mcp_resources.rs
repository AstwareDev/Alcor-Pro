use axum::body::{Body, to_bytes};
use axum::http::Request;
use alcor_pro_lib::mcp::{BoxFut, Bridge, McpState, error_result, router};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

struct Catalog;

impl Bridge for Catalog {
    fn call_tool(&self, _name: String, _arguments: Value) -> BoxFut<Value> {
        Box::pin(async { error_result("unused") })
    }
    fn read_resource(&self, uri: String) -> BoxFut<Option<String>> {
        Box::pin(async move { (uri == "palmier://models/video").then(|| "[{\"id\":\"fal/x\"}]".to_string()) })
    }
}

async fn rpc(body: Value) -> Value {
    let app = router(Arc::new(McpState::new(Arc::new(Catalog))));
    let req = Request::post("/mcp").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
    let res = app.oneshot(req).await.unwrap();
    serde_json::from_slice(&to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap()
}

#[tokio::test]
async fn initialize_advertises_resources() {
    let v = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} })).await;
    assert_eq!(v["result"]["capabilities"]["resources"]["subscribe"], false);
    assert_eq!(v["result"]["capabilities"]["resources"]["listChanged"], false);
}

#[tokio::test]
async fn lists_the_model_resources() {
    let v = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/list" })).await;
    let uris: Vec<&str> = v["result"]["resources"].as_array().unwrap().iter().map(|r| r["uri"].as_str().unwrap()).collect();
    assert_eq!(uris, ["palmier://models/video", "palmier://models/image"]);
    assert_eq!(v["result"]["resources"][0]["name"], "Video Models");
    assert_eq!(v["result"]["resources"][0]["mimeType"], "application/json");
}

#[tokio::test]
async fn reads_through_the_bridge() {
    let v = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/read", "params": { "uri": "palmier://models/video" } })).await;
    assert_eq!(v["result"]["contents"][0]["text"], "[{\"id\":\"fal/x\"}]");
    assert_eq!(v["result"]["contents"][0]["mimeType"], "application/json");

    let unavailable = rpc(json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": { "uri": "palmier://models/image" } })).await;
    assert_eq!(unavailable["error"]["code"], -32603);

    let unknown = rpc(json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": { "uri": "palmier://nope" } })).await;
    assert_eq!(unknown["result"]["contents"][0]["text"], "Unknown resource: palmier://nope");

    let missing = rpc(json!({ "jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": {} })).await;
    assert_eq!(missing["error"]["code"], -32602);
}
