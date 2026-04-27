# YouDoo Sing 开发记录

> 最后更新: 2026-04-25（MySQL 持久化迁移）

## 一、项目概述

YouDoo Sing 是一个纯 Web 端多人群唱系统，支持歌曲上传、波形分段编辑、唱段分配、用户录音、AI 评分、管理员审核选定、合成导出、最终成曲管理。

## 二、实际技术栈（已偏离原始 README）

| 层 | 技术 |
|---|---|
| 前端 | 纯 HTML + CSS + 原生 JS（无框架），WaveSurfer.js 7 |
| 后端 | Python FastAPI，单文件路由 `routes.py` (~3340行) |
| 数据存储 | **MySQL 8.0（utf8mb4）+ SQLAlchemy 2.0 ORM**，连接信息走 `.env` |
| 音频存储 | `backend/uploads/` 目录（录音 webm），`backend/finals/` 目录（合成成曲） |
| 音频处理 | librosa + soundfile + scipy + numpy（合成引擎），ffmpeg（格式转换） |
| 前端服务 | `python -m http.server 3000 --directory frontend/public` |
| 后端服务 | `cd backend && python main.py`（uvicorn 0.0.0.0:8000） |
| 数据库 | docker-compose 起 `db` 服务（MySQL 8.0），开发期直接连 `127.0.0.1:3306` |

> 历史背景：早期版本使用 `backend/data/db.json` 内存 dict + `_save_db()` 文件持久化。2026-04-25 已切换到 MySQL（方案B：完整 ORM 重构），所有路由通过 `db: Session = Depends(get_db)` 注入会话；`db.json` 仅作为一次性迁移源保留。

## 三、项目文件结构

```
youdoo-sing/
├── backend/
│   ├── main.py                  # FastAPI 入口，CORS，include_router，启动时调用 init_db()
│   ├── .env                     # MYSQL_HOST/PORT/USER/PASSWORD/DB（不入库）
│   ├── app/
│   │   ├── api/
│   │   │   └── routes.py        # 全部 API 路由（~3340行），全部走 SQLAlchemy ORM + 合成引擎
│   │   ├── core/
│   │   │   ├── config.py        # Pydantic Settings，加载 .env
│   │   │   └── database.py      # engine / SessionLocal / Base / get_db / db_session / init_db
│   │   └── models/              # SQLAlchemy ORM 模型（6 张表）
│   │       ├── song.py          # Song (relationships: segments, free_tasks)
│   │       ├── segment.py       # Segment + SegmentClaim（cascade delete-orphan）
│   │       ├── recording.py     # Recording（segment_id 不加 FK，可指向 segments 或 free_tasks）
│   │       ├── user.py          # User（wechat_openid/unionid 索引）
│   │       ├── free_task.py     # FreeTask（task_type 列名映射为 "type"）
│   │       └── final.py         # Final（song_id 不加 FK，保留歌曲删除后的成曲文件）
│   ├── scripts/
│   │   └── migrate_db_json_to_mysql.py  # 一次性迁移：db.json → MySQL（幂等，按 ID 跳过已存在）
│   ├── data/
│   │   └── db.json              # 历史数据快照，仅用于迁移；启动时不再读取
│   ├── uploads/                 # 用户上传的录音文件（.webm）+ 伴奏文件
│   ├── finals/                  # 合成成曲输出目录（.mp3/.wav + 元数据JSON + 录音备份）
│   └── requirements.txt         # 已加 sqlalchemy + pymysql + pydantic-settings
│
├── frontend/public/
│   ├── admin.html               # 管理后台入口
│   ├── record.html              # 用户录音页
│   ├── task.html                # 用户任务页
│   ├── index.html               # 登录页
│   ├── css/
│   │   ├── admin.css            # 管理后台全部样式（~1470行）
│   │   ├── record.css           # 录音页样式
│   │   ├── task.css             # 任务页样式
│   │   ├── common.css           # 公共样式
│   │   └── login.css            # 登录页样式
│   └── js/
│       ├── admin-core.js        # 管理后台核心：API工具、Toast、Modal、登录、模块路由（~131行）
│       ├── admin-modules.js     # 仪表盘 + 歌曲库模块（~385行）
│       ├── admin-editor.js      # 分段编辑器 Part1：状态/渲染/波形/覆盖层/事件绑定（~1370行）
│       ├── admin-editor2.js     # 分段编辑器 Part2：拖拽/撤销/菜单/保存/空白右键（~560行）
│       ├── admin-tasks.js       # 任务管理 + 合成导出 + 最终成曲模块（~1245行）
│       ├── config.js            # 前端配置
│       ├── login.js             # 登录逻辑
│       ├── record.js            # 用户录音页逻辑
│       └── task.js              # 用户任务页逻辑
```

