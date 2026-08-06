// Portions derived from Tabularis v0.18.0 (Copyright 2026 Andrea Debernardi).
// Modified by DeployerX for the headless MySQL/MariaDB driver host. Apache-2.0; see THIRD_PARTY_NOTICES.md.

use std::collections::BTreeMap;
use std::time::Instant;

use futures_util::TryStreamExt;
use serde_json::{json, Value};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::types::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::types::{Decimal, Json};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};

use super::common::{
    binary_value, connect_timeout, credential, floating_value, page_offset, setting, ssl_mode,
    validate_network_connection, validate_query, validate_query_access, validate_schema, StatementKind,
};
use super::{Connection, QueryRequest, SchemaRequest};
use crate::protocol::HostError;

async fn pool(connection: &Connection) -> Result<sqlx::MySqlPool, HostError> {
    let (host, port) = validate_network_connection(connection, "MySQL/MariaDB", 3306)?;
    let username = setting(connection, "username").unwrap_or("root");
    let mut options = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(username)
        .charset("utf8mb4")
        .ssl_mode(match ssl_mode(connection) {
            "preferred" => MySqlSslMode::Preferred,
            "required" => MySqlSslMode::Required,
            "verify-ca" => MySqlSslMode::VerifyCa,
            "verify-full" => MySqlSslMode::VerifyIdentity,
            _ => MySqlSslMode::Disabled,
        });
    if let Some(database) = connection.database.as_deref().filter(|value| !value.is_empty()) {
        options = options.database(database);
    }
    if let Some(password) = credential(connection, "password") {
        options = options.password(password);
    }
    MySqlPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(connect_timeout(connection))
        .connect_with(options)
        .await
        .map_err(|_| connection_error())
}

fn connection_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_MYSQL_CONNECTION_FAILED",
        "Could not connect to the MySQL or MariaDB database.",
    )
    .retryable()
}

pub struct Session {
    pool: sqlx::MySqlPool,
    read_only: bool,
    database: Option<String>,
}

impl Session {
    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn health(&self) -> Result<(), HostError> {
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .map(|_| ())
            .map_err(|_| connection_error())
    }
}

