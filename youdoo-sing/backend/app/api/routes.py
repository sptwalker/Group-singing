from fastapi import APIRouter, UploadFile, File, HTTPException, Form, Query, Body, Request
from fastapi.responses import JSONResponse
from typing import Optional, List
import uuid
import os
import json
import hashlib
import time

router = APIRouter(prefix="/api", tags=["api"])

# ============ 内存数据存储（开发阶段替代数据库） ============

SONGS_DB = {}
SEGMENTS_DB = {}
CLAIMS_DB = {}
RECORDINGS_DB = {}
USERS_DB = {}

# ============ 管理员配置 ============
ADMIN_ACCOUNTS = {
    "admin": hashlib.sha256("youdoo2026".encode()).hexdigest(),
}
ADMIN_TOKENS = {}  # token -> {username, login_time}

MUSIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "music"))
UPLOAD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "uploads"))
print(f"[DEBUG] MUSIC_DIR = {MUSIC_DIR}")
print(f"[DEBUG] MUSIC_DIR exists = {os.path.exists(MUSIC_DIR)}")
if os.path.exists(MUSIC_DIR):
    print(f"[DEBUG] Music files: {os.listdir(MUSIC_DIR)}")
os.makedirs(UPLOAD_DIR, exist_ok=True)


def init_demo_data():
    """初始化演示数据"""
    if SONGS_DB:
        return

    demo_songs = [
        {
            # 朋友 — 周华健 (标准录音室版, ~312s)
            # LRC 来源: lrclib.net 精确同步歌词
            "title": "朋友",
            "artist": "周华健",
            "filename": "周华健 - 朋友.mp3",
            "duration": 312.0,
            "lyrics_data": [
                # 第一段
                {"text": "这些年一个人 风也过雨也走", "start": 38.2, "end": 46.2, "difficulty": "easy"},
                {"text": "有过泪有过错 还记得坚持什么", "start": 46.2, "end": 53.0, "difficulty": "normal"},
                {"text": "真爱过才会懂 会寂寞会回首", "start": 53.0, "end": 60.0, "difficulty": "easy"},
                {"text": "终有梦终有你在心中", "start": 60.0, "end": 67.0, "difficulty": "normal"},
                # 副歌1
                {"text": "朋友一生一起走", "start": 67.0, "end": 72.5, "difficulty": "hard", "is_chorus": True},
                {"text": "那些日子不再有", "start": 72.5, "end": 78.0, "difficulty": "hard", "is_chorus": True},
                {"text": "一句话一辈子", "start": 78.0, "end": 83.5, "difficulty": "normal", "is_chorus": True},
                {"text": "一生情一杯酒", "start": 83.5, "end": 89.0, "difficulty": "normal", "is_chorus": True},
                {"text": "朋友不曾孤单过", "start": 89.0, "end": 94.5, "difficulty": "hard", "is_chorus": True},
                {"text": "一声朋友你会懂", "start": 94.5, "end": 100.0, "difficulty": "hard", "is_chorus": True},
                {"text": "还有伤还有痛 还要走还有我", "start": 100.0, "end": 113.0, "difficulty": "normal"},
                # 第二段
                {"text": "这些年一个人 风也过雨也走", "start": 136.0, "end": 144.0, "difficulty": "easy"},
                {"text": "有过泪有过错 还记得坚持什么", "start": 144.0, "end": 151.0, "difficulty": "normal"},
                {"text": "真爱过才会懂 会寂寞会回首", "start": 151.0, "end": 158.0, "difficulty": "easy"},
                {"text": "终有梦终有你在心中", "start": 158.0, "end": 165.0, "difficulty": "normal"},
                # 副歌2
                {"text": "朋友一生一起走", "start": 165.0, "end": 170.5, "difficulty": "hard", "is_chorus": True},
                {"text": "那些日子不再有", "start": 170.5, "end": 176.0, "difficulty": "hard", "is_chorus": True},
                {"text": "一句话一辈子", "start": 176.0, "end": 181.5, "difficulty": "normal", "is_chorus": True},
                {"text": "一生情一杯酒", "start": 181.5, "end": 187.0, "difficulty": "normal", "is_chorus": True},
                {"text": "朋友不曾孤单过", "start": 187.0, "end": 192.5, "difficulty": "hard", "is_chorus": True},
                {"text": "一声朋友你会懂", "start": 192.5, "end": 198.0, "difficulty": "hard", "is_chorus": True},
                {"text": "还有伤还有痛 还要走还有我", "start": 198.0, "end": 210.0, "difficulty": "normal"},
            ]
        },
        {
            # 真心英雄 — 李宗盛 (理性与感性作品音乐会 Live版, ~332s)
            # LRC 来源: lrclib.net 精确同步歌词
            "title": "真心英雄",
            "artist": "李宗盛",
            "filename": "李宗盛-真心英雄.mp3",
            "duration": 332.0,
            "lyrics_data": [
                # 第一段
                {"text": "在我心中曾经有一个梦", "start": 14.1, "end": 18.9, "difficulty": "easy"},
                {"text": "要用歌声让你忘了所有的痛", "start": 18.9, "end": 24.0, "difficulty": "normal"},
                {"text": "灿烂星空谁是真的英雄", "start": 24.0, "end": 28.7, "difficulty": "normal"},
                {"text": "平凡的人们给我最多感动", "start": 28.7, "end": 34.0, "difficulty": "easy"},
                {"text": "再没有恨也没有了痛", "start": 34.0, "end": 39.0, "difficulty": "easy"},
                {"text": "但愿人间处处都有爱的影踪", "start": 39.0, "end": 44.0, "difficulty": "normal"},
                {"text": "用我们的歌换你真心笑容", "start": 44.0, "end": 49.0, "difficulty": "normal"},
                {"text": "祝福你的人生从此与众不同", "start": 49.0, "end": 55.0, "difficulty": "hard"},
                # 副歌1
                {"text": "把握生命里的每一分钟", "start": 55.1, "end": 60.5, "difficulty": "hard", "is_chorus": True},
                {"text": "全力以赴我们心中的梦", "start": 60.5, "end": 66.0, "difficulty": "hard", "is_chorus": True},
                {"text": "不经历风雨怎么见彩虹", "start": 66.0, "end": 72.0, "difficulty": "hard", "is_chorus": True},
                {"text": "没有人能随随便便成功", "start": 72.0, "end": 80.0, "difficulty": "normal", "is_chorus": True},
                # 第二段
                {"text": "在我心中曾经有一个梦", "start": 94.0, "end": 99.0, "difficulty": "easy"},
                {"text": "要用歌声让你忘了所有的痛", "start": 99.0, "end": 104.0, "difficulty": "normal"},
                {"text": "灿烂星空谁是真的英雄", "start": 104.0, "end": 109.0, "difficulty": "normal"},
                {"text": "平凡的人们给我最多感动", "start": 109.0, "end": 114.5, "difficulty": "easy"},
                # 副歌2
                {"text": "把握生命里的每一分钟", "start": 114.5, "end": 120.0, "difficulty": "hard", "is_chorus": True},
                {"text": "全力以赴我们心中的梦", "start": 120.0, "end": 125.5, "difficulty": "hard", "is_chorus": True},
                {"text": "不经历风雨怎么见彩虹", "start": 125.5, "end": 131.5, "difficulty": "hard", "is_chorus": True},
                {"text": "没有人能随随便便成功", "start": 131.5, "end": 140.0, "difficulty": "normal", "is_chorus": True},
            ]
        },
        {
            # 明天会更好 — 群星 Live版 (~301s)
            # 注意：这是 Live 版本，时间戳基于标准版 LRC 并做了偏移校准
            # 标准版 LRC 第一句 [00:27.18]，实际 Live 版约在 39s 开始
            # 偏移量约 +12s
            "title": "明天会更好",
            "artist": "群星",
            "filename": "胡德夫&张信哲&那英&莫文蔚&何炅&杨宗纬&阿雅&张韶涵&魏如萱&张杰&华晨宇&马嘉祺&告五人-明天会更好(Live)(1).mp3",
            "duration": 301.0,
            "lyrics_data": [
                # 第一段
                {"text": "轻轻敲醒沉睡的心灵", "start": 39.0, "end": 44.5, "difficulty": "easy"},
                {"text": "慢慢张开你的眼睛", "start": 44.5, "end": 50.0, "difficulty": "easy"},
                {"text": "看看忙碌的世界", "start": 50.0, "end": 54.0, "difficulty": "easy"},
                {"text": "是否依然孤独地转个不停", "start": 54.0, "end": 61.0, "difficulty": "normal"},
                {"text": "春风不解风情", "start": 61.0, "end": 66.5, "difficulty": "easy"},
                {"text": "吹动少年的心", "start": 66.5, "end": 72.0, "difficulty": "easy"},
                {"text": "让昨日脸上的泪痕", "start": 72.0, "end": 78.0, "difficulty": "normal"},
                {"text": "随记忆风干了", "start": 78.0, "end": 84.0, "difficulty": "easy"},
                # 第二段
                {"text": "抬头寻找天空的翅膀", "start": 84.0, "end": 89.5, "difficulty": "easy"},
                {"text": "候鸟出现它的影迹", "start": 89.5, "end": 95.0, "difficulty": "easy"},
                {"text": "带来远处的饥荒", "start": 95.0, "end": 99.0, "difficulty": "easy"},
                {"text": "无情的战火依然存在的消息", "start": 99.0, "end": 106.0, "difficulty": "normal"},
                {"text": "玉山白雪飘零", "start": 106.0, "end": 111.5, "difficulty": "easy"},
                {"text": "燃烧少年的心", "start": 111.5, "end": 117.0, "difficulty": "easy"},
                {"text": "使真情溶化成音符", "start": 117.0, "end": 123.0, "difficulty": "normal"},
                {"text": "倾诉遥远的祝福", "start": 123.0, "end": 129.0, "difficulty": "easy"},
                # 副歌
                {"text": "唱出你的热情 伸出你的双手", "start": 129.0, "end": 138.0, "difficulty": "hard", "is_chorus": True},
                {"text": "让我拥抱着你的梦", "start": 138.0, "end": 144.0, "difficulty": "hard", "is_chorus": True},
                {"text": "让我拥有你真心的面孔", "start": 144.0, "end": 151.0, "difficulty": "normal", "is_chorus": True},
                {"text": "让我们的笑容充满着青春的骄傲", "start": 151.0, "end": 160.0, "difficulty": "hard", "is_chorus": True},
                {"text": "让我们期待明天会更好", "start": 160.0, "end": 170.0, "difficulty": "normal", "is_chorus": True},
            ]
        },
    ]

    for song_data in demo_songs:
        song_id = str(uuid.uuid4())[:8]
        audio_path = os.path.join(MUSIC_DIR, song_data["filename"])
        audio_url = f"/api/music/{song_data['filename']}"

        segments = []
        for i, lyric in enumerate(song_data["lyrics_data"]):
            seg_id = f"{song_id}-{i+1:02d}"
            seg = {
                "id": seg_id,
                "song_id": song_id,
                "index": i + 1,
                "start_time": lyric["start"],
                "end_time": lyric["end"],
                "lyrics": lyric["text"],
                "difficulty": lyric["difficulty"],
                "is_chorus": lyric.get("is_chorus", False),
                "status": "unassigned",
                "claim_count": 0,
                "submit_count": 0,
                "claims": [],
            }
            SEGMENTS_DB[seg_id] = seg
            segments.append(seg)

        SONGS_DB[song_id] = {
            "id": song_id,
            "title": song_data["title"],
            "artist": song_data["artist"],
            "duration": song_data["duration"],
            "audio_url": audio_url,
            "segment_count": len(segments),
            "participant_count": 0,
            "completion": 0.0,
            "segments": segments,
        }


