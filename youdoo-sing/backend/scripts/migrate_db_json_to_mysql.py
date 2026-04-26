"""一次性迁移脚本：把 backend/data/db.json 中的数据导入 MySQL。

用法（在 backend/ 目录下）：
    python -m scripts.migrate_db_json_to_mysql

前提：
    - backend/.env 已配置 MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DB
    - docker-compose 中的 mysql 服务已启动
    - 目标库为空（脚本不删除已存在的同 ID 行；冲突时跳过并打印警告）
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from typing import Any

# 让脚本可在 backend/ 目录下作为模块运行
HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(HERE, ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.core.database import SessionLocal, init_db  # noqa: E402
from app.models import Song, Segment, SegmentClaim, Recording, User, FreeTask, Final  # noqa: E402

DB_JSON_PATH = os.path.join(BACKEND_DIR, "data", "db.json")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _coerce_str(v: Any, default: str = "") -> str:
    if v is None:
        return default
    return str(v)


def main() -> None:
    if not os.path.exists(DB_JSON_PATH):
        print(f"[migrate] db.json not found: {DB_JSON_PATH}")
        return

    with open(DB_JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    songs = data.get("songs", {}) or {}
    segments_top = data.get("segments", {}) or {}  # 旧版扁平 segments dict（可能没有，新版直接嵌在 song 里）
    claims_top = data.get("claims", {}) or {}
    recordings = data.get("recordings", {}) or {}
    users = data.get("users", {}) or {}
    finals = data.get("finals", {}) or {}

    init_db()
    db = SessionLocal()
    inserted = {"songs": 0, "segments": 0, "claims": 0, "free_tasks": 0,
                "recordings": 0, "users": 0, "finals": 0}
    skipped = {"songs": 0, "segments": 0, "claims": 0, "free_tasks": 0,
               "recordings": 0, "users": 0, "finals": 0}

    try:
        # --- Users ---
        for uid, u in users.items():
            if db.get(User, uid) is not None:
                skipped["users"] += 1
                continue
            db.add(User(
                id=uid,
                nickname=_coerce_str(u.get("nickname"), "User"),
                avatar=_coerce_str(u.get("avatar"), ""),
                auth_provider=u.get("auth_provider"),
                wechat_openid=u.get("wechat_openid"),
                wechat_unionid=u.get("wechat_unionid"),
                wechat_scope=u.get("wechat_scope"),
                created_at=u.get("created_at") or _now(),
                last_login_at=u.get("last_login_at"),
            ))
            inserted["users"] += 1
        db.commit()

        # --- Songs + nested Segments + Claims + Free Tasks ---
        seen_segment_ids: set[str] = set()
        for sid, s in songs.items():
            if db.get(Song, sid) is not None:
                skipped["songs"] += 1
                continue
            song_orm = Song(
                id=sid,
                title=_coerce_str(s.get("title"), "未命名"),
                artist=_coerce_str(s.get("artist"), ""),
                duration=float(s.get("duration") or 0.0),
                audio_url=_coerce_str(s.get("audio_url"), ""),
                audio_file=s.get("audio_file"),
                original_filename=s.get("original_filename"),
                segment_count=int(s.get("segment_count") or 0),
                participant_count=int(s.get("participant_count") or 0),
                completion=float(s.get("completion") or 0.0),
                has_lyrics=bool(s.get("has_lyrics", False)),
                created_at=s.get("created_at") or _now(),
                accompaniment_url=s.get("accompaniment_url"),
                accompaniment_file=s.get("accompaniment_file"),
                accompaniment_duration=s.get("accompaniment_duration"),
                task_published=bool(s.get("task_published", False)),
                task_published_at=s.get("task_published_at"),
            )
            db.add(song_orm)
            inserted["songs"] += 1

            for seg in s.get("segments", []) or []:
                seg_id = seg.get("id")
                if not seg_id or seg_id in seen_segment_ids:
                    skipped["segments"] += 1
                    continue
                seen_segment_ids.add(seg_id)
                db.add(Segment(
                    id=seg_id,
                    song_id=sid,
                    index=int(seg.get("index") or 0),
                    start_time=float(seg.get("start_time") or 0.0),
                    end_time=float(seg.get("end_time") or 0.0),
                    lyrics=seg.get("lyrics") or "",
                    difficulty=_coerce_str(seg.get("difficulty"), "normal"),
                    is_chorus=bool(seg.get("is_chorus", False)),
                    status=_coerce_str(seg.get("status"), "unassigned"),
                    claim_count=int(seg.get("claim_count") or 0),
                    submit_count=int(seg.get("submit_count") or 0),
                    created_at=seg.get("created_at") or _now(),
                ))
                inserted["segments"] += 1

                for c in seg.get("claims", []) or []:
                    cid = c.get("id")
                    if not cid:
                        continue
                    if db.get(SegmentClaim, cid) is not None:
                        skipped["claims"] += 1
                        continue
                    db.add(SegmentClaim(
                        id=cid,
                        segment_id=seg_id,
                        user_id=_coerce_str(c.get("user_id"), ""),
                        user_name=_coerce_str(c.get("user_name"), ""),
                        status=_coerce_str(c.get("status"), "claimed"),
                        created_at=c.get("created_at") or _now(),
                    ))
                    inserted["claims"] += 1

            for ft in s.get("free_tasks", []) or []:
                ft_id = ft.get("id")
                if not ft_id or db.get(FreeTask, ft_id) is not None:
                    skipped["free_tasks"] += 1
                    continue
                db.add(FreeTask(
                    id=ft_id,
                    song_id=sid,
                    description=_coerce_str(ft.get("description"), ""),
                    start_time=float(ft.get("start_time") or 0.0),
                    end_time=float(ft.get("end_time") or 0.0),
                    difficulty=_coerce_str(ft.get("difficulty"), "normal"),
                    task_type=_coerce_str(ft.get("type"), "solo"),
                    created_at=ft.get("created_at") or _now(),
                ))
                inserted["free_tasks"] += 1

        db.commit()

        # --- 顶层 segments / claims（兼容旧 dump 结构）---
        for seg_id, seg in segments_top.items():
            if seg_id in seen_segment_ids or db.get(Segment, seg_id) is not None:
                continue
            song_id = seg.get("song_id")
            if not song_id or db.get(Song, song_id) is None:
                skipped["segments"] += 1
                continue
            db.add(Segment(
                id=seg_id,
                song_id=song_id,
                index=int(seg.get("index") or 0),
                start_time=float(seg.get("start_time") or 0.0),
                end_time=float(seg.get("end_time") or 0.0),
                lyrics=seg.get("lyrics") or "",
                difficulty=_coerce_str(seg.get("difficulty"), "normal"),
                is_chorus=bool(seg.get("is_chorus", False)),
                status=_coerce_str(seg.get("status"), "unassigned"),
                claim_count=int(seg.get("claim_count") or 0),
                submit_count=int(seg.get("submit_count") or 0),
                created_at=seg.get("created_at") or _now(),
            ))
            seen_segment_ids.add(seg_id)
            inserted["segments"] += 1

        for cid, c in claims_top.items():
            if db.get(SegmentClaim, cid) is not None:
                skipped["claims"] += 1
                continue
            seg_id = c.get("segment_id")
            if not seg_id or db.get(Segment, seg_id) is None:
                skipped["claims"] += 1
                continue
            db.add(SegmentClaim(
                id=cid,
                segment_id=seg_id,
                user_id=_coerce_str(c.get("user_id"), ""),
                user_name=_coerce_str(c.get("user_name"), ""),
                status=_coerce_str(c.get("status"), "claimed"),
                created_at=c.get("created_at") or _now(),
            ))
            inserted["claims"] += 1

        db.commit()

        # --- Recordings ---
        for rid, r in recordings.items():
            if db.get(Recording, rid) is not None:
                skipped["recordings"] += 1
                continue
            db.add(Recording(
                id=rid,
                segment_id=_coerce_str(r.get("segment_id"), ""),
                song_id=_coerce_str(r.get("song_id"), ""),
                user_id=_coerce_str(r.get("user_id"), ""),
                user_name=_coerce_str(r.get("user_name"), ""),
                user_avatar=_coerce_str(r.get("user_avatar"), ""),
                audio_url=_coerce_str(r.get("audio_url"), ""),
                score=float(r.get("score") or 0.0),
                score_detail=r.get("score_detail"),
                likes=int(r.get("likes") or 0),
                submitted=bool(r.get("submitted", False)),
                selected=bool(r.get("selected", False)),
                created_at=r.get("created_at") or _now(),
            ))
            inserted["recordings"] += 1
        db.commit()

        # --- Finals ---
        for fid, f in finals.items():
            if db.get(Final, fid) is not None:
                skipped["finals"] += 1
                continue
            db.add(Final(
                id=fid,
                song_id=_coerce_str(f.get("song_id"), ""),
                song_title=_coerce_str(f.get("song_title"), ""),
                song_artist=_coerce_str(f.get("song_artist"), ""),
                duration=float(f.get("duration") or 0.0),
                audio_file=f.get("audio_file"),
                audio_url=f.get("audio_url"),
                metadata_file=f.get("metadata_file"),
                recordings_dir=f.get("recordings_dir"),
                track_count=int(f.get("track_count") or 0),
                segment_count=int(f.get("segment_count") or 0),
                published=bool(f.get("published", False)),
                published_at=f.get("published_at"),
                created_at=f.get("created_at") or _now(),
            ))
            inserted["finals"] += 1
        db.commit()

    except Exception as exc:
        db.rollback()
        print(f"[migrate] FAILED: {exc}")
        raise
    finally:
        db.close()

    print("[migrate] inserted:", inserted)
    print("[migrate] skipped (already present / orphan):", skipped)


if __name__ == "__main__":
    main()
