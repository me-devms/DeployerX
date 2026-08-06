mod common;
mod mysql;
mod postgresql;
mod sqlite;

use serde::Deserialize;
use serde_json::Value;
use zeroize::Zeroize;

use crate::protocol::HostError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub driver_id: String,
    pub endpoint: Endpoint,
    pub database: Option<String>,
    pub default_schema: Option<String>,
    pub access_mode: String,
    #[serde(default)]
    pub ssl: Value,
    #[serde(default)]
    pub settings: Value,
    #[serde(default)]
    pub credentials: Value,
}

impl Drop for Connection {
    fn drop(&mut self) {
        clear_json_secrets(&mut self.credentials);
    }
}

fn clear_json_secrets(value: &mut Value) {
    match value {
        Value::String(secret) => secret.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(clear_json_secrets),
        Value::Object(values) => values.values_mut().for_each(clear_json_secrets),
        _ => {}
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub kind: String,
    pub path: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub request_id: String,
    pub query: String,
    pub page: u32,
    pub page_size: u32,
    pub schema: Option<String>,
    #[serde(default)]
    pub batch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaRequest {
    pub request_id: String,
    pub profile_id: String,
    pub schema: Option<String>,
    pub include_system: bool,
    pub max_tables: u32,
    pub max_columns_per_table: u32,
}

pub enum DriverSession {
    PostgreSql(postgresql::Session),
    MySql(mysql::Session),
    Sqlite(sqlite::Session),
}

impl DriverSession {
    pub async fn close(&self) {
        match self {
            Self::PostgreSql(session) => session.close().await,
            Self::MySql(session) => session.close().await,
            Self::Sqlite(session) => session.close().await,
        }
    }

    pub async fn health(&self) -> Result<(), HostError> {
        match self {
            Self::PostgreSql(session) => session.health().await,
            Self::MySql(session) => session.health().await,
            Self::Sqlite(session) => session.health().await,
        }
    }
}

pub async fn open_session(connection: &Connection) -> Result<(DriverSession, Value), HostError> {
    match connection.driver_id.as_str() {
        "sqlite" => sqlite::open_session(connection)
            .await
            .map(|(session, evidence)| (DriverSession::Sqlite(session), evidence)),
        "postgresql" => postgresql::open_session(connection)
            .await
            .map(|(session, evidence)| (DriverSession::PostgreSql(session), evidence)),
        "mysql" => mysql::open_session(connection)
            .await
            .map(|(session, evidence)| (DriverSession::MySql(session), evidence)),
        _ => Err(HostError::new(
            "DATABASE_MANAGER_DRIVER_NOT_AVAILABLE",
            "This database driver is not installed.",
        )),
    }
}

pub async fn execute_session_query(
    session: &DriverSession,
    request: &QueryRequest,
) -> Result<Value, HostError> {
    match session {
        DriverSession::Sqlite(session) => sqlite::execute_session_query(session, request).await,
        DriverSession::PostgreSql(session) => postgresql::execute_session_query(session, request).await,
        DriverSession::MySql(session) => mysql::execute_session_query(session, request).await,
    }
}

pub async fn session_schema_snapshot(
    session: &DriverSession,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    match session {
        DriverSession::Sqlite(session) => sqlite::session_schema_snapshot(session, request).await,
        DriverSession::PostgreSql(session) => postgresql::session_schema_snapshot(session, request).await,
        DriverSession::MySql(session) => mysql::session_schema_snapshot(session, request).await,
    }
}

pub async fn test_connection(connection: &Connection) -> Result<Value, HostError> {
    match connection.driver_id.as_str() {
        "sqlite" => sqlite::test_connection(connection).await,
        "postgresql" => postgresql::test_connection(connection).await,
        "mysql" => mysql::test_connection(connection).await,
        _ => Err(HostError::new(
            "DATABASE_MANAGER_DRIVER_NOT_AVAILABLE",
            "This database driver is not installed.",
        )),
    }
}

pub async fn execute_query(
    connection: &Connection,
    request: &QueryRequest,
) -> Result<Value, HostError> {
    match connection.driver_id.as_str() {
        "sqlite" => sqlite::execute_query(connection, request).await,
        "postgresql" => postgresql::execute_query(connection, request).await,
        "mysql" => mysql::execute_query(connection, request).await,
        _ => Err(HostError::new(
            "DATABASE_MANAGER_DRIVER_NOT_AVAILABLE",
            "This database driver is not installed.",
        )),
    }
}

pub async fn schema_snapshot(
    connection: &Connection,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    match connection.driver_id.as_str() {
        "sqlite" => sqlite::schema_snapshot(connection, request).await,
        "postgresql" => postgresql::schema_snapshot(connection, request).await,
        "mysql" => mysql::schema_snapshot(connection, request).await,
        _ => Err(HostError::new(
            "DATABASE_MANAGER_DRIVER_NOT_AVAILABLE",
            "This database driver is not installed.",
        )),
    }
}
// Portions derived from Tabularis v0.18.0 (Copyright 2026 Andrea Debernardi).
// Modified by DeployerX for renderer-independent driver contracts. Apache-2.0; see THIRD_PARTY_NOTICES.md.
