use crate::routes::{EdgeSnapshot, RouteTable};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio_postgres::NoTls;
use tracing::{error, info, warn};

pub const ROUTE_NOTIFY_CHANNEL: &str = "qorpera_web_route_changes";

pub fn spawn_postgres_sync(
    database_url: String,
    routes: Arc<RwLock<RouteTable>>,
    reconcile_interval: Duration,
) {
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            match run_sync_session(&database_url, Arc::clone(&routes), reconcile_interval).await {
                Ok(()) => {
                    backoff = Duration::from_secs(1);
                }
                Err(err) => {
                    error!(error = %err, "postgres route sync disconnected; retrying");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }
    });
}

async fn run_sync_session(
    database_url: &str,
    routes: Arc<RwLock<RouteTable>>,
    reconcile_interval: Duration,
) -> Result<(), String> {
    let (client, mut connection) = tokio_postgres::connect(database_url, NoTls)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(16);
    tokio::spawn(async move {
        let mut stream = futures_poll_notifications(&mut connection);
        while let Some(event) = stream.next().await {
            match event {
                Ok(tokio_postgres::AsyncMessage::Notification(_)) => {
                    let _ = tx.try_send(());
                }
                Ok(_) => {}
                Err(err) => {
                    warn!(error = %err, "postgres connection error");
                    break;
                }
            }
        }
    });

    client
        .batch_execute(&format!("LISTEN {ROUTE_NOTIFY_CHANNEL};"))
        .await
        .map_err(|e| format!("listen failed: {e}"))?;

    refresh_snapshot(&client, &routes).await?;
    info!("loaded initial web routing snapshot from postgres");

    let mut ticker = tokio::time::interval(reconcile_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    loop {
        tokio::select! {
            notify = rx.recv() => {
                if notify.is_none() {
                    return Err("notification stream closed".to_string());
                }
                while rx.try_recv().is_ok() {}
                refresh_snapshot(&client, &routes).await?;
            }
            _ = ticker.tick() => {
                refresh_snapshot(&client, &routes).await?;
            }
        }
    }
}

async fn refresh_snapshot(
    client: &tokio_postgres::Client,
    routes: &Arc<RwLock<RouteTable>>,
) -> Result<(), String> {
    let row = client
        .query_one("SELECT public.qorpera_web_edge_snapshot()", &[])
        .await
        .map_err(|e| format!("snapshot query failed: {e}"))?;
    let json: serde_json::Value = row.get(0);
    let snapshot: EdgeSnapshot =
        serde_json::from_value(json).map_err(|e| format!("snapshot parse failed: {e}"))?;
    let new_table = RouteTable::from_snapshot(snapshot);
    let mut guard = routes.write().map_err(|_| "route lock poisoned".to_string())?;
    *guard = new_table;
    Ok(())
}

struct ConnectionMessages<'a, S, T> {
    conn: &'a mut tokio_postgres::Connection<S, T>,
}

impl<'a, S, T> ConnectionMessages<'a, S, T>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    async fn next(&mut self) -> Option<Result<tokio_postgres::AsyncMessage, tokio_postgres::Error>> {
        std::future::poll_fn(|cx| self.conn.poll_message(cx)).await
    }
}

fn futures_poll_notifications<S, T>(
    conn: &mut tokio_postgres::Connection<S, T>,
) -> ConnectionMessages<'_, S, T> {
    ConnectionMessages { conn }
}
