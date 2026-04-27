from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

# 加载 .env 文件（本地开发用）
try:
    from dotenv import load_dotenv
    _env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(_env_path):
        load_dotenv(_env_path)
        print(f"[env] loaded .env from {_env_path}")
except ImportError:
    pass

from app.api.routes import router
from app.core.database import init_db
from app.core.multitenant import bootstrap_multitenant


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    bootstrap_multitenant()
    print("[startup] MySQL schema ready")
    yield


app = FastAPI(
    title="YouDoo Sing API",
    description="多人拼歌系统后端API",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/health")
async def health_check():
    return {"status": "healthy"}

# 挂载前端静态文件（放在路由之后，作为兜底）
_frontend_dir = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'public')
if os.path.isdir(_frontend_dir):
    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app)
