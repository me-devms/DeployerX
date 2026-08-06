// Portions derived from Tabularis v0.18.0 (Copyright 2026 Andrea Debernardi).
// Modified by DeployerX for non-creating local SQLite access. Apache-2.0; see THIRD_PARTY_NOTICES.md.

use std::path::Path;
use std::time::Instant;

use base64::Engine;
use futures_util::TryStreamExt;
use serde_json::{json, Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};

use super::{Connection, QueryRequest, SchemaRequest};
use crate::protocol::HostError;

const MAX_PAGE_SIZE: u32 = 5_000;

async fn pool(connection: &Connection) -> Result<sqlx::SqlitePool, HostError> {
    if connection.endpoint.kind != "file" {
        return Err(HostError::new(
            "DATABASE_MANAGER_SQLITE_ENDPOINT_INVALID",
            "SQLite requires a local database file.",
        ));
    }
    let path = connection
        .endpoint
        .path
        .as_deref()
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| {
            HostError::new(
                "DATABASE_MANAGER_LOCAL_RESOURCE_REQUIRED",
                "Choose the local SQLite database file first.",
            )
        })?;
    if !Path::new(path).is_file() {
        return Err(HostError::new(
            "DATABASE_MANAGER_LOCAL_RESOURCE_NOT_FOUND",
            "The selected SQLite database file is unavailable.",
        ));
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(connection.access_mode == "read-only")
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .map_err(|_| sqlite_open_error())
}

fn sqlite_open_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_SQLITE_OPEN_FAILED",
        "Could not open the selected SQLite database.",
    )
}

pub struct Session {
    pool: sqlx::SqlitePool,
    read_only: bool,
    database: String,
}

impl Session {
    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn health(&self) -> Result<(), HostError> {
        sqlx::query_scalar::<_, i64>("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .map(|_| ())
            .map_err(|_| sqlite_open_error())
    }
}

pub async fn open_session(connection: &Connection) -> Result<(Session, Value), HostError> {
    let started = Instant::now();
    let pool = pool(connection).await?;
    let version: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(&pool)
        .await
        .map_err(|_| sqlite_open_error())?;
    let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(&pool)
        .await
        .map_err(|_| {
            HostError::new(
                "DATABASE_MANAGER_SQLITE_INTEGRITY_FAILED",
                "The selected SQLite database did not pass its quick integrity check.",
            )
        })?;
    if !integrity.eq_ignore_ascii_case("ok") {
        pool.close().await;
        return Err(HostError::new(
            "DATABASE_MANAGER_SQLITE_INTEGRITY_FAILED",
            "The selected SQLite database did not pass its quick integrity check.",
        ));
    }
    let database = connection.database.clone().unwrap_or_else(|| "main".into());
    let evidence = json!({
        "status": "success",
        "latencyMs": started.elapsed().as_secs_f64() * 1000.0,
        "serverVersion": version,
        "database": database.clone(),
        "readOnly": connection.access_mode == "read-only"
    });
    Ok((Session {
        pool,
        read_only: connection.access_mode == "read-only",
        database,
    }, evidence))
}

pub async fn test_connection(connection: &Connection) -> Result<Value, HostError> {
    let (session, evidence) = open_session(connection).await?;
    session.close().await;
    Ok(evidence)
}

pub async fn execute_query(
    connection: &Connection,
    request: &QueryRequest,
) -> Result<Value, HostError> {
    let query_kind = validate_query_request(connection.access_mode == "read-only", request)?;
    let started = Instant::now();
    let pool = pool(connection).await?;
    let result = if query_kind == StatementKind::Rows {
        query_rows(&pool, request, started).await
    } else {
        execute_statement(&pool, request, started).await
    };
    pool.close().await;
    result
}

pub async fn execute_session_query(
    session: &Session,
    request: &QueryRequest,
) -> Result<Value, HostError> {
    let query_kind = validate_query_request(session.read_only, request)?;
    let started = Instant::now();
    if query_kind == StatementKind::Rows {
        query_rows(&session.pool, request, started).await
    } else {
        execute_statement(&session.pool, request, started).await
    }
}

fn validate_query_request(read_only: bool, request: &QueryRequest) -> Result<StatementKind, HostError> {
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
            "Batch execution is not available in the current SQLite driver yet.",
        ));
    }
    let query_kind = statement_kind(&request.query, read_only);
    if read_only && query_kind == StatementKind::Write {
        return Err(HostError::new(
            "DATABASE_MANAGER_READ_ONLY_VIOLATION",
            "This profile is read only and cannot run the requested statement.",
        ));
    }
    Ok(query_kind)
}

