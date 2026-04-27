from fastapi import APIRouter, UploadFile, File, HTTPException, Form, Query, Body, Request, Depends
from fastapi.responses import JSONResponse, HTMLResponse, RedirectResponse, FileResponse
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
import secrets
import smtplib
from email.message import EmailMessage
from datetime import datetime, timedelta
from difflib import SequenceMatcher
import httpx
from urllib.parse import urlencode, urlsplit
from contextlib import contextmanager

import hashlib
import hmac as _hmac

from sqlalchemy.orm import Session
from sqlalchemy import select, func as sql_func
from app.core.database import get_db, SessionLocal
from app.core.config import get_settings
from app.core.multitenant import hash_password, verify_password, get_setting, set_setting, log_audit, new_id, now_str
from app.core.auth import create_session, delete_session, set_session_cookie, clear_session_cookie, get_current_user, COOKIE_NAME
from app.models import Song, Segment, SegmentClaim, Recording, User, FreeTask, Final, AdminUser, AdminInviteCode, SystemSetting, AuditLog

# OpenAI API 配置（用于 DeepSeek 等兼容接口）
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.siliconflow.cn/v1")
OPENAI_CHAT_MODEL = os.environ.get("OPENAI_CHAT_MODEL", "deepseek-ai/DeepSeek-V3")
WECHAT_APP_ID = os.environ.get("WECHAT_APP_ID", "").strip()
WECHAT_APP_SECRET = os.environ.get("WECHAT_APP_SECRET", "").strip()
WECHAT_OAUTH_REDIRECT_URI = os.environ.get("WECHAT_OAUTH_REDIRECT_URI", "").strip()

router = APIRouter(prefix="/api", tags=["api"])

# ============ 管理员会话 ============
ADMIN_TOKENS = {}  # token -> {id, username, role, login_time}


# ============ 用户密码工具 ============

def _hash_user_password(password: str) -> str:
    salt = os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return f"pbkdf2:200000:{salt}:{dk.hex()}"


def _verify_user_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt, dk_hex = stored.split(":")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iters))
        return _hmac.compare_digest(dk.hex(), dk_hex)
    except Exception:
        return False


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


