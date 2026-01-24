"""Tests for API endpoints."""

import tempfile
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app import db as db_module
from app.main import app


@pytest.fixture
async def client():
    """Create async test client with fresh database."""
    # Create unique temp db for this test
    test_db = Path(tempfile.mkdtemp()) / "test_api.db"
    db_module.DATABASE_PATH = test_db

    # Initialize database
    await db_module.init_db()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    # Cleanup
    if test_db.exists():
        test_db.unlink()


@pytest.mark.asyncio
async def test_health_check(client):
    """Test health check endpoint."""
    response = await client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


@pytest.mark.asyncio
async def test_push_new_session(client):
    """Test pushing a new session."""
    response = await client.post(
        "/api/sessions/test-push-1/push",
        json={
            "from_line": 1,
            "append_data": '{"type": "human", "message": {"content": "Hello"}}\n{"type": "assistant", "message": {"content": "Hi"}}',
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Test Machine",
                "platform": "darwin",
                "original_path": "/Users/test",
            },
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True


@pytest.mark.asyncio
async def test_push_incremental(client):
    """Test incremental push."""
    # First push
    await client.post(
        "/api/sessions/test-push-2/push",
        json={
            "from_line": 1,
            "append_data": '{"line": 1}\n{"line": 2}',
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Test Machine",
                "platform": "darwin",
                "original_path": "/Users/test",
            },
        },
    )

    # Incremental push
    response = await client.post(
        "/api/sessions/test-push-2/push",
        json={
            "from_line": 3,
            "append_data": '{"line": 3}\n{"line": 4}',
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Test Machine",
                "platform": "darwin",
                "original_path": "/Users/test",
            },
        },
    )
    assert response.status_code == 200

    # Verify content
    pull_response = await client.get("/api/sessions/test-push-2/pull")
    assert pull_response.status_code == 200
    data = pull_response.json()
    assert data["meta"]["total_lines"] == 4


@pytest.mark.asyncio
async def test_push_conflict(client):
    """Test push with conflict (overwrite)."""
    # First push - 10 lines
    lines = "\n".join([f'{{"line": {i}}}' for i in range(1, 11)])
    await client.post(
        "/api/sessions/test-conflict/push",
        json={
            "from_line": 1,
            "append_data": lines,
            "source": {
                "machine_id": "machine-A",
                "machine_name": "Machine A",
                "platform": "darwin",
                "original_path": "/path/a",
            },
        },
    )

    # Conflict push - overwrite from line 5
    new_lines = "\n".join([f'{{"new_line": {i}}}' for i in range(5, 16)])
    response = await client.post(
        "/api/sessions/test-conflict/push",
        json={
            "from_line": 5,
            "append_data": new_lines,
            "source": {
                "machine_id": "machine-B",
                "machine_name": "Machine B",
                "platform": "linux",
                "original_path": "/path/b",
            },
        },
    )
    assert response.status_code == 200

    # Verify content
    pull_response = await client.get("/api/sessions/test-conflict/pull")
    data = pull_response.json()
    # Should have 4 original lines + 11 new lines = 15
    assert data["meta"]["total_lines"] == 15


@pytest.mark.asyncio
async def test_pull_session(client):
    """Test pulling a session."""
    # Create session first
    await client.post(
        "/api/sessions/test-pull/push",
        json={
            "from_line": 1,
            "append_data": '{"type": "human", "message": {"content": [{"type": "text", "text": "Test message"}]}}',
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Test",
                "platform": "darwin",
                "original_path": "/test",
            },
        },
    )

    # Pull session
    response = await client.get("/api/sessions/test-pull/pull")
    assert response.status_code == 200

    data = response.json()
    assert "data" in data
    assert "meta" in data
    assert "segments" in data
    assert data["meta"]["session_id"] == "test-pull"
    assert data["meta"]["first_message"] == "Test message"


@pytest.mark.asyncio
async def test_pull_nonexistent_session(client):
    """Test pulling a session that doesn't exist."""
    response = await client.get("/api/sessions/nonexistent/pull")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_pull_from_line(client):
    """Test pulling with from_line parameter."""
    # Create session
    lines = "\n".join([f'{{"line": {i}}}' for i in range(1, 6)])
    await client.post(
        "/api/sessions/test-from-line/push",
        json={
            "from_line": 1,
            "append_data": lines,
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Test",
                "platform": "darwin",
                "original_path": "/test",
            },
        },
    )

    # Pull from line 3
    response = await client.get("/api/sessions/test-from-line/pull?from_line=3")
    assert response.status_code == 200

    data = response.json()
    lines_pulled = data["data"].strip().split("\n")
    assert len(lines_pulled) == 3  # Lines 3, 4, 5


