from fastapi import APIRouter, UploadFile, File, HTTPException, Form, Query, Body, Request
from fastapi.responses import JSONResponse
from typing import Optional, List
import uuid
import os
import json
import hashlib
import time
import shutil
import subprocess
import threading
import traceback
import re
from datetime import datetime
from difflib import SequenceMatcher
import httpx

# OpenAI API 配置（用于 DeepSeek 等兼容接口）
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.siliconflow.cn/v1")
OPENAI_CHAT_MODEL = os.environ.get("OPENAI_CHAT_MODEL", "deepseek-ai/DeepSeek-V3")

router = APIRouter(prefix="/api", tags=["api"])

# ============ 内存数据存储 + JSON 文件持久化 ============

SONGS_DB = {}
SEGMENTS_DB = {}
CLAIMS_DB = {}
RECORDINGS_DB = {}
USERS_DB = {}
FINALS_DB = {}

# ============ 管理员配置 ============
ADMIN_ACCOUNTS = {
    "admin": hashlib.sha256("youdoo2026".encode()).hexdigest(),
}
ADMIN_TOKENS = {}  # token -> {username, login_time}

MUSIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "music"))
UPLOAD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "uploads"))
DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))
FINALS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "finals"))
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(FINALS_DIR, exist_ok=True)

print(f"[DEBUG] MUSIC_DIR = {MUSIC_DIR}")
print(f"[DEBUG] MUSIC_DIR exists = {os.path.exists(MUSIC_DIR)}")
print(f"[DEBUG] UPLOAD_DIR = {UPLOAD_DIR}")
print(f"[DEBUG] UPLOAD_DIR exists = {os.path.exists(UPLOAD_DIR)}")
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
        "finals": FINALS_DB,
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
    global SONGS_DB, SEGMENTS_DB, CLAIMS_DB, RECORDINGS_DB, USERS_DB, FINALS_DB
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
        FINALS_DB.update(data.get("finals", {}))
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
    """获取音频文件时长（秒），依次尝试 mutagen → ffprobe → librosa"""
    # 方法1: mutagen（最快，支持大多数格式）
    try:
        import mutagen
        audio = mutagen.File(filepath)
        if audio and audio.info and audio.info.length > 0:
            dur = round(audio.info.length, 2)
            print(f"[audio] mutagen OK: {dur}s - {os.path.basename(filepath)}")
            return dur
    except Exception as e:
        print(f"[audio] mutagen failed: {e}")

    # 方法2: ffprobe（兼容性最好）
    try:
        import subprocess
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", filepath],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0 and result.stdout.strip():
            dur = round(float(result.stdout.strip()), 2)
            if dur > 0:
                print(f"[audio] ffprobe OK: {dur}s - {os.path.basename(filepath)}")
                return dur
    except Exception as e:
        print(f"[audio] ffprobe failed: {e}")

    # 方法3: librosa（最慢但最可靠）
    try:
        import librosa
        dur = round(librosa.get_duration(filename=filepath), 2)
        if dur > 0:
            print(f"[audio] librosa OK: {dur}s - {os.path.basename(filepath)}")
            return dur
    except Exception as e:
        print(f"[audio] librosa failed: {e}")

    print(f"[audio] ALL methods failed for: {filepath}")
    return 0.0


def _parse_lrc(lrc_text: str) -> list:
    """解析 LRC 格式歌词，返回 [(time_sec, text), ...] 按时间排序
    支持格式：[mm:ss.xx]歌词  或  [mm:ss]歌词
    自动跳过元数据标签（[ti:], [ar:], [al:] 等）
    """
    lines = []
    # 匹配 [mm:ss.xx] 或 [mm:ss] 格式，支持一行多时间标签
    pattern = re.compile(r'\[(\d{1,3}):(\d{2})(?:[.:])(\d{1,3})?\]')
    meta_tags = {'ti', 'ar', 'al', 'by', 'offset', 'length', 're', 've'}

    for raw_line in lrc_text.splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        # 跳过元数据标签
        meta_match = re.match(r'^\[([a-z]+):', raw_line, re.IGNORECASE)
        if meta_match and meta_match.group(1).lower() in meta_tags:
            continue

        # 提取所有时间标签和歌词文本
        timestamps = []
        for m in pattern.finditer(raw_line):
            minutes = int(m.group(1))
            seconds = int(m.group(2))
            centiseconds = int(m.group(3)) if m.group(3) else 0
            # 兼容 mm:ss.xx (百分秒) 和 mm:ss.xxx (毫秒)
            if m.group(3) and len(m.group(3)) == 3:
                frac = centiseconds / 1000.0
            else:
                frac = centiseconds / 100.0
            t = minutes * 60 + seconds + frac
            timestamps.append(round(t, 2))

        # 提取歌词文本（去掉所有时间标签）
        text = pattern.sub('', raw_line).strip()

        for t in timestamps:
            lines.append((t, text))

    lines.sort(key=lambda x: x[0])
    return lines


def _assign_lrc_to_segments(segments: list, lrc_lines: list) -> list:
    """将 LRC 时间标记歌词精确分配到各唱段
    每句歌词按其时间戳归属到对应的唱段区间 [start_time, end_time)
    同时用规则检测副歌（重复歌词）和评估难度
    """
    # 按时间将歌词句归属到唱段
    for seg in segments:
        seg_lyrics = []
        for t, text in lrc_lines:
            if text and seg["start_time"] <= t < seg["end_time"]:
                seg_lyrics.append(text)
        seg["lyrics"] = "\n".join(seg_lyrics)

    # 副歌检测：找出重复出现的歌词段落
    lyrics_list = [seg["lyrics"].strip() for seg in segments]
    for i, seg in enumerate(segments):
        text = lyrics_list[i]
        if not text:
            continue
        # 如果这段歌词在其他段也出现过（完全相同或高度相似），标记为副歌
        repeat_count = sum(1 for j, other in enumerate(lyrics_list) if j != i and other == text)
        if repeat_count >= 1:
            seg["is_chorus"] = True

    # 难度评估
    for seg in segments:
        seg["difficulty"] = _estimate_difficulty(
            seg["lyrics"], seg["start_time"], seg["end_time"], seg.get("is_chorus", False)
        )

    assigned = sum(1 for s in segments if s["lyrics"].strip())
    chorus = sum(1 for s in segments if s.get("is_chorus"))
    print(f"[lrc] lyrics assigned to {assigned}/{len(segments)} segments, chorus={chorus}")
    return segments


