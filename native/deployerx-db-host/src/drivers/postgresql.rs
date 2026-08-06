// Portions derived from Tabularis v0.18.0 (Copyright 2026 Andrea Debernardi).
// Modified by DeployerX for the headless PostgreSQL driver host. Apache-2.0; see THIRD_PARTY_NOTICES.md.

use std::collections::BTreeMap;
use std::time::Instant;

use futures_util::TryStreamExt;
use serde_json::{json, Value};
use sqlx::postgres::types::PgInterval;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow, PgSslMode};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::types::{Decimal, Json, Uuid};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};

use super::common::{
    binary_value, connect_timeout, credential, floating_value, page_offset, setting, ssl_mode,
    validate_network_connection, validate_query, validate_query_access, validate_schema, StatementKind,
};
use super::{Connection, QueryRequest, SchemaRequest};
use crate::protocol::HostError;

async fn pool(connection: &Connection) -> Result<sqlx::PgPool, HostError> {
    let (host, port) = validate_network_connection(connection, "PostgreSQL", 5432)?;
    let username = setting(connection, "username").unwrap_or("postgres");
    let mut options = PgConnectOptions::new()
        .host(host)
        .port(port)
        .username(username)
        .ssl_mode(match ssl_mode(connection) {
            "preferred" => PgSslMode::Prefer,
            "required" => PgSslMode::Require,
            "verify-ca" => PgSslMode::VerifyCa,
            "verify-full" => PgSslMode::VerifyFull,
            _ => PgSslMode::Disable,
        });
    if let Some(database) = connection.database.as_deref().filter(|value| !value.is_empty()) {
        options = options.database(database);
    }
    if let Some(password) = credential(connection, "password") {
        options = options.password(password);
    }
    PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(connect_timeout(connection))
        .connect_with(options)
        .await
        .map_err(|_| connection_error())
}

fn connection_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_POSTGRESQL_CONNECTION_FAILED",
        "Could not connect to the PostgreSQL database.",
    )
    .retryable()
}

pub struct Session {
    pool: sqlx::PgPool,
    read_only: bool,
    database: String,
    default_schema: Option<String>,
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
    let row = sqlx::query("SELECT version() AS version, current_database() AS database")
        .fetch_one(&pool)
        .await
        .map_err(|_| connection_error())?;
    let version: String = row.try_get("version").map_err(|_| connection_error())?;
    let database: String = row.try_get("database").map_err(|_| connection_error())?;
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
        default_schema: connection.default_schema.clone(),
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
    pool: &sqlx::PgPool,
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
    pool: &sqlx::PgPool,
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
    let result = schema_snapshot_with_pool(
        &pool,
        connection.database.as_deref(),
        connection.default_schema.as_deref(),
        request,
    ).await;
    pool.close().await;
    result
}

pub async fn session_schema_snapshot(
    session: &Session,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    validate_schema(request)?;
    schema_snapshot_with_pool(
        &session.pool,
        Some(session.database.as_str()),
        session.default_schema.as_deref(),
        request,
    ).await
}