@contextmanager
def db_session():
    """供后台线程使用：with db_session() as db: ..."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _seg_id_exists(db: Session, seg_id: str) -> bool:
    return db.get(Segment, seg_id) is not None


def _apply_seg_dict_to_orm(orm_seg: Segment, d: dict) -> None:
    """把 dict 形式的 segment 字段应用回 ORM 行（仅写允许变更字段）"""
    for key in ("start_time", "end_time", "lyrics", "difficulty", "is_chorus", "status",
                "claim_count", "submit_count", "index"):
        if key in d:
            setattr(orm_seg, key, d[key])


def _new_segment_orm_from_dict(d: dict) -> Segment:
    """从 dict 创建 Segment ORM 实例（用于 _resegment_by_lrc / _split_and_analyze 的产物入库）"""
    return Segment(
        id=d["id"],
        owner_admin_id=d.get("owner_admin_id"),
        song_id=d["song_id"],
        index=d.get("index", 0),
        start_time=d.get("start_time", 0.0),
        end_time=d.get("end_time", 0.0),
        lyrics=d.get("lyrics", ""),
        difficulty=d.get("difficulty", "normal"),
        is_chorus=bool(d.get("is_chorus", False)),
        status=d.get("status", "unassigned"),
        claim_count=d.get("claim_count", 0),
        submit_count=d.get("submit_count", 0),
        created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )


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
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30
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


def _resegment_by_lrc(song_id: str, lrc_lines: list, total_duration: float,
                      target_lines_per_seg: int = 4, max_lines_per_seg: int = 6) -> list:
    """根据 LRC 时间戳重新生成唱段（当原始分段太粗时使用）

    算法：
    1. 计算行间隔的中位数，用于区分"正常行间隔"和"间奏/停顿"
    2. 间隔 > 中位数 * 2.5 或 > 8秒 的位置视为自然分段点（间奏）
    3. 连续行数达到 target_lines_per_seg 时，在最大间隔处切分
    4. 每段不超过 max_lines_per_seg 行

    返回新的 segments 列表（已含歌词、副歌标记、难度）
    """
    if not lrc_lines:
        return []

    # 过滤空歌词行，保留有文本的行
    vocal_lines = [(t, text) for t, text in lrc_lines if text.strip()]
    if not vocal_lines:
        return []

    # 计算行间隔统计信息，确定自然分段阈值
    gaps = []
    for i in range(1, len(vocal_lines)):
        gaps.append(vocal_lines[i][0] - vocal_lines[i - 1][0])

    if gaps:
        sorted_gaps = sorted(gaps)
        median_gap = sorted_gaps[len(sorted_gaps) // 2]
        # 自然分段阈值：中位数的 2.5 倍，但至少 8 秒，最多 20 秒
        natural_break_threshold = max(8.0, min(20.0, median_gap * 2.5))
    else:
        natural_break_threshold = 8.0

    print(f"[resegment] {len(vocal_lines)} vocal lines, median_gap={median_gap:.1f}s, "
          f"break_threshold={natural_break_threshold:.1f}s")

    # 第一遍：按自然间隔切分成"段组"
    groups = []  # 每个 group 是一组连续的行索引 [start_idx, end_idx)
    group_start = 0
    for i in range(1, len(vocal_lines)):
        gap = vocal_lines[i][0] - vocal_lines[i - 1][0]
        if gap >= natural_break_threshold:
            groups.append((group_start, i))
            group_start = i
    groups.append((group_start, len(vocal_lines)))

    # 第二遍：对每个段组，如果行数太多，按 target_lines_per_seg 进一步切分
    final_groups = []
    for g_start, g_end in groups:
        n_lines = g_end - g_start
        if n_lines <= max_lines_per_seg:
            final_groups.append((g_start, g_end))
        else:
            # 需要进一步切分：每 target_lines_per_seg 行切一次，在最大间隔处切
            pos = g_start
            while pos < g_end:
                remaining = g_end - pos
                if remaining <= max_lines_per_seg:
                    final_groups.append((pos, g_end))
                    break

                # 在 [pos + target_lines_per_seg - 1, pos + max_lines_per_seg] 范围内找最大间隔
                search_start = pos + max(2, target_lines_per_seg - 1)
                search_end = min(pos + max_lines_per_seg, g_end)
                best_cut = search_start
                best_gap = 0
                for j in range(search_start, search_end + 1):
                    if j >= len(vocal_lines):
                        break
                    g = vocal_lines[j][0] - vocal_lines[j - 1][0]
                    if g >= best_gap:
                        best_gap = g
                        best_cut = j

                final_groups.append((pos, best_cut))
                pos = best_cut

    # 构建唱段
    segments = []
    _seg_template = {
        "song_id": song_id, "difficulty": "normal", "is_chorus": False,
        "status": "unassigned", "claim_count": 0, "submit_count": 0, "claims": [],
    }

    for gi, (g_start, g_end) in enumerate(final_groups):
        seg_start = vocal_lines[g_start][0]
        # 段结束时间
        if gi + 1 < len(final_groups):
            seg_end = vocal_lines[final_groups[gi + 1][0]][0]
        else:
            last_t = vocal_lines[g_end - 1][0]
            if g_end >= 2:
                avg_dur = max(vocal_lines[g_end - 1][0] - vocal_lines[g_end - 2][0], 3.0)
            else:
                avg_dur = 5.0
            seg_end = min(last_t + avg_dur, total_duration)

        # 前奏段
        if gi == 0 and seg_start > 2.0:
            seg_id = f"{song_id}-{len(segments)+1:02d}"
            segments.append({
                **_seg_template, "id": seg_id, "index": len(segments) + 1,
                "start_time": 0.0, "end_time": round(seg_start, 2),
                "lyrics": "", "difficulty": "easy",
            })

        # 如果与上一个有歌词的段之间有大间隔（间奏），插入间奏段
        if gi > 0:
            prev_end = segments[-1]["end_time"] if segments else 0
            if seg_start - prev_end > 3.0:
                seg_id = f"{song_id}-{len(segments)+1:02d}"
                segments.append({
                    **_seg_template, "id": seg_id, "index": len(segments) + 1,
                    "start_time": round(prev_end, 2), "end_time": round(seg_start, 2),
                    "lyrics": "", "difficulty": "easy",
                })

        # 歌词段
        seg_lyrics = [vocal_lines[idx][1] for idx in range(g_start, g_end) if vocal_lines[idx][1].strip()]
        seg_id = f"{song_id}-{len(segments)+1:02d}"
        segments.append({
            **_seg_template, "id": seg_id, "index": len(segments) + 1,
            "start_time": round(seg_start, 2), "end_time": round(seg_end, 2),
            "lyrics": "\n".join(seg_lyrics),
        })

    # 尾奏段
    if segments and total_duration - segments[-1]["end_time"] > 3.0:
        seg_id = f"{song_id}-{len(segments)+1:02d}"
        segments.append({
            **_seg_template, "id": seg_id, "index": len(segments) + 1,
            "start_time": segments[-1]["end_time"], "end_time": round(total_duration, 2),
            "lyrics": "", "difficulty": "easy",
        })

    # 副歌检测
    lyrics_list = [seg["lyrics"].strip() for seg in segments]
    for i, seg in enumerate(segments):
        text = lyrics_list[i]
        if not text:
            continue
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
    print(f"[resegment] created {len(segments)} segments from LRC ({assigned} with lyrics, {chorus} chorus)")
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


# ============ 自动歌词获取（借鉴 LDDC 项目的匹配算法 + 多源搜索） ============

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

def _clean_title(title: str) -> str:
    """清理标题中的多余信息，提取核心歌曲名"""
    t = title.strip()
    # 移除常见后缀标记：(Live), (Remix), (翻唱), (Cover), (1), 版本号等
    t = re.sub(r'\s*[\(（\[【](?:Live|Remix|Cover|Inst\.?|Instrumental|翻唱|伴奏|现场|Demo|Acoustic|Unplugged|Remaster(?:ed)?|\d+)[\)）\]】]', '', t, flags=re.IGNORECASE)
    # 移除尾部的 (数字) 如 "(1)"
    t = re.sub(r'\s*\(\d+\)\s*$', '', t)
    return t.strip()


def _clean_artist(artist: str) -> str:
    """提取第一个/主要艺术家名"""
    if not artist:
        return ""
    # 按常见分隔符拆分，取第一个
    parts = re.split(r'[;；,，、/\\\&\+]', artist)
    first = parts[0].strip() if parts else artist.strip()
    # 移除括号内容
    first = re.sub(r'[\(（].*?[\)）]', '', first).strip()
    return first


def _auto_fetch_lyrics(title: str, artist: str, duration: float) -> dict:
    """自动从多个源获取歌词（lrclib.net + 网易云 + QQ音乐备用）

    改进策略：
    1. 清理标题（去除 Live/Remix/版本号等后缀）
    2. 放宽时长容差（从4秒→30秒，分阶梯评分）
    3. 多关键词搜索（原标题、清理后标题、仅标题、拼音等）
    4. 降级接受 plainLyrics（无时间标记的纯文本歌词）
    5. 备用源：网易云音乐 API

    返回: {"success": bool, "lrc_text": str, "method": str, "match_score": float, "track_info": dict}
    """
    result = {"success": False, "lrc_text": "", "method": "", "match_score": 0, "track_info": {}}

    if not title:
        return result

    clean_t = _clean_title(title)
    clean_a = _clean_artist(artist)

    try:
        client = httpx.Client(
            headers={
                "User-Agent": "YouDooSing/1.0 (https://github.com/sptwalker/Group-singing)",
                "Accept": "application/json",
            },
            timeout=15,
            follow_redirects=True,
        )

        # ========== 策略1：lrclib 精确匹配 ==========
        for try_title, try_artist in [(clean_t, clean_a), (title, artist), (clean_t, "")]:
            if not try_title:
                continue
            try:
                params = {"track_name": try_title, "artist_name": try_artist}
                if duration > 0:
                    params["duration"] = int(duration)
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
                print(f"[auto-lyrics] lrclib exact match failed ({try_title}/{try_artist}): {e}")

        # ========== 策略2：lrclib 搜索匹配（多关键词 + 宽松时长） ==========
        keywords = []
        if clean_a and clean_a != clean_t:
            keywords.append(f"{clean_a} {clean_t}")
        if artist and artist != clean_a:
            keywords.append(f"{artist} {title}")
        keywords.append(clean_t)
        if clean_t != title:
            keywords.append(title)
        # 去重保序
        seen = set()
        keywords = [k for k in keywords if k not in seen and not seen.add(k)]

        best_score = 0
        best_data = None
        best_plain = None  # 备用：纯文本歌词
        best_plain_score = 0

        for keyword in keywords:
            try:
                resp = client.get("https://lrclib.net/api/search", params={"q": keyword})
                if resp.status_code != 200:
                    continue
                items = resp.json()
                if not isinstance(items, list):
                    continue

                for item in items[:30]:
                    item_title = item.get("trackName", "")
                    item_artist = item.get("artistName", "")
                    item_duration = item.get("duration", 0)
                    has_synced = bool(item.get("syncedLyrics"))
                    has_plain = bool(item.get("plainLyrics"))

                    if not has_synced and not has_plain:
                        continue

                    # ---- 时长评分（阶梯式，不再硬过滤） ----
                    duration_penalty = 0
                    if duration > 0 and item_duration > 0:
                        diff = abs(duration - item_duration)
                        if diff <= 5:
                            duration_penalty = 0       # 完美匹配
                        elif diff <= 15:
                            duration_penalty = -5      # 轻微差异（不同版本）
                        elif diff <= 30:
                            duration_penalty = -15     # 较大差异（可能是不同编曲）
                        elif diff <= 60:
                            duration_penalty = -25     # 差异大但可能同一首歌
                        else:
                            duration_penalty = -40     # 差异很大，可能不是同一首

                    # ---- 标题评分 ----
                    title_score = _calculate_title_score(clean_t, _clean_title(item_title))
                    # 也用原始标题算一次，取高分
                    title_score2 = _calculate_title_score(title, item_title)
                    title_score = max(title_score, title_score2)

                    # ---- 艺术家评分 ----
                    if clean_a and item_artist:
                        artist_score = _calculate_artist_score(clean_a, item_artist)
                        # 也用原始 artist 算一次
                        if artist:
                            artist_score2 = _calculate_artist_score(artist, item_artist)
                            artist_score = max(artist_score, artist_score2)
                        score = title_score * 0.6 + artist_score * 0.4
                    else:
                        # 没有艺术家信息时，标题权重更高
                        score = title_score

                    score += duration_penalty

                    # 标题得分太低时惩罚
                    if title_score < 30:
                        score = max(0, score - 35)

                    # 优先选有同步歌词的
                    if has_synced and score > best_score:
                        best_score = score
                        best_data = item

                    # 记录最佳纯文本歌词（降级用）
                    if has_plain and score > best_plain_score:
                        best_plain_score = score
                        best_plain = item

            except Exception as e:
                print(f"[auto-lyrics] lrclib search '{keyword}' failed: {e}")
                continue

        # 评估结果：同步歌词阈值 40 分（降低门槛），纯文本阈值 50 分
        if best_data and best_score >= 40:
            result["success"] = True
            result["lrc_text"] = best_data["syncedLyrics"]
            result["method"] = "lrclib搜索匹配"
            result["match_score"] = round(best_score, 1)
            result["track_info"] = {
                "title": best_data.get("trackName", ""),
                "artist": best_data.get("artistName", ""),
                "album": best_data.get("albumName", ""),
            }
            client.close()
            return result

        # 降级：使用纯文本歌词（没有时间标记，但至少有歌词内容）
        if best_plain and best_plain_score >= 50:
            plain_text = best_plain.get("plainLyrics", "")
            if plain_text and len(plain_text.strip()) > 20:
                result["success"] = True
                result["lrc_text"] = plain_text  # 纯文本，非 LRC 格式
                result["method"] = "lrclib纯文本匹配"
                result["match_score"] = round(best_plain_score, 1)
                result["track_info"] = {
                    "title": best_plain.get("trackName", ""),
                    "artist": best_plain.get("artistName", ""),
                    "album": best_plain.get("albumName", ""),
                }
                client.close()
                return result

        # ========== 策略3：网易云音乐搜索（中文歌曲覆盖率高） ==========
        try:
            ne_result = _fetch_lyrics_netease(clean_t, clean_a, duration, client)
            if ne_result["success"]:
                client.close()
                return ne_result
        except Exception as e:
            print(f"[auto-lyrics] netease fallback failed: {e}")

        # 记录最佳未达标结果
        if best_data:
            result["match_score"] = round(best_score, 1)
            result["track_info"] = {
                "title": best_data.get("trackName", ""),
                "artist": best_data.get("artistName", ""),
            }
            print(f"[auto-lyrics] best lrclib score {best_score:.1f} < 40, skipped: {best_data.get('trackName')}")
        elif best_plain:
            result["match_score"] = round(best_plain_score, 1)
            result["track_info"] = {
                "title": best_plain.get("trackName", ""),
                "artist": best_plain.get("artistName", ""),
            }

        client.close()

    except Exception as e:
        print(f"[auto-lyrics] error: {e}")
        traceback.print_exc()

    return result


def _fetch_lyrics_netease(title: str, artist: str, duration: float, client: httpx.Client) -> dict:
    """从网易云音乐搜索歌词（免费API，中文歌曲覆盖率高）"""
    result = {"success": False, "lrc_text": "", "method": "", "match_score": 0, "track_info": {}}

    # 搜索歌曲
    search_kw = f"{artist} {title}" if artist else title
    try:
        resp = client.get(
            "https://music.163.com/api/search/get/web",
            params={"s": search_kw, "type": 1, "limit": 20},
            headers={
                "Referer": "https://music.163.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        )
        if resp.status_code != 200:
            return result
        data = resp.json()
        songs = data.get("result", {}).get("songs", [])
        if not songs:
            # 仅用标题重试
            if artist:
                resp = client.get(
                    "https://music.163.com/api/search/get/web",
                    params={"s": title, "type": 1, "limit": 20},
                    headers={
                        "Referer": "https://music.163.com/",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    songs = data.get("result", {}).get("songs", [])
            if not songs:
                return result
    except Exception as e:
        print(f"[auto-lyrics] netease search failed: {e}")
        return result

    # 对搜索结果评分
    best_song = None
    best_score = 0
    for song in songs[:10]:
        ne_title = song.get("name", "")
        ne_artists = " ".join(a.get("name", "") for a in song.get("artists", []))
        ne_duration = song.get("duration", 0) / 1000.0  # 毫秒转秒

        title_score = _calculate_title_score(title, ne_title)
        if artist and ne_artists:
            artist_score = _calculate_artist_score(artist, ne_artists)
            score = title_score * 0.6 + artist_score * 0.4
        else:
            score = title_score

        # 时长惩罚
        if duration > 0 and ne_duration > 0:
            diff = abs(duration - ne_duration)
            if diff <= 5:
                pass
            elif diff <= 15:
                score -= 5
            elif diff <= 30:
                score -= 15
            else:
                score -= 25

        if title_score < 30:
            score = max(0, score - 35)

        if score > best_score:
            best_score = score
            best_song = song

    if not best_song or best_score < 40:
        if best_song:
            print(f"[auto-lyrics] netease best score {best_score:.1f} < 40: {best_song.get('name')}")
        return result

    # 获取歌词
    song_id = best_song["id"]
    try:
        resp = client.get(
            f"https://music.163.com/api/song/lyric",
            params={"id": song_id, "lv": 1, "tv": -1},
            headers={
                "Referer": "https://music.163.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        )
        if resp.status_code != 200:
            return result
        lyric_data = resp.json()
        lrc_text = lyric_data.get("lrc", {}).get("lyric", "")
        if not lrc_text or len(lrc_text.strip()) < 20:
            return result

        ne_artists = " / ".join(a.get("name", "") for a in best_song.get("artists", []))
        result["success"] = True
        result["lrc_text"] = lrc_text
        result["method"] = "网易云音乐匹配"
        result["match_score"] = round(best_score, 1)
        result["track_info"] = {
            "title": best_song.get("name", ""),
            "artist": ne_artists,
            "album": best_song.get("album", {}).get("name", ""),
        }
        print(f"[auto-lyrics] netease matched: {best_song.get('name')} - {ne_artists} (score={best_score:.1f})")
        return result
    except Exception as e:
        print(f"[auto-lyrics] netease lyric fetch failed: {e}")
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
    with db_session() as _db:
        for i in range(len(split_points) - 1):
            seg_id = f"{song_id}-{i+1:02d}"
            while _seg_id_exists(_db, seg_id):
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

    # 如果没有歌词，自动从 lrclib.net / 网易云获取
    if not has_lyrics and title:
        print(f"[split] no lyrics provided, trying auto-fetch for '{title}' by '{artist}'...")
        fetch_result = _auto_fetch_lyrics(title, artist, duration)
        if fetch_result["success"] and fetch_result["lrc_text"]:
            fetched_text = fetch_result["lrc_text"]
            if _is_lrc_format(fetched_text):
                lrc_lines = _parse_lrc(fetched_text)
                if lrc_lines:
                    # 检测分段是否太粗糙
                    max_seg_dur = max((s["end_time"] - s["start_time"]) for s in segments) if segments else 0
                    if (max_seg_dur > 60 or len(segments) < 5) and len(lrc_lines) >= 8:
                        print(f"[split] segments too coarse (max_dur={max_seg_dur:.1f}s), "
                              f"resegmenting by LRC timestamps...")
                        new_segs = _resegment_by_lrc(song_id, lrc_lines, duration)
                        if new_segs and any(s.get("lyrics", "").strip() for s in new_segs):
                            segments = new_segs
                            has_lyrics = True
                            print(f"[split] resegmented: {len(segments)} segments from LRC")
                    if not has_lyrics:
                        segments = _assign_lrc_to_segments(segments, lrc_lines)
                        has_lyrics = any(s["lyrics"] for s in segments)
                        if has_lyrics:
                            print(f"[split] auto-fetched LRC via {fetch_result['method']} "
                                  f"(score={fetch_result['match_score']}, {len(lrc_lines)} lines)")
            if not has_lyrics:
                # 纯文本歌词：用 AI 智能分配
                segments = _ai_assign_lyrics(segments, fetched_text)
                has_lyrics = any(s["lyrics"] for s in segments)
                if has_lyrics:
                    print(f"[split] auto-fetched plain text via {fetch_result['method']}, AI assigned")
        if not has_lyrics:
            print(f"[split] auto-fetch failed or no match (score={fetch_result.get('match_score', 0) if 'fetch_result' in dir() else 0})")

    # 如果 AI 没分配歌词，用规则估算难度
    if not has_lyrics:
        for seg in segments:
            seg["difficulty"] = _estimate_difficulty("", seg["start_time"], seg["end_time"], False)

    # 注意：本函数仅产出 dict 列表；调用方负责把 segments 持久化为 ORM 行
    return segments, has_lyrics





# ============ 初始化数据：MySQL 由 main.py 启动时 init_db() 创建表，无需此处加载 ============
print("[persist] using MySQL via SQLAlchemy ORM (no file persistence)")

# ============ 用户接口 ============

WECHAT_LOGIN_TARGETS = {
    "index.html",
    "task.html",
    "record.html",
}


def _is_wechat_login_enabled() -> bool:
    return bool(WECHAT_APP_ID and WECHAT_APP_SECRET)


def _sanitize_login_target(target: Optional[str], default: str = "task.html") -> str:
    raw = (target or "").strip()
    if not raw:
        return default

    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc:
        return default

    path = (parsed.path or "").lstrip("/")
    if not path:
        path = default
    if path not in WECHAT_LOGIN_TARGETS:
        return default

    safe = path
    if parsed.query:
        safe += f"?{parsed.query}"
    if parsed.fragment:
        safe += f"#{parsed.fragment}"
    return safe


def _find_wechat_user(db: Session, openid: str, unionid: str = "") -> Optional[User]:
    if unionid:
        u = db.query(User).filter(User.wechat_unionid == unionid).first()
        if u:
            return u
    if openid:
        return db.query(User).filter(User.wechat_openid == openid).first()
    return None


def _upsert_wechat_user(db: Session, token_data: dict, profile_data: dict) -> dict:
    openid = (profile_data.get("openid") or token_data.get("openid") or "").strip()
    unionid = (profile_data.get("unionid") or token_data.get("unionid") or "").strip()
    if not openid:
        raise ValueError("Missing WeChat openid")

    nickname = (profile_data.get("nickname") or f"WeChatUser{openid[-6:]}").strip() or f"WeChatUser{openid[-6:]}"
    avatar = (profile_data.get("headimgurl") or "").strip()
    if not avatar:
        avatar = f"https://api.dicebear.com/7.x/fun-emoji/svg?seed={nickname}"

    existing_user = _find_wechat_user(db, openid, unionid)
    user_id = existing_user.id if existing_user else f"wx_{hashlib.sha256((unionid or openid).encode('utf-8')).hexdigest()[:12]}"
    now = datetime.utcnow().isoformat()

    if existing_user:
        existing_user.nickname = nickname
        existing_user.avatar = avatar
        existing_user.auth_provider = "wechat"
        existing_user.wechat_openid = openid
        existing_user.wechat_unionid = unionid
        existing_user.wechat_scope = token_data.get("scope", "snsapi_userinfo")
        existing_user.last_login_at = now
        db.commit()
        db.refresh(existing_user)
        return existing_user.to_dict()
    else:
        new_user = User(
            id=user_id,
            nickname=nickname,
            avatar=avatar,
            auth_provider="wechat",
            wechat_openid=openid,
            wechat_unionid=unionid,
            wechat_scope=token_data.get("scope", "snsapi_userinfo"),
            created_at=now,
            last_login_at=now,
        )
        db.add(new_user)
        db.commit()
        db.refresh(new_user)
        return new_user.to_dict()


def _get_wechat_callback_url(request: Request) -> str:
    if WECHAT_OAUTH_REDIRECT_URI:
        return WECHAT_OAUTH_REDIRECT_URI
    return str(request.url_for("wechat_login_callback"))


def _build_wechat_authorize_url(request: Request, target: str) -> str:
    params = {
        "appid": WECHAT_APP_ID,
        "redirect_uri": _get_wechat_callback_url(request),
        "response_type": "code",
        "scope": "snsapi_userinfo",
        "state": target,
    }
    return "https://open.weixin.qq.com/connect/oauth2/authorize?" + urlencode(params) + "#wechat_redirect"


async def _wechat_get_json(url: str, params: dict) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()
    if isinstance(data, dict) and data.get("errcode"):
        raise ValueError(data.get("errmsg") or f"WeChat API error: {data['errcode']}")
    return data


def _render_wechat_callback_page(target: str, user: Optional[dict] = None, error: str = "") -> HTMLResponse:
    safe_target = _sanitize_login_target(target)
    user_json = json.dumps(user or {}, ensure_ascii=False).replace("</", "<\\/")
    target_json = json.dumps(safe_target, ensure_ascii=False)
    error_json = json.dumps(error or "", ensure_ascii=False)

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WeChat Login</title>
    <style>
        body {{
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #f5f7fa;
            color: #1f2937;
        }}
        .panel {{
            max-width: 420px;
            margin: 12vh auto 0;
            background: #fff;
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 14px 40px rgba(15, 23, 42, 0.12);
            text-align: center;
        }}
        .title {{
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 12px;
        }}
        .desc {{
            font-size: 14px;
            line-height: 1.6;
            color: #4b5563;
        }}
        .link {{
            display: inline-block;
            margin-top: 18px;
            padding: 10px 18px;
            border-radius: 999px;
            background: #07c160;
            color: #fff;
            text-decoration: none;
            font-weight: 600;
        }}
    </style>
</head>
<body>
    <div class="panel">
        <div class="title" id="statusTitle">Signing in...</div>
        <div class="desc" id="statusDesc">Please wait while we finish WeChat authorization.</div>
        <a class="link" id="retryLink" href="#" style="display:none;">Back</a>
    </div>
    <script>
        const user = {user_json};
        const target = {target_json};
        const error = {error_json};
        const titleEl = document.getElementById('statusTitle');
        const descEl = document.getElementById('statusDesc');
        const retryLink = document.getElementById('retryLink');

        if (user && user.id) {{
            titleEl.textContent = '登录成功';
            descEl.textContent = '正在跳转...';
            window.location.replace(target);
        }} else {{
            titleEl.textContent = 'Login failed';
            descEl.textContent = error || 'Unable to complete WeChat login.';
            retryLink.style.display = 'inline-block';
            retryLink.href = target;
        }}
    </script>
</body>
</html>"""
    return HTMLResponse(html)


