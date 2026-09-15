use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;

pub struct ActionLog {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub id: i64,
    pub ts: i64,
    pub session_id: Option<String>,
    pub permission_id: Option<String>,
    pub tool: Option<String>,
    pub detail: Option<String>,
    pub decision: String,
    pub reason: Option<String>,
    pub auto: bool,
}

impl ActionLog {
    pub fn open() -> Result<Self, String> {
        let base = if cfg!(windows) {
            std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string())
        } else {
            std::env::var("XDG_DATA_HOME")
                .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.local/share")))
                .unwrap_or_else(|_| ".".to_string())
        };

        let dir = std::path::Path::new(&base).join("nexuscode");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let conn = Connection::open(dir.join("action_log.db")).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS action_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                session_id TEXT,
                permission_id TEXT,
                tool TEXT,
                detail TEXT,
                decision TEXT NOT NULL,
                reason TEXT,
                auto INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_action_log_ts ON action_log(ts DESC);",
        )
        .map_err(|e| e.to_string())?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn insert(
        &self,
        session_id: Option<&str>,
        permission_id: Option<&str>,
        tool: Option<&str>,
        detail: Option<&str>,
        decision: &str,
        reason: Option<&str>,
        auto: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO action_log (ts, session_id, permission_id, tool, detail, decision, reason, auto)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                chrono_now_ms(),
                session_id,
                permission_id,
                tool,
                detail.map(|d| d.chars().take(2000).collect::<String>()),
                decision,
                reason,
                auto as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list(&self, limit: i64) -> Result<Vec<LogEntry>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, ts, session_id, permission_id, tool, detail, decision, reason, auto
                 FROM action_log ORDER BY id DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(rusqlite::params![limit], |row| {
                Ok(LogEntry {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    session_id: row.get(2)?,
                    permission_id: row.get(3)?,
                    tool: row.get(4)?,
                    detail: row.get(5)?,
                    decision: row.get(6)?,
                    reason: row.get(7)?,
                    auto: row.get::<_, i64>(8)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn clear(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM action_log", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
