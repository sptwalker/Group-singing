from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """应用配置类"""
    
    # 应用配置
    APP_NAME: str = "YouDoo Sing API"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = True
    
    # 数据库配置
    DATABASE_URL: str = "postgresql://user:password@localhost:5432/youdoo_sing"
    
    # Redis配置
    REDIS_URL: str = "redis://localhost:6379/0"
    
    # 文件存储配置
    UPLOAD_DIR: str = "./uploads"
    MAX_FILE_SIZE: int = 50 * 1024 * 1024  # 50MB
    
    # 音频处理配置
    SEGMENT_MIN_DURATION: float = 3.0  # 最小乐句长度（秒）
    SEGMENT_MAX_DURATION: float = 15.0  # 最大乐句长度（秒）
    
    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