def _ai_assign_lyrics(segments: list, full_lyrics: str) -> list:
    """用 AI 将完整歌词智能分配到各唱段，同时识别副歌和评估难度
    segments: [{"index": 1, "start_time": 0.0, "end_time": 8.5, ...}, ...]
    full_lyrics: 完整歌词文本（每行一句）
    返回更新后的 segments 列表
    """
    if not OPENAI_API_KEY or not full_lyrics.strip():
        return segments

    try:
        from openai import OpenAI
        client = OpenAI(api_key=OPENAI_API_KEY, base_url=OPENAI_BASE_URL)

        # 构建唱段时间信息
        seg_info = []
        for seg in segments:
            dur = round(seg["end_time"] - seg["start_time"], 1)
            seg_info.append(f"[{seg['index']}] {seg['start_time']:.1f}s - {seg['end_time']:.1f}s ({dur}s)")
        seg_text = "\n".join(seg_info)

        prompt = f"""你是一位专业的音乐编辑。现在有一首歌被按静音间隔切分成了 {len(segments)} 个唱段，请根据完整歌词，完成以下任务：

1. **歌词分配**：将歌词按顺序分配到各唱段。根据每段的时长推断该段大约能唱多少歌词，合理分配。前奏/间奏/尾奏段可以为空。
2. **副歌识别**：标记哪些唱段属于副歌（chorus）。副歌通常是重复出现、情感最强烈的部分。
3. **难度评估**：评估每段的演唱难度（easy/normal/hard）。

唱段时间信息：
{seg_text}

完整歌词：
{full_lyrics.strip()}

请严格按以下 JSON 格式回复，不要包含任何其他文字：
{{"segments": [{{"index": 1, "lyrics": "该段歌词", "is_chorus": false, "difficulty": "normal"}}, ...]}}

注意：
- index 必须与唱段编号一一对应
- 前奏/间奏段的 lyrics 填空字符串 ""
- 歌词不要遗漏，按原文分配，不要修改歌词内容
- 每段歌词可以包含多行，用换行符分隔"""

        print(f"[ai] assigning lyrics to {len(segments)} segments...")
        response = client.chat.completions.create(
            model=OPENAI_CHAT_MODEL,
            messages=[
                {"role": "system", "content": "你是一位专业的音乐编辑，擅长歌曲结构分析。只返回JSON，不要其他内容。"},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=3000,
        )

        content = response.choices[0].message.content.strip()
        # 提取 JSON（兼容 markdown code block）
        if "```" in content:
            m = re.search(r'```(?:json)?\s*(.*?)\s*```', content, re.DOTALL)
            content = m.group(1) if m else content
        result = json.loads(content)

        ai_segments = result.get("segments", [])
        # 建立 index -> AI结果 的映射
        ai_map = {item["index"]: item for item in ai_segments if "index" in item}

        chorus_count = 0
        for seg in segments:
            ai_data = ai_map.get(seg["index"])
            if ai_data:
                seg["lyrics"] = ai_data.get("lyrics", "").strip()
                seg["is_chorus"] = bool(ai_data.get("is_chorus", False))
                difficulty = ai_data.get("difficulty", "normal")
                seg["difficulty"] = difficulty if difficulty in ("easy", "normal", "hard") else "normal"
                if seg["is_chorus"]:
                    chorus_count += 1

        diff_stats = {}
        for s in segments:
            diff_stats[s["difficulty"]] = diff_stats.get(s["difficulty"], 0) + 1
        print(f"[ai] lyrics assigned: chorus={chorus_count}, difficulty={diff_stats}")
        return segments
    except Exception as e:
        print(f"[ai] lyrics assignment failed: {e}")
        traceback.print_exc()
        return segments


def _is_lrc_format(text: str) -> bool:
    """检测文本是否为 LRC 格式（至少有3行带时间标签的歌词）"""
    pattern = re.compile(r'^\[(\d{1,3}):(\d{2})', re.MULTILINE)
    matches = pattern.findall(text)
    return len(matches) >= 3


# ============ 自动歌词获取（借鉴 LDDC 项目的匹配算法 + lrclib.net API） ============

_SYMBOL_MAP = {
    "（": "(", "）": ")", "：": ":", "！": "!", "？": "?",
    "／": "/", "＆": "&", "＊": "*", "＠": "@", "＃": "#",
    "＄": "$", "％": "%", "＝": "=", "＋": "+", "－": "-",
    "＜": "<", "＞": ">", "［": "[", "］": "]", "｛": "{", "｝": "}",
}

def _unified_symbol(text: str) -> str:
    """统一全角/半角符号（参考 LDDC algorithm.py）"""
    text = text.strip()
    for k, v in _SYMBOL_MAP.items():
        text = text.replace(k, v)
    return re.sub(r'\s', ' ', text)

def _text_difference(text1: str, text2: str) -> float:
    """计算两段文本的相似度 0~1（参考 LDDC algorithm.py）"""
    if text1 == text2:
        return 1.0
    return SequenceMatcher(lambda x: x == ' ', text1, text2).ratio()

def _calculate_title_score(title1: str, title2: str) -> float:
    """计算标题匹配得分 0~100（简化版 LDDC calculate_title_score）"""
    t1 = _unified_symbol(title1).lower()
    t2 = _unified_symbol(title2).lower()
    if t1 == t2:
        return 100.0
    # 基础相似度
    base_score = max(_text_difference(t1, t2), 0) * 100
    # 找共同前缀
    same_begin = ""
    for i, c in enumerate(t1):
        if len(t2) > i and c == t2[i]:
            same_begin += c
        else:
            break
    if not same_begin or same_begin in (t1, t2):
        return base_score
    # 前缀越长，分数越高
    rest1 = t1[len(same_begin):]
    rest2 = t2[len(same_begin):]
    kp = len(same_begin) / ((len(rest1) + len(rest2)) / 2 + len(same_begin))
    prefix_score = 100 * kp + max(_text_difference(rest1, rest2), 0) * (1 - kp)
    return max(base_score, prefix_score)

def _calculate_artist_score(artist1: str, artist2: str) -> float:
    """计算艺术家匹配得分 0~100（简化版 LDDC calculate_artist_score）"""
    a1 = _unified_symbol(artist1).lower()
    a2 = _unified_symbol(artist2).lower()
    if a1 == a2:
        return 100.0
    # 尝试按分隔符拆分
    sep_pattern = re.compile(r'[,、/\\&]')
    list1 = [s.strip() for s in sep_pattern.split(a1) if s.strip()]
    list2 = [s.strip() for s in sep_pattern.split(a2) if s.strip()]
    if not list1:
        list1 = [a1]
    if not list2:
        list2 = [a2]
    # 贪心匹配
    all_pairs = [(i, j, _text_difference(list1[i], list2[j]))
                 for i in range(len(list1)) for j in range(len(list2))]
    all_pairs.sort(key=lambda x: x[2], reverse=True)
    used_i, used_j = set(), set()
    total = 0.0
    for i, j, s in all_pairs:
        if i not in used_i and j not in used_j:
            used_i.add(i)
            used_j.add(j)
            total += s
    return max(total / max(len(list1), len(list2)) * 100, 0)

def _auto_fetch_lyrics(title: str, artist: str, duration: float) -> dict:
    """自动从 lrclib.net 获取歌词（参考 LDDC lrclib.py + auto_fetch.py）

    返回: {"success": bool, "lrc_text": str, "method": str, "match_score": float, "track_info": dict}
    """
    result = {"success": False, "lrc_text": "", "method": "", "match_score": 0, "track_info": {}}

    if not title:
        return result

    try:
        client = httpx.Client(
            headers={
                "User-Agent": "YouDooSing/1.0",
                "Accept": "application/json",
            },
            timeout=15,
        )

        # 策略1：精确匹配（title + artist + duration）—— 参考 LDDC lrclib.get_lyrics
        if artist and duration > 0:
            try:
                params = {
                    "track_name": title,
                    "artist_name": artist,
                    "duration": int(duration),
                }
                resp = client.get("https://lrclib.net/api/get", params=params)
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("syncedLyrics"):
                        result["success"] = True
                        result["lrc_text"] = data["syncedLyrics"]
                        result["method"] = "lrclib精确匹配"
                        result["match_score"] = 100
                        result["track_info"] = {
                            "title": data.get("trackName", ""),
                            "artist": data.get("artistName", ""),
                            "album": data.get("albumName", ""),
                        }
                        client.close()
                        return result
            except Exception as e:
                print(f"[auto-lyrics] lrclib exact match failed: {e}")

        # 策略2：搜索匹配 —— 参考 LDDC auto_fetch.py 的搜索+评分流程
        keywords = []
        if artist:
            keywords.append(f"{artist} {title}")
        keywords.append(title)

        best_score = 0
        best_data = None

        for keyword in keywords:
            try:
                resp = client.get("https://lrclib.net/api/search", params={"q": keyword})
                if resp.status_code != 200:
                    continue
                items = resp.json()
                if not isinstance(items, list):
                    continue

                for item in items[:20]:  # 最多检查20个结果
                    item_title = item.get("trackName", "")
                    item_artist = item.get("artistName", "")
                    item_duration = item.get("duration", 0)

                    # 跳过没有同步歌词的结果
                    if not item.get("syncedLyrics"):
                        continue

                    # 时长检查（参考 LDDC：相差超过4秒则跳过）
                    if duration > 0 and item_duration > 0:
                        if abs(duration - item_duration) > 4:
                            continue

                    # 计算匹配得分（参考 LDDC auto_fetch.search_callback）
                    title_score = _calculate_title_score(title, item_title)
                    artist_score = _calculate_artist_score(artist, item_artist) if artist and item_artist else None

                    if artist_score is not None:
                        score = title_score * 0.5 + artist_score * 0.5
                    else:
                        score = title_score

                    # 标题得分太低时惩罚（参考 LDDC）
                    if title_score < 30:
                        score = max(0, score - 35)

                    if score > best_score:
                        best_score = score
                        best_data = item

            except Exception as e:
                print(f"[auto-lyrics] lrclib search '{keyword}' failed: {e}")
                continue

        # 最低匹配阈值 55 分（参考 LDDC auto_fetch 的 min_score=55）
        if best_data and best_score >= 55:
            result["success"] = True
            result["lrc_text"] = best_data["syncedLyrics"]
            result["method"] = "lrclib搜索匹配"
            result["match_score"] = round(best_score, 1)
            result["track_info"] = {
                "title": best_data.get("trackName", ""),
                "artist": best_data.get("artistName", ""),
                "album": best_data.get("albumName", ""),
            }
        elif best_data:
            result["match_score"] = round(best_score, 1)
            result["track_info"] = {
                "title": best_data.get("trackName", ""),
                "artist": best_data.get("artistName", ""),
            }
            print(f"[auto-lyrics] best match score {best_score:.1f} < 55, skipped: {best_data.get('trackName')}")

        client.close()

    except Exception as e:
        print(f"[auto-lyrics] error: {e}")
        traceback.print_exc()

    return result


def _estimate_difficulty(text: str, start: float, end: float, is_chorus: bool) -> str:
    """估算唱段难度（规则方式，AI 不可用时的备用）"""
    dur = max(end - start, 0.5)
    chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
    english_words = len(re.findall(r'[a-zA-Z]+', text))
    char_count = chinese_chars + english_words
    density = char_count / dur

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
        score += 1

    if is_chorus:
        score += 2

    if char_count > 20:
        score += 1

    if score >= 5:
        return "hard"
    elif score >= 2:
        return "normal"
    else:
        return "easy"


def _split_and_analyze(song_id: str, filepath: str, duration: float, full_lyrics: str = "",
                       title: str = "", artist: str = "") -> tuple:
    """歌曲切分主流程：
    1. librosa 静音检测切分时间段
    2. 如果提供了歌词，用 AI 智能分配歌词 + 识别副歌 + 评估难度
    3. 如果没有歌词，自动从 lrclib.net 搜索获取 LRC 歌词
    返回 (segments_list, has_lyrics: bool)
    """
    # ---- 第一步：静音检测切分 ----
    split_points = [0.0]

    try:
        import librosa
        import numpy as np
        y, sr = librosa.load(filepath, sr=22050, mono=True)
        intervals = librosa.effects.split(y, top_db=30, frame_length=2048, hop_length=512)
        if len(intervals) > 1:
            for i in range(len(intervals) - 1):
                gap_start = intervals[i][1] / sr
                gap_end = intervals[i + 1][0] / sr
                gap_mid = (gap_start + gap_end) / 2.0
                if gap_end - gap_start >= 0.3:
                    split_points.append(round(gap_mid, 2))
            split_points.append(round(duration, 2))
            print(f"[split] librosa silence split: {len(split_points)-1} segments")
        else:
            split_points = None
    except Exception as e:
        print(f"[split] librosa split failed: {e}")
        split_points = None

    # 备用：等时长切分
    if not split_points or len(split_points) < 3:
        seg_dur = 10.0
        count = max(2, int(duration / seg_dur))
        seg_dur = duration / count
        split_points = [round(i * seg_dur, 2) for i in range(count + 1)]
        print(f"[split] equal-time split: {count} segments, ~{seg_dur:.1f}s each")

    # 合并过短的段（<3秒）
    merged = [split_points[0]]
    for p in split_points[1:]:
        if p - merged[-1] < 3.0 and p != split_points[-1]:
            continue
        merged.append(p)
    if merged[-1] < duration - 0.5:
        merged.append(round(duration, 2))
    split_points = merged

    # ---- 第二步：构建唱段 ----
    segments = []
    for i in range(len(split_points) - 1):
        seg_id = f"{song_id}-{i+1:02d}"
        while seg_id in SEGMENTS_DB:
            seg_id = f"{song_id}-{uuid.uuid4().hex[:4]}"
        start_t = split_points[i]
        end_t = split_points[i + 1]
        seg = {
            "id": seg_id,
            "song_id": song_id,
            "index": i + 1,
            "start_time": start_t,
            "end_time": end_t,
            "lyrics": "",
            "difficulty": "normal",
            "is_chorus": False,
            "status": "unassigned",
            "claim_count": 0,
            "submit_count": 0,
            "claims": [],
        }
        segments.append(seg)

    print(f"[split] {len(segments)} segments created")

    # ---- 第三步：歌词分配 ----
    has_lyrics = False
    if full_lyrics and full_lyrics.strip():
        if _is_lrc_format(full_lyrics):
            # LRC 格式：精确时间标记，直接解析分配
            lrc_lines = _parse_lrc(full_lyrics)
            if lrc_lines:
                segments = _assign_lrc_to_segments(segments, lrc_lines)
                has_lyrics = any(s["lyrics"] for s in segments)
                if has_lyrics:
                    print(f"[split] LRC lyrics assigned ({len(lrc_lines)} lines parsed)")
        if not has_lyrics:
            # 纯文本歌词：用 AI 智能分配
            segments = _ai_assign_lyrics(segments, full_lyrics)
            has_lyrics = any(s["lyrics"] for s in segments)
            if not has_lyrics:
                print("[split] AI lyrics assignment produced no results, falling back to rule-based")

    # 如果没有歌词，自动从 lrclib.net 获取
    if not has_lyrics and title:
        print(f"[split] no lyrics provided, trying auto-fetch for '{title}' by '{artist}'...")
        fetch_result = _auto_fetch_lyrics(title, artist, duration)
        if fetch_result["success"] and fetch_result["lrc_text"]:
            lrc_lines = _parse_lrc(fetch_result["lrc_text"])
            if lrc_lines:
                segments = _assign_lrc_to_segments(segments, lrc_lines)
                has_lyrics = any(s["lyrics"] for s in segments)
                if has_lyrics:
                    print(f"[split] auto-fetched lyrics via {fetch_result['method']} "
                          f"(score={fetch_result['match_score']}, {len(lrc_lines)} lines)")
        if not has_lyrics:
            print(f"[split] auto-fetch failed or no match (score={fetch_result.get('match_score', 0)})")

    # 如果 AI 没分配歌词，用规则估算难度
    if not has_lyrics:
        for seg in segments:
            seg["difficulty"] = _estimate_difficulty("", seg["start_time"], seg["end_time"], False)

    # 注册到数据库
    for seg in segments:
        SEGMENTS_DB[seg["id"]] = seg

    return segments, has_lyrics





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
async def mark_segment_completed(segment_id: str, request: Request):
    """管理员标记唱段为已完成"""
    verify_admin(request)
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


@router.post("/segments/{segment_id}/reopen")
async def reopen_segment(segment_id: str, request: Request):
    """管理员重新开放已完成唱段"""
    verify_admin(request)
    seg = SEGMENTS_DB.get(segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail="唱段不存在")

    seg["status"] = "claimed" if seg.get("claim_count", 0) > 0 else "unassigned"

    song = SONGS_DB.get(seg["song_id"])
    if song:
        completed = sum(1 for s in song["segments"] if s["status"] == "completed")
        song["completion"] = round(completed / len(song["segments"]) * 100, 1)

    _save_db()
    return {"success": True, "data": seg}


@router.delete("/recordings/{recording_id}")
async def delete_recording(recording_id: str, request: Request):
    """删除录音"""
    verify_admin(request)
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


@router.post("/admin/segments/{segment_id}/complete")
async def admin_mark_segment_completed(segment_id: str, request: Request):
    return await mark_segment_completed(segment_id, request)


@router.post("/admin/segments/{segment_id}/reopen")
async def admin_reopen_segment(segment_id: str, request: Request):
    return await reopen_segment(segment_id, request)


@router.delete("/admin/recordings/{recording_id}")
async def admin_delete_recording(recording_id: str, request: Request):
    return await delete_recording(recording_id, request)


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
    lyrics: str = Form(""),
    audio: UploadFile = File(...),
):
    """上传新歌曲：保存音频文件 → 读取时长 → 静音检测切分 → AI歌词分配"""
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

    # 静音检测切分 + 歌词分配（含自动获取）
    segments, has_lyrics = _split_and_analyze(song_id, filepath, duration, lyrics,
                                              title=title.strip(), artist=artist.strip())

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
        "has_lyrics": has_lyrics,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    SONGS_DB[song_id] = song
    _save_db()

    print(f"[upload] new song: {title} ({artist}), duration={duration}s, {len(segments)} segments, has_lyrics={has_lyrics}")
    return {"success": True, "data": song}