## 四、核心数据结构

### MySQL 表结构（SQLAlchemy ORM）

| 表 | 模型 | 主键 | 关键关系 |
|---|---|---|---|
| `songs` | Song | id (String 32) | `segments` 1:N（cascade delete-orphan, lazy="selectin", order_by index）<br>`free_tasks` 1:N（cascade delete-orphan） |
| `segments` | Segment | id (String 32) | `song_id` → songs.id (FK)<br>`claims` 1:N（cascade delete-orphan） |
| `segment_claims` | SegmentClaim | id (String 32) | `segment_id` → segments.id (FK) |
| `recordings` | Recording | id (String 32) | `segment_id`（**无 FK**：可指向 segments.id 或 free_tasks.id） |
| `users` | User | id (String 32) | wechat_openid / wechat_unionid 各自加索引 |
| `free_tasks` | FreeTask | id (String 32) | `song_id` → songs.id (FK)；ORM 属性 `task_type` 映射数据库列 `type` |
| `finals` | Final | id (String 32) | `song_id` **无 FK**（删除歌曲后成曲文件仍可保留） |

> 表结构由 `init_db()` 在 FastAPI startup 时通过 `Base.metadata.create_all(bind=engine)` 自动创建；当前不使用 Alembic。

### Segment 字段
```json
{
  "id": "a1b2c3",
  "song_id": "xxx",
  "index": 1,
  "start_time": 38.5,
  "end_time": 45.4,
  "lyrics": "这些年一个人 风也过雨也走",
  "difficulty": "easy|normal|hard",
  "is_chorus": false,
  "status": "unassigned|claimed|completed",
  "claim_count": 1,
  "submit_count": 3,
  "recordings": []
}
```

### Recording 字段
```json
{
  "id": "rec_xxx",
  "song_id": "xxx",
  "segment_id": "a1b2c3",
  "user_id": "u_xxx",
  "user_name": "微信用户2218",
  "audio_url": "/api/uploads/ccb2b476.webm",
  "score": 3.0,
  "score_detail": {
    "star": 3,
    "composite": 53,
    "dimensions": {
      "pitch":  { "score": 40, "label": "音准", "icon": "🎵", "detail": "..." },
      "volume": { "score": 69, "label": "音量", "icon": "🔊", "detail": "..." },
      "rhythm": { "score": 35, "label": "节奏", "icon": "🥁", "detail": "..." },
      "tone":   { "score": 83, "label": "音色", "icon": "🎶", "detail": "..." }
    }
  },
  "submitted": true,
  "selected": false,
  "created_at": "2026-04-12T..."
}
```

### Final（最终成曲）字段
```json
{
  "id": "a1b2c3d4",
  "song_id": "xxx",
  "song_title": "朋友",
  "song_artist": "周华健",
  "duration": 240.5,
  "audio_file": "final_xxx_a1b2c3d4.mp3",
  "audio_url": "/api/finals/final_xxx_a1b2c3d4.mp3",
  "metadata_file": "meta_xxx_a1b2c3d4.json",
  "recordings_dir": "recs_xxx_a1b2c3d4",
  "track_count": 8,
  "segment_count": 12,
  "published": false,
  "created_at": "2026-04-15 14:30:00",
  "published_at": "2026-04-15 15:00:00"
}
```