pub async fn open_session(connection: &Connection) -> Result<(Session, Value), HostError> {
    let started = Instant::now();
    let pool = pool(connection).await?;
    let row = sqlx::query("SELECT VERSION() AS version, DATABASE() AS database")
        .fetch_one(&pool)
        .await
        .map_err(|_| connection_error())?;
    let version: String = row.try_get("version").map_err(|_| connection_error())?;
    let database: Option<String> = row
        .try_get("database")
        .ok()
        .flatten()
        .or_else(|| connection.database.clone());
    let evidence = json!({
        "status": "success",
        "latencyMs": started.elapsed().as_secs_f64() * 1000.0,
        "serverVersion": version,
        "database": database.clone().unwrap_or_default(),
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
    let query_kind = validate_query(connection, request)?;
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
    let query_kind = validate_query_access(session.read_only, request)?;
    let started = Instant::now();
    if query_kind == StatementKind::Rows {
        query_rows(&session.pool, request, started).await
    } else {
        execute_statement(&session.pool, request, started).await
    }
}

async fn query_rows(
    pool: &sqlx::MySqlPool,
    request: &QueryRequest,
    started: Instant,
) -> Result<Value, HostError> {
    let description = pool.describe(&request.query).await.map_err(|_| query_error())?;
    let columns: Vec<Value> = description
        .columns()
        .iter()
        .map(|column| json!({ "name": column.name(), "dataType": column.type_info().name() }))
        .collect();
    let offset = page_offset(request);
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
    let has_more = rows.len() > request.page_size as usize;
    if has_more {
        rows.pop();
    }
    Ok(json!({
        "columns": columns,
        "rows": rows,
        "affectedRows": 0,
        "truncated": has_more,
        "pagination": { "page": request.page, "pageSize": request.page_size, "totalRows": null, "hasMore": has_more },
        "executionTimeMs": started.elapsed().as_secs_f64() * 1000.0,
        "warnings": [],
        "additionalResults": []
    }))
}

async fn execute_statement(
    pool: &sqlx::MySqlPool,
    request: &QueryRequest,
    started: Instant,
) -> Result<Value, HostError> {
    let result = sqlx::query(&request.query)
        .execute(pool)
        .await
        .map_err(|_| query_error())?;
    Ok(json!({
        "columns": [], "rows": [], "affectedRows": result.rows_affected(), "truncated": false,
        "pagination": null, "executionTimeMs": started.elapsed().as_secs_f64() * 1000.0,
        "warnings": [], "additionalResults": []
    }))
}

pub async fn schema_snapshot(
    connection: &Connection,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    validate_schema(request)?;
    let pool = pool(connection).await?;
    let result = schema_snapshot_with_pool(&pool, connection.database.as_deref(), request).await;
    pool.close().await;
    result
}

pub async fn session_schema_snapshot(
    session: &Session,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    validate_schema(request)?;
    schema_snapshot_with_pool(&session.pool, session.database.as_deref(), request).await
}

async fn schema_snapshot_with_pool(
    pool: &sqlx::MySqlPool,
    database: Option<&str>,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    let schema_filter = request.schema.as_deref().or(database);
    let mut catalog = sqlx::query(
        "SELECT table_schema, table_name, table_type FROM information_schema.tables \
         WHERE table_schema = COALESCE(?, DATABASE()) \
         AND (? OR table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')) \
         ORDER BY table_schema, table_name LIMIT ?",
    )
    .bind(schema_filter)
    .bind(request.include_system)
    .bind(u64::from(request.max_tables) + 1)
    .fetch_all(pool)
    .await
    .map_err(|_| schema_error())?;
    let tables_truncated = catalog.len() > request.max_tables as usize;
    catalog.truncate(request.max_tables as usize);
    let mut schemas: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut columns_truncated = false;
    for table in catalog {
        let schema_name: String = table.try_get("table_schema").map_err(|_| schema_error())?;
        let table_name: String = table.try_get("table_name").map_err(|_| schema_error())?;
        let table_type: String = table.try_get("table_type").map_err(|_| schema_error())?;
        let mut column_rows = sqlx::query(
            "SELECT column_name, column_type, is_nullable, column_default, column_key \
             FROM information_schema.columns WHERE table_schema = ? AND table_name = ? \
             ORDER BY ordinal_position LIMIT ?",
        )
        .bind(&schema_name)
        .bind(&table_name)
        .bind(u64::from(request.max_columns_per_table) + 1)
        .fetch_all(pool)
        .await
        .map_err(|_| schema_error())?;
        if column_rows.len() > request.max_columns_per_table as usize {
            columns_truncated = true;
            column_rows.truncate(request.max_columns_per_table as usize);
        }
        let columns: Result<Vec<Value>, HostError> = column_rows
            .into_iter()
            .map(|column| {
                Ok(json!({
                    "name": column.try_get::<String, _>("column_name").map_err(|_| schema_error())?,
                    "dataType": column.try_get::<String, _>("column_type").map_err(|_| schema_error())?,
                    "nullable": column.try_get::<String, _>("is_nullable").unwrap_or_else(|_| "YES".into()) == "YES",
                    "primaryKey": column.try_get::<String, _>("column_key").unwrap_or_default() == "PRI",
                    "defaultValue": column.try_get::<Option<String>, _>("column_default").ok().flatten()
                }))
            })
            .collect();
        schemas.entry(schema_name).or_default().push(json!({
            "name": table_name,
            "type": if table_type.contains("VIEW") { "view" } else { "table" },
            "columns": columns?
        }));
    }
    let mut warnings = Vec::new();
    if tables_truncated {
        warnings.push("The schema contains additional tables beyond the configured limit.");
    }
    if columns_truncated {
        warnings.push("One or more tables contain additional columns beyond the configured limit.");
    }
    Ok(json!({
        "database": database,
        "schemas": schemas.into_iter().map(|(name, tables)| json!({ "name": name, "tables": tables })).collect::<Vec<_>>(),
        "truncated": tables_truncated || columns_truncated,
        "warnings": warnings
    }))
}

fn row_to_json(row: &MySqlRow) -> Result<Value, HostError> {
    let mut values = Vec::with_capacity(row.len());
    for index in 0..row.len() {
        let raw = row.try_get_raw(index).map_err(|_| query_error())?;
        if raw.is_null() {
            values.push(Value::Null);
            continue;
        }
        let type_name = row.column(index).type_info().name().to_ascii_uppercase();
        let value = match type_name.as_str() {
            "BOOLEAN" | "BOOL" => Value::Bool(row.try_get::<bool, _>(index).map_err(|_| query_error())?),
            "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => json!(row.try_get::<i64, _>(index).map_err(|_| query_error())?),
            "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "INTEGER UNSIGNED" | "BIGINT UNSIGNED" => json!(row.try_get::<u64, _>(index).map_err(|_| query_error())?),
            "FLOAT" | "DOUBLE" => floating_value(row.try_get::<f64, _>(index).map_err(|_| query_error())?),
            "DECIMAL" | "NUMERIC" => Value::String(row.try_get::<Decimal, _>(index).map_err(|_| query_error())?.to_string()),
            "BIT" | "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => binary_value(row.try_get::<Vec<u8>, _>(index).map_err(|_| query_error())?),
            "JSON" => row.try_get::<Json<Value>, _>(index).map_err(|_| query_error())?.0,
            "DATE" => Value::String(row.try_get::<NaiveDate, _>(index).map_err(|_| query_error())?.to_string()),
            "TIME" => Value::String(row.try_get::<NaiveTime, _>(index).map_err(|_| query_error())?.to_string()),
            "DATETIME" | "TIMESTAMP" => Value::String(row.try_get::<NaiveDateTime, _>(index).map_err(|_| query_error())?.to_string()),
            "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => Value::String(row.try_get::<String, _>(index).map_err(|_| query_error())?),
            _ => return Err(HostError::new(
                "DATABASE_MANAGER_RESULT_TYPE_UNSUPPORTED",
                format!("MySQL or MariaDB returned an unsupported result type: {type_name}."),
            )),
        };
        values.push(value);
    }
    Ok(Value::Array(values))
}

fn query_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_QUERY_FAILED",
        "MySQL or MariaDB could not execute the requested statement.",
    )
}

fn schema_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_SCHEMA_DISCOVERY_FAILED",
        "MySQL or MariaDB schema discovery failed.",
    )
}
