# syntax=docker/dockerfile:1.7
# YouDoo Sing - 多人群唱管理系统
# 多阶段构建：Node 打包前端 + Python 运行后端

# 前端构建阶段：使用 Node 镜像编译静态资源
FROM node:20-bookworm-slim AS frontend-builder

# 设置前端构建目录
WORKDIR /app/frontend

# 先复制 npm 依赖清单，便于复用依赖缓存层
COPY frontend/package.json frontend/package-lock.json ./

# 配置 npm 下载重试策略并安装前端依赖
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-factor 2 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set registry https://registry.npmjs.org/ && \
    npm ci --no-audit --prefer-offline

# 复制完整前端源码和构建配置
COPY frontend/ ./

# 执行前端生产构建，生成 dist 静态资源
RUN npm run build

# 运行阶段：使用 Python 镜像承载后端服务
FROM python:3.10-slim

# 安装运行时系统依赖：ffmpeg、libsndfile 和健康检查用 curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 设置应用根目录
WORKDIR /app

# 先复制后端依赖清单，利用 Docker 层缓存
COPY backend/requirements.txt /app/backend/requirements.txt

# 安装 Python 依赖，失败时回退到显式包列表
RUN pip install --no-cache-dir -r /app/backend/requirements.txt 2>/dev/null || \
    pip install --no-cache-dir \
    fastapi uvicorn python-multipart \
    sqlalchemy alembic psycopg2-binary \
    pydantic pydantic-settings python-dotenv \
    librosa soundfile mutagen scipy numpy openai httpx

# 从前端构建阶段复制 dist 产物到后端静态目录
COPY --from=frontend-builder /app/frontend/dist/ /app/frontend/public/


# 复制后端代码到运行镜像
COPY backend/ /app/backend/

# 创建容器内的数据、上传和成品目录
RUN mkdir -p /app/backend/data /app/backend/uploads /app/backend/finals /music

# 声明应用监听的 HTTP 端口
EXPOSE 8000

# 定义容器健康检查接口
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 切换到后端启动目录
WORKDIR /app/backend

# 使用 uvicorn 启动 FastAPI 服务
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