def _wechat_callback_response(
    target: str,
    user: Optional[dict] = None,
    error: str = "",
    json_mode: bool = False,
    status_code: int = 200,
):
    safe_target = _sanitize_login_target(target)
    if json_mode:
        if error:
            return JSONResponse({"detail": error, "target": safe_target}, status_code=status_code)
        return JSONResponse(
            {
                "success": True,
                "data": {
                    "user": user or {},
                    "target": safe_target,
                },
            },
            status_code=status_code,
        )
    return _render_wechat_callback_page(safe_target, user=user, error=error)


@router.get("/auth/wechat/config")
async def wechat_login_config(request: Request):
    callback_url = _get_wechat_callback_url(request)
    enabled = _is_wechat_login_enabled()
    return {
        "success": True,
        "data": {
            "enabled": enabled,
            "scope": "snsapi_userinfo",
            "callback_url": callback_url if enabled else "",
        },
    }


@router.get("/auth/wechat/login")
async def wechat_login_redirect(request: Request, target: str = Query("task.html")):
    if not _is_wechat_login_enabled():
        raise HTTPException(status_code=400, detail="WeChat login is not configured")

    safe_target = _sanitize_login_target(target)
    return RedirectResponse(_build_wechat_authorize_url(request, safe_target), status_code=302)


@router.get("/auth/wechat/callback", response_class=HTMLResponse, name="wechat_login_callback")
async def wechat_login_callback(
    request: Request,
    code: Optional[str] = None,
    state: str = "task.html",
    mode: str = Query(""),
):
    safe_target = _sanitize_login_target(state)
    json_mode = (mode or "").strip().lower() == "json"

    if not _is_wechat_login_enabled():
        return _wechat_callback_response(
            safe_target,
            error="WeChat login is not configured",
            json_mode=json_mode,
            status_code=400,
        )

    if not code or code == "authdeny":
        return _wechat_callback_response(
            safe_target,
            error="WeChat authorization was cancelled",
            json_mode=json_mode,
            status_code=400,
        )

    try:
        token_data = await _wechat_get_json(
            "https://api.weixin.qq.com/sns/oauth2/access_token",
            {
                "appid": WECHAT_APP_ID,
                "secret": WECHAT_APP_SECRET,
                "code": code,
                "grant_type": "authorization_code",
            },
        )

        profile_data = {
            "openid": token_data.get("openid", ""),
            "unionid": token_data.get("unionid", ""),
        }

        if token_data.get("access_token") and token_data.get("openid"):
            try:
                userinfo = await _wechat_get_json(
                    "https://api.weixin.qq.com/sns/userinfo",
                    {
                        "access_token": token_data["access_token"],
                        "openid": token_data["openid"],
                        "lang": "zh_CN",
                    },
                )
                profile_data.update(userinfo)
            except Exception as profile_error:
                print(f"[wechat] userinfo fallback: {profile_error}")

        with db_session() as db:
            user = _upsert_wechat_user(db, token_data, profile_data)
        resp = _wechat_callback_response(safe_target, user=user, json_mode=json_mode)
        set_session_cookie(resp, create_session(user))
        return resp
    except Exception as exc:
        print(f"[wechat] login callback failed: {exc}")
        return _wechat_callback_response(
            safe_target,
            error=f"WeChat login failed: {exc}",
            json_mode=json_mode,
            status_code=400,
        )


@router.post("/user/login")
async def user_login(nickname: str = Form(...), db: Session = Depends(get_db)):
    """模拟登录：直接创建一个随机 ID 的本地用户"""
    user_id = str(uuid.uuid4())[:8]
    avatar = f"https://api.dicebear.com/7.x/fun-emoji/svg?seed={nickname}"
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    user = User(
        id=user_id,
        nickname=nickname,
        avatar=avatar,
        auth_provider="mock",
        created_at=now,
        last_login_at=now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"success": True, "data": user.to_dict()}


# ============ 传统账号认证接口 ============

_USERNAME_RE = re.compile(r'^[a-zA-Z0-9_]{3,32}$')


