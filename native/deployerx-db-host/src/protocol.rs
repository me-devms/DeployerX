use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub jsonrpc: String,
    pub protocol_version: u32,
    pub id: Option<String>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response<T>
where
    T: Serialize,
{
    pub jsonrpc: &'static str,
    pub protocol_version: u32,
    pub id: String,
    pub result: T,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub jsonrpc: &'static str,
    pub protocol_version: u32,
    pub id: String,
    pub error: RpcError,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: &'static str,
    pub data: RpcErrorData,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcErrorData {
    pub safe_message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

pub struct HostError {
    pub code: &'static str,
    pub safe_message: String,
    pub retryable: bool,
}

impl HostError {
    pub fn new(code: &'static str, safe_message: impl Into<String>) -> Self {
        Self {
            code,
            safe_message: safe_message.into(),
            retryable: false,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
}

pub fn success<T>(id: String, result: T) -> Response<T>
where
    T: Serialize,
{
    Response {
        jsonrpc: "2.0",
        protocol_version: PROTOCOL_VERSION,
        id,
        result,
    }
}

pub fn failure(id: String, error: HostError) -> ErrorResponse {
    ErrorResponse {
        jsonrpc: "2.0",
        protocol_version: PROTOCOL_VERSION,
        id,
        error: RpcError {
            code: error.code.to_string(),
            message: "Database driver operation failed.",
            data: RpcErrorData {
                safe_message: error.safe_message,
                retryable: error.retryable,
                details: None,
            },
        },
    }
}
// Portions derived from Tabularis v0.18.0 (Copyright 2026 Andrea Debernardi).
// Modified by DeployerX for versioned, secret-safe JSON-RPC. Apache-2.0; see THIRD_PARTY_NOTICES.md.
