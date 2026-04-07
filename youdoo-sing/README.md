# YouDoo Sing - 多人拼歌系统

一个纯 Web 端多人拼歌程序，支持歌曲上传、自动乐句切分、唱段分配与录制。

## 项目结构

```
youdoo-sing/
├── backend/          # FastAPI 后端
│   ├── app/
│   │   ├── api/      # API 路由
│   │   ├── models/   # 数据库模型
│   │   ├── schemas/  # Pydantic 模型
│   │   ├── core/     # 配置与数据库连接
│   │   └── services/ # 音频处理逻辑
│   ├── tests/
│   ├── requirements.txt
│   └── main.py
└── frontend/         # React + TypeScript 前端
    ├── src/
    │   ├── components/
    │   ├── pages/
    │   ├── services/
    │   └── types/
    └── package.json
```

## 技术栈

- **前端**: React 18 + TypeScript + Vite + Tailwind CSS
- **后端**: Python 3.11 + FastAPI + SQLAlchemy + Alembic
- **数据库**: PostgreSQL
- **缓存**: Redis
- **音频处理**: Librosa + FFmpeg

## 快速开始

### 后端

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

## License

MIT
