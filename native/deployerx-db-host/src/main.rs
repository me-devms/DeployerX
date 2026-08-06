// Portions derived from Tabularis v0.18.0 (Copyright 2026 Andrea Debernardi).
// Modified by DeployerX for a bounded headless JSON-RPC host. Apache-2.0; see THIRD_PARTY_NOTICES.md.

mod drivers;
mod protocol;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use drivers::{Connection, DriverSession, QueryRequest, SchemaRequest};
use protocol::{failure, success, HostError, Request, PROTOCOL_VERSION};

const MAX_INPUT_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SESSIONS: usize = 32;
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

type Writer = Arc<Mutex<BufWriter<tokio::io::Stdout>>>;
type Tasks = Arc<Mutex<HashMap<String, JoinHandle<()>>>>;
type Sessions = Arc<Mutex<HashMap<String, HostedSession>>>;

struct HostedSession {
    driver: Arc<DriverSession>,
    opened_at_ms: u128,
    last_used_at_ms: u128,
    active_requests: usize,
}

struct SessionLease {
    sessions: Sessions,
    session_id: String,
    driver: Arc<DriverSession>,
    opened_at_ms: u128,
    last_used_at_ms: u128,
    touch_idle: bool,
}

impl SessionLease {
    fn driver(&self) -> &DriverSession {
        &self.driver
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        let sessions = Arc::clone(&self.sessions);
        let session_id = self.session_id.clone();
        let driver = Arc::clone(&self.driver);
        let touch_idle = self.touch_idle;
        let _ = tokio::spawn(async move {
            let mut values = sessions.lock().await;
            if let Some(session) = values.get_mut(&session_id) {
                if Arc::ptr_eq(&session.driver, &driver) {
                    session.active_requests = session.active_requests.saturating_sub(1);
                    if touch_idle {
                        session.last_used_at_ms = epoch_millis();
                    }
                }
            }
        });
    }
}