## 五、关键 API 端点

### 管理员基础
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/login` | 管理员登录，返回 token |
| GET | `/api/admin/check` | 校验 token 有效性 |
| GET | `/api/admin/stats` | 系统统计数据 |

### 歌曲管理
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/songs` | 歌曲列表 |
| GET | `/api/admin/songs/{id}` | 歌曲详情（含 segments + 嵌套 recordings） |
| POST | `/api/admin/songs/upload` | 上传歌曲 + AI 识别切分 |
| PUT | `/api/admin/songs/{id}` | 更新歌曲信息 |
| DELETE | `/api/admin/songs/{id}` | 删除歌曲 |
| PUT | `/api/admin/songs/{id}/segments/batch` | 批量更新分段（含孤儿录音检测） |
| POST | `/api/admin/songs/{id}/accompaniment` | 上传伴奏（校验时长） |
| DELETE | `/api/admin/songs/{id}/accompaniment` | 删除伴奏 |

### 录音管理
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/recordings?song_id=xxx` | 获取录音列表 |
| POST | `/api/admin/recordings/{id}/select` | 选定录音（独唱互斥） |
| POST | `/api/admin/recordings/{id}/unselect` | 取消选定录音 |
| DELETE | `/api/admin/recordings/{id}` | 删除录音 |

### 唱段状态
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/segments/{id}/complete` | 标记唱段完成锁定 |
| POST | `/api/segments/{id}/reopen` | 重新解锁唱段 |

### 合成引擎
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/songs/{id}/synthesize` | 启动异步合成任务 |
| GET | `/api/admin/songs/{id}/synth-status` | 查询合成进度（前端轮询） |

### 最终成曲管理
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/finals` | 获取所有成曲列表 |
| GET | `/api/admin/finals/{id}` | 获取单个成曲详情 |
| POST | `/api/admin/finals/{id}/publish` | 发布成曲 |
| POST | `/api/admin/finals/{id}/unpublish` | 取消发布 |
| DELETE | `/api/admin/finals/{id}` | 删除成曲（含文件清理） |

### 文件服务
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/music/{filename}` | 提供原始音乐文件 |
| GET | `/api/uploads/{filename}` | 提供上传的录音/伴奏文件 |
| GET | `/api/finals/{filename}` | 提供合成成曲文件 |

## 六、分段编辑器模块详解

### 文件分工
- **admin-editor.js** (~1370行)：Part1 - 编辑器状态管理、渲染、WaveSurfer 波形、覆盖层、事件绑定
- **admin-editor2.js** (~560行)：Part2 - 拖拽交互、撤销重做、右键菜单、保存逻辑、空白区右键

### 连锁对系统
- `_linkedPairs` Set 存储 `"i:j"` 形式的连锁对
- `_rebuildLinkedPairs()` 检测 gap < 0.05s 的相邻唱段自动建立连锁
- 拖拽期间（`_dragInfo` 存在时）不重建连锁对，拖拽结束后在 `_endDrag` 中重建
- `_syncAdjacentBoundary()` 对连锁唱段联动移动边界，非连锁唱段则限制不越界
- 连锁标记显示在分界线上：`.seg-link-indicator` 包含 `.link-line`（黄色虚线）和 `.link-icon`（🔗居中）

### 唱段编号标签
- 标签从 seg-block 内部移出，作为 `.seg-overlay-container` 的直接子元素独立渲染
- `_renderOverlayLabels(ov, dur)` 在每个 seg-block 中心位置创建独立 div 标签
- 不受 seg-block 的 `opacity: 0.35` 影响，完全可见

### `_syncOverlayBlocks`
- 使用 `:scope > .seg-block` 选择器只操作 seg-block 元素，不误删标签和连锁标记

### 空白区域右键菜单
- `_onOverlayContextMenu` 绑定在 `#segOverlay` 和 `#waveformWrap` 上
- 检测点击是否在空白区域，计算空白段范围，超过 3 秒显示"新建唱段切片"菜单
- `_addSegInBlank()` 以点击位置为中心创建默认 5 秒的独立唱段

