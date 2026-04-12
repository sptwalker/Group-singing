from fastapi import APIRouter, UploadFile, File, HTTPException, Form, Query, Body, Request
from fastapi.responses import JSONResponse
from typing import Optional, List
import uuid
import os
import json
import hashlib
import time
import shutil
from datetime import datetime

router = APIRouter(prefix="/api", tags=["api"])

# ============ 内存数据存储 + JSON 文件持久化 ============

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
DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))
os.makedirs(DATA_DIR, exist_ok=True)

print(f"[DEBUG] MUSIC_DIR = {MUSIC_DIR}")
print(f"[DEBUG] MUSIC_DIR exists = {os.path.exists(MUSIC_DIR)}")
print(f"[DEBUG] DATA_DIR = {DATA_DIR}")
if os.path.exists(MUSIC_DIR):
    print(f"[DEBUG] Music files: {os.listdir(MUSIC_DIR)}")
os.makedirs(UPLOAD_DIR, exist_ok=True)

_DB_FILE = os.path.join(DATA_DIR, "db.json")

def _save_db():
    """将所有内存数据持久化到 JSON 文件"""
    data = {
        "songs": SONGS_DB,
        "segments": SEGMENTS_DB,
        "claims": CLAIMS_DB,
        "recordings": RECORDINGS_DB,
        "users": USERS_DB,
    }
    tmp = _DB_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        if os.path.exists(_DB_FILE):
            os.replace(tmp, _DB_FILE)
        else:
            os.rename(tmp, _DB_FILE)
        print(f"[persist] saved {len(SONGS_DB)} songs, {len(SEGMENTS_DB)} segments, {len(RECORDINGS_DB)} recordings")
    except Exception as e:
        print(f"[persist] save failed: {e}")