#[derive(Deserialize)]
struct ConnectionParams {
    connection: Connection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenConnectionParams {
    session_id: String,
    connection: Connection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

#[derive(Deserialize)]
struct QueryParams {
    connection: Connection,
    request: QueryRequest,
}

#[derive(Deserialize)]
struct SchemaParams {
    connection: Connection,
    request: SchemaRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionQueryParams {
    session_id: String,
    request: QueryRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSchemaParams {
    session_id: String,
    request: SchemaRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelParams {
    request_id: String,
}

#[tokio::main]
async fn main() {
    let writer = Arc::new(Mutex::new(BufWriter::new(tokio::io::stdout())));
    let tasks: Tasks = Arc::new(Mutex::new(HashMap::new()));
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.len() > MAX_INPUT_LINE_BYTES {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(_) => continue,
        };
        if request.jsonrpc != "2.0" || request.protocol_version != PROTOCOL_VERSION {
            if let Some(id) = request.id {
                write_json(
                    &writer,
                    &failure(
                        id,
                        HostError::new(
                            "DATABASE_MANAGER_DRIVER_PROTOCOL_MISMATCH",
                            "The database driver protocol version is incompatible.",
                        ),
                    ),
                )
                .await;
            }
            continue;
        }
        match request.method.as_str() {
            "system.shutdown" => {
                abort_all(&tasks).await;
                close_all_sessions(&sessions).await;
                break;
            }
            "request.cancel" => {
                if let Ok(params) = serde_json::from_value::<CancelParams>(request.params) {
                    if let Some(task) = tasks.lock().await.remove(&params.request_id) {
                        task.abort();
                    }
                }
            }
            _ => {
                let Some(id) = request.id else { continue };
                let task_writer = Arc::clone(&writer);
                let task_map = Arc::clone(&tasks);
                let task_sessions = Arc::clone(&sessions);
                let task_id = id.clone();
                let map_id = id.clone();
                let (begin_tx, begin_rx) = tokio::sync::oneshot::channel();
                let handle = tokio::spawn(async move {
                    let _ = begin_rx.await;
                    dispatch(task_writer, task_sessions, id, request.method, request.params).await;
                    task_map.lock().await.remove(&task_id);
                });
                tasks.lock().await.insert(map_id, handle);
                let _ = begin_tx.send(());
            }
        }
    }
    abort_all(&tasks).await;
    close_all_sessions(&sessions).await;
}

async fn dispatch(writer: Writer, sessions: Sessions, id: String, method: String, params: Value) {
    let result = match method.as_str() {
        "system.health" => Ok(json!({
            "status": "ready",
            "protocolVersion": PROTOCOL_VERSION,
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "drivers": ["postgresql", "mysql", "sqlite"],
            "connectionModes": ["physical-pool"],
            "maxSessions": MAX_SESSIONS,
            "sessionIdleTimeoutMs": SESSION_IDLE_TIMEOUT.as_millis()
        })),
        "connection.test" => match serde_json::from_value::<ConnectionParams>(params) {
            Ok(params) => drivers::test_connection(&params.connection).await,
            Err(_) => Err(invalid_params()),
        },
        "connection.open" => match serde_json::from_value::<OpenConnectionParams>(params) {
            Ok(params) => open_connection(&sessions, params).await,
            Err(_) => Err(invalid_params()),
        },
        "connection.close" => match serde_json::from_value::<SessionParams>(params) {
            Ok(params) => close_connection(&sessions, &params.session_id).await,
            Err(_) => Err(invalid_params()),
        },
        "connection.status" => match serde_json::from_value::<SessionParams>(params) {
            Ok(params) => connection_status(&sessions, &params.session_id).await,
            Err(_) => Err(invalid_params()),
        },
        "query.execute" => match serde_json::from_value::<QueryParams>(params) {
            Ok(params) => drivers::execute_query(&params.connection, &params.request).await,
            Err(_) => Err(invalid_params()),
        },
        "query.execute_session" => match serde_json::from_value::<SessionQueryParams>(params) {
            Ok(params) => match acquire_session(&sessions, &params.session_id, true).await {
                Ok(session) => drivers::execute_session_query(session.driver(), &params.request).await,
                Err(error) => Err(error),
            },
            Err(_) => Err(invalid_params()),
        },
        "schema.snapshot" => match serde_json::from_value::<SchemaParams>(params) {
            Ok(params) => drivers::schema_snapshot(&params.connection, &params.request).await,
            Err(_) => Err(invalid_params()),
        },
        "schema.snapshot_session" => match serde_json::from_value::<SessionSchemaParams>(params) {
            Ok(params) => match acquire_session(&sessions, &params.session_id, true).await {
                Ok(session) => drivers::session_schema_snapshot(session.driver(), &params.request).await,
                Err(error) => Err(error),
            },
            Err(_) => Err(invalid_params()),
        },
        _ => Err(HostError::new(
            "DATABASE_MANAGER_DRIVER_METHOD_NOT_FOUND",
            "The database driver method is not supported.",
        )),
    };
    match result {
        Ok(value) => write_json(&writer, &success(id, value)).await,
        Err(error) => write_json(&writer, &failure(id, error)).await,
    }
}

async fn open_connection(sessions: &Sessions, params: OpenConnectionParams) -> Result<Value, HostError> {
    let OpenConnectionParams { session_id, connection } = params;
    validate_session_id(&session_id)?;
    prune_sessions(sessions, epoch_millis()).await;
    let (driver, evidence) = drivers::open_session(&connection).await?;
    drop(connection);
    let now = epoch_millis();
    let mut values = sessions.lock().await;
    if values.len() >= MAX_SESSIONS && !values.contains_key(&session_id) {
        drop(values);
        driver.close().await;
        return Err(HostError::new(
            "DATABASE_MANAGER_CONNECTION_LIMIT_REACHED",
            "Too many database connections are open. Close one and try again.",
        ));
    }
    let replaced = values.insert(session_id, HostedSession {
        driver: Arc::new(driver),
        opened_at_ms: now,
        last_used_at_ms: now,
        active_requests: 0,
    });
    drop(values);
    if let Some(session) = replaced {
        let _ = tokio::spawn(async move { session.driver.close().await; });
    }
    Ok(json!({
        "status": "success",
        "connectionMode": "physical-pool",
        "openedAtMs": now,
        "lastUsedAtMs": now,
        "idleTimeoutMs": SESSION_IDLE_TIMEOUT.as_millis(),
        "evidence": evidence
    }))
}

async fn close_connection(sessions: &Sessions, session_id: &str) -> Result<Value, HostError> {
    validate_session_id(session_id)?;
    let session = sessions.lock().await.remove(session_id);
    let closed = session.is_some();
    if let Some(session) = session {
        let _ = tokio::spawn(async move { session.driver.close().await; });
    }
    Ok(json!({ "status": "closed", "closed": closed }))
}

async fn connection_status(sessions: &Sessions, session_id: &str) -> Result<Value, HostError> {
    validate_session_id(session_id)?;
    let session = match acquire_session(sessions, session_id, false).await {
        Ok(session) => session,
        Err(error) if error.code == "DATABASE_MANAGER_CONNECTION_SESSION_CLOSED" => {
            return Ok(json!({ "status": "closed", "connectionMode": "physical-pool" }));
        }
        Err(error) => return Err(error),
    };
    if let Err(error) = session.driver().health().await {
        evict_session(sessions, session_id, &session.driver).await;
        return Ok(json!({
            "status": "failed",
            "connectionMode": "physical-pool",
            "code": error.code,
            "retryable": error.retryable
        }));
    }
    let current = sessions.lock().await.get(session_id)
        .map(|stored| Arc::ptr_eq(&stored.driver, &session.driver))
        .unwrap_or(false);
    if !current {
        return Ok(json!({ "status": "closed", "connectionMode": "physical-pool" }));
    }
    Ok(json!({
        "status": "ready",
        "connectionMode": "physical-pool",
        "openedAtMs": session.opened_at_ms,
        "lastUsedAtMs": session.last_used_at_ms,
        "idleTimeoutMs": SESSION_IDLE_TIMEOUT.as_millis()
    }))
}

async fn acquire_session(sessions: &Sessions, session_id: &str, touch_idle: bool) -> Result<SessionLease, HostError> {
    validate_session_id(session_id)?;
    let now = epoch_millis();
    prune_sessions(sessions, now).await;
    let mut values = sessions.lock().await;
    let session = values.get_mut(session_id).ok_or_else(|| HostError::new(
        "DATABASE_MANAGER_CONNECTION_SESSION_CLOSED",
        "The database connection is closed. Open it and try again.",
    ))?;
    if touch_idle {
        session.last_used_at_ms = now;
    }
    session.active_requests += 1;
    Ok(SessionLease {
        sessions: Arc::clone(sessions),
        session_id: session_id.into(),
        driver: Arc::clone(&session.driver),
        opened_at_ms: session.opened_at_ms,
        last_used_at_ms: session.last_used_at_ms,
        touch_idle,
    })
}

async fn evict_session(sessions: &Sessions, session_id: &str, driver: &Arc<DriverSession>) {
    let removed = {
        let mut values = sessions.lock().await;
        let matches = values.get(session_id)
            .map(|session| Arc::ptr_eq(&session.driver, driver))
            .unwrap_or(false);
        if matches { values.remove(session_id) } else { None }
    };
    if let Some(session) = removed {
        let _ = tokio::spawn(async move { session.driver.close().await; });
    }
}

fn validate_session_id(session_id: &str) -> Result<(), HostError> {
    if session_id.len() < 16
        || session_id.len() > 200
        || !session_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(invalid_params());
    }
    Ok(())
}

async fn prune_sessions(sessions: &Sessions, now_ms: u128) {
    let timeout_ms = SESSION_IDLE_TIMEOUT.as_millis();
    let expired = {
        let mut values = sessions.lock().await;
        let ids: Vec<String> = values.iter()
            .filter(|(_, session)| session.active_requests == 0 && now_ms.saturating_sub(session.last_used_at_ms) >= timeout_ms)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        ids.into_iter().filter_map(|session_id| values.remove(&session_id)).collect::<Vec<_>>()
    };
    for session in expired {
        session.driver.close().await;
    }
}

async fn close_all_sessions(sessions: &Sessions) {
    let values: Vec<HostedSession> = sessions.lock().await.drain().map(|(_, session)| session).collect();
    for session in values {
        session.driver.close().await;
    }
}

fn epoch_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn invalid_params() -> HostError {
    HostError::new(
        "DATABASE_MANAGER_DRIVER_PARAMS_INVALID",
        "The database driver request is invalid.",
    )
}

async fn write_json<T>(writer: &Writer, value: &T)
where
    T: serde::Serialize,
{
    let Ok(mut encoded) = serde_json::to_vec(value) else {
        return;
    };
    encoded.push(b'\n');
    let mut output = writer.lock().await;
    if output.write_all(&encoded).await.is_ok() {
        let _ = output.flush().await;
    }
}

async fn abort_all(tasks: &Tasks) {
    let handles: Vec<JoinHandle<()>> = tasks.lock().await.drain().map(|(_, task)| task).collect();
    for task in handles {
        task.abort();
    }
}
