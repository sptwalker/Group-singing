from sqlalchemy import Column, String
from app.core.database import Base


class User(Base):
    """用户（用户名密码 / 微信登录）"""
    __tablename__ = "users"

    id = Column(String(64), primary_key=True, index=True)
    owner_admin_id = Column(String(32), nullable=True, index=True)
    nickname = Column(String(255), nullable=False)
    avatar = Column(String(512), nullable=True)
    auth_provider = Column(String(32), nullable=True)
    username = Column(String(64), unique=True, nullable=True, index=True)
    password_hash = Column(String(255), nullable=True)
    wechat_openid = Column(String(128), nullable=True, index=True)
    wechat_unionid = Column(String(128), nullable=True, index=True)
    wechat_scope = Column(String(64), nullable=True)
    created_at = Column(String(64), nullable=True)
    last_login_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "owner_admin_id": self.owner_admin_id,
            "nickname": self.nickname,
            "avatar": self.avatar or "",
        }
        if self.auth_provider:
            d["auth_provider"] = self.auth_provider
        if self.wechat_openid:
            d["wechat_openid"] = self.wechat_openid
        if self.wechat_unionid:
            d["wechat_unionid"] = self.wechat_unionid
        if self.wechat_scope:
            d["wechat_scope"] = self.wechat_scope
        if self.created_at:
            d["created_at"] = self.created_at
        if self.last_login_at:
            d["last_login_at"] = self.last_login_at
        return d