def _load_db() -> bool:
    """从 JSON 文件恢复数据，成功返回 True"""
    global SONGS_DB, SEGMENTS_DB, CLAIMS_DB, RECORDINGS_DB, USERS_DB
    if not os.path.exists(_DB_FILE):
        return False
    try:
        with open(_DB_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        SONGS_DB.update(data.get("songs", {}))
        SEGMENTS_DB.update(data.get("segments", {}))
        CLAIMS_DB.update(data.get("claims", {}))
        RECORDINGS_DB.update(data.get("recordings", {}))
        USERS_DB.update(data.get("users", {}))
        # 修复引用：让 SONGS_DB 中的 segment 指向 SEGMENTS_DB 的同一对象
        for song in SONGS_DB.values():
            for i, seg in enumerate(song.get("segments", [])):
                if seg["id"] in SEGMENTS_DB:
                    song["segments"][i] = SEGMENTS_DB[seg["id"]]
        print(f"[persist] loaded {len(SONGS_DB)} songs, {len(SEGMENTS_DB)} segments, {len(RECORDINGS_DB)} recordings from {_DB_FILE}")
        return bool(SONGS_DB)
    except Exception as e:
        print(f"[persist] load failed: {e}")
        return False


def _get_audio_duration(filepath: str) -> float:
    """用 mutagen 获取音频文件时长（秒）"""
    try:
        import mutagen
        audio = mutagen.File(filepath)
        if audio and audio.info:
            return round(audio.info.length, 2)
    except Exception as e:
        print(f"[audio] mutagen failed for {filepath}: {e}")
    return 0.0


def _whisper_transcribe(filepath: str) -> list:
    """用 Whisper 识别音频歌词，返回带时间戳的片段列表
    返回: [{"start": float, "end": float, "text": str}, ...] 或 None（失败）
    """
    try:
        import whisper
        print(f"[whisper] loading model for: {filepath}")
        model = whisper.load_model("base")
        result = model.transcribe(filepath, language=None, verbose=False)
        segments = result.get("segments", [])
        if not segments:
            print("[whisper] no segments detected")
            return None
        lang = result.get("language", "unknown")
        print(f"[whisper] detected language: {lang}, {len(segments)} segments")
        # 过滤掉纯空白或过短片段，合并过短的相邻片段
        cleaned = []
        for seg in segments:
            text = seg.get("text", "").strip()
            if not text:
                continue
            start = round(seg["start"], 2)
            end = round(seg["end"], 2)
            if end - start < 0.5:
                continue
            # 如果与上一段间隔很小且上一段很短，合并
            if cleaned and (start - cleaned[-1]["end"]) < 0.3 and (cleaned[-1]["end"] - cleaned[-1]["start"]) < 3.0:
                cleaned[-1]["end"] = end
                cleaned[-1]["text"] = cleaned[-1]["text"] + " " + text
            else:
                cleaned.append({"start": start, "end": end, "text": text})
        if not cleaned:
            return None
        print(f"[whisper] cleaned to {len(cleaned)} segments")
        return cleaned
    except Exception as e:
        print(f"[whisper] transcription failed: {e}")
        import traceback
        traceback.print_exc()
        return None


def _normalize_lyrics(text: str) -> str:
    """将歌词归一化用于相似度比较：去标点、转小写、去多余空白"""
    import re
    t = text.lower().strip()
    t = re.sub(r'[^\w\s\u4e00-\u9fff]', '', t)  # 保留中英文字符和空白
    t = re.sub(r'\s+', ' ', t).strip()
    return t


def _detect_chorus_segments(whisper_segments: list) -> set:
    """检测副歌（合唱）段落索引。
    策略：歌词出现2次及以上的片段视为副歌。
    用归一化歌词做模糊匹配，相似度>0.6即认为是同一句。
    """
    from difflib import SequenceMatcher
    n = len(whisper_segments)
    normalized = [_normalize_lyrics(ws["text"]) for ws in whisper_segments]

    # 构建相似度矩阵，找出重复出现的歌词
    repeat_count = [0] * n
    for i in range(n):
        for j in range(i + 1, n):
            if not normalized[i] or not normalized[j]:
                continue
            # 短文本用精确比较，长文本用模糊匹配
            if len(normalized[i]) < 4 or len(normalized[j]) < 4:
                sim = 1.0 if normalized[i] == normalized[j] else 0.0
            else:
                sim = SequenceMatcher(None, normalized[i], normalized[j]).ratio()
            if sim > 0.6:
                repeat_count[i] += 1
                repeat_count[j] += 1

    # 重复出现的歌词段标记为副歌
    chorus_indices = set()
    for i, cnt in enumerate(repeat_count):
        if cnt >= 1:  # 至少有1个相似段 = 至少出现2次
            chorus_indices.add(i)

    # 扩展：如果连续段中大部分是副歌，把夹在中间的也标为副歌（副歌通常是连续的）
    if chorus_indices and n > 3:
        expanded = set(chorus_indices)
        for i in range(1, n - 1):
            if i not in expanded and (i - 1) in expanded and (i + 1) in expanded:
                expanded.add(i)
        chorus_indices = expanded

    return chorus_indices


def _estimate_difficulty(text: str, start: float, end: float, is_chorus: bool) -> str:
    """估算唱段难度。
    规则：
    - 歌词密度（字数/秒）高 → 更难（唱得快）
    - 唱段时长短且密度高 → 更难
    - 副歌段通常需要更大声量和情感 → 基础难度+1
    返回: 'easy' / 'normal' / 'hard'
    """
    dur = max(end - start, 0.5)
    # 计算有效字符数（中文每字算1，英文每词算1）
    import re
    chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
    english_words = len(re.findall(r'[a-zA-Z]+', text))
    char_count = chinese_chars + english_words

    density = char_count / dur  # 字/秒

    # 基础难度评分 0-10
    score = 0
    if density > 4.0:
        score += 4
    elif density > 2.5:
        score += 2
    elif density > 1.5:
        score += 1

    if dur < 3.0 and density > 2.0:
        score += 2
    elif dur > 8.0:
        score += 1  # 长段需要气息控制

    if is_chorus:
        score += 2  # 副歌通常更有表现力要求

    if char_count > 20:
        score += 1  # 歌词多需要记忆

    if score >= 5:
        return "hard"
    elif score >= 2:
        return "normal"
    else:
        return "easy"


def _ai_split_segments(song_id: str, filepath: str, duration: float) -> tuple:
    """AI 歌词识别切分 + 自动标注合唱和难度
    返回 (segments_list, ai_split_success)
    成功: 返回按歌词切分的唱段列表（含合唱/难度标注）, True
    失败: 返回空列表, False
    """
    whisper_result = _whisper_transcribe(filepath)
    if not whisper_result:
        print(f"[ai_split] whisper failed for song {song_id}, returning empty")
        return [], False

    # 第一步：检测副歌段落
    chorus_indices = _detect_chorus_segments(whisper_result)
    chorus_count = len(chorus_indices)
    print(f"[ai_split] detected {chorus_count} chorus segments out of {len(whisper_result)}")

    # 第二步：构建唱段，自动标注难度和合唱
    segments = []
    for i, ws in enumerate(whisper_result):
        seg_id = f"{song_id}-{i+1:02d}"
        while seg_id in SEGMENTS_DB:
            seg_id = f"{song_id}-{uuid.uuid4().hex[:4]}"
        lyrics = ws["text"].strip()
        is_chorus = i in chorus_indices
        end_time = min(ws["end"], duration)
        difficulty = _estimate_difficulty(lyrics, ws["start"], end_time, is_chorus)

        seg = {
            "id": seg_id,
            "song_id": song_id,
            "index": i + 1,
            "start_time": ws["start"],
            "end_time": end_time,
            "lyrics": lyrics,
            "difficulty": difficulty,
            "is_chorus": is_chorus,
            "status": "unassigned",
            "claim_count": 0,
            "submit_count": 0,
            "claims": [],
        }
        SEGMENTS_DB[seg_id] = seg
        segments.append(seg)

    diff_stats = {}
    for s in segments:
        diff_stats[s["difficulty"]] = diff_stats.get(s["difficulty"], 0) + 1
    print(f"[ai_split] song {song_id}: {len(segments)} segments, chorus={chorus_count}, difficulty={diff_stats}")
    return segments, True


# ============ 初始化数据：从文件加载 ============
if not _load_db():
    print("[persist] no saved data found, starting with empty database")
else:
    print("[persist] data restored from disk")

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
    _save_db()
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

    _save_db()
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

    _save_db()
    return {"success": True, "data": seg}


# ============ 录音接口 ============

@router.post("/recordings/upload")
async def upload_recording(
    segment_id: str = Form(...),
    song_id: str = Form(...),
    user_id: str = Form(...),
    user_name: str = Form(...),
    score: float = Form(0.0),
    score_detail: str = Form(""),
    audio: UploadFile = File(...),
):
    """上传录音"""
    rec_id = str(uuid.uuid4())[:8]
    filename = f"{rec_id}.webm"
    filepath = os.path.join(UPLOAD_DIR, filename)

    content = await audio.read()
    with open(filepath, "wb") as f:
        f.write(content)

    # 解析多维度评分
    parsed_detail = None
    if score_detail:
        try:
            parsed_detail = json.loads(score_detail)
        except Exception:
            pass

    recording = {
        "id": rec_id,
        "segment_id": segment_id,
        "song_id": song_id,
        "user_id": user_id,
        "user_name": user_name,
        "audio_url": f"/api/uploads/{filename}",
        "score": score,
        "score_detail": parsed_detail,
        "likes": 0,
        "submitted": False,
        "selected": False,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    RECORDINGS_DB[rec_id] = recording
    _save_db()
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

        song = SONGS_DB.get(seg["song_id"])
        if song:
            # 同步更新 SONGS_DB 中的 segment 副本（JSON 反序列化后引用不同）
            for s in song["segments"]:
                if s["id"] == seg["id"]:
                    s["submit_count"] = submitted_count
                    break
            completed = sum(1 for s in song["segments"] if s["status"] == "completed")
            song["completion"] = round(completed / len(song["segments"]) * 100, 1)

    _save_db()
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

    _save_db()
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
    _save_db()
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
    _save_db()
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
    """提供上传文件（音频/录音）"""
    filepath = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="文件不存在")
    ext = os.path.splitext(filename)[1].lower()
    mime_map = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
        '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
        '.wma': 'audio/x-ms-wma', '.webm': 'audio/webm',
    }
    return FileResponse(filepath, media_type=mime_map.get(ext, 'application/octet-stream'))


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