@pytest.mark.asyncio
async def test_list_sessions(client):
    """Test listing sessions."""
    # Create some sessions
    for i in range(3):
        await client.post(
            f"/api/sessions/list-test-{i}/push",
            json={
                "from_line": 1,
                "append_data": f'{{"msg": "Session {i}"}}',
                "source": {
                    "machine_id": "machine-1",
                    "machine_name": "Test",
                    "platform": "darwin",
                    "original_path": "/test",
                },
            },
        )

    response = await client.get("/api/sessions")
    assert response.status_code == 200

    data = response.json()
    assert "sessions" in data
    assert len(data["sessions"]) >= 3


@pytest.mark.asyncio
async def test_list_sessions_with_limit(client):
    """Test listing sessions with limit."""
    # Create some sessions first
    for i in range(5):
        await client.post(
            f"/api/sessions/limit-test-{i}/push",
            json={
                "from_line": 1,
                "append_data": f'{{"msg": "Session {i}"}}',
                "source": {
                    "machine_id": "machine-1",
                    "machine_name": "Test",
                    "platform": "darwin",
                    "original_path": "/test",
                },
            },
        )

    response = await client.get("/api/sessions?limit=2")
    assert response.status_code == 200

    data = response.json()
    assert len(data["sessions"]) == 2


@pytest.mark.asyncio
async def test_get_session_detail(client):
    """Test getting session detail."""
    # Create session with multiple segments
    await client.post(
        "/api/sessions/detail-test/push",
        json={
            "from_line": 1,
            "append_data": '{"line": 1}',
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Machine 1",
                "platform": "darwin",
                "original_path": "/path/1",
            },
        },
    )
    await client.post(
        "/api/sessions/detail-test/push",
        json={
            "from_line": 2,
            "append_data": '{"line": 2}',
            "source": {
                "machine_id": "machine-2",
                "machine_name": "Machine 2",
                "platform": "linux",
                "original_path": "/path/2",
            },
        },
    )

    response = await client.get("/api/sessions/detail-test")
    assert response.status_code == 200

    data = response.json()
    assert "session" in data
    assert "segments" in data
    assert len(data["segments"]) == 2


@pytest.mark.asyncio
async def test_delete_session(client):
    """Test deleting a session."""
    # Create session
    await client.post(
        "/api/sessions/delete-test/push",
        json={
            "from_line": 1,
            "append_data": '{"test": true}',
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Test",
                "platform": "darwin",
                "original_path": "/test",
            },
        },
    )

    # Delete
    response = await client.delete("/api/sessions/delete-test")
    assert response.status_code == 200

    # Verify deleted
    response = await client.get("/api/sessions/delete-test")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_nonexistent_session(client):
    """Test deleting a session that doesn't exist."""
    response = await client.delete("/api/sessions/nonexistent")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_extract_first_message_text_array(client):
    """Test extracting first message from text array format."""
    await client.post(
        "/api/sessions/extract-test-1/push",
        json={
            "from_line": 1,
            "append_data": '{"type": "human", "message": {"content": [{"type": "text", "text": "Hello from array"}]}}',
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Test",
                "platform": "darwin",
                "original_path": "/test",
            },
        },
    )

    response = await client.get("/api/sessions/extract-test-1")
    data = response.json()
    assert data["session"]["first_message"] == "Hello from array"


@pytest.mark.asyncio
async def test_extract_first_message_string(client):
    """Test extracting first message from string format."""
    await client.post(
        "/api/sessions/extract-test-2/push",
        json={
            "from_line": 1,
            "append_data": '{"type": "human", "message": {"content": "Hello string"}}',
            "source": {
                "machine_id": "machine-1",
                "machine_name": "Test",
                "platform": "darwin",
                "original_path": "/test",
            },
        },
    )

    response = await client.get("/api/sessions/extract-test-2")
    data = response.json()
    assert data["session"]["first_message"] == "Hello string"


@pytest.mark.asyncio
async def test_segments_tracking(client):
    """Test that segments correctly track sources."""
    # Push from machine A
    await client.post(
        "/api/sessions/segment-test/push",
        json={
            "from_line": 1,
            "append_data": '{"line": 1}\n{"line": 2}\n{"line": 3}',
            "source": {
                "machine_id": "machine-A",
                "machine_name": "MacBook",
                "platform": "darwin",
                "original_path": "/Users/alice/project",
            },
        },
    )

    # Push from machine B
    await client.post(
        "/api/sessions/segment-test/push",
        json={
            "from_line": 4,
            "append_data": '{"line": 4}\n{"line": 5}',
            "source": {
                "machine_id": "machine-B",
                "machine_name": "WSL",
                "platform": "wsl",
                "original_path": "/home/alice/project",
            },
        },
    )

    response = await client.get("/api/sessions/segment-test")
    data = response.json()

    segments = data["segments"]
    assert len(segments) == 2

    assert segments[0]["machine_name"] == "MacBook"
    assert segments[0]["from_line"] == 1
    assert segments[0]["to_line"] == 3

    assert segments[1]["machine_name"] == "WSL"
    assert segments[1]["from_line"] == 4
    assert segments[1]["to_line"] == 5