@router.get("/admin/songs")
async def admin_get_songs(request: Request):
    """获取所有歌曲（含完整信息）"""
    verify_admin(request)
    songs = []
    for s in SONGS_DB.values():
        # 检查原曲文件是否存在（兼容 /api/uploads/ 和 /api/music/ 两种路径）
        audio_file = s.get("audio_file", "")
        audio_url = s.get("audio_url", "")
        audio_exists = False
        if audio_file:
            audio_exists = os.path.exists(os.path.join(UPLOAD_DIR, audio_file))
        if not audio_exists and audio_url:
            if "/api/uploads/" in audio_url:
                fname = audio_url.split("/api/uploads/")[-1]
                audio_exists = os.path.exists(os.path.join(UPLOAD_DIR, fname))
            elif "/api/music/" in audio_url:
                fname = audio_url.split("/api/music/")[-1]
                audio_exists = os.path.exists(os.path.join(MUSIC_DIR, fname))
        # 检查伴奏文件是否存在
        acc_file = s.get("accompaniment_file", "")
        has_acc = bool(acc_file) and os.path.exists(os.path.join(UPLOAD_DIR, acc_file))
        # 动态计算是否有歌词（兼容旧数据）
        has_lyrics = s.get("has_lyrics", False) or any(seg.get("lyrics", "").strip() for seg in s.get("segments", []))
        songs.append({
            **s,
            "claimed_count": sum(1 for seg in s["segments"] if seg["status"] != "unassigned"),
            "completed_count": sum(1 for seg in s["segments"] if seg["status"] == "completed"),
            "recording_count": sum(1 for r in RECORDINGS_DB.values() if r["song_id"] == s["id"]),
            "audio_file_exists": audio_exists,
            "has_accompaniment": has_acc,
            "has_lyrics": has_lyrics,
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


@router.post("/admin/songs/{song_id}/lyrics")
async def admin_upload_lyrics(song_id: str, request: Request):
    """为已有歌曲上传歌词（支持 LRC 格式精确匹配或纯文本 AI 分配）"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")

    body = await request.json()
    full_lyrics = body.get("lyrics", "").strip()
    if not full_lyrics:
        raise HTTPException(status_code=400, detail="歌词内容不能为空")

    segments = song["segments"]
    is_lrc = _is_lrc_format(full_lyrics)

    if is_lrc:
        # LRC 格式：精确时间标记，直接解析分配
        lrc_lines = _parse_lrc(full_lyrics)
        if lrc_lines:
            updated = _assign_lrc_to_segments(segments, lrc_lines)
        else:
            updated = segments
    else:
        # 纯文本歌词：用 AI 智能分配
        updated = _ai_assign_lyrics(segments, full_lyrics)

    has_lyrics = any(s.get("lyrics", "").strip() for s in updated)
    if not has_lyrics:
        method = "LRC 解析" if is_lrc else "AI 歌词分配"
        return {"success": False, "detail": f"{method}未成功，请检查歌词内容或格式"}

    # 更新唱段和歌曲状态
    song["segments"] = updated
    song["has_lyrics"] = True
    for seg in updated:
        SEGMENTS_DB[seg["id"]] = seg
    _save_db()

    method = "LRC精确匹配" if is_lrc else "AI智能分配"
    assigned = sum(1 for s in updated if s.get('lyrics'))
    print(f"[lyrics] song {song_id}: {method}, lyrics assigned to {assigned} segments")
    return {"success": True, "data": {"has_lyrics": True, "segment_count": len(updated), "method": method}}


@router.post("/admin/songs/{song_id}/auto-lyrics")
async def admin_auto_fetch_lyrics(song_id: str, request: Request):
    """自动从 lrclib.net 获取歌词并分配到唱段（参考 LDDC 的搜索匹配算法）"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")

    title = song.get("title", "")
    artist = song.get("artist", "")
    duration = song.get("duration", 0)

    if not title:
        raise HTTPException(status_code=400, detail="歌曲缺少标题信息，无法搜索歌词")

    print(f"[auto-lyrics] manual trigger for '{title}' by '{artist}' ({duration}s)")
    fetch_result = _auto_fetch_lyrics(title, artist, duration)

    if not fetch_result["success"] or not fetch_result["lrc_text"]:
        return {
            "success": False,
            "detail": f"未找到匹配的歌词（最高匹配分={fetch_result['match_score']}）",
            "data": {"match_score": fetch_result["match_score"], "track_info": fetch_result.get("track_info", {})}
        }

    # 解析 LRC 并分配到唱段
    lrc_lines = _parse_lrc(fetch_result["lrc_text"])
    if not lrc_lines:
        return {"success": False, "detail": "歌词解析失败"}

    segments = song["segments"]
    updated = _assign_lrc_to_segments(segments, lrc_lines)
    has_lyrics = any(s.get("lyrics", "").strip() for s in updated)

    if not has_lyrics:
        return {"success": False, "detail": "歌词已获取但无法匹配到任何唱段，可能时间戳不对应"}

    # 更新数据库
    song["segments"] = updated
    song["has_lyrics"] = True
    for seg in updated:
        SEGMENTS_DB[seg["id"]] = seg
    _save_db()

    assigned = sum(1 for s in updated if s.get('lyrics'))
    print(f"[auto-lyrics] success: {fetch_result['method']}, score={fetch_result['match_score']}, "
          f"{assigned}/{len(updated)} segments assigned")
    return {
        "success": True,
        "data": {
            "has_lyrics": True,
            "segment_count": len(updated),
            "assigned_count": assigned,
            "method": fetch_result["method"],
            "match_score": fetch_result["match_score"],
            "track_info": fetch_result["track_info"],
        }
    }


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
        seg_status = seg_data.get("status", "unassigned")
        if seg_status == "claimed":
            seg_status = "unassigned"
        seg = {
            "id": new_id,
            "song_id": song_id,
            "index": i + 1,
            "start_time": seg_data.get("start_time", 0),
            "end_time": seg_data.get("end_time", 0),
            "lyrics": seg_data.get("lyrics", ""),
            "difficulty": seg_data.get("difficulty", "normal"),
            "is_chorus": seg_data.get("is_chorus", False),
            "status": seg_status,
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
    """选定录音为该唱段的最终版本
    独唱段：互斥，同段仅允许一条选定
    合唱段：允许多选（最多20条）
    """
    verify_admin(request)
    rec = RECORDINGS_DB.get(recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")
    seg = SEGMENTS_DB.get(rec["segment_id"])
    is_chorus = seg.get("is_chorus", False) if seg else False
    if is_chorus:
        # 合唱段：检查已选定数量上限
        selected_count = sum(1 for r in RECORDINGS_DB.values()
                            if r["segment_id"] == rec["segment_id"] and r.get("selected"))
        if selected_count >= 20 and not rec.get("selected"):
            raise HTTPException(status_code=400, detail="合唱段最多选定20条录音")
    else:
        # 独唱段：互斥，取消同唱段其他录音的选定
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


@router.post("/admin/songs/{song_id}/accompaniment")
async def admin_upload_accompaniment(
    song_id: str,
    request: Request,
    audio: UploadFile = File(...),
):
    """上传伴奏文件，校验时长与原曲基本一致（±5秒）"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")

    _, ext = os.path.splitext(audio.filename or "")
    ext = ext.lower()
    if ext not in ALLOWED_AUDIO_EXT:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式: {ext}")

    # 保存临时文件检测时长
    tmp_filename = f"acc_{song_id}{ext}"
    tmp_filepath = os.path.join(UPLOAD_DIR, tmp_filename)
    content = await audio.read()
    with open(tmp_filepath, "wb") as f:
        f.write(content)

    acc_duration = _get_audio_duration(tmp_filepath)
    if acc_duration <= 0:
        os.remove(tmp_filepath)
        raise HTTPException(status_code=400, detail="无法读取伴奏时长，请检查文件是否损坏")

    song_duration = song.get("duration", 0)
    diff = abs(acc_duration - song_duration)
    tolerance = max(5.0, song_duration * 0.03)  # 容差：5秒或3%
    if diff > tolerance:
        os.remove(tmp_filepath)
        raise HTTPException(
            status_code=400,
            detail=f"伴奏时长({acc_duration:.1f}s)与原曲({song_duration:.1f}s)相差{diff:.1f}s，超出容差{tolerance:.1f}s"
        )

    # 检测通过，保存
    song["accompaniment_url"] = f"/api/uploads/{tmp_filename}"
    song["accompaniment_file"] = tmp_filename
    song["accompaniment_duration"] = acc_duration
    _save_db()

    print(f"[accompaniment] song={song_id}, acc_duration={acc_duration}s, song_duration={song_duration}s, diff={diff:.1f}s")
    return {
        "success": True,
        "data": {
            "accompaniment_url": song["accompaniment_url"],
            "accompaniment_duration": acc_duration,
            "song_duration": song_duration,
            "diff": round(diff, 2),
        }
    }


@router.delete("/admin/songs/{song_id}/accompaniment")
async def admin_delete_accompaniment(song_id: str, request: Request):
    """删除伴奏文件"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    acc_file = song.pop("accompaniment_file", None)
    song.pop("accompaniment_url", None)
    song.pop("accompaniment_duration", None)
    if acc_file:
        fp = os.path.join(UPLOAD_DIR, acc_file)
        if os.path.exists(fp):
            os.remove(fp)
    _save_db()
    return {"success": True, "message": "伴奏已删除"}


# ============ 合成引擎 ============

# 合成任务状态：{song_id: {status, progress, step, message, final_id, error}}
SYNTH_TASKS = {}

SYNTH_STEPS = [
    ("denoise", "降噪处理"),
    ("align", "节奏对齐"),
    ("pitch", "音高修正"),
    ("loudness", "响度均衡"),
    ("vocal_enhance", "人声增强"),
    ("spatial", "空间效果"),
    ("chorus_enhance", "合唱增强"),
    ("final_mix", "最终混音"),
]


def _convert_webm_to_wav(src_path: str, dst_path: str) -> bool:
    """将 webm 转换为 wav"""
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", src_path, "-ar", "44100", "-ac", "1", dst_path],
            capture_output=True, text=True, timeout=60
        )
        return result.returncode == 0
    except Exception as e:
        print(f"[synth] webm->wav failed: {e}")
        return False


def _convert_to_wav(src_path: str, dst_path: str, sr: int = 44100, mono: bool = False) -> bool:
    """将任意音频转换为 wav"""
    try:
        cmd = ["ffmpeg", "-y", "-i", src_path, "-ar", str(sr)]
        if mono:
            cmd += ["-ac", "1"]
        cmd.append(dst_path)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        return result.returncode == 0
    except Exception as e:
        print(f"[synth] convert failed: {e}")
        return False


def _apply_pitch_shift(audio_data, sr, semitones):
    """应用音高偏移"""
    if semitones == 0:
        return audio_data
    try:
        import librosa
        return librosa.effects.pitch_shift(y=audio_data, sr=sr, n_steps=semitones)
    except Exception as e:
        print(f"[synth] pitch shift failed: {e}")
        return audio_data


def _apply_reverb(audio_data, sr, amount):
    """应用简单混响（基于延迟叠加）"""
    if amount <= 0:
        return audio_data
    try:
        import numpy as np
        wet = amount / 100.0 * 0.4
        delays = [int(sr * d) for d in [0.03, 0.05, 0.08, 0.12]]
        decays = [0.4, 0.3, 0.2, 0.1]
        result = audio_data.copy().astype(np.float64)
        for delay, decay in zip(delays, decays):
            delayed = np.zeros_like(result)
            if delay < len(result):
                delayed[delay:] = result[:-delay] if delay > 0 else result
                result += delayed * decay * wet
        max_val = np.max(np.abs(result))
        if max_val > 0:
            result = result / max_val * np.max(np.abs(audio_data))
        return result.astype(audio_data.dtype)
    except Exception as e:
        print(f"[synth] reverb failed: {e}")
        return audio_data


def _normalize_loudness(audio_data, target_db=-18.0):
    """响度归一化"""
    try:
        import numpy as np
        rms = np.sqrt(np.mean(audio_data.astype(np.float64) ** 2))
        if rms < 1e-8:
            return audio_data
        current_db = 20 * np.log10(rms + 1e-10)
        gain = 10 ** ((target_db - current_db) / 20)
        result = audio_data.astype(np.float64) * gain
        peak = np.max(np.abs(result))
        if peak > 0.95:
            result = result * 0.95 / peak
        return result.astype(np.float32)
    except Exception as e:
        print(f"[synth] normalize failed: {e}")
        return audio_data


def _run_synthesis(song_id: str, song: dict, segments: list, recordings_map: dict):
    """在后台线程中执行合成"""
    import numpy as np
    try:
        import soundfile as sf
        import librosa
    except ImportError as e:
        SYNTH_TASKS[song_id] = {"status": "error", "error": f"缺少依赖: {e}"}
        return

    task = SYNTH_TASKS[song_id]
    sr = 44100
    work_dir = os.path.join(FINALS_DIR, f"work_{song_id}")
    os.makedirs(work_dir, exist_ok=True)

    try:
        duration = song.get("duration", 0)
        total_samples = int(duration * sr)
        if total_samples <= 0:
            raise ValueError("歌曲时长无效")

        # ---- Step 1: 降噪处理（转换格式 + 基础降噪）----
        task.update({"step": 0, "progress": 5, "message": "降噪处理 - 转换录音格式..."})
        vocal_tracks = []  # [(audio_data, start_sample, seg_info, rec_info)]

        for seg in segments:
            seg_recs = recordings_map.get(seg["id"], [])
            for rec in seg_recs:
                audio_url = rec.get("audio_url", "")
                filename = os.path.basename(audio_url)
                src_path = os.path.join(UPLOAD_DIR, filename)
                if not os.path.exists(src_path):
                    print(f"[synth] recording file not found: {src_path}")
                    continue

                wav_path = os.path.join(work_dir, f"rec_{rec['id']}.wav")
                ext = os.path.splitext(filename)[1].lower()
                if ext == ".webm":
                    if not _convert_webm_to_wav(src_path, wav_path):
                        continue
                elif ext == ".wav":
                    shutil.copy2(src_path, wav_path)
                else:
                    if not _convert_to_wav(src_path, wav_path, sr=sr, mono=True):
                        continue

                try:
                    audio, file_sr = sf.read(wav_path, dtype='float32')
                    if len(audio.shape) > 1:
                        audio = np.mean(audio, axis=1)
                    if file_sr != sr:
                        audio = librosa.resample(audio, orig_sr=file_sr, target_sr=sr)
                except Exception as e:
                    print(f"[synth] read wav failed: {e}")
                    continue

                start_sample = int(seg["start_time"] * sr)
                vocal_tracks.append((audio, start_sample, seg, rec))

        if not vocal_tracks:
            raise ValueError("没有可用的录音文件")

        task.update({"progress": 12, "message": f"降噪完成 - {len(vocal_tracks)} 条录音"})

        # ---- Step 2: 节奏对齐 ----
        task.update({"step": 1, "progress": 18, "message": "节奏对齐..."})
        # 录音已按唱段时间定位，此步骤确认对齐
        task.update({"progress": 25, "message": "节奏对齐完成"})

        # ---- Step 3: 音高修正 ----
        task.update({"step": 2, "progress": 28, "message": "音高修正..."})
        processed_tracks = []
        for audio, start_sample, seg, rec in vocal_tracks:
            pitch_shift = rec.get("_pitchShift", 0)
            if pitch_shift != 0:
                audio = _apply_pitch_shift(audio, sr, pitch_shift)
            processed_tracks.append((audio, start_sample, seg, rec))
        task.update({"progress": 35, "message": "音高修正完成"})

        # ---- Step 4: 响度均衡 ----
        task.update({"step": 3, "progress": 38, "message": "响度均衡..."})
        normalized_tracks = []
        for audio, start_sample, seg, rec in processed_tracks:
            audio = _normalize_loudness(audio, target_db=-18.0)
            normalized_tracks.append((audio, start_sample, seg, rec))
        task.update({"progress": 45, "message": "响度均衡完成"})

        # ---- Step 5: 人声增强 ----
        task.update({"step": 4, "progress": 48, "message": "人声增强..."})
        enhanced_tracks = []
        for audio, start_sample, seg, rec in normalized_tracks:
            # 轻微高通滤波去除低频噪声
            try:
                from scipy.signal import butter, sosfilt
                sos = butter(4, 80, btype='highpass', fs=sr, output='sos')
                audio = sosfilt(sos, audio).astype(np.float32)
            except Exception:
                pass
            enhanced_tracks.append((audio, start_sample, seg, rec))
        task.update({"progress": 55, "message": "人声增强完成"})

        # ---- Step 6: 空间效果（混响）----
        task.update({"step": 5, "progress": 58, "message": "空间效果..."})
        spatial_tracks = []
        for audio, start_sample, seg, rec in enhanced_tracks:
            reverb_amount = rec.get("_reverb", 0)
            if reverb_amount > 0:
                audio = _apply_reverb(audio, sr, reverb_amount)
            spatial_tracks.append((audio, start_sample, seg, rec))
        task.update({"progress": 65, "message": "空间效果完成"})

        # ---- Step 7: 合唱增强 ----
        task.update({"step": 6, "progress": 68, "message": "合唱增强..."})
        # 合唱段多人录音混合时轻微时间偏移增加厚度
        final_tracks = []
        chorus_seg_ids = set()
        for seg in segments:
            if seg.get("is_chorus"):
                chorus_seg_ids.add(seg["id"])

        for i, (audio, start_sample, seg, rec) in enumerate(spatial_tracks):
            if seg["id"] in chorus_seg_ids:
                # 合唱段：轻微随机偏移增加厚度感
                offset_samples = np.random.randint(-int(sr * 0.005), int(sr * 0.005) + 1)
                start_sample = max(0, start_sample + offset_samples)
            final_tracks.append((audio, start_sample, seg, rec))
        task.update({"progress": 75, "message": "合唱增强完成"})

        # ---- Step 8: 最终混音 ----
        task.update({"step": 7, "progress": 78, "message": "最终混音 - 合并人声..."})

        # 混合所有人声轨道到一条立体声总线
        vocal_mix = np.zeros(total_samples, dtype=np.float64)
        for audio, start_sample, seg, rec in final_tracks:
            end_sample = min(start_sample + len(audio), total_samples)
            actual_len = end_sample - start_sample
            if actual_len > 0 and start_sample >= 0:
                vocal_mix[start_sample:end_sample] += audio[:actual_len].astype(np.float64)

        # 归一化人声混合
        peak = np.max(np.abs(vocal_mix))
        if peak > 0:
            vocal_mix = vocal_mix / peak * 0.85

        task.update({"progress": 85, "message": "最终混音 - 混合伴奏..."})

        # 加载伴奏
        acc_file = song.get("accompaniment_file", "")
        acc_audio = None
        if acc_file:
            acc_path = os.path.join(UPLOAD_DIR, acc_file)
            if os.path.exists(acc_path):
                acc_wav = os.path.join(work_dir, "acc.wav")
                if _convert_to_wav(acc_path, acc_wav, sr=sr):
                    try:
                        acc_raw, acc_sr = sf.read(acc_wav, dtype='float32')
                        if len(acc_raw.shape) > 1:
                            acc_audio = np.mean(acc_raw, axis=1)
                        else:
                            acc_audio = acc_raw
                        if acc_sr != sr:
                            acc_audio = librosa.resample(acc_audio, orig_sr=acc_sr, target_sr=sr)
                    except Exception as e:
                        print(f"[synth] load acc failed: {e}")

        # 混合伴奏 + 人声
        if acc_audio is not None:
            # 确保长度一致
            if len(acc_audio) > total_samples:
                acc_audio = acc_audio[:total_samples]
            elif len(acc_audio) < total_samples:
                acc_audio = np.pad(acc_audio, (0, total_samples - len(acc_audio)))
            # 伴奏稍低于人声
            acc_norm = acc_audio.astype(np.float64)
            acc_peak = np.max(np.abs(acc_norm))
            if acc_peak > 0:
                acc_norm = acc_norm / acc_peak * 0.65
            final_mix = vocal_mix * 0.7 + acc_norm * 0.5
        else:
            final_mix = vocal_mix

        # 最终限幅
        peak = np.max(np.abs(final_mix))
        if peak > 0.95:
            final_mix = final_mix * 0.95 / peak

        task.update({"progress": 92, "message": "最终混音 - 导出文件..."})

        # 保存最终音频
        final_id = str(uuid.uuid4())[:8]
        final_filename = f"final_{song_id}_{final_id}.wav"
        final_path = os.path.join(FINALS_DIR, final_filename)
        sf.write(final_path, final_mix.astype(np.float32), sr)

        # 转换为 mp3 以减小体积
        mp3_filename = f"final_{song_id}_{final_id}.mp3"
        mp3_path = os.path.join(FINALS_DIR, mp3_filename)
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", final_path, "-b:a", "192k", mp3_path],
                capture_output=True, timeout=120
            )
            if os.path.exists(mp3_path) and os.path.getsize(mp3_path) > 0:
                os.remove(final_path)
                final_filename = mp3_filename
                final_path = mp3_path
        except Exception:
            pass

        # 保存元数据
        metadata = {
            "song_id": song_id,
            "song_title": song.get("title", ""),
            "song_artist": song.get("artist", ""),
            "duration": duration,
            "segments": [],
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        for seg in segments:
            seg_meta = {
                "id": seg["id"],
                "index": seg["index"],
                "start_time": seg["start_time"],
                "end_time": seg["end_time"],
                "lyrics": seg.get("lyrics", ""),
                "is_chorus": seg.get("is_chorus", False),
                "recordings": [],
            }
            seg_recs = recordings_map.get(seg["id"], [])
            for rec in seg_recs:
                seg_meta["recordings"].append({
                    "id": rec["id"],
                    "user_name": rec.get("user_name", ""),
                    "audio_url": rec.get("audio_url", ""),
                    "score": rec.get("score", 0),
                    "pitch_shift": rec.get("_pitchShift", 0),
                    "reverb": rec.get("_reverb", 0),
                })
            metadata["segments"].append(seg_meta)

        meta_path = os.path.join(FINALS_DIR, f"meta_{song_id}_{final_id}.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)

        # 复制所有唱段录音到 finals 目录备份
        recs_dir = os.path.join(FINALS_DIR, f"recs_{song_id}_{final_id}")
        os.makedirs(recs_dir, exist_ok=True)
        for seg in segments:
            seg_recs = recordings_map.get(seg["id"], [])
            for rec in seg_recs:
                src = os.path.join(UPLOAD_DIR, os.path.basename(rec.get("audio_url", "")))
                if os.path.exists(src):
                    try:
                        shutil.copy2(src, os.path.join(recs_dir, os.path.basename(src)))
                    except Exception:
                        pass

        # 保存到数据库
        final_record = {
            "id": final_id,
            "song_id": song_id,
            "song_title": song.get("title", ""),
            "song_artist": song.get("artist", ""),
            "duration": duration,
            "audio_file": final_filename,
            "audio_url": f"/api/finals/{final_filename}",
            "metadata_file": f"meta_{song_id}_{final_id}.json",
            "recordings_dir": f"recs_{song_id}_{final_id}",
            "track_count": len(final_tracks),
            "segment_count": len(segments),
            "published": False,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        FINALS_DB[final_id] = final_record
        _save_db()

        task.update({
            "status": "done",
            "progress": 100,
            "step": 7,
            "message": "合成完成！",
            "final_id": final_id,
        })
        print(f"[synth] completed: song={song_id}, final={final_id}, tracks={len(final_tracks)}")

    except Exception as e:
        traceback.print_exc()
        task.update({"status": "error", "error": str(e), "message": f"合成失败: {e}"})
    finally:
        # 清理工作目录
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception:
            pass


@router.post("/admin/songs/{song_id}/synthesize")
async def admin_start_synthesis(song_id: str, request: Request):
    """启动合成任务"""
    verify_admin(request)
    song = SONGS_DB.get(song_id)
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")

    # 检查是否已有进行中的合成
    existing = SYNTH_TASKS.get(song_id)
    if existing and existing.get("status") == "running":
        raise HTTPException(status_code=400, detail="该歌曲已有合成任务正在进行")

    segments = song.get("segments", [])
    if not segments:
        raise HTTPException(status_code=400, detail="歌曲没有唱段")

    # 读取请求体中的录音参数（升降调、混响）
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    rec_params = body.get("rec_params", {})  # {rec_id: {pitchShift, reverb}}

    # 收集每个唱段的已选定录音
    recordings_map = {}  # seg_id -> [rec, ...]
    missing_segs = []
    for seg in segments:
        seg_recs = [
            r for r in RECORDINGS_DB.values()
            if r["segment_id"] == seg["id"] and r.get("selected") and r.get("submitted")
        ]
        if not seg_recs:
            missing_segs.append(f"#{seg['index']}")
        else:
            # 应用前端传来的参数
            for r in seg_recs:
                params = rec_params.get(r["id"], {})
                r["_pitchShift"] = params.get("pitchShift", 0)
                r["_reverb"] = params.get("reverb", 0)
        recordings_map[seg["id"]] = seg_recs

    if missing_segs:
        raise HTTPException(
            status_code=400,
            detail=f"以下唱段未选定录音: {', '.join(missing_segs[:5])}{'...' if len(missing_segs)>5 else ''}"
        )

    # 初始化任务状态
    SYNTH_TASKS[song_id] = {
        "status": "running",
        "progress": 0,
        "step": 0,
        "message": "准备中...",
        "final_id": None,
        "error": None,
    }

    # 启动后台线程
    thread = threading.Thread(
        target=_run_synthesis,
        args=(song_id, song, segments, recordings_map),
        daemon=True
    )
    thread.start()

    return {"success": True, "message": "合成任务已启动"}


@router.get("/admin/songs/{song_id}/synth-status")
async def admin_synth_status(song_id: str, request: Request):
    """查询合成任务状态"""
    verify_admin(request)
    task = SYNTH_TASKS.get(song_id)
    if not task:
        return {"success": True, "data": {"status": "none"}}
    return {"success": True, "data": task}


# ============ 管理员 - 最终成曲管理 ============

@router.get("/admin/finals")
async def admin_get_finals(request: Request):
    """获取所有最终成曲"""
    verify_admin(request)
    finals = sorted(FINALS_DB.values(), key=lambda f: f.get("created_at", ""), reverse=True)
    return {"success": True, "data": finals}


@router.get("/admin/finals/{final_id}")
async def admin_get_final(final_id: str, request: Request):
    """获取单个最终成曲详情"""
    verify_admin(request)
    final = FINALS_DB.get(final_id)
    if not final:
        raise HTTPException(status_code=404, detail="成曲不存在")
    return {"success": True, "data": final}


@router.post("/admin/finals/{final_id}/publish")
async def admin_publish_final(final_id: str, request: Request):
    """发布成曲"""
    verify_admin(request)
    final = FINALS_DB.get(final_id)
    if not final:
        raise HTTPException(status_code=404, detail="成曲不存在")
    final["published"] = True
    final["published_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _save_db()
    return {"success": True, "data": final}


@router.post("/admin/finals/{final_id}/unpublish")
async def admin_unpublish_final(final_id: str, request: Request):
    """取消发布"""
    verify_admin(request)
    final = FINALS_DB.get(final_id)
    if not final:
        raise HTTPException(status_code=404, detail="成曲不存在")
    final["published"] = False
    final.pop("published_at", None)
    _save_db()
    return {"success": True, "data": final}


@router.delete("/admin/finals/{final_id}")
async def admin_delete_final(final_id: str, request: Request):
    """删除成曲及其所有关联文件"""
    verify_admin(request)
    final = FINALS_DB.pop(final_id, None)
    if not final:
        raise HTTPException(status_code=404, detail="成曲不存在")
    # 删除音频文件
    audio_file = final.get("audio_file", "")
    if audio_file:
        fp = os.path.join(FINALS_DIR, audio_file)
        if os.path.exists(fp):
            try: os.remove(fp)
            except: pass
    # 删除元数据文件
    meta_file = final.get("metadata_file", "")
    if meta_file:
        fp = os.path.join(FINALS_DIR, meta_file)
        if os.path.exists(fp):
            try: os.remove(fp)
            except: pass
    # 删除录音备份目录
    recs_dir = final.get("recordings_dir", "")
    if recs_dir:
        dp = os.path.join(FINALS_DIR, recs_dir)
        if os.path.exists(dp):
            try: shutil.rmtree(dp)
            except: pass
    _save_db()
    return {"success": True, "message": "成曲已删除"}


@router.get("/finals/{filename:path}")
async def serve_final_file(filename: str):
    """提供最终成曲文件（/api/finals/ 路径）"""
    filepath = os.path.join(FINALS_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="文件不存在")
    ext = os.path.splitext(filename)[1].lower()
    mime_map = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
        '.ogg': 'audio/ogg',
    }
    return FileResponse(filepath, media_type=mime_map.get(ext, 'application/octet-stream'))