async fn schema_snapshot_with_pool(
    pool: &sqlx::PgPool,
    database: Option<&str>,
    default_schema: Option<&str>,
    request: &SchemaRequest,
) -> Result<Value, HostError> {
    let schema_filter = request.schema.as_deref().or(default_schema);
    let mut catalog = sqlx::query(
        "SELECT table_schema, table_name, table_type FROM information_schema.tables \
         WHERE table_catalog = current_database() AND ($1::text IS NULL OR table_schema = $1) \
         AND ($2 OR table_schema NOT IN ('pg_catalog', 'information_schema')) \
         ORDER BY table_schema, table_name LIMIT $3",
    )
    .bind(schema_filter)
    .bind(request.include_system)
    .bind(i64::from(request.max_tables) + 1)
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
            "SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default, \
             EXISTS (SELECT 1 FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name \
             AND tc.constraint_schema = kcu.constraint_schema \
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema \
             AND tc.table_name = c.table_name AND kcu.column_name = c.column_name) AS primary_key \
             FROM information_schema.columns c WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position LIMIT $3",
        )
        .bind(&schema_name)
        .bind(&table_name)
        .bind(i64::from(request.max_columns_per_table) + 1)
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
                let data_type: String = column.try_get("data_type").map_err(|_| schema_error())?;
                let udt_name: String = column.try_get("udt_name").unwrap_or_default();
                let type_label = if data_type.eq_ignore_ascii_case("USER-DEFINED") { udt_name } else { data_type };
                Ok(json!({
                    "name": column.try_get::<String, _>("column_name").map_err(|_| schema_error())?,
                    "dataType": type_label,
                    "nullable": column.try_get::<String, _>("is_nullable").unwrap_or_else(|_| "YES".into()) == "YES",
                    "primaryKey": column.try_get::<bool, _>("primary_key").unwrap_or(false),
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

fn row_to_json(row: &PgRow) -> Result<Value, HostError> {
    let mut values = Vec::with_capacity(row.len());
    for index in 0..row.len() {
        let raw = row.try_get_raw(index).map_err(|_| query_error())?;
        if raw.is_null() {
            values.push(Value::Null);
            continue;
        }
        let type_name = row.column(index).type_info().name().to_ascii_uppercase();
        let value = match type_name.as_str() {
            "BOOL" => Value::Bool(row.try_get::<bool, _>(index).map_err(|_| query_error())?),
            "INT2" => json!(row.try_get::<i16, _>(index).map_err(|_| query_error())?),
            "INT4" => json!(row.try_get::<i32, _>(index).map_err(|_| query_error())?),
            "INT8" => json!(row.try_get::<i64, _>(index).map_err(|_| query_error())?),
            "OID" => json!(row.try_get::<u32, _>(index).map_err(|_| query_error())?),
            "FLOAT4" => floating_value(row.try_get::<f32, _>(index).map_err(|_| query_error())? as f64),
            "FLOAT8" => floating_value(row.try_get::<f64, _>(index).map_err(|_| query_error())?),
            "NUMERIC" => Value::String(row.try_get::<Decimal, _>(index).map_err(|_| query_error())?.to_string()),
            "BYTEA" => binary_value(row.try_get::<Vec<u8>, _>(index).map_err(|_| query_error())?),
            "JSON" | "JSONB" => row.try_get::<Json<Value>, _>(index).map_err(|_| query_error())?.0,
            "UUID" => Value::String(row.try_get::<Uuid, _>(index).map_err(|_| query_error())?.to_string()),
            "DATE" => Value::String(row.try_get::<NaiveDate, _>(index).map_err(|_| query_error())?.to_string()),
            "TIME" => Value::String(row.try_get::<NaiveTime, _>(index).map_err(|_| query_error())?.to_string()),
            "TIMESTAMP" => Value::String(row.try_get::<NaiveDateTime, _>(index).map_err(|_| query_error())?.to_string()),
            "TIMESTAMPTZ" => Value::String(row.try_get::<DateTime<Utc>, _>(index).map_err(|_| query_error())?.to_rfc3339()),
            "INTERVAL" => {
                let value = row.try_get::<PgInterval, _>(index).map_err(|_| query_error())?;
                json!({ "months": value.months, "days": value.days, "microseconds": value.microseconds })
            }
            "BOOL[]" | "_BOOL" => json!(row.try_get::<Vec<bool>, _>(index).map_err(|_| query_error())?),
            "INT2[]" | "_INT2" => json!(row.try_get::<Vec<i16>, _>(index).map_err(|_| query_error())?),
            "INT4[]" | "_INT4" => json!(row.try_get::<Vec<i32>, _>(index).map_err(|_| query_error())?),
            "INT8[]" | "_INT8" => json!(row.try_get::<Vec<i64>, _>(index).map_err(|_| query_error())?),
            "FLOAT4[]" | "_FLOAT4" => json!(row.try_get::<Vec<f32>, _>(index).map_err(|_| query_error())?),
            "FLOAT8[]" | "_FLOAT8" => json!(row.try_get::<Vec<f64>, _>(index).map_err(|_| query_error())?),
            "NUMERIC[]" | "_NUMERIC" => Value::Array(
                row.try_get::<Vec<Decimal>, _>(index)
                    .map_err(|_| query_error())?
                    .into_iter()
                    .map(|value| Value::String(value.to_string()))
                    .collect(),
            ),
            "UUID[]" | "_UUID" => Value::Array(
                row.try_get::<Vec<Uuid>, _>(index)
                    .map_err(|_| query_error())?
                    .into_iter()
                    .map(|value| Value::String(value.to_string()))
                    .collect(),
            ),
            "BYTEA[]" | "_BYTEA" => Value::Array(
                row.try_get::<Vec<Vec<u8>>, _>(index)
                    .map_err(|_| query_error())?
                    .into_iter()
                    .map(binary_value)
                    .collect(),
            ),
            "JSON[]" | "JSONB[]" | "_JSON" | "_JSONB" => Value::Array(
                row.try_get::<Vec<Json<Value>>, _>(index)
                    .map_err(|_| query_error())?
                    .into_iter()
                    .map(|value| value.0)
                    .collect(),
            ),
            "TEXT[]" | "VARCHAR[]" | "_TEXT" | "_VARCHAR" => json!(row.try_get::<Vec<String>, _>(index).map_err(|_| query_error())?),
            "CHAR" | "VARCHAR" | "TEXT" | "NAME" | "CITEXT" | "UNKNOWN" => Value::String(row.try_get::<String, _>(index).map_err(|_| query_error())?),
            _ => return Err(HostError::new(
                "DATABASE_MANAGER_RESULT_TYPE_UNSUPPORTED",
                format!("PostgreSQL returned an unsupported result type: {type_name}."),
            )),
        };
        values.push(value);
    }
    Ok(Value::Array(values))
}

fn query_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_QUERY_FAILED",
        "PostgreSQL could not execute the requested statement.",
    )
}

fn schema_error() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_SCHEMA_DISCOVERY_FAILED",
        "PostgreSQL schema discovery failed.",
    )
}
