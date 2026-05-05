from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """应用配置类"""

    # 应用配置
    APP_NAME: str = "YouDoo Sing API"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = True

    # 数据库配置（MySQL）
    # 优先读 DATABASE_URL；否则用下面的分项拼装
    DATABASE_URL: str = ""
    MYSQL_HOST: str = "localhost"
    MYSQL_PORT: int = 3306
    MYSQL_USER: str = "youdoo"
    MYSQL_PASSWORD: str = "youdoo"
    MYSQL_DB: str = "youdoo_sing"

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # Session
    SESSION_TTL: int = 60 * 20   # 20分钟（滑动过期）
    COOKIE_SECURE: bool = False   # 生产环境改 true（HTTPS）

    # 系统邮件配置（SMTP 地址和密码后续在 .env 中配置）
    MAIL_FROM: str = "sing@youdoo.com"
    SMTP_HOST: str = ""
    SMTP_PORT: int = 465
    SMTP_USER: str = "sing@youdoo.com"
    SMTP_PASSWORD: str = ""
    SMTP_USE_SSL: bool = True

    # 文件存储配置
    UPLOAD_DIR: str = "./uploads"
    MAX_FILE_SIZE: int = 50 * 1024 * 1024  # 50MB

    # 华为云 OBS 配置
    OBS_ENDPOINT: str = ""
    OBS_ACCESS_KEY: str = ""
    OBS_SECRET_KEY: str = ""
    OBS_BUCKET: str = ""

    # 音频处理配置
    SEGMENT_MIN_DURATION: float = 3.0
    SEGMENT_MAX_DURATION: float = 15.0

    class Config:
        env_file = ".env"
        extra = "ignore"

    def get_database_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL
        return (
            f"mysql+pymysql://{self.MYSQL_USER}:{self.MYSQL_PASSWORD}"
            f"@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DB}?charset=utf8mb4"
        )


@lru_cache()
def get_settings() -> Settings:
    return Settings()
