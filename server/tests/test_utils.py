"""Tests for utility functions."""

import json
import pytest

from app.main import extract_first_user_message


def test_extract_from_human_text_array():
    """Test extracting message from human type with text array."""
    jsonl = '{"type": "human", "message": {"content": [{"type": "text", "text": "Hello world"}]}}'
    result = extract_first_user_message(jsonl)
    assert result == "Hello world"


def test_extract_from_human_string():
    """Test extracting message from human type with string content."""
    jsonl = '{"type": "human", "message": {"content": "Direct string message"}}'
    result = extract_first_user_message(jsonl)
    assert result == "Direct string message"


def test_extract_from_user_role():
    """Test extracting message from user role format."""
    jsonl = '{"role": "user", "content": "User role message"}'
    result = extract_first_user_message(jsonl)
    assert result == "User role message"


def test_extract_skips_assistant():
    """Test that assistant messages are skipped."""
    jsonl = '{"type": "assistant", "message": {"content": "Assistant response"}}\n{"type": "human", "message": {"content": "User message"}}'
    result = extract_first_user_message(jsonl)
    assert result == "User message"


def test_extract_truncates_long_message():
    """Test that long messages are truncated."""
    long_text = "x" * 300
    jsonl = f'{{"type": "human", "message": {{"content": "{long_text}"}}}}'
    result = extract_first_user_message(jsonl)
    assert len(result) == 200


def test_extract_from_empty():
    """Test extracting from empty content."""
    result = extract_first_user_message("")
    assert result is None


def test_extract_from_invalid_json():
    """Test extracting from invalid JSON."""
    result = extract_first_user_message("not valid json")
    assert result is None


def test_extract_from_multiline():
    """Test extracting from multiline JSONL."""
    jsonl = """{"type": "summary", "data": {}}
{"type": "human", "message": {"content": [{"type": "text", "text": "First user message"}]}}
{"type": "assistant", "message": {"content": "Response"}}"""
    result = extract_first_user_message(jsonl)
    assert result == "First user message"


def test_extract_handles_mixed_content():
    """Test extracting when content has mixed types."""
    data = {
        "type": "human",
        "message": {
            "content": [
                {"type": "image", "data": "..."},
                {"type": "text", "text": "Text after image"},
            ]
        },
    }
    jsonl = json.dumps(data)
    result = extract_first_user_message(jsonl)
    assert result == "Text after image"