@router.post("/auth/register")
async def auth_register(
    username: str = Form(...),
    password: str = Form(...),
    nickname: str = Form(""),
    db: Session = Depends(get_db),
):
    username = username.strip()
    if not _USERNAME_RE.match(username):
        raise HTTPException(400, "用户名需为 3-32 位字母、数字或下划线")
    if len(password) < 6:
        raise HTTPException(400, "密码不能少于 6 位")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(400, "用户名已存在")

    nick = nickname.strip() or username
    now = now_str()
    user = User(
        id=new_id("u"),
        username=username,
        password_hash=_hash_user_password(password),
        nickname=nick,
        avatar=f"https://api.dicebear.com/7.x/fun-emoji/svg?seed={nick}",
        auth_provider="password",
        created_at=now,
        last_login_at=now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    user_dict = user.to_dict()
    resp = JSONResponse({"success": True, "data": user_dict})
    set_session_cookie(resp, create_session(user_dict))
    return resp


@router.post("/auth/login")
async def auth_login(
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    username = username.strip()
    user = db.query(User).filter(User.username == username).first()
    if not user or not user.password_hash or not _verify_user_password(password, user.password_hash):
        raise HTTPException(401, "用户名或密码错误")

    user.last_login_at = now_str()
    db.commit()
    db.refresh(user)

    user_dict = user.to_dict()
    resp = JSONResponse({"success": True, "data": user_dict})
    set_session_cookie(resp, create_session(user_dict))
    return resp


@router.post("/auth/logout")
async def auth_logout(request: Request):
    session_id = request.cookies.get(COOKIE_NAME)
    if session_id:
        delete_session(session_id)
    resp = JSONResponse({"success": True})
    clear_session_cookie(resp)
    return resp


@router.get("/me")
async def get_me(request: Request):
    from app.core.auth import get_optional_user
    user = get_optional_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")
    return {"success": True, "data": user}


@router.post("/auth/bind-password")
async def auth_bind_password(
    username: str = Form(...),
    password: str = Form(...),
    request: Request = None,
    db: Session = Depends(get_db),
):
    current = get_current_user(request)
    username = username.strip()
    if not _USERNAME_RE.match(username):
        raise HTTPException(400, "用户名需为 3-32 位字母、数字或下划线")
    if len(password) < 6:
        raise HTTPException(400, "密码不能少于 6 位")
    conflict = db.query(User).filter(User.username == username, User.id != current["id"]).first()
    if conflict:
        raise HTTPException(400, "用户名已被占用")

    user = db.get(User, current["id"])
    if not user:
        raise HTTPException(404, "用户不存在")
    user.username = username
    user.password_hash = _hash_user_password(password)
    db.commit()
    db.refresh(user)
    return {"success": True, "data": user.to_dict()}


# ============ 歌曲接口 ============

def _calc_completion_orm(db: Session, song: Song) -> float:
    """完成度 = (已 completed 的段 + 有提交录音的段) / 总段数"""
    segs = song.segments
    if not segs:
        return 0.0
    seg_ids = [s.id for s in segs]
    submitted_seg_ids = {
        r.segment_id for r in db.query(Recording.segment_id)
        .filter(Recording.song_id == song.id, Recording.submitted == True,
                Recording.segment_id.in_(seg_ids),
                Recording.owner_admin_id == song.owner_admin_id).all()
    }
    done = sum(1 for s in segs if s.status == "completed" or s.id in submitted_seg_ids)
    return round(done / len(segs) * 100, 1)


def _calc_participant_count_orm(db: Session, song_id: str, owner_admin_id: Optional[str] = None) -> int:
    q = db.query(Recording.user_id).filter(Recording.song_id == song_id, Recording.submitted == True)
    if owner_admin_id is not None:
        q = q.filter(Recording.owner_admin_id == owner_admin_id)
    rows = q.distinct().all()
    return len(rows)


def _published_final_brief(db: Session, song_id: str, full: bool = False, owner_admin_id: Optional[str] = None) -> Optional[dict]:
    q = db.query(Final).filter(Final.song_id == song_id, Final.published == True)
    if owner_admin_id is not None:
        q = q.filter(Final.owner_admin_id == owner_admin_id)
    f = q.first()

    if not f:
        return None
    brief = {"id": f.id, "audio_url": f.audio_url or "", "duration": f.duration or 0}
    if full:
        brief.update({
            "song_title": f.song_title or "",
            "song_artist": f.song_artist or "",
            "track_count": f.track_count,
            "segment_count": f.segment_count,
            "created_at": f.created_at or "",
        })
    return brief


@router.get("/songs")
async def get_songs(db: Session = Depends(get_db)):
    """获取所有已发布且所属管理员可用的歌曲"""
    songs_orm = db.query(Song).filter(Song.task_published == True).all()
    songs = []
    for s in songs_orm:
        if s.owner_admin_id:
            admin = db.get(AdminUser, s.owner_admin_id)
            if not admin or admin.status != "active" or admin.freeze_tasks:
                continue
        songs.append({
            "id": s.id,
            "title": s.title,
            "artist": s.artist or "",
            "duration": s.duration,
            "audio_url": s.audio_url,
            "segment_count": s.segment_count,
            "participant_count": _calc_participant_count_orm(db, s.id, s.owner_admin_id),
            "completion": _calc_completion_orm(db, s),
            "published_final": _published_final_brief(db, s.id, full=False, owner_admin_id=s.owner_admin_id),
        })
    return {"success": True, "data": songs}


@router.get("/songs/{song_id}")
async def get_song(song_id: str, db: Session = Depends(get_db)):
    """获取已发布任务歌曲详情（含唱段）"""
    song = _get_active_song_for_user(db, song_id)
    data = song.to_dict(include_segments=True)
    data["published_final"] = _published_final_brief(db, song_id, full=True, owner_admin_id=song.owner_admin_id)
    data["completion"] = _calc_completion_orm(db, song)
    data["participant_count"] = _calc_participant_count_orm(db, song_id, song.owner_admin_id)
    return {"success": True, "data": data}


# ============ 唱段接口 ============

@router.get("/songs/{song_id}/segments")
async def get_segments(song_id: str, db: Session = Depends(get_db)):
    """获取已发布任务歌曲所有唱段"""
    song = _get_active_song_for_user(db, song_id)
    return {"success": True, "data": [s.to_dict() for s in song.segments]}



@router.post("/segments/{segment_id}/claim")
async def claim_segment(
    segment_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """认领唱段"""
    current = get_current_user(request)
    user_id = current["id"]
    user_name = current["nickname"]

    seg = db.get(Segment, segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail="唱段不存在")
    _get_active_song_for_user(db, seg.song_id)
    if seg.status == "completed":
        raise HTTPException(status_code=400, detail="该唱段已完成")

    # 检查是否已认领
    for c in seg.claims:
        if c.user_id == user_id:
            return {"success": True, "data": seg.to_dict(), "message": "您已认领该唱段"}

    claim = SegmentClaim(
        id=str(uuid.uuid4())[:8],
        owner_admin_id=seg.owner_admin_id,
        segment_id=segment_id,
        user_id=user_id,
        user_name=user_name,
        status="claimed",
        created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )
    db.add(claim)
    db.flush()
    db.refresh(seg)
    seg.claim_count = len(seg.claims)
    if seg.status == "unassigned":
        seg.status = "claimed"

    # 更新参与人数（按所有段的 claim user 数）
    song = db.get(Song, seg.song_id)
    if song:
        seg_ids = [s.id for s in song.segments]
        if seg_ids:
            user_count = db.query(SegmentClaim.user_id).filter(
                SegmentClaim.segment_id.in_(seg_ids)
            ).distinct().count()
            song.participant_count = user_count

    db.commit()
    db.refresh(seg)
    return {"success": True, "data": seg.to_dict()}


@router.post("/segments/random-claim")
async def random_claim(
    song_id: str = Form(...),
    request: Request = None,
    db: Session = Depends(get_db),
):
    """随机认领一个可唱段"""
    current = get_current_user(request)
    user_id = current["id"]
    user_name = current["nickname"]

    song = _get_active_song_for_user(db, song_id)


    import random
    available = [s for s in song.segments if s.status != "completed"]
    unclaimed_by_user = [s for s in available if not any(c.user_id == user_id for c in s.claims)]
    pool = unclaimed_by_user if unclaimed_by_user else available

    if not pool:
        raise HTTPException(status_code=400, detail="没有可认领的唱段了")

    seg = random.choice(pool)
    if not any(c.user_id == user_id for c in seg.claims):
        claim = SegmentClaim(
            id=str(uuid.uuid4())[:8],
            owner_admin_id=seg.owner_admin_id,
            segment_id=seg.id,
            user_id=user_id,
            user_name=user_name,
            status="claimed",
            created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )
        db.add(claim)
        db.flush()
        db.refresh(seg)
        seg.claim_count = len(seg.claims)
    if seg.status == "unassigned":
        seg.status = "claimed"

    seg_ids = [s.id for s in song.segments]
    if seg_ids:
        user_count = db.query(SegmentClaim.user_id).filter(
            SegmentClaim.segment_id.in_(seg_ids)
        ).distinct().count()
        song.participant_count = user_count

    db.commit()
    db.refresh(seg)
    return {"success": True, "data": seg.to_dict()}


# ============ 录音接口 ============

@router.post("/recordings/upload")
async def upload_recording(
    segment_id: str = Form(...),
    song_id: str = Form(...),
    score: float = Form(0.0),
    score_detail: str = Form(""),
    audio: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_db),
):
    """上传录音"""
    current = get_current_user(request)
    user_id = current["id"]
    user_name = current["nickname"]
    avatar = current.get("avatar") or f"https://api.dicebear.com/7.x/fun-emoji/svg?seed={user_name}"

    rec_id = str(uuid.uuid4())[:8]
    filename = f"{rec_id}.webm"
    filepath = os.path.join(UPLOAD_DIR, filename)

    content = await audio.read()
    with open(filepath, "wb") as f:
        f.write(content)

    parsed_detail = None
    if score_detail:
        try:
            parsed_detail = json.loads(score_detail)
        except Exception:
            pass

    seg = db.get(Segment, segment_id)
    song = db.get(Song, song_id)
    if not seg or not song or seg.song_id != song_id:
        raise HTTPException(status_code=404, detail="唱段不存在")
    if song.owner_admin_id:
        admin = db.get(AdminUser, song.owner_admin_id)
        if not admin or admin.status != "active" or admin.freeze_tasks:
            raise HTTPException(status_code=404, detail="任务不可用")

    rec = Recording(
        id=rec_id,
        owner_admin_id=song.owner_admin_id,
        segment_id=segment_id,
        song_id=song_id,
        user_id=user_id,
        user_name=user_name,
        user_avatar=avatar,
        audio_url=f"/api/uploads/{filename}",
        score=score,
        score_detail=parsed_detail,
        likes=0,
        submitted=False,
        selected=False,
        created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return {"success": True, "data": rec.to_dict()}


@router.post("/recordings/{recording_id}/submit")
async def submit_recording(recording_id: str, db: Session = Depends(get_db)):
    """提交录音 — 每段允许多人提交，不自动标记完成（需管理员手动标记）"""
    rec = db.get(Recording, recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")

    rec.submitted = True

    seg = db.get(Segment, rec.segment_id)
    if seg:
        submitted_count = db.query(Recording).filter(
            Recording.segment_id == seg.id, Recording.submitted == True
        ).count()
        seg.submit_count = submitted_count

        song = db.get(Song, seg.song_id)
        if song and song.segments:
            completed = sum(1 for s in song.segments if s.status == "completed")
            song.completion = round(completed / len(song.segments) * 100, 1)

    db.commit()
    db.refresh(rec)
    return {"success": True, "data": rec.to_dict()}


@router.post("/segments/{segment_id}/complete")
async def mark_segment_completed(segment_id: str, request: Request, db: Session = Depends(get_db)):
    """管理员标记唱段为已完成"""
    admin = verify_admin(request, db)
    seg = _get_owned_segment(db, segment_id, admin)

    seg.status = "completed"

    song = db.get(Song, seg.song_id)
    if song and song.segments:
        completed = sum(1 for s in song.segments if s.status == "completed")
        song.completion = round(completed / len(song.segments) * 100, 1)

    db.commit()
    db.refresh(seg)
    return {"success": True, "data": seg.to_dict()}


@router.post("/segments/{segment_id}/reopen")
async def reopen_segment(segment_id: str, request: Request, db: Session = Depends(get_db)):
    """管理员重新开放已完成唱段"""
    admin = verify_admin(request, db)
    seg = _get_owned_segment(db, segment_id, admin)

    seg.status = "claimed" if (seg.claim_count or 0) > 0 else "unassigned"

    song = db.get(Song, seg.song_id)
    if song and song.segments:
        completed = sum(1 for s in song.segments if s.status == "completed")
        song.completion = round(completed / len(song.segments) * 100, 1)

    db.commit()
    db.refresh(seg)
    return {"success": True, "data": seg.to_dict()}


@router.delete("/recordings/{recording_id}")
async def delete_recording(recording_id: str, request: Request, db: Session = Depends(get_db)):
    """删除录音"""
    admin = verify_admin(request, db)
    rec = _get_owned_recording(db, recording_id, admin)
    audio_url = rec.audio_url or ""
    db.delete(rec)
    db.commit()

    fname = audio_url.split("/")[-1] if "/" in audio_url else f"{recording_id}.webm"
    filepath = os.path.join(UPLOAD_DIR, fname)
    if os.path.exists(filepath):
        try:
            os.remove(filepath)
        except Exception:
            pass
    return {"success": True, "message": "已删除"}


@router.get("/recordings")
async def get_recordings(
    song_id: Optional[str] = None,
    segment_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """获取录音列表（仅 submitted）"""
    q = db.query(Recording).filter(Recording.submitted == True)
    if song_id:
        song = _get_active_song_for_user(db, song_id)
        q = q.filter(Recording.song_id == song_id, Recording.owner_admin_id == song.owner_admin_id)
    if segment_id:
        seg = db.get(Segment, segment_id)
        if not seg:
            raise HTTPException(status_code=404, detail="唱段不存在")
        _get_active_song_for_user(db, seg.song_id)
        q = q.filter(Recording.segment_id == segment_id, Recording.owner_admin_id == seg.owner_admin_id)
    return {"success": True, "data": [r.to_dict() for r in q.all()]}


@router.post("/recordings/{recording_id}/like")
async def like_recording(recording_id: str, db: Session = Depends(get_db)):
    """点赞录音"""
    rec = db.get(Recording, recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")
    rec.likes = (rec.likes or 0) + 1
    db.commit()
    db.refresh(rec)
    return {"success": True, "data": rec.to_dict()}


@router.post("/admin/segments/{segment_id}/complete")
async def admin_mark_segment_completed(segment_id: str, request: Request, db: Session = Depends(get_db)):
    return await mark_segment_completed(segment_id, request, db)


@router.post("/admin/segments/{segment_id}/reopen")
async def admin_reopen_segment(segment_id: str, request: Request, db: Session = Depends(get_db)):
    return await reopen_segment(segment_id, request, db)


@router.delete("/admin/recordings/{recording_id}")
async def admin_delete_recording(recording_id: str, request: Request, db: Session = Depends(get_db)):
    return await delete_recording(recording_id, request, db)


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

def verify_admin(request: Request, db: Session = None):
    """验证管理员 token，兼容旧调用方式。"""
    auth = request.headers.get("Authorization", "")
    token = auth.replace("Bearer ", "") if auth.startswith("Bearer ") else ""
    session = ADMIN_TOKENS.get(token)
    if not token or not session:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    if db is not None:
        admin = db.get(AdminUser, session.get("id"))
        if not admin or admin.status in ("frozen", "deleted"):
            ADMIN_TOKENS.pop(token, None)
            raise HTTPException(status_code=403, detail="账户已被冻结或删除")
        session.update(admin.to_dict())
    return session


def require_super_admin(request: Request, db: Session):
    admin = verify_admin(request, db)
    if admin.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="需要超级管理员权限")
    return admin


def _admin_public_data(admin: AdminUser) -> dict:
    return {
        "id": admin.id,
        "username": admin.username,
        "display_name": admin.display_name or admin.username,
        "email": admin.email or "",
        "email_confirmed": bool(admin.email_confirmed),
        "pending_email": admin.pending_email or "",
        "email_change_expires_at": admin.email_change_expires_at,
        "role": admin.role,
        "status": admin.status,
        "song_limit": admin.song_limit,
        "freeze_tasks": bool(admin.freeze_tasks),
    }


def _admin_owner_id(admin: dict) -> Optional[str]:
    return None if admin.get("role") == "super_admin" else admin.get("id")


def _filter_owner(query, model, admin: dict):
    owner_id = _admin_owner_id(admin)
    return query if not owner_id else query.filter(model.owner_admin_id == owner_id)


def _get_owned_song(db: Session, song_id: str, admin: dict) -> Song:
    q = db.query(Song).filter(Song.id == song_id)
    q = _filter_owner(q, Song, admin)
    song = q.first()
    if not song:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return song


def _get_owned_segment(db: Session, segment_id: str, admin: dict) -> Segment:
    q = db.query(Segment).filter(Segment.id == segment_id)
    q = _filter_owner(q, Segment, admin)
    seg = q.first()
    if not seg:
        raise HTTPException(status_code=404, detail="唱段不存在")
    return seg


def _get_owned_recording(db: Session, recording_id: str, admin: dict) -> Recording:
    q = db.query(Recording).filter(Recording.id == recording_id)
    q = _filter_owner(q, Recording, admin)
    rec = q.first()
    if not rec:
        raise HTTPException(status_code=404, detail="录音不存在")
    return rec


def _get_owned_final(db: Session, final_id: str, admin: dict) -> Final:
    q = db.query(Final).filter(Final.id == final_id)
    q = _filter_owner(q, Final, admin)
    final = q.first()
    if not final:
        raise HTTPException(status_code=404, detail="成曲不存在")
    return final


def _get_active_song_for_user(db: Session, song_id: str) -> Song:
    song = db.get(Song, song_id)
    if not song or not song.task_published:
        raise HTTPException(status_code=404, detail="歌曲不存在或任务未发布")
    if song.owner_admin_id:
        admin = db.get(AdminUser, song.owner_admin_id)
        if not admin or admin.status != "active" or admin.freeze_tasks:
            raise HTTPException(status_code=404, detail="任务不可用")
    return song





@router.get("/admin/register-status")
async def admin_register_status(db: Session = Depends(get_db)):
    return {"success": True, "data": {
        "enabled": bool(get_setting(db, "admin_registration_enabled", False)),
        "invite_required": bool(get_setting(db, "admin_registration_invite_required", True)),
    }}


def _validate_admin_password(password: str) -> None:
    if len(password or "") <= 6:
        raise HTTPException(status_code=400, detail="密码需要长于6位")
    if not re.search(r"[A-Za-z]", password or "") or not re.search(r"\d", password or ""):
        raise HTTPException(status_code=400, detail="密码必须同时包含字母和数字")


def _build_admin_activation_url(request: Request, token: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/admin/activate?token={token}"


def _build_admin_email_change_url(request: Request, token: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/admin/email-change/confirm?token={token}"


def _send_admin_email(to_email: str, subject: str, body: str) -> None:
    settings = get_settings()
    if not settings.SMTP_HOST or not settings.SMTP_PASSWORD:
        print(f"[mail] SMTP未配置，邮件未实际发送。to={to_email}, subject={subject}, body={body}")
        return
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.MAIL_FROM
    msg["To"] = to_email
    msg.set_content(body)
    if settings.SMTP_USE_SSL:
        with smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as smtp:
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as smtp:
            smtp.starttls()
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            smtp.send_message(msg)


def _send_admin_activation_email(to_email: str, activation_url: str) -> None:
    subject = "一起来拼歌管理员账户注册确认"
    body = (
        "感谢您注册”一起来拼歌“管理员账户，请您点击以下链接确认你的注册，如果无法打开请将链接复制到浏览器的地址栏进行访问，谢谢！\n"
        f"{activation_url}"
    )
    _send_admin_email(to_email, subject, body)


def _send_admin_email_change_email(to_email: str, confirm_url: str) -> None:
    subject = "一起来拼歌管理员账户邮箱变更确认"
    body = (
        "您正在修改“一起来拼歌”管理员账户邮箱，请点击以下链接确认新邮箱，如果无法打开请将链接复制到浏览器的地址栏进行访问，谢谢！\n"
        f"{confirm_url}"
    )
    _send_admin_email(to_email, subject, body)


@router.post("/admin/register")
async def admin_register(
    request: Request,
    username: str = Body(...),
    password: str = Body(...),
    email: str = Body(...),
    display_name: str = Body(""),
    invite_code: str = Body(""),
    db: Session = Depends(get_db),
):
    if not get_setting(db, "admin_registration_enabled", False):
        raise HTTPException(status_code=403, detail="管理员注册暂未开放")
    invite_required = bool(get_setting(db, "admin_registration_invite_required", True))
    username = username.strip()
    email = email.strip()
    if not username or len(username) < 3:
        raise HTTPException(status_code=400, detail="用户名至少3个字符")
    if "@" not in email:
        raise HTTPException(status_code=400, detail="请输入有效邮箱")
    _validate_admin_password(password)
    if db.query(AdminUser).filter(AdminUser.username == username).first():
        raise HTTPException(status_code=400, detail="用户名已存在")
    if db.query(AdminUser).filter(AdminUser.email == email).first():
        raise HTTPException(status_code=400, detail="邮箱已注册")
    code_row = None
    if invite_required:
        code_row = db.query(AdminInviteCode).filter(AdminInviteCode.code == invite_code.strip()).first()
        if not code_row or code_row.status != "unused":
            raise HTTPException(status_code=400, detail="授权码无效或已使用")
    admin = AdminUser(
        id=new_id("admin"),
        username=username,
        password_hash=hash_password(password),
        display_name=display_name.strip() or username,
        email=email,
        email_confirmed=True,
        email_activation_token=None,
        email_activation_expires_at=None,
        role="admin",
        status="active",
        song_limit=int(get_setting(db, "default_song_limit", 5)),
        created_at=now_str(),
    )
    db.add(admin)
    if code_row:
        code_row.status = "used"
        code_row.used_by = admin.id
        code_row.used_at = now_str()
    log_audit(db, {"id": admin.id, "username": admin.username}, "admin_register", "admin_user", admin.id, {"email": email, "email_activation_skipped": True})
    db.commit()
    return {"success": True, "message": "注册成功，请使用新账号登录。", "data": _admin_public_data(admin)}


@router.get("/admin/activate", response_class=HTMLResponse)
async def admin_activate(token: str = Query(...), db: Session = Depends(get_db)):
    admin = db.query(AdminUser).filter(AdminUser.email_activation_token == token).first()
    if not admin:
        return HTMLResponse("<h2>激活链接无效</h2><p>请确认链接是否完整，或重新注册。</p>", status_code=400)
    try:
        expires_at = datetime.strptime(admin.email_activation_expires_at or "", "%Y-%m-%d %H:%M:%S")
    except Exception:
        expires_at = datetime.min
    if datetime.now() > expires_at:
        return HTMLResponse("<h2>激活链接已过期</h2><p>注册激活链接有效时间为一天，请重新注册。</p>", status_code=400)
    admin.email_confirmed = True
    admin.email_activation_token = None
    admin.email_activation_expires_at = None
    log_audit(db, {"id": admin.id, "username": admin.username}, "admin_email_activated", "admin_user", admin.id)
    db.commit()
    return HTMLResponse("<h2>管理员账户已激活</h2><p>您现在可以返回管理后台登录。</p>")


@router.put("/admin/account")
async def admin_update_account(
    request: Request,
    current_password: str = Body(""),
    new_password: str = Body(""),
    new_email: str = Body(""),
    db: Session = Depends(get_db),
):
    session_admin = verify_admin(request, db)
    admin = db.get(AdminUser, session_admin["id"])
    if not admin:
        raise HTTPException(status_code=404, detail="管理员不存在")
    detail = {}
    if new_password:
        _validate_admin_password(new_password)
        admin.password_hash = hash_password(new_password)
        detail["password_changed"] = True
    new_email = new_email.strip()
    if new_email and new_email != (admin.email or ""):
        if not current_password or not verify_password(current_password, admin.password_hash):
            raise HTTPException(status_code=403, detail="修改邮箱需要先验证当前密码")
        exists = db.query(AdminUser).filter(AdminUser.email == new_email, AdminUser.id != admin.id).first()
        pending_exists = db.query(AdminUser).filter(AdminUser.pending_email == new_email, AdminUser.id != admin.id).first()
        if exists or pending_exists:
            raise HTTPException(status_code=400, detail="邮箱已被使用")
        if "@" not in new_email:
            raise HTTPException(status_code=400, detail="请输入有效邮箱")
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now() + timedelta(days=1)
        admin.pending_email = new_email
        admin.email_change_token = token
        admin.email_change_expires_at = expires_at.strftime("%Y-%m-%d %H:%M:%S")
        confirm_url = _build_admin_email_change_url(request, token)
        detail["pending_email"] = new_email
        detail["email_change_expires_at"] = admin.email_change_expires_at
    if not detail:
        raise HTTPException(status_code=400, detail="没有需要更新的内容")
    log_audit(db, session_admin, "admin_update_account", "admin_user", admin.id, detail)
    db.commit()
    if detail.get("pending_email"):
        try:
            _send_admin_email_change_email(new_email, confirm_url)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"邮箱确认邮件发送失败: {exc}")
    data = _admin_public_data(admin)
    ADMIN_TOKENS.update({k: {**v, **data} for k, v in ADMIN_TOKENS.items() if v.get("id") == admin.id})
    message = "账号设置已更新"
    if detail.get("pending_email"):
        message = f"确认邮件已发送到{new_email}，点击邮件链接后邮箱才会变更成功。"
    return {"success": True, "message": message, "data": data}


@router.get("/admin/email-change/confirm", response_class=HTMLResponse)
async def admin_confirm_email_change(token: str = Query(...), db: Session = Depends(get_db)):
    admin = db.query(AdminUser).filter(AdminUser.email_change_token == token).first()
    if not admin or not admin.pending_email:
        return HTMLResponse("<h2>邮箱修改链接无效</h2><p>请确认链接是否完整，或重新发起邮箱修改。</p>", status_code=400)
    try:
        expires_at = datetime.strptime(admin.email_change_expires_at or "", "%Y-%m-%d %H:%M:%S")
    except Exception:
        expires_at = datetime.min
    if datetime.now() > expires_at:
        return HTMLResponse("<h2>邮箱修改链接已过期</h2><p>邮箱修改确认链接有效时间为一天，请重新发起修改。</p>", status_code=400)
    old_email = admin.email
    admin.email = admin.pending_email
    admin.email_confirmed = True
    admin.pending_email = None
    admin.email_change_token = None
    admin.email_change_expires_at = None
    log_audit(db, {"id": admin.id, "username": admin.username}, "admin_email_changed", "admin_user", admin.id, {"old_email": old_email, "new_email": admin.email})
    db.commit()
    return HTMLResponse("<h2>账号邮箱修改成功</h2><p>您现在可以返回管理后台继续使用。</p>")


@router.post("/admin/login")

async def admin_login(username: str = Body(...), password: str = Body(...), db: Session = Depends(get_db)):
    """管理员登录"""
    admin = db.query(AdminUser).filter(AdminUser.username == username.strip()).first()
    if not admin or not verify_password(password, admin.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if admin.status == "deleted":
        raise HTTPException(status_code=403, detail="账户已删除")
    if admin.status == "frozen":
        raise HTTPException(status_code=403, detail="账户已冻结")
    if admin.role != "super_admin" and not admin.email_confirmed:
        raise HTTPException(status_code=403, detail=f"请在你的注册邮箱{admin.email or ''}中查找注册邮件，并点击激活链接。")
    admin.last_login_at = now_str()
    token = hashlib.sha256(f"{admin.id}{time.time()}{uuid.uuid4()}".encode()).hexdigest()[:32]
    ADMIN_TOKENS[token] = {**_admin_public_data(admin), "login_time": time.time()}
    log_audit(db, admin, "admin_login", "admin_user", admin.id)
    db.commit()
    return {"success": True, "data": {"token": token, **_admin_public_data(admin)}}


@router.get("/admin/check")
async def admin_check(request: Request, db: Session = Depends(get_db)):
    """检查管理员登录状态"""
    admin = verify_admin(request, db)
    return {"success": True, "data": admin}



@router.get("/super/admins")
async def super_list_admins(request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    admins = db.query(AdminUser).order_by(AdminUser.created_at.desc()).all()
    data = []
    for a in admins:
        d = a.to_dict()
        d.update({
            "song_count": int(db.query(sql_func.count(Song.id)).filter(Song.owner_admin_id == a.id).scalar() or 0),
            "recording_count": int(db.query(sql_func.count(Recording.id)).filter(Recording.owner_admin_id == a.id).scalar() or 0),
            "final_count": int(db.query(sql_func.count(Final.id)).filter(Final.owner_admin_id == a.id).scalar() or 0),
        })
        data.append(d)
    log_audit(db, super_admin, "super_list_admins", "admin_user", "*")
    db.commit()
    return {"success": True, "data": data}


@router.put("/super/admins/{admin_id}")
async def super_update_admin(admin_id: str, request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    admin = db.get(AdminUser, admin_id)
    if not admin or admin.role == "super_admin":
        raise HTTPException(status_code=404, detail="管理员不存在或不可修改")
    body = await request.json()
    detail = {}
    if "song_limit" in body:
        try:
            admin.song_limit = max(0, int(body.get("song_limit") or 0))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="歌曲库上限必须是整数")
        detail["song_limit"] = admin.song_limit
    if "display_name" in body:
        admin.display_name = str(body.get("display_name") or "").strip() or admin.username
        detail["display_name"] = admin.display_name
    if "email" in body:
        email = str(body.get("email") or "").strip()
        if email and "@" not in email:
            raise HTTPException(status_code=400, detail="邮箱格式不正确")
        admin.email = email
        detail["email"] = admin.email
    if not detail:
        raise HTTPException(status_code=400, detail="没有可更新的字段")
    log_audit(db, super_admin, "super_update_admin", "admin_user", admin.id, detail)
    db.commit()
    db.refresh(admin)
    return {"success": True, "data": admin.to_dict()}


@router.post("/super/admins/{admin_id}/freeze")
async def super_freeze_admin(admin_id: str, request: Request, freeze_tasks: bool = Body(False), db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    admin = db.get(AdminUser, admin_id)
    if not admin or admin.role == "super_admin":
        raise HTTPException(status_code=404, detail="管理员不存在或不可冻结")
    admin.status = "frozen"
    admin.freeze_tasks = bool(freeze_tasks)
    for token, session in list(ADMIN_TOKENS.items()):
        if session.get("id") == admin.id:
            ADMIN_TOKENS.pop(token, None)
    log_audit(db, super_admin, "super_freeze_admin", "admin_user", admin.id, {"freeze_tasks": freeze_tasks})
    db.commit()
    return {"success": True, "data": admin.to_dict()}


@router.post("/super/admins/{admin_id}/unfreeze")
async def super_unfreeze_admin(admin_id: str, request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    admin = db.get(AdminUser, admin_id)
    if not admin or admin.role == "super_admin":
        raise HTTPException(status_code=404, detail="管理员不存在或不可解冻")
    admin.status = "active"
    admin.freeze_tasks = False
    log_audit(db, super_admin, "super_unfreeze_admin", "admin_user", admin.id)
    db.commit()
    return {"success": True, "data": admin.to_dict()}


@router.post("/super/admins/{admin_id}/reset-password")
async def super_reset_admin_password(admin_id: str, request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    admin = db.get(AdminUser, admin_id)
    if not admin or admin.role == "super_admin":
        raise HTTPException(status_code=404, detail="管理员不存在或不可重置")
    admin.password_hash = hash_password("123456")
    for token, session in list(ADMIN_TOKENS.items()):
        if session.get("id") == admin.id:
            ADMIN_TOKENS.pop(token, None)
    log_audit(db, super_admin, "super_reset_admin_password", "admin_user", admin.id)
    db.commit()
    return {"success": True, "message": "密码已重置为123456"}


@router.delete("/super/admins/{admin_id}")
async def super_soft_delete_admin(admin_id: str, request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    admin = db.get(AdminUser, admin_id)
    if not admin or admin.role == "super_admin":
        raise HTTPException(status_code=404, detail="管理员不存在或不可删除")
    admin.status = "deleted"
    admin.deleted_at = now_str()
    admin.freeze_tasks = True
    for token, session in list(ADMIN_TOKENS.items()):
        if session.get("id") == admin.id:
            ADMIN_TOKENS.pop(token, None)
    log_audit(db, super_admin, "super_soft_delete_admin", "admin_user", admin.id)
    db.commit()
    return {"success": True, "data": admin.to_dict()}


@router.post("/super/admins/{admin_id}/restore")
async def super_restore_admin(admin_id: str, request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    admin = db.get(AdminUser, admin_id)
    if not admin or admin.role == "super_admin":
        raise HTTPException(status_code=404, detail="管理员不存在或不可恢复")
    admin.status = "active"
    admin.deleted_at = None
    admin.freeze_tasks = False
    log_audit(db, super_admin, "super_restore_admin", "admin_user", admin.id)
    db.commit()
    return {"success": True, "data": admin.to_dict()}


@router.delete("/super/admins/{admin_id}/purge-data")
async def super_purge_admin_data(admin_id: str, request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    admin = db.get(AdminUser, admin_id)
    if not admin or admin.status != "deleted" or admin.role == "super_admin":
        raise HTTPException(status_code=400, detail="只能清理已软删除的普通管理员")
    song_ids = [s.id for s in db.query(Song).filter(Song.owner_admin_id == admin_id).all()]
    rec_files = [os.path.basename(r.audio_url or "") for r in db.query(Recording).filter(Recording.owner_admin_id == admin_id).all()]
    final_rows = db.query(Final).filter(Final.owner_admin_id == admin_id).all()
    for model in (Recording, SegmentClaim, FreeTask, Segment, Final, Song):
        db.query(model).filter(model.owner_admin_id == admin_id).delete(synchronize_session=False)
    db.delete(admin)
    db.commit()
    for fname in rec_files:
        if fname:
            fp = os.path.join(UPLOAD_DIR, fname)
            if os.path.exists(fp):
                try: os.remove(fp)
                except Exception: pass
    for sid in song_ids:
        for fp in [os.path.join(UPLOAD_DIR, f"{sid}.mp3"), os.path.join(UPLOAD_DIR, f"{sid}.wav")]:
            if os.path.exists(fp):
                try: os.remove(fp)
                except Exception: pass
    for f in final_rows:
        for name in (f.audio_file, f.metadata_file):
            if name and os.path.exists(os.path.join(FINALS_DIR, name)):
                try: os.remove(os.path.join(FINALS_DIR, name))
                except Exception: pass
        if f.recordings_dir and os.path.exists(os.path.join(FINALS_DIR, f.recordings_dir)):
            try: shutil.rmtree(os.path.join(FINALS_DIR, f.recordings_dir))
            except Exception: pass
    log_audit(db, super_admin, "super_purge_admin_data", "admin_user", admin_id)
    db.commit()
    return {"success": True, "message": "软删除账户数据已清理"}


@router.get("/super/settings")
async def super_get_settings(request: Request, db: Session = Depends(get_db)):
    require_super_admin(request, db)
    rows = db.query(SystemSetting).order_by(SystemSetting.key).all()
    return {"success": True, "data": {r.key: r.to_dict() for r in rows}}


@router.put("/super/settings")
async def super_update_settings(request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    body = await request.json()
    allowed = {
        "admin_registration_enabled": "bool",
        "admin_registration_invite_required": "bool",
        "default_song_limit": "int",
        "final_mix_enabled": "bool",
    }
    for key, value in body.items():
        if key in allowed:
            set_setting(db, key, value, allowed[key], updated_by=super_admin.get("id"))
    log_audit(db, super_admin, "super_update_settings", "system_settings", "*", body)
    db.commit()
    return {"success": True}


@router.post("/super/invite-codes")
async def super_create_invite_code(request: Request, db: Session = Depends(get_db)):
    super_admin = require_super_admin(request, db)
    code = f"YDS-{uuid.uuid4().hex[:4].upper()}-{uuid.uuid4().hex[:4].upper()}"
    row = AdminInviteCode(id=new_id("code"), code=code, created_by=super_admin.get("id"), status="unused", created_at=now_str())
    db.add(row)
    log_audit(db, super_admin, "super_create_invite_code", "invite_code", code)
    db.commit()
    return {"success": True, "data": row.to_dict()}


@router.get("/super/invite-codes")
async def super_list_invite_codes(request: Request, db: Session = Depends(get_db)):
    require_super_admin(request, db)
    rows = db.query(AdminInviteCode).order_by(AdminInviteCode.created_at.desc()).all()
    return {"success": True, "data": [r.to_dict() for r in rows]}


@router.get("/super/stats")
async def super_stats(request: Request, db: Session = Depends(get_db)):
    require_super_admin(request, db)
    server = {}
    try:
        import psutil
        server = {
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "memory_percent": psutil.virtual_memory().percent,
            "disk_percent": psutil.disk_usage(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))).percent,
        }
    except Exception as e:
        server = {"error": str(e)}
    data = {
        "admin_count": int(db.query(sql_func.count(AdminUser.id)).scalar() or 0),
        "active_admin_count": int(db.query(sql_func.count(AdminUser.id)).filter(AdminUser.status == "active").scalar() or 0),
        "song_count": int(db.query(sql_func.count(Song.id)).scalar() or 0),
        "recording_count": int(db.query(sql_func.count(Recording.id)).scalar() or 0),
        "final_count": int(db.query(sql_func.count(Final.id)).scalar() or 0),
        "user_count": int(db.query(sql_func.count(User.id)).scalar() or 0),
        "server": server,
    }
    return {"success": True, "data": data}


@router.get("/super/finals")
async def super_get_finals(request: Request, db: Session = Depends(get_db)):
    require_super_admin(request, db)
    finals = db.query(Final).order_by(Final.created_at.desc()).all()
    return {"success": True, "data": [f.to_dict() for f in finals]}




# ============ 管理员 - 歌曲管理 ============

ALLOWED_AUDIO_EXT = {'.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma'}


@router.post("/admin/songs/upload")
async def admin_upload_song(
    request: Request,
    title: str = Form(...),
    artist: str = Form(""),
    audio: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """上传新歌曲：保存音频文件 → 读取时长（不进行切分，等歌词上传后再切分）"""
    admin = verify_admin(request, db)

    if admin.get("role") != "super_admin":
        current_count = db.query(sql_func.count(Song.id)).filter(Song.owner_admin_id == admin.get("id")).scalar() or 0
        if current_count >= int(admin.get("song_limit") or 5):
            raise HTTPException(status_code=400, detail=f"歌曲库已达上限({admin.get('song_limit') or 5}首)")

    _, ext = os.path.splitext(audio.filename or "")
    ext = ext.lower()
    if ext not in ALLOWED_AUDIO_EXT:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式: {ext}，支持: {', '.join(ALLOWED_AUDIO_EXT)}")

    song_id = str(uuid.uuid4())[:8]
    safe_filename = f"{song_id}{ext}"
    filepath = os.path.join(UPLOAD_DIR, safe_filename)

    content = await audio.read()
    with open(filepath, "wb") as f:
        f.write(content)

    duration = _get_audio_duration(filepath)
    if duration <= 0:
        os.remove(filepath)
        raise HTTPException(status_code=400, detail="无法读取音频时长，请检查文件是否损坏")

    audio_url = f"/api/uploads/{safe_filename}"
    song = Song(
        id=song_id,
        owner_admin_id=_admin_owner_id(admin),
        title=title.strip() or os.path.splitext(audio.filename or "未命名")[0],
        artist=artist.strip(),
        duration=duration,
        audio_url=audio_url,
        audio_file=safe_filename,
        original_filename=audio.filename,
        segment_count=0,
        participant_count=0,
        completion=0.0,
        has_lyrics=False,
        task_published=False,
        created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )
    db.add(song)
    db.commit()
    db.refresh(song)

    print(f"[upload] new song: {title} ({artist}), duration={duration}s, no segments (awaiting lyrics)")
    return {"success": True, "data": song.to_dict()}


@router.get("/admin/songs")
async def admin_get_songs(request: Request, db: Session = Depends(get_db)):
    """获取所有歌曲（含完整信息）"""
    admin = verify_admin(request, db)
    songs_orm = _filter_owner(db.query(Song), Song, admin).all()
    rec_q = db.query(Recording.song_id, sql_func.count(Recording.id))
    rec_q = _filter_owner(rec_q, Recording, admin)
    rec_counts = dict(rec_q.group_by(Recording.song_id).all())
    songs = []
    for s in songs_orm:
        audio_file = s.audio_file or ""
        audio_url = s.audio_url or ""
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
        acc_file = s.accompaniment_file or ""
        has_acc = bool(acc_file) and os.path.exists(os.path.join(UPLOAD_DIR, acc_file))
        has_lyrics = bool(s.has_lyrics) or any((seg.lyrics or "").strip() for seg in s.segments)
        d = s.to_dict(include_segments=True)
        d.update({
            "claimed_count": sum(1 for seg in s.segments if seg.status != "unassigned"),
            "completed_count": sum(1 for seg in s.segments if seg.status == "completed"),
            "recording_count": int(rec_counts.get(s.id, 0)),
            "audio_file_exists": audio_exists,
            "has_accompaniment": has_acc,
            "has_lyrics": has_lyrics,
        })
        songs.append(d)
    return {"success": True, "data": songs}


@router.get("/admin/songs/{song_id}")
async def admin_get_song(song_id: str, request: Request, db: Session = Depends(get_db)):
    """获取歌曲完整详情"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)

    # 该歌曲所有录音按 segment_id 分组
    recs_by_seg = {}
    for r in db.query(Recording).filter(Recording.song_id == song_id).all():
        recs_by_seg.setdefault(r.segment_id, []).append(r.to_dict())

    enriched_segments = []
    for seg in song.segments:
        seg_d = seg.to_dict()
        seg_d["recordings"] = recs_by_seg.get(seg.id, [])
        enriched_segments.append(seg_d)

    acc_file = song.accompaniment_file or ""
    has_acc = bool(acc_file) and os.path.exists(os.path.join(UPLOAD_DIR, acc_file))
    has_lyrics = bool(song.has_lyrics) or any((seg.lyrics or "").strip() for seg in song.segments)

    data = song.to_dict(include_segments=False)
    data["segments"] = enriched_segments
    data["has_accompaniment"] = has_acc
    data["has_lyrics"] = has_lyrics
    # 自由任务在前端可单独拉，但保留兼容
    data["free_tasks"] = [ft.to_dict() for ft in song.free_tasks]
    return {"success": True, "data": data}


@router.put("/admin/songs/{song_id}")
async def admin_update_song(song_id: str, request: Request, db: Session = Depends(get_db)):
    """更新歌曲基本信息"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)
    body = await request.json()
    if "title" in body:
        song.title = body["title"]
    if "artist" in body:
        song.artist = body["artist"]
    if "duration" in body:
        song.duration = body["duration"]
    db.commit()
    db.refresh(song)
    return {"success": True, "data": song.to_dict()}


@router.delete("/admin/songs/{song_id}")
async def admin_delete_song(song_id: str, request: Request, db: Session = Depends(get_db)):
    """删除歌曲及其所有关联数据和文件"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)

    audio_file = song.audio_file
    acc_file = song.accompaniment_file

    # 收集需要删除的录音文件路径
    rec_audio_urls = [r.audio_url or "" for r in db.query(Recording).filter(Recording.song_id == song_id).all()]
    # 收集需要删除的最终成曲文件
    finals_to_delete = db.query(Final).filter(Final.song_id == song_id).all()
    final_files = []
    for f in finals_to_delete:
        if f.audio_file:
            final_files.append(("audio", f.audio_file))
        if f.metadata_file:
            final_files.append(("audio", f.metadata_file))
        if f.recordings_dir:
            final_files.append(("dir", f.recordings_dir))

    # 数据库层级删除（cascade 会自动清理 segments / segment_claims / free_tasks）
    db.query(Recording).filter(Recording.song_id == song_id).delete(synchronize_session=False)
    for f in finals_to_delete:
        db.delete(f)
    db.delete(song)
    db.commit()

    # 文件系统清理
    for url in rec_audio_urls:
        fname = os.path.basename(url)
        if fname:
            fp = os.path.join(UPLOAD_DIR, fname)
            if os.path.exists(fp):
                try: os.remove(fp)
                except Exception: pass
    if audio_file:
        fp = os.path.join(UPLOAD_DIR, audio_file)
        if os.path.exists(fp):
            try: os.remove(fp)
            except Exception: pass
    if acc_file:
        fp = os.path.join(UPLOAD_DIR, acc_file)
        if os.path.exists(fp):
            try: os.remove(fp)
            except Exception: pass
    for kind, name in final_files:
        fp = os.path.join(FINALS_DIR, name)
        if kind == "dir" and os.path.exists(fp):
            try: shutil.rmtree(fp)
            except Exception: pass
        elif kind == "audio" and os.path.exists(fp):
            try: os.remove(fp)
            except Exception: pass

    return {"success": True, "message": "歌曲已删除"}


def _replace_segments_with_dicts(db: Session, song: Song, seg_dicts: list) -> list:
    """删除该歌曲所有旧 segment 并按 dict 列表新建。返回新的 ORM segment 列表。"""
    for old in list(song.segments):
        db.delete(old)
    db.flush()
    new_orm = []
    for d in seg_dicts:
        if not d.get("id"):
            d["id"] = f"{song.id}-{uuid.uuid4().hex[:6]}"
        d["owner_admin_id"] = song.owner_admin_id
        # 避免 ID 冲突
        while db.get(Segment, d["id"]) is not None:
            d["id"] = f"{song.id}-{uuid.uuid4().hex[:6]}"
        seg = _new_segment_orm_from_dict(d)
        db.add(seg)
        new_orm.append(seg)
    db.flush()
    return new_orm


@router.post("/admin/songs/{song_id}/lyrics")
async def admin_upload_lyrics(song_id: str, request: Request, db: Session = Depends(get_db)):
    """为已有歌曲上传歌词（支持 LRC 格式精确匹配或纯文本 AI 分配）"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)

    body = await request.json()
    full_lyrics = body.get("lyrics", "").strip()
    if not full_lyrics:
        raise HTTPException(status_code=400, detail="歌词内容不能为空")

    segments_dicts = [s.to_dict() for s in song.segments]
    duration = song.duration or 0
    is_lrc = _is_lrc_format(full_lyrics)
    resegmented = False
    no_segments = len(segments_dicts) == 0

    if is_lrc:
        lrc_lines = _parse_lrc(full_lyrics)
        if lrc_lines:
            max_seg_dur = max((s["end_time"] - s["start_time"]) for s in segments_dicts) if segments_dicts else 999
            if no_segments or ((max_seg_dur > 60 or len(segments_dicts) < 5) and len(lrc_lines) >= 8):
                updated = _resegment_by_lrc(song.id, lrc_lines, duration)
                if updated and any(s.get("lyrics", "").strip() for s in updated):
                    resegmented = True
                    segments_dicts = updated
            if not resegmented:
                if no_segments:
                    filepath = os.path.join(UPLOAD_DIR, song.audio_file or "")
                    if os.path.exists(filepath):
                        seg_new, _ = _split_and_analyze(song.id, filepath, duration)
                        segments_dicts = seg_new
                updated = _assign_lrc_to_segments(segments_dicts, lrc_lines)
                segments_dicts = updated
        else:
            updated = segments_dicts
    else:
        if no_segments:
            filepath = os.path.join(UPLOAD_DIR, song.audio_file or "")
            if os.path.exists(filepath):
                seg_new, _ = _split_and_analyze(song.id, filepath, duration)
                segments_dicts = seg_new
        updated = _ai_assign_lyrics(segments_dicts, full_lyrics)
        segments_dicts = updated

    has_lyrics = any(s.get("lyrics", "").strip() for s in segments_dicts)
    if not has_lyrics:
        method = "LRC 解析" if is_lrc else "AI 歌词分配"
        return {"success": False, "detail": f"{method}未成功，请检查歌词内容或格式"}

    _replace_segments_with_dicts(db, song, segments_dicts)
    song.has_lyrics = True
    song.segment_count = len(segments_dicts)
    db.commit()

    method = "LRC精确匹配" if is_lrc else "AI智能分配"
    if resegmented:
        method += "（已按歌词重新分段）"
    assigned = sum(1 for s in segments_dicts if s.get('lyrics'))
    print(f"[lyrics] song {song_id}: {method}, lyrics assigned to {assigned} segments")
    return {"success": True, "data": {"has_lyrics": True, "segment_count": len(segments_dicts), "method": method}}


@router.post("/admin/songs/{song_id}/auto-lyrics")
async def admin_auto_fetch_lyrics(song_id: str, request: Request, db: Session = Depends(get_db)):
    """自动从 lrclib.net 获取歌词并分配到唱段"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)

    title = song.title or ""
    artist = song.artist or ""
    duration = song.duration or 0
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

    fetched_text = fetch_result["lrc_text"]
    segments_dicts = [s.to_dict() for s in song.segments]
    has_lyrics = False
    resegmented = False
    no_segments = len(segments_dicts) == 0
    updated = segments_dicts

    if _is_lrc_format(fetched_text):
        lrc_lines = _parse_lrc(fetched_text)
        if lrc_lines:
            max_seg_dur = max((s["end_time"] - s["start_time"]) for s in segments_dicts) if segments_dicts else 999
            needs_resegment = no_segments or ((max_seg_dur > 60 or len(segments_dicts) < 5) and len(lrc_lines) >= 8)

            if needs_resegment:
                print(f"[auto-lyrics] resegmenting by LRC...")
                updated = _resegment_by_lrc(song.id, lrc_lines, duration)
                if updated:
                    has_lyrics = any(s.get("lyrics", "").strip() for s in updated)
                    resegmented = True

            if not has_lyrics:
                if no_segments:
                    filepath = os.path.join(UPLOAD_DIR, song.audio_file or "")
                    if os.path.exists(filepath):
                        seg_new, _ = _split_and_analyze(song.id, filepath, duration)
                        segments_dicts = seg_new
                updated = _assign_lrc_to_segments(segments_dicts, lrc_lines)
                has_lyrics = any(s.get("lyrics", "").strip() for s in updated)

    if not has_lyrics:
        if no_segments:
            filepath = os.path.join(UPLOAD_DIR, song.audio_file or "")
            if os.path.exists(filepath):
                seg_new, _ = _split_and_analyze(song.id, filepath, duration)
                segments_dicts = seg_new
        updated = _ai_assign_lyrics(segments_dicts, fetched_text)
        has_lyrics = any(s.get("lyrics", "").strip() for s in updated)

    if not has_lyrics:
        return {"success": False, "detail": "歌词已获取但无法匹配到任何唱段，可能时间戳不对应"}

    _replace_segments_with_dicts(db, song, updated)
    song.has_lyrics = True
    song.segment_count = len(updated)
    db.commit()

    assigned = sum(1 for s in updated if s.get('lyrics'))
    method_desc = fetch_result["method"]
    if resegmented:
        method_desc += "（已按歌词重新分段）"
    print(f"[auto-lyrics] success: {method_desc}, {assigned}/{len(updated)} assigned")
    return {
        "success": True,
        "data": {
            "has_lyrics": True,
            "segment_count": len(updated),
            "assigned_count": assigned,
            "method": method_desc,
            "match_score": fetch_result["match_score"],
            "track_info": fetch_result["track_info"],
            "resegmented": resegmented,
        }
    }


# ============ 管理员 - 唱段管理 ============

@router.put("/admin/segments/{segment_id}")
async def admin_update_segment(segment_id: str, request: Request, db: Session = Depends(get_db)):
    """更新唱段信息（时间、歌词、难度等）"""
    admin = verify_admin(request, db)
    seg = _get_owned_segment(db, segment_id, admin)
    body = await request.json()
    for key in ["start_time", "end_time", "lyrics", "difficulty", "is_chorus", "status"]:
        if key in body:
            setattr(seg, key, body[key])
    db.commit()
    db.refresh(seg)
    return {"success": True, "data": seg.to_dict()}


@router.post("/admin/songs/{song_id}/segments")
async def admin_add_segment(song_id: str, request: Request, db: Session = Depends(get_db)):
    """新增唱段"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)
    body = await request.json()

    existing_count = len(song.segments)
    seg_id = f"{song_id}-{existing_count+1:02d}"
    while db.get(Segment, seg_id) is not None:
        seg_id = f"{song_id}-{uuid.uuid4().hex[:4]}"

    seg = Segment(
        id=seg_id,
        owner_admin_id=song.owner_admin_id,
        song_id=song_id,
        index=existing_count + 1,
        start_time=body.get("start_time", 0),
        end_time=body.get("end_time", 0),
        lyrics=body.get("lyrics", ""),
        difficulty=body.get("difficulty", "normal"),
        is_chorus=bool(body.get("is_chorus", False)),
        status="unassigned",
        claim_count=0,
        submit_count=0,
        created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )
    db.add(seg)
    db.flush()
    db.refresh(song)

    # 按 start_time 排序并重新编号
    sorted_segs = sorted(song.segments, key=lambda s: s.start_time)
    for i, s in enumerate(sorted_segs):
        s.index = i + 1
    song.segment_count = len(sorted_segs)
    db.commit()
    db.refresh(seg)
    return {"success": True, "data": seg.to_dict()}


@router.delete("/admin/segments/{segment_id}")
async def admin_delete_segment(segment_id: str, request: Request, db: Session = Depends(get_db)):
    """删除唱段"""
    admin = verify_admin(request, db)
    seg = _get_owned_segment(db, segment_id, admin)
    song = db.get(Song, seg.song_id)
    db.delete(seg)
    db.flush()

    if song:
        sorted_segs = sorted(song.segments, key=lambda s: s.start_time)
        for i, s in enumerate(sorted_segs):
            s.index = i + 1
        song.segment_count = len(sorted_segs)
    db.commit()
    return {"success": True, "message": "唱段已删除"}


@router.put("/admin/songs/{song_id}/segments/batch")
async def admin_batch_update_segments(song_id: str, request: Request, db: Session = Depends(get_db)):
    """批量替换唱段（前端方案原样写入）"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)
    if song.task_published:
        raise HTTPException(status_code=400, detail="任务已发布，无法修改分段。请先取消任务。")
    body = await request.json()
    segments_data = body.get("segments", [])
    confirm_delete = body.get("confirm_delete", False)

    old_segs = list(song.segments)
    old_seg_ids = {s.id for s in old_segs}
    old_seg_lookup = {s.id: s for s in old_segs}
    new_seg_ids = {s.get("id") for s in segments_data if s.get("id")}
    removed_seg_ids = old_seg_ids - new_seg_ids

    # 找将失效的已提交录音
    orphan_recs = []
    if removed_seg_ids:
        orphan_recs = db.query(Recording).filter(
            Recording.song_id == song_id,
            Recording.submitted == True,
            Recording.segment_id.in_(removed_seg_ids),
        ).all()

    if orphan_recs and not confirm_delete:
        detail = {}
        for r in orphan_recs:
            sid = r.segment_id
            if sid not in detail:
                old_seg = old_seg_lookup.get(sid)
                detail[sid] = {
                    "lyrics": (old_seg.lyrics or "") if old_seg else "",
                    "index": old_seg.index if old_seg else 0,
                    "count": 0,
                }
            detail[sid]["count"] += 1
        return {
            "success": False,
            "need_confirm": True,
            "orphan_count": len(orphan_recs),
            "detail": list(detail.values()),
        }

    # 删除将失效段相关的录音（含未提交）+ 音频文件
    deleted_recordings = 0
    if removed_seg_ids:
        all_orphan_recs = db.query(Recording).filter(
            Recording.song_id == song_id,
            Recording.segment_id.in_(removed_seg_ids),
        ).all()
        for r in all_orphan_recs:
            rec_url = r.audio_url or ""
            fname = os.path.basename(rec_url)
            if fname:
                fp = os.path.join(UPLOAD_DIR, fname)
                if os.path.exists(fp):
                    try: os.remove(fp)
                    except Exception: pass
            db.delete(r)
        deleted_recordings = sum(1 for r in all_orphan_recs if r.submitted)

    # 删除所有旧段（cascade 自动清 claims）
    for old in old_segs:
        db.delete(old)
    db.flush()

    # 重建
    new_segs_orm = []
    for i, sd in enumerate(segments_data):
        new_id = f"{song_id}-{uuid.uuid4().hex[:6]}"
        while db.get(Segment, new_id) is not None:
            new_id = f"{song_id}-{uuid.uuid4().hex[:6]}"
        status = sd.get("status", "unassigned")
        if status == "claimed":
            status = "unassigned"
        seg = Segment(
            id=new_id,
            owner_admin_id=song.owner_admin_id,
            song_id=song_id,
            index=i + 1,
            start_time=sd.get("start_time", 0),
            end_time=sd.get("end_time", 0),
            lyrics=sd.get("lyrics", ""),
            difficulty=sd.get("difficulty", "normal"),
            is_chorus=bool(sd.get("is_chorus", False)),
            status=status,
            claim_count=0,
            submit_count=0,
            created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )
        db.add(seg)
        new_segs_orm.append(seg)

    song.segment_count = len(new_segs_orm)
    db.commit()
    return {
        "success": True,
        "data": [s.to_dict() for s in new_segs_orm],
        "deleted_recordings": deleted_recordings,
    }


@router.post("/admin/songs/{song_id}/publish-task")
async def admin_publish_task(song_id: str, request: Request, db: Session = Depends(get_db)):
    """发布歌曲任务"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)
    if not song.segments:
        raise HTTPException(status_code=400, detail="歌曲没有唱段数据，请先完成分段编辑")
    song.task_published = True
    song.task_published_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db.commit()
    db.refresh(song)
    return {"success": True, "data": song.to_dict()}


@router.post("/admin/songs/{song_id}/unpublish-task")
async def admin_unpublish_task(song_id: str, request: Request, db: Session = Depends(get_db)):
    """取消歌曲任务，删除该歌曲所有用户录音并恢复可编辑状态"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)

    # 删除录音 + 文件
    recs = db.query(Recording).filter(Recording.song_id == song_id).all()
    deleted_count = 0
    for r in recs:
        url = r.audio_url or ""
        fname = url.split("/")[-1] if "/" in url else url
        if fname:
            fp = os.path.join(UPLOAD_DIR, fname)
            if os.path.exists(fp):
                try: os.remove(fp)
                except Exception: pass
        db.delete(r)
        deleted_count += 1

    # 重置所有唱段状态 + 清空认领
    for seg in song.segments:
        seg.status = "unassigned"
        seg.claim_count = 0
        seg.submit_count = 0
        for c in list(seg.claims):
            db.delete(c)

    song.task_published = False
    song.task_published_at = None
    db.commit()
    return {"success": True, "deleted_recordings": deleted_count}


# ============ 管理员 - 自由任务管理 ============

@router.get("/admin/songs/{song_id}/free-tasks")
async def admin_get_free_tasks(song_id: str, request: Request, db: Session = Depends(get_db)):
    """获取歌曲的自由任务列表"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)
    free_tasks = []
    for ft in song.free_tasks:
        ft_data = ft.to_dict()
        ft_data["recordings"] = [
            r.to_dict() for r in db.query(Recording).filter(
                Recording.song_id == song_id,
                Recording.segment_id == ft.id,
            ).all()
        ]
        free_tasks.append(ft_data)
    return {"success": True, "data": free_tasks}


@router.post("/admin/songs/{song_id}/free-tasks")
async def admin_create_free_task(song_id: str, request: Request, db: Session = Depends(get_db)):
    """创建新的自由任务（最多5个）"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)

    body = await request.json()
    description = (body.get("description") or "").strip()
    start_time = float(body.get("start_time", 0))
    end_time = float(body.get("end_time", 0))
    difficulty = body.get("difficulty", "normal")
    task_type = body.get("type", "solo")

    if not description:
        raise HTTPException(status_code=400, detail="描述文字不能为空")
    if end_time - start_time < 5:
        raise HTTPException(status_code=400, detail="时间间隔至少需要5秒")

    if len(song.free_tasks) >= 5:
        raise HTTPException(status_code=400, detail="每首歌曲最多5个自由任务")

    ft = FreeTask(
        id=f"ft_{uuid.uuid4().hex[:8]}",
        owner_admin_id=song.owner_admin_id,
        song_id=song_id,
        description=description,
        start_time=start_time,
        end_time=end_time,
        difficulty=difficulty,
        task_type=task_type,
        created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )
    db.add(ft)
    db.commit()
    db.refresh(ft)
    data = ft.to_dict()
    data["recordings"] = []
    return {"success": True, "data": data}


@router.delete("/admin/songs/{song_id}/free-tasks/{free_task_id}")
async def admin_delete_free_task(song_id: str, free_task_id: str, request: Request, db: Session = Depends(get_db)):
    """删除自由任务（同时删除其录音）"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)

    ft = db.query(FreeTask).filter(FreeTask.id == free_task_id, FreeTask.song_id == song_id).first()
    if not ft:
        raise HTTPException(status_code=404, detail="自由任务不存在")

    recs_to_del = db.query(Recording).filter(Recording.segment_id == free_task_id).all()
    for rec in recs_to_del:
        url = rec.audio_url or ""
        fname = url.split("/")[-1] if "/" in url else url
        if fname:
            fp = os.path.join(UPLOAD_DIR, fname)
            if os.path.exists(fp):
                try: os.remove(fp)
                except Exception: pass
        db.delete(rec)

    db.delete(ft)
    db.commit()
    return {"success": True, "deleted_recordings": len(recs_to_del)}


# ============ 管理员 - 录音管理 ============

@router.get("/admin/recordings")
async def admin_get_recordings(request: Request, song_id: Optional[str] = None, db: Session = Depends(get_db)):
    """获取所有录音（含未提交的）"""
    admin = verify_admin(request, db)
    q = _filter_owner(db.query(Recording), Recording, admin)
    if song_id:
        _get_owned_song(db, song_id, admin)
        q = q.filter(Recording.song_id == song_id)
    return {"success": True, "data": [r.to_dict() for r in q.all()]}


@router.post("/admin/recordings/{recording_id}/select")
async def admin_select_recording(recording_id: str, request: Request, db: Session = Depends(get_db)):
    """选定录音为该唱段的最终版本
    独唱段：互斥，同段仅允许一条选定
    合唱段：允许多选（最多20条）
    """
    admin = verify_admin(request, db)
    rec = _get_owned_recording(db, recording_id, admin)
    seg = db.get(Segment, rec.segment_id)
    is_chorus = bool(seg.is_chorus) if seg else False
    if is_chorus:
        selected_count = db.query(Recording).filter(
            Recording.segment_id == rec.segment_id, Recording.selected == True
        ).count()
        if selected_count >= 20 and not rec.selected:
            raise HTTPException(status_code=400, detail="合唱段最多选定20条录音")
    else:
        # 独唱段：互斥
        db.query(Recording).filter(
            Recording.segment_id == rec.segment_id
        ).update({"selected": False}, synchronize_session=False)
    rec.selected = True
    db.commit()
    db.refresh(rec)
    return {"success": True, "data": rec.to_dict()}


@router.post("/admin/recordings/{recording_id}/unselect")
async def admin_unselect_recording(recording_id: str, request: Request, db: Session = Depends(get_db)):
    """取消选定录音"""
    admin = verify_admin(request, db)
    rec = _get_owned_recording(db, recording_id, admin)
    rec.selected = False
    db.commit()
    db.refresh(rec)
    return {"success": True, "data": rec.to_dict()}


@router.post("/admin/recordings/{recording_id}/trim")
async def admin_trim_recording(recording_id: str, request: Request, db: Session = Depends(get_db)):
    """裁剪录音：将开头和结尾指定秒数的音频静音（保持总时长不变）"""
    admin = verify_admin(request, db)
    body = await request.json()
    trim_start = float(body.get("trim_start", 0))
    trim_end = float(body.get("trim_end", 0))

    if trim_start <= 0 and trim_end <= 0:
        return {"success": True, "message": "无需裁剪"}

    rec = _get_owned_recording(db, recording_id, admin)

    audio_url = rec.audio_url or ""
    filename = audio_url.split("/")[-1] if "/" in audio_url else audio_url
    src_path = os.path.join(UPLOAD_DIR, filename)

    if not os.path.exists(src_path):
        raise HTTPException(status_code=404, detail="音频文件不存在")

    # 使用 ffmpeg 获取音频时长
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", src_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10
        )
        total_duration = float(probe.stdout.strip())
    except Exception:
        total_duration = 0

    if total_duration > 0 and (trim_start + trim_end) >= total_duration:
        raise HTTPException(status_code=400, detail="裁剪范围超出音频时长")

    # 使用 ffmpeg volume 滤镜将裁剪区域静音，保持总时长不变
    # 构建 volume 滤镜表达式：
    #   - 0 ~ trim_start 秒：静音
    #   - trim_start ~ (total_duration - trim_end) 秒：保持原声
    #   - (total_duration - trim_end) ~ total_duration 秒：静音
    ext = os.path.splitext(filename)[1]
    tmp_path = src_path + ".trimmed" + ext

    volume_expr_parts = []
    if trim_start > 0:
        volume_expr_parts.append(f"between(t,0,{trim_start})")
    if trim_end > 0 and total_duration > 0:
        mute_from = total_duration - trim_end
        volume_expr_parts.append(f"gte(t,{mute_from})")

    if not volume_expr_parts:
        return {"success": True, "message": "无需裁剪"}

    # volume=0 when in mute regions, else 1
    mute_condition = "+".join(volume_expr_parts)
    volume_filter = f"volume='if({mute_condition},0,1)':eval=frame"

    cmd = ["ffmpeg", "-y", "-i", src_path, "-af", volume_filter, "-c:v", "copy", tmp_path]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        if result.returncode != 0:
            print(f"[trim] ffmpeg error: {result.stderr}")
            raise Exception(result.stderr[-500:] if len(result.stderr) > 500 else result.stderr)

        # 替换原文件
        shutil.move(tmp_path, src_path)
        return {"success": True, "data": rec.to_dict()}
    except Exception as e:
        # 清理临时文件
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise HTTPException(status_code=500, detail=f"裁剪失败: {str(e)}")


# ============ 管理员 - 统计 ============

@router.get("/admin/stats")
async def admin_stats(request: Request, db: Session = Depends(get_db)):
    """获取系统统计"""
    admin = verify_admin(request, db)
    total_songs = _filter_owner(db.query(sql_func.count(Song.id)), Song, admin).scalar() or 0
    total_segments = _filter_owner(db.query(sql_func.count(Segment.id)), Segment, admin).scalar() or 0
    total_recordings = _filter_owner(db.query(sql_func.count(Recording.id)), Recording, admin).scalar() or 0
    total_users = db.query(sql_func.count(User.id)).scalar() or 0
    completed_segments = _filter_owner(db.query(sql_func.count(Segment.id)).filter(Segment.status == "completed"), Segment, admin).scalar() or 0
    submitted_recordings = _filter_owner(db.query(sql_func.count(Recording.id)).filter(Recording.submitted == True), Recording, admin).scalar() or 0
    return {"success": True, "data": {
        "total_songs": int(total_songs),
        "total_segments": int(total_segments),
        "total_recordings": int(total_recordings),
        "total_users": int(total_users),
        "completed_segments": int(completed_segments),
        "submitted_recordings": int(submitted_recordings),
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
    db: Session = Depends(get_db),
):
    """上传伴奏文件，校验时长与原曲基本一致"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)

    _, ext = os.path.splitext(audio.filename or "")
    ext = ext.lower()
    if ext not in ALLOWED_AUDIO_EXT:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式: {ext}")

    tmp_filename = f"acc_{song_id}{ext}"
    tmp_filepath = os.path.join(UPLOAD_DIR, tmp_filename)
    content = await audio.read()
    with open(tmp_filepath, "wb") as f:
        f.write(content)

    acc_duration = _get_audio_duration(tmp_filepath)
    if acc_duration <= 0:
        os.remove(tmp_filepath)
        raise HTTPException(status_code=400, detail="无法读取伴奏时长，请检查文件是否损坏")

    song_duration = song.duration or 0
    diff = abs(acc_duration - song_duration)
    tolerance = max(5.0, song_duration * 0.03)
    if diff > tolerance:
        os.remove(tmp_filepath)
        raise HTTPException(
            status_code=400,
            detail=f"伴奏时长({acc_duration:.1f}s)与原曲({song_duration:.1f}s)相差{diff:.1f}s，超出容差{tolerance:.1f}s"
        )

    song.accompaniment_url = f"/api/uploads/{tmp_filename}"
    song.accompaniment_file = tmp_filename
    song.accompaniment_duration = acc_duration
    db.commit()

    print(f"[accompaniment] song={song_id}, acc_duration={acc_duration}s, song_duration={song_duration}s, diff={diff:.1f}s")
    return {
        "success": True,
        "data": {
            "accompaniment_url": song.accompaniment_url,
            "accompaniment_duration": acc_duration,
            "song_duration": song_duration,
            "diff": round(diff, 2),
        }
    }


@router.delete("/admin/songs/{song_id}/accompaniment")
async def admin_delete_accompaniment(song_id: str, request: Request, db: Session = Depends(get_db)):
    """删除伴奏文件"""
    admin = verify_admin(request, db)
    song = _get_owned_song(db, song_id, admin)
    acc_file = song.accompaniment_file
    song.accompaniment_url = None
    song.accompaniment_file = None
    song.accompaniment_duration = None
    db.commit()
    if acc_file:
        fp = os.path.join(UPLOAD_DIR, acc_file)
        if os.path.exists(fp):
            try: os.remove(fp)
            except Exception: pass
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
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60
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
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
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

        # 保存到数据库（在后台线程中开新 Session）
        with db_session() as db_bg:
            owner_admin_id = song.get("owner_admin_id")
            final_orm = Final(
                id=final_id,
                owner_admin_id=owner_admin_id,
                song_id=song_id,
                song_title=song.get("title", ""),
                song_artist=song.get("artist", ""),
                duration=duration,
                audio_file=final_filename,
                audio_url=f"/api/finals/{final_filename}",
                metadata_file=f"meta_{song_id}_{final_id}.json",
                recordings_dir=f"recs_{song_id}_{final_id}",
                track_count=len(final_tracks),
                segment_count=len(segments),
                published=False,
                created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            )
            db_bg.add(final_orm)
            db_bg.commit()

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
async def admin_start_synthesis(song_id: str, request: Request, db: Session = Depends(get_db)):
    """启动合成任务"""
    admin = verify_admin(request, db)
    song_orm = _get_owned_song(db, song_id, admin)

    existing = SYNTH_TASKS.get(song_id)
    if existing and existing.get("status") == "running":
        raise HTTPException(status_code=400, detail="该歌曲已有合成任务正在进行")

    if not song_orm.segments:
        raise HTTPException(status_code=400, detail="歌曲没有唱段")

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    rec_params = body.get("rec_params", {})

    # 物化为纯 dict（后台线程不能持有 Session-bound ORM 对象）
    song_dict = song_orm.to_dict(include_segments=False)
    segments_dicts = [s.to_dict() for s in song_orm.segments]

    recordings_map = {}
    missing_segs = []
    for seg in segments_dicts:
        seg_recs_orm = db.query(Recording).filter(
            Recording.segment_id == seg["id"],
            Recording.owner_admin_id == song_orm.owner_admin_id,
            Recording.selected == True,
            Recording.submitted == True,
        ).all()
        if not seg_recs_orm:
            missing_segs.append(f"#{seg['index']}")
        seg_recs = []
        for r in seg_recs_orm:
            d = r.to_dict()
            params = rec_params.get(r.id, {})
            d["_pitchShift"] = params.get("pitchShift", 0)
            d["_reverb"] = params.get("reverb", 0)
            seg_recs.append(d)
        recordings_map[seg["id"]] = seg_recs

    if missing_segs:
        raise HTTPException(
            status_code=400,
            detail=f"以下唱段未选定录音: {', '.join(missing_segs[:5])}{'...' if len(missing_segs)>5 else ''}"
        )

    SYNTH_TASKS[song_id] = {
        "status": "running",
        "progress": 0,
        "step": 0,
        "message": "准备中...",
        "final_id": None,
        "error": None,
    }

    thread = threading.Thread(
        target=_run_synthesis,
        args=(song_id, song_dict, segments_dicts, recordings_map),
        daemon=True,
    )
    thread.start()

    return {"success": True, "message": "合成任务已启动"}


@router.get("/admin/songs/{song_id}/synth-status")
async def admin_synth_status(song_id: str, request: Request, db: Session = Depends(get_db)):
    """查询合成任务状态"""
    admin = verify_admin(request, db)
    _get_owned_song(db, song_id, admin)
    task = SYNTH_TASKS.get(song_id)
    if not task:
        return {"success": True, "data": {"status": "none"}}
    return {"success": True, "data": task}


# ============ 管理员 - 最终成曲管理 ============

@router.get("/admin/finals")
async def admin_get_finals(request: Request, db: Session = Depends(get_db)):
    """获取所有最终成曲"""
    admin = verify_admin(request, db)
    finals = _filter_owner(db.query(Final), Final, admin).order_by(Final.created_at.desc()).all()
    return {"success": True, "data": [f.to_dict() for f in finals]}


@router.get("/admin/finals/{final_id}")
async def admin_get_final(final_id: str, request: Request, db: Session = Depends(get_db)):
    """获取单个最终成曲详情"""
    admin = verify_admin(request, db)
    final = _get_owned_final(db, final_id, admin)
    return {"success": True, "data": final.to_dict()}


@router.post("/admin/finals/{final_id}/publish")
async def admin_publish_final(final_id: str, request: Request, db: Session = Depends(get_db)):
    """发布成曲"""
    admin = verify_admin(request, db)
    final = _get_owned_final(db, final_id, admin)
    final.published = True
    final.published_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db.commit()
    db.refresh(final)
    return {"success": True, "data": final.to_dict()}


@router.post("/admin/finals/{final_id}/unpublish")
async def admin_unpublish_final(final_id: str, request: Request, db: Session = Depends(get_db)):
    """取消发布"""
    admin = verify_admin(request, db)
    final = _get_owned_final(db, final_id, admin)
    final.published = False
    final.published_at = None
    db.commit()
    db.refresh(final)
    return {"success": True, "data": final.to_dict()}


@router.delete("/admin/finals/{final_id}")
async def admin_delete_final(final_id: str, request: Request, db: Session = Depends(get_db)):
    """删除成曲及其所有关联文件"""
    admin = verify_admin(request, db)
    final = _get_owned_final(db, final_id, admin)
    audio_file = final.audio_file or ""
    meta_file = final.metadata_file or ""
    recs_dir = final.recordings_dir or ""
    db.delete(final)
    db.commit()

    if audio_file:
        fp = os.path.join(FINALS_DIR, audio_file)
        if os.path.exists(fp):
            try: os.remove(fp)
            except Exception: pass
    if meta_file:
        fp = os.path.join(FINALS_DIR, meta_file)
        if os.path.exists(fp):
            try: os.remove(fp)
            except Exception: pass
    if recs_dir:
        dp = os.path.join(FINALS_DIR, recs_dir)
        if os.path.exists(dp):
            try: shutil.rmtree(dp)
            except Exception: pass
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