ALLOWED_AUDIO_EXT = {'.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma'}

@router.post("/admin/songs/upload")
async def admin_upload_song(
    request: Request,
    title: str = Form(...),
    artist: str = Form(""),
    audio: UploadFile = File(...),
):
    """上传新歌曲：保存音频文件 → 读取时长 → 自动切分唱段"""
    verify_admin(request)

    # 检查文件类型
    _, ext = os.path.splitext(audio.filename or "")
    ext = ext.lower()
    if ext not in ALLOWED_AUDIO_EXT:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式: {ext}，支持: {', '.join(ALLOWED_AUDIO_EXT)}")

    song_id = str(uuid.uuid4())[:8]
    safe_filename = f"{song_id}{ext}"
    filepath = os.path.join(UPLOAD_DIR, safe_filename)

    # 保存文件
    content = await audio.read()
    with open(filepath, "wb") as f:
        f.write(content)

    # 获取音频时长
    duration = _get_audio_duration(filepath)
    if duration <= 0:
        os.remove(filepath)
        raise HTTPException(status_code=400, detail="无法读取音频时长，请检查文件是否损坏")

    audio_url = f"/api/uploads/{safe_filename}"

    # AI 歌词识别切分
    segments, ai_split = _ai_split_segments(song_id, filepath, duration)

    song = {
        "id": song_id,
        "title": title.strip() or os.path.splitext(audio.filename or "未命名")[0],
        "artist": artist.strip(),
        "duration": duration,
        "audio_url": audio_url,
        "audio_file": safe_filename,
        "original_filename": audio.filename,
        "segment_count": len(segments),
        "participant_count": 0,
        "completion": 0.0,
        "segments": segments,
        "ai_split": ai_split,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    SONGS_DB[song_id] = song
    _save_db()

    print(f"[upload] new song: {title} ({artist}), duration={duration}s, {len(segments)} segments, ai_split={ai_split}")
    return {"success": True, "data": song}


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
    _save_db()
    return {"success": True, "data": song}


@router.delete("/admin/songs/{song_id}")
async def admin_delete_song(song_id: str, request: Request):
    """删除歌曲及其所有关联数据和文件"""
    verify_admin(request)
    song = SONGS_DB.pop(song_id, None)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    # 清理唱段
    seg_ids = [seg["id"] for seg in song["segments"]]
    for sid in seg_ids:
        SEGMENTS_DB.pop(sid, None)
    # 清理录音数据和文件
    to_del = [rid for rid, r in RECORDINGS_DB.items() if r["song_id"] == song_id]
    for rid in to_del:
        rec = RECORDINGS_DB.pop(rid, None)
        if rec:
            rec_file = os.path.join(UPLOAD_DIR, os.path.basename(rec.get("audio_url", "")))
            if os.path.exists(rec_file):
                try: os.remove(rec_file)
                except: pass
    # 清理认领数据
    claim_ids = [cid for cid, c in CLAIMS_DB.items() if c.get("segment_id") in seg_ids]
    for cid in claim_ids:
        CLAIMS_DB.pop(cid, None)
    # 删除歌曲音频文件
    audio_file = song.get("audio_file")
    if audio_file:
        audio_path = os.path.join(UPLOAD_DIR, audio_file)
        if os.path.exists(audio_path):
            try: os.remove(audio_path)
            except: pass
    _save_db()
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
    _save_db()
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
    _save_db()
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
    _save_db()
    return {"success": True, "message": "唱段已删除"}


@router.put("/admin/songs/{song_id}/segments/batch")
async def admin_batch_update_segments(song_id: str, request: Request):
    """批量替换唱段（前端方案原样写入）"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    body = await request.json()
    segments_data = body.get("segments", [])
    confirm_delete = body.get("confirm_delete", False)

    old_seg_ids = {s["id"] for s in song["segments"]}
    new_seg_ids = {s.get("id") for s in segments_data if s.get("id")}

    # 找出将失效的 segment ID（旧ID中不在新数据里的）
    removed_seg_ids = old_seg_ids - new_seg_ids

    # 统计这些失效段关联的已提交录音
    orphan_recs = [
        r for r in RECORDINGS_DB.values()
        if r.get("song_id") == song_id and r.get("submitted")
        and r["segment_id"] in removed_seg_ids
    ]

    # 如果有失效录音且前端未确认，返回预检信息
    if orphan_recs and not confirm_delete:
        # 按段分组统计详情
        detail = {}
        for r in orphan_recs:
            seg_id = r["segment_id"]
            if seg_id not in detail:
                old_seg = next((s for s in song["segments"] if s["id"] == seg_id), None)
                detail[seg_id] = {
                    "lyrics": old_seg["lyrics"] if old_seg else "",
                    "index": old_seg["index"] if old_seg else 0,
                    "count": 0,
                }
            detail[seg_id]["count"] += 1
        return {
            "success": False,
            "need_confirm": True,
            "orphan_count": len(orphan_recs),
            "detail": list(detail.values()),
        }

    # 确认后：删除失效录音及其音频文件
    if orphan_recs:
        for r in orphan_recs:
            rec_file = os.path.join(UPLOAD_DIR, os.path.basename(r.get("audio_url", "")))
            if os.path.exists(rec_file):
                try:
                    os.remove(rec_file)
                except Exception:
                    pass
            RECORDINGS_DB.pop(r["id"], None)
        # 同时清理该歌曲所有未提交的失效录音
        draft_orphans = [
            rid for rid, r in RECORDINGS_DB.items()
            if r.get("song_id") == song_id and not r.get("submitted")
            and r["segment_id"] in removed_seg_ids
        ]
        for rid in draft_orphans:
            r = RECORDINGS_DB.pop(rid, None)
            if r:
                rec_file = os.path.join(UPLOAD_DIR, os.path.basename(r.get("audio_url", "")))
                if os.path.exists(rec_file):
                    try:
                        os.remove(rec_file)
                    except Exception:
                        pass

    # 清除该歌曲所有旧段
    for old_seg in song["segments"]:
        SEGMENTS_DB.pop(old_seg["id"], None)

    # 用前端数据原样重建
    new_segments = []
    for i, seg_data in enumerate(segments_data):
        new_id = f"{song_id}-{uuid.uuid4().hex[:6]}"
        while new_id in SEGMENTS_DB:
            new_id = f"{song_id}-{uuid.uuid4().hex[:6]}"
        seg = {
            "id": new_id,
            "song_id": song_id,
            "index": i + 1,
            "start_time": seg_data.get("start_time", 0),
            "end_time": seg_data.get("end_time", 0),
            "lyrics": seg_data.get("lyrics", ""),
            "difficulty": seg_data.get("difficulty", "normal"),
            "is_chorus": seg_data.get("is_chorus", False),
            "status": seg_data.get("status", "unassigned"),
            "claim_count": 0,
            "submit_count": 0,
            "claims": [],
        }
        SEGMENTS_DB[new_id] = seg
        new_segments.append(seg)

    song["segments"] = new_segments
    song["segment_count"] = len(new_segments)
    _save_db()
    return {"success": True, "data": new_segments, "deleted_recordings": len(orphan_recs)}


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
    _save_db()
    return {"success": True, "data": rec}


@router.post("/admin/recordings/{recording_id}/unselect")
async def admin_unselect_recording(recording_id: str, request: Request):
    """取消选定录音"""
    verify_admin(request)
    rec = RECORDINGS_DB.get(recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")
    rec["selected"] = False
    _save_db()
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