# ============ 用户接口 ============

@router.post("/user/login")
async def user_login(nickname: str = Form(...)):
    """模拟微信登录"""
    user_id = str(uuid.uuid4())[:8]
    user = {
        "id": user_id,
        "nickname": nickname,
        "avatar": f"https://api.dicebear.com/7.x/fun-emoji/svg?seed={nickname}",
    }
    USERS_DB[user_id] = user
    return {"success": True, "data": user}


# ============ 歌曲接口 ============

@router.get("/songs")
async def get_songs():
    """获取所有歌曲列表"""
    songs = []
    for s in SONGS_DB.values():
        songs.append({
            "id": s["id"],
            "title": s["title"],
            "artist": s["artist"],
            "duration": s["duration"],
            "audio_url": s["audio_url"],
            "segment_count": s["segment_count"],
            "participant_count": s["participant_count"],
            "completion": s["completion"],
        })
    return {"success": True, "data": songs}


@router.get("/songs/{song_id}")
async def get_song(song_id: str):
    """获取歌曲详情（含唱段）"""
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return {"success": True, "data": song}


# ============ 唱段接口 ============

@router.get("/songs/{song_id}/segments")
async def get_segments(song_id: str):
    """获取歌曲所有唱段"""
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return {"success": True, "data": song["segments"]}