### 保存逻辑（孤儿录音处理）
- `_saveAll()` 调用 `PUT /admin/songs/{id}/segments/batch`
- 后端检测旧 segment ID 被移除后对应的已提交录音（孤儿录音）
- 返回 `{ success: false, need_confirm: true, orphan_count: N }` (HTTP 200)
- 前端弹出确认模态框，用户确认后以 `confirm_delete: true` 重新发送
- 后端删除孤儿录音记录 + 音频文件，然后重建分段

### 播放边界
- RAF `_tickEditorAudio` + timeupdate 双重边界检查，`end_time - 0.02` 容差

### 波形自动跟随
- 居中模式：滚动使播放线保持在视口中心，5% 容差

## 七、任务管理模块详解

### 唱段任务表
- 表头：`# | 歌曲 | 歌词 | 类型(合唱/独唱) | 时间 | 难度 | 认领 | 录音 | 操作`
- 行可点击选择，选中后高亮（左侧蓝色边框），自动筛选下方录音表
- 再次点击取消选择
- 操作按钮使用 `event.stopPropagation()` 防止触发行选择
- "完成锁定"按钮：无提交录音时 disabled 灰色禁用
- "重新解锁"按钮：已完成唱段显示

### 录音提交表
- 表头：`用户名 | 提交时间 | 音准 | 音量 | 节奏 | 音色 | 综合 | 已选定 | 操作`
- 评分从 `score_detail.dimensions` 提取，颜色编码：≥80绿 / ≥60黄 / <60红
- 操作区：波形迷你图 + 播放按钮 + 选定/取消选定按钮 + 删除按钮
- **独唱唱段**（`is_chorus=false`）：只能选定一条录音，已有选定时其他录音的选定按钮 disabled
- **合唱唱段**（`is_chorus=true`）：无选定数量限制
- 已选定录音显示"取消选定"按钮（黄色）

### 全局状态变量
- `_taskSongs` / `_taskAllSegs` / `_taskSelectedSegId` / `_taskSelectedIsChorus`

## 八、合成导出模块详解

### 功能概述
合成导出模块（`renderExport`）提供歌曲合成前的预览和参数调整界面：
- 选择歌曲后加载波形图、唱段切片、已选定录音
- 支持伴奏上传和播放预览
- 每条录音可调节升降调（pitchShift）和混响（reverb）参数
- "开始合成"按钮触发后端异步合成任务

### 合成流程
1. 前端 `_expStartSynth()` 收集所有录音的 `recParams`（pitchShift/reverb）
2. 显示合成进度模态框（8步指示器 + 进度条）
3. POST `/admin/songs/{id}/synthesize` 发送参数
4. 后端启动 `threading.Thread` 执行 `_run_synthesis()`
5. 前端 `_pollSynthStatus()` 每秒轮询进度
6. 合成完成后自动跳转到"最终成曲"页面

### 8步合成管线
| 步骤 | 名称 | 说明 |
|---|---|---|
| 1 | 降噪处理 | 转换录音格式（webm→wav via ffmpeg），读取音频数据 |
| 2 | 节奏对齐 | 按唱段时间定位录音（当前基于唱段时间戳对齐） |
| 3 | 音高修正 | 应用 `librosa.effects.pitch_shift` 升降调 |
| 4 | 响度均衡 | RMS 响度归一化至 -18dB |
| 5 | 人声增强 | 80Hz 高通滤波（scipy Butterworth 4阶） |
| 6 | 空间效果 | 延迟叠加混响（4条延迟线，衰减系数 0.4/0.3/0.2/0.1） |
| 7 | 合唱增强 | 合唱段录音微时间偏移（±5ms）增加厚度感 |
| 8 | 最终混音 | 人声混合 + 伴奏混合（人声0.7 + 伴奏0.5），限幅至0.95，导出mp3 |

