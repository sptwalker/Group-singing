# syntax=docker/dockerfile:1.7

FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt

RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r /app/backend/requirements.txt 2>/dev/null || \
    pip install --no-cache-dir \
    fastapi uvicorn python-multipart \
    sqlalchemy alembic psycopg2-binary \
    pydantic pydantic-settings python-dotenv \
    librosa soundfile mutagen scipy numpy openai httpx

# Serve the same static multi-page frontend in Docker as in development.
COPY frontend/public/ /app/frontend/public/
COPY backend/ /app/backend/

RUN mkdir -p /app/backend/data /app/backend/uploads /app/backend/finals /music

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/health || exit 1

WORKDIR /app/backend

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "80"]
