# YouDoo Sing - 多人群唱管理系统
# 单容器部署：FastAPI 后端 + 静态前端

FROM python:3.10-slim

# 系统依赖：ffmpeg（音频转码）、libsndfile（soundfile库）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖文件，利用 Docker 层缓存
COPY backend/requirements.txt /app/backend/requirements.txt

# 安装 Python 依赖（跳过 whisper 避免下载大模型，生产环境按需开启）
RUN pip install --no-cache-dir -r /app/backend/requirements.txt 2>/dev/null || \
    pip install --no-cache-dir \
    fastapi uvicorn python-multipart \
    sqlalchemy alembic psycopg2-binary \
    pydantic pydantic-settings python-dotenv \
    librosa soundfile mutagen scipy numpy

# 复制后端代码
COPY backend/ /app/backend/

# 复制前端静态文件
COPY frontend/public/ /app/frontend/public/

# 创建数据目录
RUN mkdir -p /app/backend/data /app/backend/uploads /app/backend/finals /music

# 暴露端口
EXPOSE 8000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 启动服务
WORKDIR /app/backend
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
