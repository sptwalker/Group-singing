from sqlalchemy import Column, String, Float, Integer, Boolean, JSON
from app.core.database import Base


class Recording(Base):
    """用户录音
    注意：segment_id 既可指向 segments.id（普通唱段），也可指向 free_tasks.id（自由任务），
    因此不加 FK 约束，业务侧自行解释。
    """
    __tablename__ = "recordings"

    id = Column(String(32), primary_key=True, index=True)
    segment_id = Column(String(64), nullable=False, index=True)
    song_id = Column(String(32), nullable=False, index=True)
    user_id = Column(String(64), nullable=False, index=True)
    user_name = Column(String(255), nullable=False)
    user_avatar = Column(String(512), nullable=True)
    audio_url = Column(String(512), nullable=True)
    score = Column(Float, default=0.0, nullable=False)
    score_detail = Column(JSON, nullable=True)
    likes = Column(Integer, default=0, nullable=False)
    submitted = Column(Boolean, default=False, nullable=False, index=True)
    selected = Column(Boolean, default=False, nullable=False)
    created_at = Column(String(32), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "segment_id": self.segment_id,
            "song_id": self.song_id,
            "user_id": self.user_id,
            "user_name": self.user_name,
            "user_avatar": self.user_avatar or "",
            "audio_url": self.audio_url or "",
            "score": self.score,
            "score_detail": self.score_detail,
            "likes": self.likes,
            "submitted": self.submitted,
            "selected": self.selected,
            "created_at": self.created_at,
        }
