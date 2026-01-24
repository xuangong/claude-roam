"""Tests for database operations."""

import pytest

from app.db import (
    add_segment,
    create_session,
    delete_segments_after,
    delete_session,
    get_content,
    get_segments,
    get_session,
    get_sessions,
    truncate_content,
    update_content,
    update_session_metadata,
)


@pytest.mark.asyncio
async def test_create_session(db_connection):
    """Test creating a new session."""
    await create_session(
        db_connection,
        "test-session-1",
        first_message="Hello world",
        summary="Test session",
    )

    session = await get_session(db_connection, "test-session-1")
    assert session is not None
    assert session["session_id"] == "test-session-1"
    assert session["first_message"] == "Hello world"
    assert session["summary"] == "Test session"
    assert session["total_lines"] == 0


@pytest.mark.asyncio
async def test_get_nonexistent_session(db_connection):
    """Test getting a session that doesn't exist."""
    session = await get_session(db_connection, "nonexistent")
    assert session is None


@pytest.mark.asyncio
async def test_update_content(db_connection):
    """Test updating session content."""
    await create_session(db_connection, "test-session-2")
    await update_content(
        db_connection,
        "test-session-2",
        '{"line": 1}\n{"line": 2}',
        2,
    )

    content = await get_content(db_connection, "test-session-2")
    assert content == '{"line": 1}\n{"line": 2}'

    session = await get_session(db_connection, "test-session-2")
    assert session["total_lines"] == 2


@pytest.mark.asyncio
async def test_truncate_content(db_connection):
    """Test truncating content."""
    await create_session(db_connection, "test-session-3")
    await update_content(
        db_connection,
        "test-session-3",
        '{"line": 1}\n{"line": 2}\n{"line": 3}',
        3,
    )

    truncated = await truncate_content(db_connection, "test-session-3", 2)
    assert truncated == '{"line": 1}\n{"line": 2}'

    content = await get_content(db_connection, "test-session-3")
    assert content == '{"line": 1}\n{"line": 2}'


@pytest.mark.asyncio
async def test_add_and_get_segments(db_connection):
    """Test adding and getting segments."""
    await create_session(db_connection, "test-session-4")
    await add_segment(
        db_connection,
        "test-session-4",
        from_line=1,
        to_line=10,
        machine_id="machine-1",
        machine_name="Test Machine",
        platform="darwin",
        original_path="/Users/test",
    )

    segments = await get_segments(db_connection, "test-session-4")
    assert len(segments) == 1
    assert segments[0]["from_line"] == 1
    assert segments[0]["to_line"] == 10
    assert segments[0]["machine_id"] == "machine-1"
    assert segments[0]["machine_name"] == "Test Machine"


@pytest.mark.asyncio
async def test_delete_segments_after(db_connection):
    """Test deleting segments after a line."""
    await create_session(db_connection, "test-session-5")
    await add_segment(
        db_connection,
        "test-session-5",
        from_line=1,
        to_line=10,
        machine_id="machine-1",
    )
    await add_segment(
        db_connection,
        "test-session-5",
        from_line=11,
        to_line=20,
        machine_id="machine-1",
    )

    await delete_segments_after(db_connection, "test-session-5", 11)

    segments = await get_segments(db_connection, "test-session-5")
    assert len(segments) == 1
    assert segments[0]["to_line"] == 10


@pytest.mark.asyncio
async def test_list_sessions(db_connection):
    """Test listing sessions."""
    await create_session(db_connection, "list-test-1", first_message="First")
    await create_session(db_connection, "list-test-2", first_message="Second")

    sessions, total = await get_sessions(db_connection)
    assert len(sessions) >= 2
    assert total >= 2


@pytest.mark.asyncio
async def test_search_sessions(db_connection):
    """Test searching sessions."""
    await create_session(
        db_connection, "search-test-1", first_message="Search keyword test"
    )
    await create_session(
        db_connection, "search-test-2", first_message="Another message"
    )

    # Search for keyword
    sessions, total = await get_sessions(db_connection, query="keyword")
    session_ids = [s["session_id"] for s in sessions]
    assert "search-test-1" in session_ids
    assert total >= 1


@pytest.mark.asyncio
async def test_delete_session(db_connection):
    """Test deleting a session."""
    await create_session(db_connection, "delete-test")
    await add_segment(
        db_connection,
        "delete-test",
        from_line=1,
        to_line=5,
        machine_id="machine-1",
    )

    success = await delete_session(db_connection, "delete-test")
    assert success is True

    session = await get_session(db_connection, "delete-test")
    assert session is None

    # Segments should also be deleted (cascade)
    segments = await get_segments(db_connection, "delete-test")
    assert len(segments) == 0


@pytest.mark.asyncio
async def test_delete_nonexistent_session(db_connection):
    """Test deleting a session that doesn't exist."""
    success = await delete_session(db_connection, "nonexistent-session")
    assert success is False


@pytest.mark.asyncio
async def test_update_session_metadata(db_connection):
    """Test updating session metadata."""
    await create_session(db_connection, "metadata-test")
    await update_session_metadata(
        db_connection,
        "metadata-test",
        first_message="Updated message",
        summary="Updated summary",
    )

    session = await get_session(db_connection, "metadata-test")
    assert session["first_message"] == "Updated message"
    assert session["summary"] == "Updated summary"


@pytest.mark.asyncio
async def test_segment_overlap_handling(db_connection):
    """Test handling of overlapping segments."""
    await create_session(db_connection, "overlap-test")

    # Add first segment
    await add_segment(
        db_connection,
        "overlap-test",
        from_line=1,
        to_line=20,
        machine_id="machine-A",
    )

    # Simulate conflict - delete from line 11 and add new
    await delete_segments_after(db_connection, "overlap-test", 11)
    await add_segment(
        db_connection,
        "overlap-test",
        from_line=11,
        to_line=25,
        machine_id="machine-B",
    )

    segments = await get_segments(db_connection, "overlap-test")
    assert len(segments) == 2
    # First segment should be truncated to line 10
    assert segments[0]["to_line"] == 10
    assert segments[0]["machine_id"] == "machine-A"
    # Second segment should have the new data
    assert segments[1]["from_line"] == 11
    assert segments[1]["to_line"] == 25
    assert segments[1]["machine_id"] == "machine-B"
