"""FastAPI main application for Claude Roam."""

import json
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .db import (
    add_segment,
    create_session,
    delete_segments_after,
    delete_session,
    get_content,
    get_db,
    get_segments,
    get_session,
    get_sessions,
    get_sessions_by_dir,
    get_sessions_grouped,
    init_db,
    search_content,
    truncate_content,
    update_content,
    update_session_metadata,
)
from .models import (
    ErrorResponse,
    GroupedSessionItem,
    GroupedSessionsResponse,
    HealthResponse,
    PullResponse,
    PushRequest,
    PushResponse,
    SearchResponse,
    SearchResultItem,
    Segment,
    SessionDetailResponse,
    SessionListItem,
    SessionListResponse,
    SessionMeta,
    SessionsByDirResponse,
)


def extract_first_user_message(jsonl_data: str) -> Optional[str]:
    """Extract the first user message from JSONL content."""
    for line in jsonl_data.strip().split("\n"):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
            # Check for human/user messages in different formats
            if obj.get("type") == "human" and obj.get("message"):
                msg = obj["message"]
                if isinstance(msg, dict) and msg.get("content"):
                    content = msg["content"]
                    if isinstance(content, list):
                        for item in content:
                            if isinstance(item, dict) and item.get("type") == "text":
                                return item.get("text", "")[:200]
                    elif isinstance(content, str):
                        return content[:200]
            elif obj.get("role") == "user" and obj.get("content"):
                content = obj["content"]
                if isinstance(content, str):
                    return content[:200]
        except (json.JSONDecodeError, KeyError):
            continue
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    await init_db()
    yield


