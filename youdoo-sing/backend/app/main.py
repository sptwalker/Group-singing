# backend/app/main.py  【全量正确代码，直接覆盖】
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.songs import router as songs_router
from app.api.routes import router as legacy_api_router
from app.core.database import engine, Base

app = FastAPI(title="拼歌系统", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(songs_router, prefix="/api", tags=["songs"])
app.include_router(legacy_api_router)

@app.on_event("startup")
async def on_startup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

@app.get("/")
def root():
    return {"message": "拼歌系统运行正常"}

@app.get("/health")
def health():
    return {"status": "ok"}