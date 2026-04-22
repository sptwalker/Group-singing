# YouDoo Sing 开发记录

> 最后更新: 2026-04-15

## 一、项目概述

YouDoo Sing 是一个纯 Web 端多人群唱系统，支持歌曲上传、波形分段编辑、唱段分配、用户录音、AI 评分、管理员审核选定、合成导出、最终成曲管理。

## 二、实际技术栈（已偏离原始 README）

| 层 | 技术 |
|---|---|
| 前端 | 纯 HTML + CSS + 原生 JS（无框架），WaveSurfer.js 7 |
| 后端 | Python FastAPI，单文件路由 `routes.py` (~1770行) |
| 数据存储 | JSON 文件 `backend/data/db.json`（内存 dict + `_save_db()` 持久化） |
| 音频存储 | `backend/uploads/` 目录（录音 webm），`backend/finals/` 目录（合成成曲） |
| 音频处理 | librosa + soundfile + scipy + numpy（合成引擎），ffmpeg（格式转换） |
| 前端服务 | `python -m http.server 3000 --directory frontend/public` |
| 后端服务 | `cd backend && python main.py`（uvicorn 0.0.0.0:8000） |

> 注意：`models/`, `schemas/`, `core/database.py` 等 SQLAlchemy 相关代码为早期遗留，**当前未使用**，实际数据全部走 JSON 文件。

## 三、项目文件结构

```
youdoo-sing/
├── backend/
│   ├── main.py                  # FastAPI 入口，CORS，include_router
│   ├── app/
│   │   └── api/
│   │       └── routes.py        # 全部 API 路由（~1770行），含 JSON DB 操作 + 合成引擎
│   ├── data/
│   │   └── db.json              # 运行时数据存储（songs, segments, claims, recordings, users, finals）
│   ├── uploads/                 # 用户上传的录音文件（.webm）+ 伴奏文件
│   ├── finals/                  # 合成成曲输出目录（.mp3/.wav + 元数据JSON + 录音备份）
│   └── requirements.txt
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

### db.json 顶层结构
```json
{
  "songs": { "<song_id>": { ... } },
  "segments": { "<seg_id>": { ... } },
  "claims": { "<claim_id>": { ... } },
  "recordings": { "<rec_id>": { ... } },
  "users": { "<user_id>": { ... } },
  "finals": { "<final_id>": { ... } }
}
```

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

```bash
# 后端（端口 8000）
cd youdoo-sing/backend
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
python main.py

# 前端（端口 3000）
cd youdoo-sing
python -m http.server 3000 --directory frontend/public
```

## 十六、已知注意事项

1. **Segment ID 重建问题**：`PUT /segments/batch` 会用 `uuid.uuid4().hex[:6]` 重新生成所有 ID，已通过孤儿录音检测+确认删除机制解决
2. **db.json 并发**：当前无锁机制，单用户开发环境使用
3. **遗留代码**：`models/`, `schemas/`, `core/database.py` 为 SQLAlchemy 遗留，未使用
4. **前端缓存**：HTML 中 JS/CSS 引用带 `?v=` 版本号参数，修改后需更新
5. **admin.html 脚本加载顺序**：`admin-core.js` → `admin-modules.js` → `admin-editor.js` → `admin-editor2.js` → `admin-tasks.js`
6. **合成任务状态**：`SYNTH_TASKS` 存储在内存中，服务器重启后丢失（合成结果已持久化到 `FINALS_DB`）
7. **ffmpeg 依赖**：合成引擎需要 ffmpeg 在系统 PATH 中，用于 webm→wav 和 wav→mp3 转换
8. **合成线程安全**：同一歌曲同时只允许一个合成任务，通过 `SYNTH_TASKS` 状态检查实现
9. **finals 目录结构**：每次合成生成音频文件 + 元数据 JSON + 录音备份目录，删除成曲时同步清理所有关联文件