### 合成输出文件
```
finals/
├── final_{song_id}_{final_id}.mp3    # 最终混音音频
├── meta_{song_id}_{final_id}.json    # 元数据（唱段、录音信息，供未来视频生成）
└── recs_{song_id}_{final_id}/        # 录音备份目录
    ├── ccb2b476.webm
    └── ...
```

### 合成任务状态
```json
{
  "status": "running|done|error",
  "progress": 0-100,
  "step": 0-7,
  "message": "当前步骤描述",
  "final_id": "完成后的成曲ID",
  "error": "错误信息（仅error状态）"
}
```

## 九、最终成曲模块详解

### 功能概述
最终成曲模块（`renderFinals`）管理合成完成的歌曲：
- 列表展示所有成曲，按创建时间倒序
- 每张卡片显示：播放按钮、歌曲信息、状态标签、唱段数/轨道数/时长/创建时间
- 操作：播放/暂停、发布/取消发布、删除

### 前端状态变量
- `_finalsPlayingAudio` — 当前播放的 Audio 对象
- `_finalsPlayingId` — 当前播放的成曲 ID

### 播放逻辑
- `_toggleFinalPlay()` 切换播放/暂停
- 使用 `_expBuildUrl()` 构建完整音频 URL
- 播放结束自动重置按钮状态

## 十、用户端页面

### task.html / task.js（任务页）
- `updateLyricsSubmitCounts()`：从 `recordings` 数组按 `segment_id` 计数，更新歌词卡上的"已提交人次"

### record.html / record.js（录音页）
- 用户录音、AI 评分、提交功能

## 十一、CSS 样式约定

### admin.css 结构（~1470行）
- CSS 变量定义（`:root`）
- 登录页 → 主布局 → 侧边栏 → 主内容区
- 通用组件（card、btn、table、badge、empty-state、loading）
- Toast → 模态框 → 表单
- 分段编辑器（editor-layout、seg-list-panel、waveform-panel、seg-block、连锁标记、拖拽手柄、详情面板、播放栏）
- 右键菜单
- 歌曲库
- 任务管理（task-seg-row 行选择、score-cell 评分颜色）
- 合成导出（export-toolbar、export-playbar、录音卡片）
- 合成进度对话框（synth-progress-wrap、synth-step-list、synth-progress-bar）
- 最终成曲模块（finals-header、final-card、final-play-btn）
- 响应式

### 关键样式类
- `.btn:disabled` — 灰色背景 `#cbd5e1`，浅灰文字 `#94a3b8`
- `.badge-chorus` — 粉色背景，合唱标记
- `.task-seg-active` — 选中行高亮，左侧 inset shadow
- `.score-high/mid/low` — 评分颜色（绿/黄/红）
- `.synth-step.active` — 蓝色背景，当前合成步骤
- `.synth-step.done` — 绿色背景，已完成步骤
- `.final-play-btn` — 圆形播放按钮，主色调

## 十二、模态框交互

- `showModal(title, bodyHtml, footerHtml)` 创建模态框
- 点击遮罩关闭：追踪 `mousedown` 目标，只有 mousedown 和 click 都在遮罩上才关闭
- 防止拖选文字时误关闭模态框

## 十三、admin-core.js API 工具

```javascript
const API = 'http://127.0.0.1:8000/api';
adminFetch(path, opts)  // 通用请求，自动加 Bearer token，401 自动登出
aGet(p)   // GET
aPut(p,b) // PUT + JSON body
aPost(p,b)// POST + JSON body
aDel(p)   // DELETE
```

- `adminFetch` 只在 `!res.ok`（非2xx）时 throw，所以 `need_confirm`（HTTP 200）正常返回处理