@router.post("/segments/{segment_id}/claim")
async def claim_segment(segment_id: str, user_id: str = Form(...), user_name: str = Form(...)):
    """认领唱段"""
    seg = SEGMENTS_DB.get(segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail="唱段不存在")
    if seg["status"] == "completed":
        raise HTTPException(status_code=400, detail="该唱段已完成")

    # 检查是否已认领
    for c in seg["claims"]:
        if c["user_id"] == user_id:
            return {"success": True, "data": seg, "message": "您已认领该唱段"}

    claim_id = str(uuid.uuid4())[:8]
    claim = {
        "id": claim_id,
        "segment_id": segment_id,
        "user_id": user_id,
        "user_name": user_name,
        "status": "claimed",
    }
    seg["claims"].append(claim)
    seg["claim_count"] = len(seg["claims"])
    if seg["status"] == "unassigned":
        seg["status"] = "claimed"
    CLAIMS_DB[claim_id] = claim

    # 更新参与人数
    song = SONGS_DB.get(seg["song_id"])
    if song:
        all_users = set()
        for s in song["segments"]:
            for c in s["claims"]:
                all_users.add(c["user_id"])
        song["participant_count"] = len(all_users)

    return {"success": True, "data": seg}


@router.post("/segments/random-claim")
async def random_claim(song_id: str = Form(...), user_id: str = Form(...), user_name: str = Form(...)):
    """随机认领一个可唱段"""
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")

    import random
    available = [s for s in song["segments"] if s["status"] != "completed"]
    # 优先选未被当前用户认领的
    unclaimed_by_user = [s for s in available if not any(c["user_id"] == user_id for c in s["claims"])]
    pool = unclaimed_by_user if unclaimed_by_user else available

    if not pool:
        raise HTTPException(status_code=400, detail="没有可认领的唱段了")

    seg = random.choice(pool)
    claim_id = str(uuid.uuid4())[:8]
    claim = {
        "id": claim_id,
        "segment_id": seg["id"],
        "user_id": user_id,
        "user_name": user_name,
        "status": "claimed",
    }
    if not any(c["user_id"] == user_id for c in seg["claims"]):
        seg["claims"].append(claim)
        seg["claim_count"] = len(seg["claims"])
    if seg["status"] == "unassigned":
        seg["status"] = "claimed"
    CLAIMS_DB[claim_id] = claim

    song["participant_count"] = len(set(
        c["user_id"] for s in song["segments"] for c in s["claims"]
    ))

    return {"success": True, "data": seg}