pub async fn schema_snapshot(
    connection: &Connection,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    validate_schema_request(request)?;
    let pool = pool(connection).await?;
    let database = connection.database.as_deref().unwrap_or("main");
    let result = schema_snapshot_with_pool(&pool, database, request).await;
    pool.close().await;
    result
}

pub async fn session_schema_snapshot(
    session: &Session,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    validate_schema_request(request)?;
    schema_snapshot_with_pool(&session.pool, &session.database, request).await
}

fn validate_schema_request(request: &SchemaRequest) -> Result<(), HostError> {
    if request.max_tables == 0
        || request.max_tables > 1_000
        || request.max_columns_per_table == 0
        || request.max_columns_per_table > 1_000
    {
        return Err(HostError::new(
            "DATABASE_MANAGER_SCHEMA_LIMIT_INVALID",
            "The database schema discovery limits are invalid.",
        ));
    }
    Ok(())
}

async fn schema_snapshot_with_pool(
    pool: &sqlx::SqlitePool,
    database: &str,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    let catalog_sql = if request.include_system {
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY type, name LIMIT ?1"
    } else {
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT ?1"
    };
    let mut catalog = sqlx::query(catalog_sql)
        .bind(i64::from(request.max_tables) + 1)
        .fetch_all(pool)
        .await
        .map_err(|_| schema_error())?;
    let truncated = catalog.len() > request.max_tables as usize;
    catalog.truncate(request.max_tables as usize);
    let mut tables = Vec::with_capacity(catalog.len());
    let mut columns_truncated = false;
    for entry in catalog {
        let name: String = entry.try_get("name").map_err(|_| schema_error())?;
        let object_type: String = entry.try_get("type").map_err(|_| schema_error())?;
        let escaped_name = name.replace('\'', "''");
        let pragma = format!("PRAGMA table_xinfo('{escaped_name}')");
        let mut column_rows = sqlx::query(&pragma)
            .fetch_all(pool)
            .await
            .map_err(|_| schema_error())?;
        if column_rows.len() > request.max_columns_per_table as usize {
            columns_truncated = true;
            column_rows.truncate(request.max_columns_per_table as usize);
        }
        let mut columns = Vec::with_capacity(column_rows.len());
        for column in column_rows {
            let column_name: String = column.try_get("name").map_err(|_| schema_error())?;
            let data_type: String = column.try_get("type").unwrap_or_default();
            let not_null: i64 = column.try_get("notnull").unwrap_or(0);
            let primary_key: i64 = column.try_get("pk").unwrap_or(0);
            let default_value: Option<String> = column.try_get("dflt_value").ok().flatten();
            columns.push(json!({
                "name": column_name,
                "dataType": data_type,
                "nullable": not_null == 0,
                "primaryKey": primary_key > 0,
                "defaultValue": default_value
            }));
        }
        tables.push(json!({
            "name": name,
            "type": if object_type == "view" { "view" } else { "table" },
            "columns": columns
        }));
    }
    let mut warnings = Vec::new();
    if truncated {
        warnings.push("The schema contains additional tables beyond the configured limit.");
    }
    if columns_truncated {
        warnings.push("One or more tables contain additional columns beyond the configured limit.");
    }
    Ok(json!({
        "database": database,
        "schemas": [{ "name": "main", "tables": tables }],
        "truncated": truncated || columns_truncated,
        "warnings": warnings
    }))
}

fn schema_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_SCHEMA_DISCOVERY_FAILED",
        "SQLite schema discovery failed.",
    )
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum StatementKind {
    Rows,
    Write,
}

fn statement_kind(sql: &str, read_only: bool) -> StatementKind {
    let first = without_leading_comments(sql)
        .split(|character: char| character.is_whitespace() || character == '(')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if matches!(first.as_str(), "SELECT" | "PRAGMA" | "EXPLAIN" | "VALUES")
        || (first == "WITH" && !read_only)
    {
        StatementKind::Rows
    } else {
        StatementKind::Write
    }
}

