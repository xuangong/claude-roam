"""Pydantic models for Claude Roam API."""

from pydantic import BaseModel
from typing import Optional


class SourceInfo(BaseModel):
    """Source information for push request."""

    machine_id: str
    machine_name: Optional[str] = None
    platform: Optional[str] = None
    original_path: Optional[str] = None


class PushRequest(BaseModel):
    """Request body for push endpoint."""

    from_line: int  # 1-based
    append_data: str
    source: SourceInfo


class PushResponse(BaseModel):
    """Response for push endpoint."""

    ok: bool


class Segment(BaseModel):
    """Segment information."""

    id: int
    from_line: int
    to_line: int
    machine_id: str
    machine_name: Optional[str] = None
    platform: Optional[str] = None
    original_path: Optional[str] = None
    pushed_at: str


class SessionMeta(BaseModel):
    """Session metadata."""

    session_id: str
    summary: Optional[str] = None
    first_message: Optional[str] = None
    total_lines: int
    created_at: str
    updated_at: str


class PullResponse(BaseModel):
    """Response for pull endpoint."""

    data: str
    meta: SessionMeta
    segments: list[Segment]


class SessionListItem(BaseModel):
    """Session list item."""

    session_id: str
    summary: Optional[str] = None
    first_message: Optional[str] = None
    total_lines: int
    created_at: str
    updated_at: str
    machines: Optional[str] = None
    last_path: Optional[str] = None


class SessionListResponse(BaseModel):
    """Response for list sessions endpoint."""

    sessions: list[SessionListItem]
    total: int
    page: int
    limit: int
    has_more: bool


class SessionDetailResponse(BaseModel):
    """Response for session detail endpoint."""

    session: SessionMeta
    segments: list[Segment]


class HealthResponse(BaseModel):
    """Health check response."""

    status: str


class ErrorResponse(BaseModel):
    """Error response."""

    error: str
    detail: Optional[str] = None


class SearchResultItem(BaseModel):
    """Search result item with snippet."""

    session_id: str
    summary: Optional[str] = None
    first_message: Optional[str] = None
    total_lines: int
    created_at: str
    updated_at: str
    machines: Optional[str] = None
    last_path: Optional[str] = None
    snippet: Optional[str] = None


class SearchResponse(BaseModel):
    """Response for search endpoint."""

    results: list[SearchResultItem]
    total: int


class GroupedSessionItem(BaseModel):
    """Session item with machine/path info for grouping."""

    session_id: str
    summary: Optional[str] = None
    first_message: Optional[str] = None
    total_lines: int
    created_at: str
    updated_at: str
    machine_name: Optional[str] = None
    original_path: Optional[str] = None


class GroupedSessionsResponse(BaseModel):
    """Response for grouped sessions endpoint."""

    sessions: list[GroupedSessionItem]


class SessionsByDirResponse(BaseModel):
    """Response for sessions by directory endpoint."""

    sessions: list[SessionListItem]