# ============ 录音接口 ============

@router.post("/recordings/upload")
async def upload_recording(
    segment_id: str = Form(...),
    song_id: str = Form(...),
    user_id: str = Form(...),
    user_name: str = Form(...),
    score: float = Form(0.0),
    audio: UploadFile = File(...),
):
    """上传录音"""
    rec_id = str(uuid.uuid4())[:8]
    filename = f"{rec_id}.webm"
    filepath = os.path.join(UPLOAD_DIR, filename)

    content = await audio.read()
    with open(filepath, "wb") as f:
        f.write(content)

    recording = {
        "id": rec_id,
        "segment_id": segment_id,
        "song_id": song_id,
        "user_id": user_id,
        "user_name": user_name,
        "audio_url": f"/api/uploads/{filename}",
        "score": score,
        "likes": 0,
        "submitted": False,
        "selected": False,
    }
    RECORDINGS_DB[rec_id] = recording
    return {"success": True, "data": recording}


@router.post("/recordings/{recording_id}/submit")
async def submit_recording(recording_id: str):
    """提交录音 — 每段允许多人提交，不自动标记完成（需管理员手动标记）"""
    rec = RECORDINGS_DB.get(recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")

    rec["submitted"] = True

    seg = SEGMENTS_DB.get(rec["segment_id"])
    if seg:
        # 更新提交人数
        submitted_count = sum(
            1 for r in RECORDINGS_DB.values()
            if r["segment_id"] == seg["id"] and r["submitted"]
        )
        seg["submit_count"] = submitted_count
        # 不再自动标记 completed，需管理员手动操作

        song = SONGS_DB.get(seg["song_id"])
        if song:
            completed = sum(1 for s in song["segments"] if s["status"] == "completed")
            song["completion"] = round(completed / len(song["segments"]) * 100, 1)

    return {"success": True, "data": rec}


@router.post("/segments/{segment_id}/complete")
async def mark_segment_completed(segment_id: str):
    """管理员标记唱段为已完成"""
    seg = SEGMENTS_DB.get(segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail="唱段不存在")

    seg["status"] = "completed"

    song = SONGS_DB.get(seg["song_id"])
    if song:
        completed = sum(1 for s in song["segments"] if s["status"] == "completed")
        song["completion"] = round(completed / len(song["segments"]) * 100, 1)

    return {"success": True, "data": seg}


@router.delete("/recordings/{recording_id}")
async def delete_recording(recording_id: str):
    """删除录音"""
    rec = RECORDINGS_DB.pop(recording_id, None)
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")
    filepath = os.path.join(UPLOAD_DIR, f"{recording_id}.webm")
    if os.path.exists(filepath):
        os.remove(filepath)
    return {"success": True, "message": "已删除"}


@router.get("/recordings")
async def get_recordings(song_id: Optional[str] = None, segment_id: Optional[str] = None):
    """获取录音列表"""
    results = list(RECORDINGS_DB.values())
    if song_id:
        results = [r for r in results if r["song_id"] == song_id]
    if segment_id:
        results = [r for r in results if r["segment_id"] == segment_id]
    results = [r for r in results if r["submitted"]]
    return {"success": True, "data": results}


@router.post("/recordings/{recording_id}/like")
async def like_recording(recording_id: str):
    """点赞录音"""
    rec = RECORDINGS_DB.get(recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")
    rec["likes"] += 1
    return {"success": True, "data": rec}


# ============ 音频文件服务 ============

from fastapi.responses import FileResponse

@router.get("/music/{filename:path}")
async def serve_music(filename: str):
    """提供音乐文件"""
    filepath = os.path.join(MUSIC_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(filepath, media_type="audio/mpeg")


@router.get("/uploads/{filename:path}")
async def serve_upload(filename: str):
    """提供上传文件"""
    filepath = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(filepath, media_type="audio/webm")


# ============ 管理员鉴权 ============

def verify_admin(request: Request):
    """验证管理员 token"""
    auth = request.headers.get("Authorization", "")
    token = auth.replace("Bearer ", "") if auth.startswith("Bearer ") else ""
    if not token or token not in ADMIN_TOKENS:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    return ADMIN_TOKENS[token]


@router.post("/admin/login")
async def admin_login(username: str = Body(...), password: str = Body(...)):
    """管理员登录"""
    pwd_hash = hashlib.sha256(password.encode()).hexdigest()
    if username not in ADMIN_ACCOUNTS or ADMIN_ACCOUNTS[username] != pwd_hash:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = hashlib.sha256(f"{username}{time.time()}{uuid.uuid4()}".encode()).hexdigest()[:32]
    ADMIN_TOKENS[token] = {"username": username, "login_time": time.time()}
    return {"success": True, "data": {"token": token, "username": username}}


@router.get("/admin/check")
async def admin_check(request: Request):
    """检查管理员登录状态"""
    admin = verify_admin(request)
    return {"success": True, "data": admin}


# ============ 管理员 - 歌曲管理 ============

@router.get("/admin/songs")
async def admin_get_songs(request: Request):
    """获取所有歌曲（含完整信息）"""
    verify_admin(request)
    songs = []
    for s in SONGS_DB.values():
        songs.append({
            **s,
            "claimed_count": sum(1 for seg in s["segments"] if seg["status"] != "unassigned"),
            "completed_count": sum(1 for seg in s["segments"] if seg["status"] == "completed"),
            "recording_count": sum(1 for r in RECORDINGS_DB.values() if r["song_id"] == s["id"]),
        })
    return {"success": True, "data": songs}


@router.get("/admin/songs/{song_id}")
async def admin_get_song(song_id: str, request: Request):
    """获取歌曲完整详情"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    # 附带每段的录音信息
    enriched_segments = []
    for seg in song["segments"]:
        recs = [r for r in RECORDINGS_DB.values() if r["segment_id"] == seg["id"]]
        enriched_segments.append({**seg, "recordings": recs})
    return {"success": True, "data": {**song, "segments": enriched_segments}}


@router.put("/admin/songs/{song_id}")
async def admin_update_song(song_id: str, request: Request):
    """更新歌曲基本信息"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    body = await request.json()
    for key in ["title", "artist", "duration"]:
        if key in body:
            song[key] = body[key]
    return {"success": True, "data": song}


@router.delete("/admin/songs/{song_id}")
async def admin_delete_song(song_id: str, request: Request):
    """删除歌曲"""
    verify_admin(request)
    song = SONGS_DB.pop(song_id, None)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    # 清理关联数据
    seg_ids = [seg["id"] for seg in song["segments"]]
    for sid in seg_ids:
        SEGMENTS_DB.pop(sid, None)
    to_del = [rid for rid, r in RECORDINGS_DB.items() if r["song_id"] == song_id]
    for rid in to_del:
        RECORDINGS_DB.pop(rid, None)
    return {"success": True, "message": "歌曲已删除"}


# ============ 管理员 - 唱段管理 ============

@router.put("/admin/segments/{segment_id}")
async def admin_update_segment(segment_id: str, request: Request):
    """更新唱段信息（时间、歌词、难度等）"""
    verify_admin(request)
    seg = SEGMENTS_DB.get(segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail="唱段不存在")
    body = await request.json()
    for key in ["start_time", "end_time", "lyrics", "difficulty", "is_chorus", "status"]:
        if key in body:
            seg[key] = body[key]
    return {"success": True, "data": seg}


@router.post("/admin/songs/{song_id}/segments")
async def admin_add_segment(song_id: str, request: Request):
    """新增唱段"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    body = await request.json()
    seg_id = f"{song_id}-{len(song['segments'])+1:02d}"
    # 确保 ID 唯一
    while seg_id in SEGMENTS_DB:
        seg_id = f"{song_id}-{uuid.uuid4().hex[:4]}"
    seg = {
        "id": seg_id,
        "song_id": song_id,
        "index": len(song["segments"]) + 1,
        "start_time": body.get("start_time", 0),
        "end_time": body.get("end_time", 0),
        "lyrics": body.get("lyrics", ""),
        "difficulty": body.get("difficulty", "normal"),
        "is_chorus": body.get("is_chorus", False),
        "status": "unassigned",
        "claim_count": 0,
        "submit_count": 0,
        "claims": [],
    }
    SEGMENTS_DB[seg_id] = seg
    song["segments"].append(seg)
    song["segment_count"] = len(song["segments"])
    # 按 start_time 排序并重新编号
    song["segments"].sort(key=lambda s: s["start_time"])
    for i, s in enumerate(song["segments"]):
        s["index"] = i + 1
    return {"success": True, "data": seg}


@router.delete("/admin/segments/{segment_id}")
async def admin_delete_segment(segment_id: str, request: Request):
    """删除唱段"""
    verify_admin(request)
    seg = SEGMENTS_DB.pop(segment_id, None)
    if not seg:
        raise HTTPException(status_code=404, detail="唱段不存在")
    song = SONGS_DB.get(seg["song_id"])
    if song:
        song["segments"] = [s for s in song["segments"] if s["id"] != segment_id]
        song["segment_count"] = len(song["segments"])
        for i, s in enumerate(song["segments"]):
            s["index"] = i + 1
    return {"success": True, "message": "唱段已删除"}


@router.put("/admin/songs/{song_id}/segments/batch")
async def admin_batch_update_segments(song_id: str, request: Request):
    """批量更新唱段（用于拖拽调整后保存）"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    body = await request.json()
    segments_data = body.get("segments", [])
    for seg_data in segments_data:
        seg = SEGMENTS_DB.get(seg_data.get("id"))
        if seg:
            for key in ["start_time", "end_time", "lyrics", "difficulty", "is_chorus"]:
                if key in seg_data:
                    seg[key] = seg_data[key]
    # 重新排序
    song["segments"].sort(key=lambda s: s["start_time"])
    for i, s in enumerate(song["segments"]):
        s["index"] = i + 1
    return {"success": True, "data": song["segments"]}


# ============ 管理员 - 录音管理 ============

@router.get("/admin/recordings")
async def admin_get_recordings(request: Request, song_id: Optional[str] = None):
    """获取所有录音（含未提交的）"""
    verify_admin(request)
    results = list(RECORDINGS_DB.values())
    if song_id:
        results = [r for r in results if r["song_id"] == song_id]
    return {"success": True, "data": results}


@router.post("/admin/recordings/{recording_id}/select")
async def admin_select_recording(recording_id: str, request: Request):
    """选定录音为该唱段的最终版本"""
    verify_admin(request)
    rec = RECORDINGS_DB.get(recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")
    # 取消同唱段其他录音的选定
    for r in RECORDINGS_DB.values():
        if r["segment_id"] == rec["segment_id"]:
            r["selected"] = False
    rec["selected"] = True
    return {"success": True, "data": rec}


# ============ 管理员 - 统计 ============

@router.get("/admin/stats")
async def admin_stats(request: Request):
    """获取系统统计"""
    verify_admin(request)
    total_songs = len(SONGS_DB)
    total_segments = len(SEGMENTS_DB)
    total_recordings = len(RECORDINGS_DB)
    total_users = len(USERS_DB)
    completed_segments = sum(1 for s in SEGMENTS_DB.values() if s["status"] == "completed")
    submitted_recordings = sum(1 for r in RECORDINGS_DB.values() if r["submitted"])
    return {"success": True, "data": {
        "total_songs": total_songs,
        "total_segments": total_segments,
        "total_recordings": total_recordings,
        "total_users": total_users,
        "completed_segments": completed_segments,
        "submitted_recordings": submitted_recordings,
    }}


# ============ 管理员 - 音乐文件列表 ============

@router.get("/admin/music-files")
async def admin_list_music_files(request: Request):
    """列出 music 目录中的所有音频文件"""
    verify_admin(request)
    files = []
    if os.path.exists(MUSIC_DIR):
        for f in os.listdir(MUSIC_DIR):
            if f.lower().endswith(('.mp3', '.wav', '.flac', '.ogg', '.m4a')):
                filepath = os.path.join(MUSIC_DIR, f)
                files.append({
                    "filename": f,
                    "size": os.path.getsize(filepath),
                    "url": f"/api/music/{f}",
                })
    return {"success": True, "data": files}
