# YouDoo Sing 开发记录

> 最后更新: 2026-04-13

## 一、项目概述

YouDoo Sing 是一个纯 Web 端多人群唱系统，支持歌曲上传、波形分段编辑、唱段分配、用户录音、AI 评分、管理员审核选定、合成导出。

## 二、实际技术栈（已偏离原始 README）

| 层 | 技术 |
|---|---|
| 前端 | 纯 HTML + CSS + 原生 JS（无框架），WaveSurfer.js 7 |
| 后端 | Python FastAPI，单文件路由 `routes.py` (~1017行) |
| 数据存储 | JSON 文件 `backend/data/db.json`（内存 dict + `_save_db()` 持久化） |
| 音频存储 | `backend/uploads/` 目录，webm 格式 |
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
│   │       └── routes.py        # 全部 API 路由（~1017行），含 JSON DB 操作
│   ├── data/
│   │   └── db.json              # 运行时数据存储（songs, segments, recordings, users）
│   ├── uploads/                 # 用户上传的录音文件（.webm）
│   └── requirements.txt
│
├── frontend/public/
│   ├── admin.html               # 管理后台入口
│   ├── record.html              # 用户录音页
│   ├── task.html                # 用户任务页
│   ├── index.html               # 登录页
│   ├── css/
│   │   ├── admin.css            # 管理后台全部样式（~1291行）
│   │   ├── record.css           # 录音页样式
│   │   ├── task.css             # 任务页样式
│   │   ├── common.css           # 公共样式
│   │   └── login.css            # 登录页样式
│   └── js/
│       ├── admin-core.js        # 管理后台核心：API工具、Toast、Modal、登录、模块路由
│       ├── admin-modules.js     # 仪表盘 + 歌曲库模块
│       ├── admin-editor.js      # 分段编辑器 Part1：状态/渲染/波形/覆盖层/事件绑定（~1370行）
│       ├── admin-editor2.js     # 分段编辑器 Part2：拖拽/撤销/菜单/保存/空白右键（~560行）
│       ├── admin-tasks.js       # 任务管理 + 合成导出模块（~375行）
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
  "recordings": { "<rec_id>": { ... } },
  "users": { "<user_id>": { ... } }
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

## 五、关键 API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/login` | 管理员登录，返回 token |
| GET | `/api/admin/songs` | 歌曲列表 |
| GET | `/api/admin/songs/{id}` | 歌曲详情（含 segments + 嵌套 recordings） |
| PUT | `/api/admin/songs/{id}/segments/batch` | 批量更新分段（含孤儿录音检测） |
| GET | `/api/admin/recordings?song_id=xxx` | 获取录音列表 |
| POST | `/api/admin/recordings/{id}/select` | 选定录音（同唱段互斥） |
| POST | `/api/admin/recordings/{id}/unselect` | 取消选定录音 |
| DELETE | `/api/recordings/{id}` | 删除录音 |
| POST | `/api/segments/{id}/complete` | 标记唱段完成锁定 |
| POST | `/api/segments/{id}/reopen` | 重新解锁唱段 |
| GET | `/api/admin/stats` | 系统统计数据 |

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
- 表头：`# | 歌曲 | 歌词 | 类型(合唱/独唱) | 时间 | 难度 | 状态 | 认领 | 录音 | 操作`
- 行可点击选择，选中后高亮（左侧蓝色边框），自动筛选下方录音表
- 再次点击取消选择
- 操作按钮使用 `event.stopPropagation()` 防止触发行选择

### 录音提交表
- 表头：`用户名 | 提交时间 | 音准 | 音量 | 节奏 | 音色 | 综合 | 已选定 | 操作`
- 评分从 `score_detail.dimensions` 提取，颜色编码：≥80绿 / ≥60黄 / <60红
- 操作区：波形迷你图 + 播放按钮 + 选定/取消选定按钮 + 删除按钮
- **独唱唱段**（`is_chorus=false`）：只能选定一条录音，已有选定时其他录音的选定按钮 disabled
- **合唱唱段**（`is_chorus=true`）：无选定数量限制
- 已选定录音显示"取消选定"按钮（黄色）

### 全局状态变量
- `_taskSongs` / `_taskAllSegs` / `_taskSelectedSegId` / `_taskSelectedIsChorus`

## 八、用户端页面

### task.html / task.js（任务页）
- `updateLyricsSubmitCounts()`：从 `recordings` 数组按 `segment_id` 计数，更新歌词卡上的"已提交人次"

### record.html / record.js（录音页）
- 用户录音、AI 评分、提交功能

## 九、CSS 样式约定

### admin.css 结构（~1291行）
- CSS 变量定义（`:root`）
- 登录页 → 主布局 → 侧边栏 → 主内容区
- 通用组件（card、btn、table、badge、empty-state、loading）
- Toast → 模态框 → 表单
- 分段编辑器（editor-layout、seg-list-panel、waveform-panel、seg-block、连锁标记、拖拽手柄、详情面板、播放栏）
- 右键菜单
- 歌曲库
- 任务管理（task-seg-row 行选择、score-cell 评分颜色）
- 响应式

### 关键样式类
- `.btn:disabled` — 灰色背景 `#cbd5e1`，浅灰文字 `#94a3b8`
- `.badge-chorus` — 粉色背景，合唱标记
- `.task-seg-active` — 选中行高亮，左侧 inset shadow
- `.score-high/mid/low` — 评分颜色（绿/黄/红）

## 十、模态框交互

- `showModal(title, bodyHtml, footerHtml)` 创建模态框
- 点击遮罩关闭：追踪 `mousedown` 目标，只有 mousedown 和 click 都在遮罩上才关闭
- 防止拖选文字时误关闭模态框

## 十一、admin-core.js API 工具

```javascript
const API = 'http://127.0.0.1:8000/api';
adminFetch(path, opts)  // 通用请求，自动加 Bearer token，401 自动登出
aGet(p)   // GET
aPut(p,b) // PUT + JSON body
aPost(p,b)// POST + JSON body
aDel(p)   // DELETE
```

- `adminFetch` 只在 `!res.ok`（非2xx）时 throw，所以 `need_confirm`（HTTP 200）正常返回处理

## 十二、启动方式

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

## 十三、已知注意事项

1. **Segment ID 重建问题**：`PUT /segments/batch` 会用 `uuid.uuid4().hex[:6]` 重新生成所有 ID，已通过孤儿录音检测+确认删除机制解决
2. **db.json 并发**：当前无锁机制，单用户开发环境使用
3. **遗留代码**：`models/`, `schemas/`, `core/database.py` 为 SQLAlchemy 遗留，未使用
4. **前端缓存**：HTML 中 JS/CSS 引用带 `?v=` 版本号参数，修改后需更新
5. **admin.html 脚本加载顺序**：`admin-core.js` → `admin-modules.js` → `admin-editor.js` → `admin-editor2.js` → `admin-tasks.js`