fn without_leading_comments(mut sql: &str) -> &str {
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

async fn query_rows(
    pool: &sqlx::SqlitePool,
    request: &QueryRequest,
    started: Instant,
) -> Result<Value, HostError> {
    let description = pool
        .describe(&request.query)
        .await
        .map_err(|_| query_error())?;
    let columns: Vec<Value> = description
        .columns()
        .iter()
        .map(|column| {
            json!({
                "name": column.name(),
                "dataType": column.type_info().name()
            })
        })
        .collect();
    let offset = (request.page as u64 - 1) * request.page_size as u64;
    let take = request.page_size as usize + 1;
    let mut skipped = 0_u64;
    let mut rows = Vec::with_capacity(take);
    let mut stream = sqlx::query(&request.query).fetch(pool);
    while let Some(row) = stream.try_next().await.map_err(|_| query_error())? {
        if skipped < offset {
            skipped += 1;
            continue;
        }
        rows.push(row_to_json(&row)?);
        if rows.len() >= take {
            break;
        }
    }
    let truncated = rows.len() > request.page_size as usize;
    if truncated {
        rows.pop();
    }
    Ok(json!({
        "columns": columns,
        "rows": rows,
        "affectedRows": 0,
        "truncated": truncated,
        "pagination": {
            "page": request.page,
            "pageSize": request.page_size,
            "totalRows": null,
            "hasMore": truncated
        },
        "executionTimeMs": started.elapsed().as_secs_f64() * 1000.0,
        "warnings": [],
        "additionalResults": []
    }))
}

async fn execute_statement(
    pool: &sqlx::SqlitePool,
    request: &QueryRequest,
    started: Instant,
) -> Result<Value, HostError> {
    let result = sqlx::query(&request.query)
        .execute(pool)
        .await
        .map_err(|_| query_error())?;
    Ok(json!({
        "columns": [],
        "rows": [],
        "affectedRows": result.rows_affected(),
        "truncated": false,
        "pagination": null,
        "executionTimeMs": started.elapsed().as_secs_f64() * 1000.0,
        "warnings": [],
        "additionalResults": []
    }))
}

fn query_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_QUERY_FAILED",
        "SQLite could not execute the requested statement.",
    )
}

fn row_to_json(row: &SqliteRow) -> Result<Value, HostError> {
    let mut values = Vec::with_capacity(row.len());
    for index in 0..row.len() {
        let raw = row.try_get_raw(index).map_err(|_| query_error())?;
        if raw.is_null() {
            values.push(Value::Null);
            continue;
        }
        let type_name = row.column(index).type_info().name().to_ascii_uppercase();
        let value = match type_name.as_str() {
            "BOOL" | "BOOLEAN" => row.try_get::<bool, _>(index).map(Value::Bool),
            "INTEGER" | "INT" | "BIGINT" | "SMALLINT" | "TINYINT" => row
                .try_get::<i64, _>(index)
                .map(|value| Value::Number(value.into())),
            "REAL" | "FLOAT" | "DOUBLE" | "NUMERIC" | "DECIMAL" => row
                .try_get::<f64, _>(index)
                .map(|value| serde_json::Number::from_f64(value).map(Value::Number).unwrap_or_else(|| Value::String(value.to_string()))),
            "BLOB" => row.try_get::<Vec<u8>, _>(index).map(|bytes| {
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
            }),
            _ => row.try_get::<String, _>(index).map(Value::String),
        }
        .map_err(|_| query_error())?;
        values.push(value);
    }
    Ok(Value::Array(values))
}

#[cfg(test)]
mod tests {
    use super::{statement_kind, without_leading_comments, StatementKind};

    #[test]
    fn classifies_row_and_write_statements_conservatively() {
        assert!(matches!(statement_kind("SELECT 1", true), StatementKind::Rows));
        assert!(matches!(statement_kind("-- note\nPRAGMA table_info(t)", true), StatementKind::Rows));
        assert!(matches!(statement_kind("DELETE FROM t", true), StatementKind::Write));
        assert!(matches!(statement_kind("WITH x AS (SELECT 1) SELECT * FROM x", true), StatementKind::Write));
        assert!(matches!(statement_kind("WITH x AS (SELECT 1) SELECT * FROM x", false), StatementKind::Rows));
    }

    #[test]
    fn removes_only_leading_comments() {
        assert_eq!(without_leading_comments(" ; /* first */ -- second\n SELECT 1"), "SELECT 1");
    }
}