## 十四、依赖安装

### Python 依赖
```bash
cd youdoo-sing/backend
pip install -r requirements.txt
```

核心音频处理依赖（合成引擎必需）：
| 包 | 最低版本 | 用途 |
|---|---|---|
| numpy | >=2.0.0 | 数组运算、音频数据处理 |
| librosa | >=0.10.2 | 音高偏移、重采样、音频分析 |
| soundfile | >=0.12.1 | WAV 文件读写 |
| scipy | >=1.12.0 | 高通滤波（Butterworth） |
| mutagen | >=1.47.0 | 音频元数据读取（时长检测） |

数据库依赖：
| 包 | 用途 |
|---|---|
| SQLAlchemy >=2.0 | ORM + 连接池 |
| PyMySQL | MySQL 驱动（`mysql+pymysql://...`） |
| pydantic-settings | 加载 `.env` 配置 |

### 系统依赖
| 工具 | 用途 |
|---|---|
| ffmpeg | 音频格式转换（webm→wav, wav→mp3），必须在系统 PATH 中 |

### 验证依赖安装
```bash
# Python 依赖
python -c "import librosa, soundfile, scipy, numpy; print('OK')"

# ffmpeg
ffmpeg -version
```

## 十五、启动方式

### 1) 启动 MySQL（开发期用 docker-compose）
```bash
cd youdoo-sing
docker-compose up -d db        # 启动 MySQL 8.0（端口 3306）
```

### 2) 配置 `.env`（已有则跳过）
`backend/.env` 包含：
```
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=youdoo
MYSQL_PASSWORD=youdoo123
MYSQL_DB=youdoo_sing
```

### 3) 一次性迁移历史数据（仅首次）
```bash
cd youdoo-sing/backend
python -m scripts.migrate_db_json_to_mysql
```
脚本读取 `data/db.json`，按 ID 幂等导入；末尾打印 `inserted` / `skipped` 统计。

### 4) 启动后端 / 前端
```bash
# 后端（端口 8000）
cd youdoo-sing/backend
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
python main.py               # FastAPI startup 会调用 init_db() 自动建表

# 前端（端口 3000）
cd youdoo-sing
python -m http.server 3000 --directory frontend/public
```

启动日志包含 `[startup] MySQL schema ready` 表示 ORM 元数据已同步至库。

## 十六、已知注意事项

1. **Segment ID 重建问题**：`PUT /segments/batch` 会用 `uuid.uuid4().hex[:6]` 重新生成所有 ID，已通过孤儿录音检测+确认删除机制解决；批量替换时由 `_replace_segments_with_dicts` 先 `db.delete()` + flush 再插入新行，避免 PK 冲突
2. **MySQL 并发**：FastAPI 每个请求一个 Session（`Depends(get_db)`），并发安全由数据库事务保证
3. **前端缓存**：HTML 中 JS/CSS 引用带 `?v=` 版本号参数，修改后需更新
4. **admin.html 脚本加载顺序**：`admin-core.js` → `admin-modules.js` → `admin-editor.js` → `admin-editor2.js` → `admin-tasks.js`
5. **合成任务状态**：`SYNTH_TASKS` 存储在内存中，服务器重启后丢失（合成结果已持久化到 `finals` 表）
6. **ffmpeg 依赖**：合成引擎需要 ffmpeg 在系统 PATH 中，用于 webm→wav 和 wav→mp3 转换
7. **合成线程安全**：同一歌曲同时只允许一个合成任务，通过 `SYNTH_TASKS` 状态检查实现
8. **合成线程 + ORM**：Session 不可跨线程使用。`admin_start_synthesis` 必须先把 Song / Segment / Recording 通过 `.to_dict()` 物化为 plain dict 再传给 `threading.Thread`；后台 `_run_synthesis` 在写 Final 时用 `with db_session() as db_bg:` 重新开会话
9. **finals 目录结构**：每次合成生成音频文件 + 元数据 JSON + 录音备份目录，删除成曲时同步清理所有关联文件
10. **Recording.segment_id 不加 FK**：因为该字段在不同流程下既可能引用 `segments.id`，也可能引用 `free_tasks.id`，加 FK 会破坏自由任务录音
11. **Final.song_id 不加 FK**：删除歌曲后保留历史成曲音频，`admin_delete_song` 主动清理 Recording 与 Final 行
12. **Cascade 删除**：`Song.segments` / `Segment.claims` / `Song.free_tasks` 都配置了 `cascade="all, delete-orphan"`；删除 Song 时这些子表会自动清理，但 `recordings` 与 `finals` 仍需手动处理（无 FK）
13. **db.json 已退役**：启动时不再读取，相关 `_save_db()` / `_load_db()` 已全部删除；保留 `data/db.json` 仅供迁移脚本使用

