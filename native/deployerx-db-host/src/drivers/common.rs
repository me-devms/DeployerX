use std::time::Duration;

use base64::Engine;
use serde_json::{Map, Number, Value};

use super::{Connection, QueryRequest, SchemaRequest};
use crate::protocol::HostError;

pub const MAX_PAGE_SIZE: u32 = 5_000;
pub const MAX_SCHEMA_TABLES: u32 = 1_000;
pub const MAX_SCHEMA_COLUMNS: u32 = 1_000;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum StatementKind {
    Rows,
    Write,
}

pub fn validate_network_connection(
    connection: &Connection,
    driver_name: &str,
    default_port: u16,
) -> Result<(&str, u16), HostError> {
    if connection.endpoint.kind != "network" {
        return Err(HostError::new(
            "DATABASE_MANAGER_NETWORK_ENDPOINT_INVALID",
            format!("{driver_name} requires a network endpoint."),
        ));
    }
    let host = connection
        .endpoint
        .host
        .as_deref()
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| {
            HostError::new(
                "DATABASE_MANAGER_NETWORK_ENDPOINT_INVALID",
                format!("{driver_name} requires a valid host."),
            )
        })?;
    Ok((host, connection.endpoint.port.unwrap_or(default_port)))
}

pub fn setting<'a>(connection: &'a Connection, key: &str) -> Option<&'a str> {
    connection
        .settings
        .as_object()
        .and_then(|settings| settings.get(key))
        .and_then(Value::as_str)
        .filter(|value| !value.contains('\0'))
}

pub fn credential<'a>(connection: &'a Connection, key: &str) -> Option<&'a str> {
    connection
        .credentials
        .as_object()
        .and_then(|credentials| credentials.get(key))
        .and_then(Value::as_str)
        .filter(|value| !value.contains('\0'))
}

pub fn ssl_mode(connection: &Connection) -> &str {
    connection
        .ssl
        .as_object()
        .and_then(|ssl| ssl.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("disabled")
}

pub fn connect_timeout(connection: &Connection) -> Duration {
    let milliseconds = connection
        .settings
        .as_object()
        .and_then(|settings| settings.get("connectTimeoutMs"))
        .and_then(Value::as_u64)
        .unwrap_or(15_000)
        .clamp(1_000, 120_000);
    Duration::from_millis(milliseconds)
}

pub fn validate_query(
    connection: &Connection,
    request: &QueryRequest,
) -> Result<StatementKind, HostError> {
    validate_query_access(connection.access_mode == "read-only", request)
}

pub fn validate_query_access(
    read_only: bool,
    request: &QueryRequest,
) -> Result<StatementKind, HostError> {
    if request.query.as_bytes().len() > 2 * 1024 * 1024 || request.query.trim().is_empty() {
        return Err(HostError::new(
            "DATABASE_MANAGER_QUERY_INVALID",
            "The database query is empty or too large.",
        ));
    }
    if request.page == 0 || request.page_size == 0 || request.page_size > MAX_PAGE_SIZE {
        return Err(HostError::new(
            "DATABASE_MANAGER_QUERY_PAGE_INVALID",
            "The database query page is invalid.",
        ));
    }
    if request.batch {
        return Err(HostError::new(
            "DATABASE_MANAGER_BATCH_NOT_IMPLEMENTED",
            "Raw driver batches are disabled. Use the explicit sequential batch service.",
        ));
    }
    let kind = statement_kind(&request.query, read_only);
    if read_only && kind == StatementKind::Write {
        return Err(HostError::new(
            "DATABASE_MANAGER_READ_ONLY_VIOLATION",
            "This profile is read only and cannot run the requested statement.",
        ));
    }
    Ok(kind)
}

pub fn validate_schema(request: &SchemaRequest) -> Result<(), HostError> {
    if request.max_tables == 0
        || request.max_tables > MAX_SCHEMA_TABLES
        || request.max_columns_per_table == 0
        || request.max_columns_per_table > MAX_SCHEMA_COLUMNS
    {
        return Err(HostError::new(
            "DATABASE_MANAGER_SCHEMA_LIMIT_INVALID",
            "The database schema discovery limits are invalid.",
        ));
    }
    Ok(())
}

pub fn statement_kind(sql: &str, read_only: bool) -> StatementKind {
    let first = without_leading_comments(sql)
        .split(|character: char| character.is_whitespace() || character == '(')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if matches!(first.as_str(), "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "VALUES")
        || (first == "WITH" && !read_only)
    {
        StatementKind::Rows
    } else {
        StatementKind::Write
    }
}

pub fn without_leading_comments(mut sql: &str) -> &str {
    loop {
        sql = sql.trim_start_matches(|character: char| character.is_whitespace() || character == ';');
        if let Some(rest) = sql.strip_prefix("--") {
            sql = rest.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
            continue;
        }
        if let Some(rest) = sql.strip_prefix("/*") {
            sql = rest.split_once("*/").map(|(_, tail)| tail).unwrap_or("");
            continue;
        }
        return sql;
    }
}

pub fn binary_value(bytes: Vec<u8>) -> Value {
    let mut binary = Map::new();
    binary.insert("type".into(), Value::String("binary".into()));
    binary.insert(
        "byteLength".into(),
        Value::Number((bytes.len() as u64).into()),
    );
    binary.insert(
        "base64".into(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
    );
    Value::Object(binary)
}

pub fn floating_value(value: f64) -> Value {
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or_else(|| Value::String(value.to_string()))
}

pub fn page_offset(request: &QueryRequest) -> u64 {
    (request.page as u64 - 1) * request.page_size as u64
}

#[cfg(test)]
mod tests {
    use super::{statement_kind, without_leading_comments, StatementKind};

    #[test]
    fn classifies_row_and_write_statements_conservatively() {
        assert!(matches!(statement_kind("SELECT 1", true), StatementKind::Rows));
        assert!(matches!(statement_kind("-- note\nSHOW TABLES", true), StatementKind::Rows));
        assert!(matches!(statement_kind("DELETE FROM t", true), StatementKind::Write));
        assert!(matches!(statement_kind("WITH x AS (SELECT 1) SELECT * FROM x", true), StatementKind::Write));
        assert!(matches!(statement_kind("WITH x AS (SELECT 1) SELECT * FROM x", false), StatementKind::Rows));
    }

    #[test]
    fn removes_only_leading_comments() {
        assert_eq!(without_leading_comments(" ; /* first */ -- second\n SELECT 1"), "SELECT 1");
    }
}
// Portions derived from Tabularis v0.18.0 (Copyright 2026 Andrea Debernardi).
// Modified by DeployerX for bounded validation and serialization. Apache-2.0; see THIRD_PARTY_NOTICES.md.
