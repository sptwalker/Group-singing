from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from app.core.config import get_settings

settings = get_settings()

engine = create_engine(
    settings.get_database_url(),
    pool_pre_ping=True,
    pool_recycle=3600,
    future=True,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)

Base = declarative_base()


def get_db():
    """FastAPI 依赖：每次请求创建一个 Session 并在结束时关闭"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """启动时调用：自动建表（开发用，生产建议改 alembic 迁移）"""
    # 必须先 import 所有 model 让 Base.metadata 收集到表
    from app.models import song, segment, recording, user, free_task, final  # noqa: F401
    Base.metadata.create_all(bind=engine)