## 十七、2026-04-27 管理员系统检查与单元测试

### 检查范围
- 后端多租户/管理员核心：`backend/app/api/routes.py`、`backend/app/core/multitenant.py`、`backend/app/core/database.py`、`backend/app/core/config.py`
- ORM 模型：`backend/app/models/admin.py`、`song.py`、`segment.py`、`recording.py`、`user.py`、`free_task.py`、`final.py`、`__init__.py`
- 重点验证：超级管理员初始化、注册开关、授权码、冻结/解冻、重置密码、审计日志、普通管理员歌曲租户隔离、超级管理员全局可见性

### 新增测试
- 新增 `backend/tests/test_admin_system.py`
- 测试使用 SQLite 文件库 `backend/tests/admin_system_test.sqlite3`，通过 `DATABASE_URL` 临时覆盖数据库连接
- 每个测试用例执行前 `drop_all/create_all` 并调用 `bootstrap_multitenant()` 初始化默认系统数据

### 覆盖用例
1. `test_super_admin_seed_login_and_check`：验证 `administrator / 888888` 初始化、登录、`/api/admin/check`、错误密码拒绝
2. `test_registration_settings_invite_code_and_audit_log`：验证默认注册状态、超级管理员修改注册设置、生成授权码、授权码注册普通管理员、授权码不可复用、审计日志写入
3. `test_freeze_unfreeze_and_reset_password`：验证冻结管理员、冻结后旧 token 失效、冻结后禁止登录、解冻、重置密码为 `123456`
4. `test_admin_song_tenant_isolation_and_super_visibility`：验证普通管理员只能看到自己的歌曲，跨租户访问返回 404，超级管理员可查看全部歌曲

### 测试注意事项
- Windows 下 SQLite 文件在 SQLAlchemy 连接未释放时不能立即删除；测试 teardown 改为 `drop_all()` 后 `engine.dispose()`，不在每个用例结束时删除数据库文件
- `requirements.txt` 已补充 `pytest>=8.3.0` 作为测试依赖

### 测试结果
- 运行命令：`powershell -NoProfile -Command "cd 'd:/Users/walker/Documents/walker/Videcode/group-singing/youdoo-sing/backend'; $env:PYTHONPATH='d:/Users/walker/Documents/walker/Videcode/group-singing/youdoo-sing/backend/venv/Lib/site-packages'; python -m pytest tests/test_admin_system.py -q"`
- 结果：`4 passed, 1 warning in 3.22s`
- 非阻塞警告：`app/core/config.py` 使用 Pydantic V1 风格 `class Config`，后续可迁移为 `ConfigDict`

### 后续风险点
- `users.owner_admin_id` 与“微信用户全局保留、录音按管理员隔离”的目标存在潜在冲突，后续应调整用户/参与记录边界
- 加密任务链接尚未实现，用户端 `/api/songs` 仍可能枚举已发布任务
- 录音提交、点赞、上传文件访问、成曲文件访问还需要继续加固任务权限与租户边界