app = FastAPI(
    title="Claude Roam API",
    description="API for Claude Code session roaming sync",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    return HealthResponse(status="ok")


@app.post(
    "/api/sessions/{session_id}/push",
    response_model=PushResponse,
    responses={400: {"model": ErrorResponse}},
)
async def push_session(session_id: str, request: PushRequest):
    """Push session content (incremental)."""
    db = await get_db()
    try:
        session = await get_session(db, session_id)

        # 计算新行数
        new_lines = request.append_data.strip().split("\n") if request.append_data.strip() else []
        new_line_count = len(new_lines)

        if session is None:
            # 创建新session
            first_message = extract_first_user_message(request.append_data)
            await create_session(db, session_id, first_message=first_message)
            await update_content(db, session_id, request.append_data.strip(), new_line_count)
            await add_segment(
                db,
                session_id,
                from_line=1,
                to_line=new_line_count,
                machine_id=request.source.machine_id,
                machine_name=request.source.machine_name,
                platform=request.source.platform,
                original_path=request.source.original_path,
            )
        else:
            current_lines = session["total_lines"]
            current_content = await get_content(db, session_id) or ""

            if request.from_line <= current_lines:
                # 有冲突 - 截断并覆盖
                truncated = await truncate_content(db, session_id, request.from_line - 1)
                await delete_segments_after(db, session_id, request.from_line)
                new_content = truncated + ("\n" if truncated else "") + request.append_data.strip()
                total = request.from_line - 1 + new_line_count
                actual_from_line = request.from_line
            else:
                # 直接追加 - 从实际的下一行开始
                new_content = current_content + ("\n" if current_content else "") + request.append_data.strip()
                total = current_lines + new_line_count
                # 修正：segment 的 from_line 应该从实际位置开始，而不是客户端声称的位置
                actual_from_line = current_lines + 1

            await update_content(db, session_id, new_content, total)

            # 添加新segment - 使用修正后的行号
            await add_segment(
                db,
                session_id,
                from_line=actual_from_line,
                to_line=actual_from_line + new_line_count - 1,
                machine_id=request.source.machine_id,
                machine_name=request.source.machine_name,
                platform=request.source.platform,
                original_path=request.source.original_path,
            )

            # 如果是新session或没有first_message，尝试提取
            if not session.get("first_message"):
                full_content = new_content
                first_message = extract_first_user_message(full_content)
                if first_message:
                    await update_session_metadata(db, session_id, first_message=first_message)

        return PushResponse(ok=True)
    finally:
        await db.close()


@app.get(
    "/api/sessions/{session_id}/pull",
    response_model=PullResponse,
    responses={404: {"model": ErrorResponse}},
)
async def pull_session(
    session_id: str,
    from_line: Optional[int] = Query(None, ge=1, description="Start from line number"),
):
    """Pull session content."""
    db = await get_db()
    try:
        session = await get_session(db, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")

        content = await get_content(db, session_id) or ""
        segments = await get_segments(db, session_id)

        # 如果指定了from_line，返回增量内容
        if from_line is not None:
            lines = content.split("\n") if content else []
            content = "\n".join(lines[from_line - 1 :])

        return PullResponse(
            data=content,
            meta=SessionMeta(
                session_id=session["session_id"],
                summary=session["summary"],
                first_message=session["first_message"],
                total_lines=session["total_lines"],
                created_at=session["created_at"],
                updated_at=session["updated_at"],
            ),
            segments=[
                Segment(
                    id=seg["id"],
                    from_line=seg["from_line"],
                    to_line=seg["to_line"],
                    machine_id=seg["machine_id"],
                    machine_name=seg["machine_name"],
                    platform=seg["platform"],
                    original_path=seg["original_path"],
                    pushed_at=seg["pushed_at"],
                )
                for seg in segments
            ],
        )
    finally:
        await db.close()


@app.get("/api/sessions", response_model=SessionListResponse)
async def list_sessions(
    q: Optional[str] = Query(None, description="Search query"),
    limit: int = Query(10, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """List sessions with optional search."""
    db = await get_db()
    try:
        sessions, total = await get_sessions(db, query=q, limit=limit, offset=offset)
        page = (offset // limit) + 1 if limit > 0 else 1
        has_more = offset + len(sessions) < total
        return SessionListResponse(
            sessions=[
                SessionListItem(
                    session_id=s["session_id"],
                    summary=s["summary"],
                    first_message=s["first_message"],
                    total_lines=s["total_lines"],
                    created_at=s["created_at"],
                    updated_at=s["updated_at"],
                    machines=s.get("machines"),
                    last_path=s.get("last_path"),
                )
                for s in sessions
            ],
            total=total,
            page=page,
            limit=limit,
            has_more=has_more,
        )
    finally:
        await db.close()


@app.get("/api/sessions/grouped", response_model=GroupedSessionsResponse)
async def list_sessions_grouped():
    """List all sessions grouped by machine and path."""
    db = await get_db()
    try:
        sessions = await get_sessions_grouped(db)
        return GroupedSessionsResponse(
            sessions=[
                GroupedSessionItem(
                    session_id=s["session_id"],
                    summary=s["summary"],
                    first_message=s["first_message"],
                    total_lines=s["total_lines"],
                    created_at=s["created_at"],
                    updated_at=s["updated_at"],
                    machine_name=s.get("machine_name"),
                    original_path=s.get("original_path"),
                )
                for s in sessions
            ]
        )
    finally:
        await db.close()


@app.get("/api/sessions/by-dir", response_model=SessionsByDirResponse)
async def list_sessions_by_dir(
    machine: str = Query(..., description="Machine name"),
    path: str = Query(..., description="Original path"),
):
    """List sessions by machine name and original path (cloud directory)."""
    db = await get_db()
    try:
        sessions = await get_sessions_by_dir(db, machine, path)
        return SessionsByDirResponse(
            sessions=[
                SessionListItem(
                    session_id=s["session_id"],
                    summary=s["summary"],
                    first_message=s["first_message"],
                    total_lines=s["total_lines"],
                    created_at=s["created_at"],
                    updated_at=s["updated_at"],
                    machines=s.get("machines"),
                    last_path=s.get("last_path"),
                )
                for s in sessions
            ]
        )
    finally:
        await db.close()


@app.get(
    "/api/sessions/{session_id}",
    response_model=SessionDetailResponse,
    responses={404: {"model": ErrorResponse}},
)
async def get_session_detail(session_id: str):
    """Get session details."""
    db = await get_db()
    try:
        session = await get_session(db, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")

        segments = await get_segments(db, session_id)

        return SessionDetailResponse(
            session=SessionMeta(
                session_id=session["session_id"],
                summary=session["summary"],
                first_message=session["first_message"],
                total_lines=session["total_lines"],
                created_at=session["created_at"],
                updated_at=session["updated_at"],
            ),
            segments=[
                Segment(
                    id=seg["id"],
                    from_line=seg["from_line"],
                    to_line=seg["to_line"],
                    machine_id=seg["machine_id"],
                    machine_name=seg["machine_name"],
                    platform=seg["platform"],
                    original_path=seg["original_path"],
                    pushed_at=seg["pushed_at"],
                )
                for seg in segments
            ],
        )
    finally:
        await db.close()


@app.delete(
    "/api/sessions/{session_id}",
    response_model=PushResponse,
    responses={404: {"model": ErrorResponse}},
)
async def delete_session_endpoint(session_id: str):
    """Delete a session."""
    db = await get_db()
    try:
        success = await delete_session(db, session_id)
        if not success:
            raise HTTPException(status_code=404, detail="Session not found")
        return PushResponse(ok=True)
    finally:
        await db.close()


@app.get("/api/search", response_model=SearchResponse)
async def search_sessions(
    q: str = Query(..., min_length=1, description="Search query for content"),
):
    """Full-text search in session content. Returns all matching results."""
    db = await get_db()
    try:
        results = await search_content(db, q)
        return SearchResponse(
            results=[
                SearchResultItem(
                    session_id=r["session_id"],
                    summary=r["summary"],
                    first_message=r["first_message"],
                    total_lines=r["total_lines"],
                    created_at=r["created_at"],
                    updated_at=r["updated_at"],
                    machines=r.get("machines"),
                    last_path=r.get("last_path"),
                    snippet=r.get("snippet"),
                )
                for r in results
            ],
            total=len(results),
        )
    finally:
        await db.close()
