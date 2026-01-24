"""Authentication module for Claude Roam."""

import os
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Optional

import httpx
import jwt

from .db import create_or_update_user, get_db, get_user_by_id

# Configuration
GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
JWT_SECRET = os.environ.get("JWT_SECRET", secrets.token_hex(32))
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_DAYS = 30

# GitHub OAuth URLs
GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code"
GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_USER_EMAILS_URL = "https://api.github.com/user/emails"


def create_jwt_token(user_id: str) -> str:
    """Create a JWT token for a user."""
    payload = {
        "sub": user_id,
        "iat": datetime.utcnow(),
        "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRATION_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_jwt_token(token: str) -> Optional[str]:
    """Verify a JWT token and return user_id if valid."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload.get("sub")
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


async def get_current_user(token: str) -> Optional[dict]:
    """Get current user from JWT token."""
    user_id = verify_jwt_token(token)
    if not user_id:
        return None

    db = await get_db()
    try:
        return await get_user_by_id(db, user_id)
    finally:
        await db.close()


# ============ GitHub OAuth ============

async def github_request_device_code() -> dict:
    """Request a device code from GitHub."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            GITHUB_DEVICE_CODE_URL,
            data={
                "client_id": GITHUB_CLIENT_ID,
                "scope": "read:user user:email",
            },
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        return response.json()


async def github_check_device_token(device_code: str) -> dict:
    """Check if device code has been authorized."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            GITHUB_ACCESS_TOKEN_URL,
            data={
                "client_id": GITHUB_CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            headers={"Accept": "application/json"},
        )
        return response.json()


async def github_exchange_code(code: str, redirect_uri: str) -> dict:
    """Exchange authorization code for access token (Web Flow)."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            GITHUB_ACCESS_TOKEN_URL,
            data={
                "client_id": GITHUB_CLIENT_ID,
                "client_secret": GITHUB_CLIENT_SECRET,
                "code": code,
                "redirect_uri": redirect_uri,
            },
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        return response.json()


async def github_get_user(access_token: str) -> dict:
    """Get user info from GitHub."""
    async with httpx.AsyncClient() as client:
        response = await client.get(
            GITHUB_USER_URL,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
            },
        )
        response.raise_for_status()
        user_data = response.json()

        # Get primary email if not public
        if not user_data.get("email"):
            email_response = await client.get(
                GITHUB_USER_EMAILS_URL,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/json",
                },
            )
            if email_response.status_code == 200:
                emails = email_response.json()
                primary_email = next(
                    (e["email"] for e in emails if e.get("primary")),
                    None
                )
                user_data["email"] = primary_email

        return user_data


async def create_user_from_github(github_user: dict) -> dict:
    """Create or update user from GitHub data."""
    db = await get_db()
    try:
        # Check if user exists
        from .db import get_user_by_provider
        existing_user = await get_user_by_provider(db, "github", str(github_user["id"]))

        user_id = existing_user["id"] if existing_user else str(uuid.uuid4())

        user = await create_or_update_user(
            db,
            user_id=user_id,
            provider="github",
            provider_id=str(github_user["id"]),
            email=github_user.get("email"),
            name=github_user.get("name") or github_user.get("login"),
            avatar_url=github_user.get("avatar_url"),
        )
        return user
    finally:
        await db.close()
