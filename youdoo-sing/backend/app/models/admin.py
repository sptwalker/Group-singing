from sqlalchemy import Column, String, Integer, Boolean, Text
from app.core.database import Base


class AdminUser(Base):
    """后台管理员 / 租户主体"""
    __tablename__ = "admin_users"

    id = Column(String(32), primary_key=True, index=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    password_hash = Column(String(128), nullable=False)
    display_name = Column(String(128), nullable=True)
    email = Column(String(128), nullable=True)
    email_confirmed = Column(Boolean, default=False, nullable=False)
    role = Column(String(24), default="admin", nullable=False, index=True)
    status = Column(String(24), default="active", nullable=False, index=True)
    freeze_tasks = Column(Boolean, default=False, nullable=False)
    song_limit = Column(Integer, default=5, nullable=False)
    storage_limit_mb = Column(Integer, nullable=True)
    created_at = Column(String(32), nullable=True)
    last_login_at = Column(String(32), nullable=True)
    deleted_at = Column(String(32), nullable=True)

    def to_dict(self, include_private: bool = False) -> dict:
        d = {
            "id": self.id,
            "username": self.username,
            "display_name": self.display_name or self.username,
            "email": self.email or "",
            "email_confirmed": bool(self.email_confirmed),
            "role": self.role,
            "status": self.status,
            "freeze_tasks": bool(self.freeze_tasks),
            "song_limit": self.song_limit,
            "storage_limit_mb": self.storage_limit_mb,
            "created_at": self.created_at,
            "last_login_at": self.last_login_at,
            "deleted_at": self.deleted_at,
        }
        if include_private:
            d["password_hash"] = self.password_hash
        return d


class AdminInviteCode(Base):
    """管理员注册授权码：一人一码，无有效期"""
    __tablename__ = "admin_invite_codes"

    id = Column(String(32), primary_key=True, index=True)
    code = Column(String(64), unique=True, nullable=False, index=True)
    created_by = Column(String(32), nullable=True, index=True)
    used_by = Column(String(32), nullable=True, index=True)
    status = Column(String(24), default="unused", nullable=False, index=True)
    created_at = Column(String(32), nullable=True)
    used_at = Column(String(32), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "code": self.code,
            "created_by": self.created_by,
            "used_by": self.used_by,
            "status": self.status,
            "created_at": self.created_at,
            "used_at": self.used_at,
        }


class SystemSetting(Base):
    """系统参数"""
    __tablename__ = "system_settings"

    key = Column(String(64), primary_key=True)
    value = Column(Text, nullable=True)
    value_type = Column(String(24), default="string", nullable=False)
    description = Column(Text, nullable=True)
    updated_by = Column(String(32), nullable=True)
    updated_at = Column(String(32), nullable=True)

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "value": self.value,
            "value_type": self.value_type,
            "description": self.description or "",
            "updated_by": self.updated_by,
            "updated_at": self.updated_at,
        }


class AuditLog(Base):
    """超级管理员/管理员关键操作审计日志"""
    __tablename__ = "audit_logs"

    id = Column(String(32), primary_key=True, index=True)
    actor_admin_id = Column(String(32), nullable=True, index=True)
    actor_username = Column(String(64), nullable=True)
    action = Column(String(64), nullable=False, index=True)
    target_type = Column(String(64), nullable=True, index=True)
    target_id = Column(String(64), nullable=True, index=True)
    detail = Column(Text, nullable=True)
    ip = Column(String(64), nullable=True)
    created_at = Column(String(32), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "actor_admin_id": self.actor_admin_id,
            "actor_username": self.actor_username,
            "action": self.action,
            "target_type": self.target_type,
            "target_id": self.target_id,
            "detail": self.detail or "",
            "ip": self.ip or "",
            "created_at": self.created_at,
        }
