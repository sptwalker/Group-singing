import json
import uuid
from typing import Optional

import redis as redis_lib
from fastapi import HTTPException, Request, Response

from app.core.config import get_settings

settings = get_settings()

COOKIE_NAME = "youdoo_session"

_redis_client: Optional[redis_lib.Redis] = None


def _redis() -> redis_lib.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis_lib.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_client


def create_session(user_dict: dict) -> str:
    session_id = str(uuid.uuid4())
    _redis().set(
        f"session:{session_id}",
        json.dumps(user_dict, ensure_ascii=False),
        ex=settings.SESSION_TTL,
    )
    return session_id


def get_session_user(session_id: str) -> Optional[dict]:
    if not session_id:
        return None
    r = _redis()
    key = f"session:{session_id}"
    data = r.get(key)
    if not data:
        return None
    r.expire(key, settings.SESSION_TTL)
    return json.loads(data)


def delete_session(session_id: str) -> None:
    _redis().delete(f"session:{session_id}")


def set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=session_id,
        max_age=settings.SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=COOKIE_NAME, path="/")


def get_current_user(request: Request) -> dict:
    session_id = request.cookies.get(COOKIE_NAME)
    user = get_session_user(session_id) if session_id else None
    if not user:
        raise HTTPException(status_code=401, detail="未登录")
    return user


def get_optional_user(request: Request) -> Optional[dict]:
    session_id = request.cookies.get(COOKIE_NAME)
    return get_session_user(session_id) if session_id else None
