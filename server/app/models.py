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


# ============ Auth Models ============

class User(BaseModel):
    """User model."""

    id: str
    provider: str
    provider_id: str
    email: Optional[str] = None
    name: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: str
    updated_at: str


class UserResponse(BaseModel):
    """Response for user info endpoint."""

    user: User


class TokenResponse(BaseModel):
    """Response for token endpoint."""

    access_token: str
    token_type: str = "bearer"
    user: User


class DeviceCodeRequest(BaseModel):
    """Request for device code."""

    provider: str  # 'github' | 'google'


class DeviceCodeResponse(BaseModel):
    """Response for device code request."""

    device_code: str
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int


class DeviceTokenRequest(BaseModel):
    """Request to check device code status."""

    device_code: str
    provider: str


class DeviceTokenResponse(BaseModel):
    """Response for device token check."""

    status: str  # 'pending' | 'completed' | 'expired'
    access_token: Optional[str] = None
    user: Optional[User] = None


class OAuthCallbackRequest(BaseModel):
    """Request for OAuth callback."""

    code: str
    state: Optional[str] = None


# ============ Pinned Folders Models ============

class PinnedFolder(BaseModel):
    """Pinned folder item."""

    id: int
    user_id: str
    machine_name: str
    original_path: str
    pinned_at: str


class PinnedFoldersResponse(BaseModel):
    """Response for pinned folders endpoint."""

    folders: list[PinnedFolder]


class PinFolderRequest(BaseModel):
    """Request to pin a folder."""

    machine_name: str
    original_path: str
