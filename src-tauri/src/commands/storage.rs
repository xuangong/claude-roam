//! Storage admin commands (for debugging)

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppDb;

/// Table information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub row_count: i64,
    pub columns: Vec<ColumnInfo>,
}

/// Column information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub cid: i32,
    pub name: String,
    pub type_name: String,
    pub notnull: bool,
    pub dflt_value: Option<String>,
    pub pk: bool,
}

/// Table data with pagination
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableData {
    pub table_name: String,
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<serde_json::Value>,
    pub total_rows: i64,
    pub page: i32,
    pub page_size: i32,
    pub total_pages: i32,
}

/// Query result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: Option<i64>,
    pub last_insert_rowid: Option<i64>,
}

/// List all tables in the database
#[tauri::command]
pub async fn storage_list_tables(db: State<'_, AppDb>) -> Result<Vec<TableInfo>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map_err(|e| e.to_string())?;

    let table_names: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut tables = Vec::new();

    for name in table_names {
        // Skip virtual tables for column info
        if name.ends_with("_fts") {
            continue;
        }

        // Get column info
        let columns = get_table_columns(&conn, &name)?;

        // Get row count
        let row_count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM \"{}\"", name), [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        tables.push(TableInfo {
            name,
            row_count,
            columns,
        });
    }

    Ok(tables)
}

/// Read table data with pagination
#[tauri::command]
pub async fn storage_read_table(
    db: State<'_, AppDb>,
    table_name: String,
    page: i32,
    page_size: i32,
    search_query: Option<String>,
) -> Result<TableData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Validate table name to prevent SQL injection
    let valid_tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if !valid_tables.contains(&table_name) {
        return Err(format!("Invalid table name: {}", table_name));
    }

    // Get columns
    let columns = get_table_columns(&conn, &table_name)?;

    // Build query
    let offset = (page - 1) * page_size;

    let (sql, count_sql) = if let Some(ref _query) = search_query {
        // Build search conditions
        let search_conditions: Vec<String> = columns
            .iter()
            .map(|c| format!("CAST(\"{}\" AS TEXT) LIKE '%' || ?1 || '%'", c.name))
            .collect();

        let where_clause = search_conditions.join(" OR ");

        (
            format!(
                "SELECT * FROM \"{}\" WHERE {} LIMIT {} OFFSET {}",
                table_name, where_clause, page_size, offset
            ),
            format!(
                "SELECT COUNT(*) FROM \"{}\" WHERE {}",
                table_name, where_clause
            ),
        )
    } else {
        (
            format!(
                "SELECT * FROM \"{}\" LIMIT {} OFFSET {}",
                table_name, page_size, offset
            ),
            format!("SELECT COUNT(*) FROM \"{}\"", table_name),
        )
    };

    // Get total count
    let total_rows: i64 = if let Some(ref query) = search_query {
        conn.query_row(&count_sql, [query], |row| row.get(0))
            .unwrap_or(0)
    } else {
        conn.query_row(&count_sql, [], |row| row.get(0))
            .unwrap_or(0)
    };

    // Execute query
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let _column_count = stmt.column_count();
    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let rows: Vec<serde_json::Value> = if let Some(ref query) = search_query {
        stmt.query_map([query], |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let value = row_value_to_json(row, i);
                obj.insert(name.clone(), value);
            }
            Ok(serde_json::Value::Object(obj))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect()
    } else {
        stmt.query_map([], |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let value = row_value_to_json(row, i);
                obj.insert(name.clone(), value);
            }
            Ok(serde_json::Value::Object(obj))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect()
    };

    let total_pages = ((total_rows as f64) / (page_size as f64)).ceil() as i32;

    Ok(TableData {
        table_name,
        columns,
        rows,
        total_rows,
        page,
        page_size,
        total_pages,
    })
}

/// Execute raw SQL query (debug mode only)
#[tauri::command]
pub async fn storage_execute_sql(
    #[allow(unused_variables)] db: State<'_, AppDb>,
    #[allow(unused_variables)] query: String,
) -> Result<QueryResult, String> {
    // Only allow in debug mode
    #[cfg(not(debug_assertions))]
    {
        return Err("SQL execution is only available in debug mode".to_string());
    }

    #[cfg(debug_assertions)]
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Check if it's a SELECT query
    let is_select = query.trim().to_uppercase().starts_with("SELECT");

    if is_select {
        let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let column_count = columns.len();

        let rows: Vec<Vec<serde_json::Value>> = stmt
            .query_map([], |row| {
                let mut values = Vec::new();
                for i in 0..column_count {
                    values.push(row_value_to_json(row, i));
                }
                Ok(values)
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(QueryResult {
            columns,
            rows,
            rows_affected: None,
            last_insert_rowid: None,
        })
    } else {
        let rows_affected = conn.execute(&query, []).map_err(|e| e.to_string())?;
        let last_insert_rowid = conn.last_insert_rowid();

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: Some(rows_affected as i64),
            last_insert_rowid: Some(last_insert_rowid),
        })
    }
    }
}

fn get_table_columns(conn: &rusqlite::Connection, table_name: &str) -> Result<Vec<ColumnInfo>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{}\")", table_name))
        .map_err(|e| e.to_string())?;

    let columns: Vec<ColumnInfo> = stmt
        .query_map([], |row| {
            Ok(ColumnInfo {
                cid: row.get(0)?,
                name: row.get(1)?,
                type_name: row.get(2)?,
                notnull: row.get(3)?,
                dflt_value: row.get(4)?,
                pk: row.get::<_, i32>(5)? > 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(columns)
}

fn row_value_to_json(row: &rusqlite::Row, index: usize) -> serde_json::Value {
    // Try different types
    if let Ok(v) = row.get::<_, i64>(index) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(v) = row.get::<_, f64>(index) {
        if let Some(n) = serde_json::Number::from_f64(v) {
            return serde_json::Value::Number(n);
        }
    }
    if let Ok(v) = row.get::<_, String>(index) {
        return serde_json::Value::String(v);
    }
    if let Ok(v) = row.get::<_, Vec<u8>>(index) {
        return serde_json::Value::String(format!("<blob: {} bytes>", v.len()));
    }

    serde_json::Value::Null
}
