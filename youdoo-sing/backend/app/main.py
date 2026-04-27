from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import router as legacy_api_router
from app.core.database import init_db
from app.core.multitenant import bootstrap_multitenant


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    bootstrap_multitenant()
    print("[startup] MySQL schema ready")
    yield


app = FastAPI(title="拼歌系统", version="1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(legacy_api_router)


@app.get("/")
def root():
    return {"message": "拼歌系统运行正常"}


@app.get("/health")
def health():
    return {"status": "ok"}
