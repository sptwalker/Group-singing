import hashlib
import json
import os
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.database import engine, SessionLocal
from app.models import AdminUser, AdminInviteCode, SystemSetting, AuditLog, Song, Segment, SegmentClaim, Recording, FreeTask, Final, User

SUPER_ADMIN_ID = "super_administrator"
DEFAULT_ADMIN_ID = "admin_default"


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def hash_password(password: str) -> str:
    salt = os.environ.get("ADMIN_PASSWORD_SALT", "youdoo-sing")
    return hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()


def verify_password(password: str, password_hash: str) -> bool:
    return hash_password(password) == password_hash or hashlib.sha256(password.encode()).hexdigest() == password_hash


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def get_setting(db: Session, key: str, default: Any = None) -> Any:
    row = db.get(SystemSetting, key)
    if not row:
        return default
    if row.value_type == "bool":
        return str(row.value).lower() in ("1", "true", "yes", "on")
    if row.value_type == "int":
        try:
            return int(row.value)
        except Exception:
            return default
    if row.value_type == "json":
        try:
            return json.loads(row.value or "null")
        except Exception:
            return default
    return row.value


def set_setting(db: Session, key: str, value: Any, value_type: str = "string", description: str = "", updated_by: str | None = None) -> None:
    row = db.get(SystemSetting, key)
    if value_type == "json":
        stored = json.dumps(value, ensure_ascii=False)
    elif value_type == "bool":
        stored = "true" if bool(value) else "false"
    else:
        stored = str(value)
    if not row:
        row = SystemSetting(key=key)
        db.add(row)
    row.value = stored
    row.value_type = value_type
    if description:
        row.description = description
    row.updated_by = updated_by
    row.updated_at = now_str()


def log_audit(db: Session, actor: dict | AdminUser | None, action: str, target_type: str = "", target_id: str = "", detail: Any = None, ip: str = "") -> None:
    actor_id = None
    actor_username = None
    if isinstance(actor, AdminUser):
        actor_id = actor.id
        actor_username = actor.username
    elif isinstance(actor, dict):
        actor_id = actor.get("id") or actor.get("admin_id")
        actor_username = actor.get("username")
    db.add(AuditLog(
        id=new_id("audit"),
        actor_admin_id=actor_id,
        actor_username=actor_username,
        action=action,
        target_type=target_type,
        target_id=target_id,
        detail=json.dumps(detail, ensure_ascii=False) if isinstance(detail, (dict, list)) else (str(detail) if detail is not None else ""),
        ip=ip,
        created_at=now_str(),
    ))


def _add_column_if_missing(table: str, column: str, ddl: str) -> None:
    inspector = inspect(engine)
    existing = {c["name"] for c in inspector.get_columns(table)}
    if column in existing:
        return
    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))


def ensure_multitenant_schema() -> None:
    BaseTables = ["songs", "segments", "segment_claims", "recordings", "free_tasks", "finals", "users"]
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    for table in BaseTables:
        if table in tables:
            _add_column_if_missing(table, "owner_admin_id", "owner_admin_id VARCHAR(32) NULL")
            try:
                with engine.begin() as conn:
                    conn.execute(text(f"CREATE INDEX idx_{table}_owner_admin_id ON {table} (owner_admin_id)"))
            except Exception:
                pass
    if "admin_users" in tables:
        for column, ddl in [
            ("email_confirmed", "email_confirmed TINYINT(1) NOT NULL DEFAULT 0"),
            ("email_activation_token", "email_activation_token VARCHAR(128) NULL"),
            ("email_activation_expires_at", "email_activation_expires_at VARCHAR(32) NULL"),
            ("pending_email", "pending_email VARCHAR(128) NULL"),
            ("email_change_token", "email_change_token VARCHAR(128) NULL"),
            ("email_change_expires_at", "email_change_expires_at VARCHAR(32) NULL"),
            ("freeze_tasks", "freeze_tasks TINYINT(1) NOT NULL DEFAULT 0"),
            ("storage_limit_mb", "storage_limit_mb INT NULL"),
            ("deleted_at", "deleted_at VARCHAR(32) NULL"),
        ]:
            _add_column_if_missing("admin_users", column, ddl)


def seed_multitenant_defaults() -> None:
    db = SessionLocal()
    try:
        now = now_str()
        super_admin = db.get(AdminUser, SUPER_ADMIN_ID)
        if not super_admin:
            db.add(AdminUser(
                id=SUPER_ADMIN_ID,
                username="administrator",
                password_hash=hash_password("888888"),
                display_name="超级管理员",
                email="administrator@local",
                email_confirmed=True,
                role="super_admin",
                status="active",
                song_limit=999999,
                created_at=now,
            ))
        default_admin = db.get(AdminUser, DEFAULT_ADMIN_ID)
        if not default_admin:
            db.add(AdminUser(
                id=DEFAULT_ADMIN_ID,
                username="admin",
                password_hash=hash_password("youdoo2026"),
                display_name="默认管理员",
                email="admin@local",
                email_confirmed=True,
                role="admin",
                status="active",
                song_limit=5,
                created_at=now,
            ))
        defaults = {
            "admin_registration_enabled": ("false", "bool", "是否开放普通管理员注册"),
            "admin_registration_invite_required": ("true", "bool", "注册是否需要授权码"),
            "default_song_limit": ("5", "int", "普通管理员默认歌曲库上限"),
            "server_stats_level": ("enhanced", "string", "服务器统计级别"),
            "final_mix_enabled": ("true", "bool", "是否允许歌曲合成"),
        }
        for key, (value, value_type, desc) in defaults.items():
            if not db.get(SystemSetting, key):
                db.add(SystemSetting(key=key, value=value, value_type=value_type, description=desc, updated_at=now))
        db.commit()
        _assign_legacy_rows(db)
        db.commit()
    finally:
        db.close()


def _assign_legacy_rows(db: Session) -> None:
    for model in (Song, Segment, SegmentClaim, Recording, FreeTask, Final, User):
        db.query(model).filter(model.owner_admin_id.is_(None)).update({"owner_admin_id": DEFAULT_ADMIN_ID}, synchronize_session=False)


def bootstrap_multitenant() -> None:
    ensure_multitenant_schema()
    seed_multitenant_defaults()
