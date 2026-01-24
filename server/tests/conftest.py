"""Pytest configuration for Claude Roam server tests."""

import asyncio
import os
import tempfile
from pathlib import Path

import pytest
import pytest_asyncio
import aiosqlite

from app import db as db_module


@pytest.fixture(scope="session")
def event_loop():
    """Create event loop for async tests."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture
async def db():
    """Create a fresh database for each test."""
    # Create unique temp db for each test
    test_db = Path(tempfile.mkdtemp()) / "test_roam.db"
    db_module.DATABASE_PATH = test_db

    # Initialize database
    await db_module.init_db()

    yield test_db

    # Cleanup
    if test_db.exists():
        test_db.unlink()


@pytest_asyncio.fixture
async def db_connection(db):
    """Get a database connection."""
    conn = await aiosqlite.connect(db)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    await conn.close()
