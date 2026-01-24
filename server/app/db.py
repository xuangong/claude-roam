"""Database module for Claude Roam."""

import os
import aiosqlite
from pathlib import Path
from typing import Optional

DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", Path(__file__).parent.parent / "roam.db"))


async def get_db() -> aiosqlite.Connection:
    """Get database connection."""
    db = await aiosqlite.connect(DATABASE_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys = ON")
    return db


async def init_db():
    """Initialize database schema."""
    db = await aiosqlite.connect(DATABASE_PATH)
    try:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.executescript("""
            -- sessions: 会话元信息
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                summary TEXT,
                first_message TEXT,
                total_lines INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            -- content: 会话内容（JSONL 整体存储）
            CREATE TABLE IF NOT EXISTS content (
                session_id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );

            -- segments: 行级来源追踪
            CREATE TABLE IF NOT EXISTS segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                from_line INTEGER NOT NULL,
                to_line INTEGER NOT NULL,
                machine_id TEXT NOT NULL,
                machine_name TEXT,
                platform TEXT,
                original_path TEXT,
                pushed_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );

            -- 全文搜索 (session 元信息)
            CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
                session_id UNINDEXED,
                summary,
                first_message
            );

            -- 全文搜索 (对话内容)
            CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
                session_id UNINDEXED,
                data
            );

            -- 索引
            CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id);
        """)
        await db.commit()
    finally:
        await db.close()


async def create_session(
    db: aiosqlite.Connection,
    session_id: str,
    first_message: Optional[str] = None,
    summary: Optional[str] = None,
) -> None:
    """Create a new session."""
    await db.execute(
        """
        INSERT INTO sessions (session_id, first_message, summary)
        VALUES (?, ?, ?)
        """,
        (session_id, first_message, summary),
    )
    await db.execute(
        "INSERT INTO content (session_id, data) VALUES (?, '')",
        (session_id,),
    )
    # 插入全文搜索 (session 元信息)
    await db.execute(
        "INSERT INTO sessions_fts (session_id, summary, first_message) VALUES (?, ?, ?)",
        (session_id, summary or "", first_message or ""),
    )
    # 插入全文搜索 (对话内容)
    await db.execute(
        "INSERT INTO content_fts (session_id, data) VALUES (?, '')",
        (session_id,),
    )
    await db.commit()


async def get_session(db: aiosqlite.Connection, session_id: str) -> Optional[dict]:
    """Get session metadata."""
    cursor = await db.execute(
        "SELECT * FROM sessions WHERE session_id = ?",
        (session_id,),
    )
    row = await cursor.fetchone()
    if row:
        return dict(row)
    return None


async def get_sessions(
    db: aiosqlite.Connection,
    query: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """List sessions with optional search. Returns (sessions, total_count)."""
    if query:
        # Get total count
        count_cursor = await db.execute(
            "SELECT COUNT(*) FROM sessions_fts WHERE sessions_fts MATCH ?",
            (query,),
        )
        total = (await count_cursor.fetchone())[0]

        cursor = await db.execute(
            """
            SELECT s.*,
                   GROUP_CONCAT(DISTINCT seg.machine_name) as machines,
                   (SELECT original_path FROM segments WHERE session_id = s.session_id ORDER BY pushed_at DESC LIMIT 1) as last_path
            FROM sessions s
            LEFT JOIN segments seg ON s.session_id = seg.session_id
            WHERE s.session_id IN (
                SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ?
            )
            GROUP BY s.session_id
            ORDER BY s.updated_at DESC
            LIMIT ? OFFSET ?
            """,
            (query, limit, offset),
        )
    else:
        # Get total count
        count_cursor = await db.execute("SELECT COUNT(*) FROM sessions")
        total = (await count_cursor.fetchone())[0]

        cursor = await db.execute(
            """
            SELECT s.*,
                   GROUP_CONCAT(DISTINCT seg.machine_name) as machines,
                   (SELECT original_path FROM segments WHERE session_id = s.session_id ORDER BY pushed_at DESC LIMIT 1) as last_path
            FROM sessions s
            LEFT JOIN segments seg ON s.session_id = seg.session_id
            GROUP BY s.session_id
            ORDER BY s.updated_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )
    rows = await cursor.fetchall()
    return [dict(row) for row in rows], total


async def get_content(db: aiosqlite.Connection, session_id: str) -> Optional[str]:
    """Get session content."""
    cursor = await db.execute(
        "SELECT data FROM content WHERE session_id = ?",
        (session_id,),
    )
    row = await cursor.fetchone()
    if row:
        return row["data"]
    return None


async def update_content(
    db: aiosqlite.Connection,
    session_id: str,
    data: str,
    total_lines: int,
) -> None:
    """Update session content."""
    await db.execute(
        "UPDATE content SET data = ? WHERE session_id = ?",
        (data, session_id),
    )
    await db.execute(
        """
        UPDATE sessions SET total_lines = ?, updated_at = datetime('now')
        WHERE session_id = ?
        """,
        (total_lines, session_id),
    )
    # 更新全文搜索索引
    await db.execute(
        "UPDATE content_fts SET data = ? WHERE session_id = ?",
        (data, session_id),
    )
    await db.commit()


async def truncate_content(
    db: aiosqlite.Connection,
    session_id: str,
    keep_lines: int,
) -> str:
    """Truncate content to specified line count, return truncated content."""
    content = await get_content(db, session_id)
    if not content:
        return ""

    lines = content.split("\n")
    truncated = "\n".join(lines[:keep_lines])
    await db.execute(
        "UPDATE content SET data = ? WHERE session_id = ?",
        (truncated, session_id),
    )
    return truncated


async def get_segments(db: aiosqlite.Connection, session_id: str) -> list[dict]:
    """Get segments for a session."""
    cursor = await db.execute(
        """
        SELECT * FROM segments WHERE session_id = ?
        ORDER BY from_line ASC
        """,
        (session_id,),
    )
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]


async def add_segment(
    db: aiosqlite.Connection,
    session_id: str,
    from_line: int,
    to_line: int,
    machine_id: str,
    machine_name: Optional[str] = None,
    platform: Optional[str] = None,
    original_path: Optional[str] = None,
) -> None:
    """Add a segment."""
    await db.execute(
        """
        INSERT INTO segments (session_id, from_line, to_line, machine_id, machine_name, platform, original_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (session_id, from_line, to_line, machine_id, machine_name, platform, original_path),
    )
    await db.commit()


async def delete_segments_after(
    db: aiosqlite.Connection,
    session_id: str,
    from_line: int,
) -> None:
    """Delete segments that start at or after specified line."""
    # 删除完全在范围后的segments
    await db.execute(
        "DELETE FROM segments WHERE session_id = ? AND from_line >= ?",
        (session_id, from_line),
    )
    # 截断跨越边界的segment
    await db.execute(
        """
        UPDATE segments SET to_line = ? - 1
        WHERE session_id = ? AND from_line < ? AND to_line >= ?
        """,
        (from_line, session_id, from_line, from_line),
    )
    await db.commit()


async def delete_session(db: aiosqlite.Connection, session_id: str) -> bool:
    """Delete a session."""
    # 先删除FTS记录
    await db.execute(
        "DELETE FROM sessions_fts WHERE session_id = ?",
        (session_id,),
    )
    await db.execute(
        "DELETE FROM content_fts WHERE session_id = ?",
        (session_id,),
    )
    cursor = await db.execute(
        "DELETE FROM sessions WHERE session_id = ?",
        (session_id,),
    )
    await db.commit()
    return cursor.rowcount > 0


async def update_session_fts(
    db: aiosqlite.Connection,
    session_id: str,
    summary: Optional[str] = None,
    first_message: Optional[str] = None,
) -> None:
    """Update FTS index for session."""
    await db.execute(
        """
        UPDATE sessions_fts SET summary = ?, first_message = ?
        WHERE session_id = ?
        """,
        (summary or "", first_message or "", session_id),
    )
    await db.commit()


async def update_session_metadata(
    db: aiosqlite.Connection,
    session_id: str,
    first_message: Optional[str] = None,
    summary: Optional[str] = None,
) -> None:
    """Update session metadata."""
    updates = []
    params = []
    if first_message is not None:
        updates.append("first_message = ?")
        params.append(first_message)
    if summary is not None:
        updates.append("summary = ?")
        params.append(summary)

    if updates:
        params.append(session_id)
        await db.execute(
            f"UPDATE sessions SET {', '.join(updates)} WHERE session_id = ?",
            tuple(params),
        )
        await update_session_fts(db, session_id, summary, first_message)
        await db.commit()


async def search_content(
    db: aiosqlite.Connection,
    query: str,
) -> list[dict]:
    """Search content full-text, return all matching sessions."""
    cursor = await db.execute(
        """
        SELECT
            s.*,
            GROUP_CONCAT(DISTINCT seg.machine_name) as machines,
            (SELECT original_path FROM segments WHERE session_id = s.session_id ORDER BY pushed_at DESC LIMIT 1) as last_path
        FROM content_fts fts
        JOIN sessions s ON fts.session_id = s.session_id
        LEFT JOIN segments seg ON s.session_id = seg.session_id
        WHERE content_fts MATCH ?
        GROUP BY s.session_id
        ORDER BY s.updated_at DESC
        """,
        (query,),
    )
    rows = await cursor.fetchall()
    results = []
    for row in rows:
        d = dict(row)
        # 获取包含关键词的上下文作为 snippet
        content = await get_content(db, d["session_id"])
        if content:
            # 在内容中查找关键词位置，提取上下文
            query_lower = query.lower()
            content_lower = content.lower()
            pos = content_lower.find(query_lower)
            if pos != -1:
                start = max(0, pos - 100)
                end = min(len(content), pos + len(query) + 200)
                snippet = content[start:end]
                # 高亮关键词
                import re
                snippet = re.sub(
                    f'({re.escape(query)})',
                    r'<mark>\1</mark>',
                    snippet,
                    flags=re.IGNORECASE
                )
                d["snippet"] = "..." + snippet + "..." if start > 0 else snippet + "..."
            else:
                d["snippet"] = content[:300] + "..."
        else:
            d["snippet"] = None
        results.append(d)
    return results


async def get_sessions_grouped(
    db: aiosqlite.Connection,
) -> list[dict]:
    """Get all sessions grouped by machine and path."""
    cursor = await db.execute(
        """
        SELECT
            s.*,
            seg.machine_name,
            seg.original_path,
            seg.pushed_at as last_pushed
        FROM sessions s
        LEFT JOIN (
            SELECT session_id, machine_name, original_path, pushed_at,
                   ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY pushed_at DESC) as rn
            FROM segments
        ) seg ON s.session_id = seg.session_id AND seg.rn = 1
        ORDER BY seg.machine_name, seg.original_path, s.updated_at DESC
        """
    )
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]


async def get_sessions_by_dir(
    db: aiosqlite.Connection,
    machine_name: str,
    original_path: str,
) -> list[dict]:
    """Get sessions by machine name and original path (cloud directory)."""
    cursor = await db.execute(
        """
        SELECT DISTINCT
            s.*,
            GROUP_CONCAT(DISTINCT seg.machine_name) as machines,
            (SELECT original_path FROM segments WHERE session_id = s.session_id ORDER BY pushed_at DESC LIMIT 1) as last_path
        FROM sessions s
        JOIN segments seg ON s.session_id = seg.session_id
        WHERE seg.machine_name = ? AND seg.original_path = ?
        GROUP BY s.session_id
        ORDER BY s.updated_at DESC
        """,
        (machine_name, original_path),
    )
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]
