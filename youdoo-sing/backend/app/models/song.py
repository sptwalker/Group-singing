from sqlalchemy import Column, String, Float, Integer, Boolean, Text
from sqlalchemy.orm import relationship
from app.core.database import Base


class Song(Base):
    """歌曲"""
    __tablename__ = "songs"

    id = Column(String(32), primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    artist = Column(String(255), nullable=True, default="")
    duration = Column(Float, nullable=False, default=0.0)
    audio_url = Column(String(512), nullable=False, default="")
    audio_file = Column(String(255), nullable=True)
    original_filename = Column(String(255), nullable=True)
    segment_count = Column(Integer, default=0, nullable=False)
    participant_count = Column(Integer, default=0, nullable=False)
    completion = Column(Float, default=0.0, nullable=False)
    has_lyrics = Column(Boolean, default=False, nullable=False)
    created_at = Column(String(32), nullable=True)
    accompaniment_url = Column(String(512), nullable=True)
    accompaniment_file = Column(String(255), nullable=True)
    accompaniment_duration = Column(Float, nullable=True)
    task_published = Column(Boolean, default=False, nullable=False)
    task_published_at = Column(String(32), nullable=True)

    segments = relationship(
        "Segment",
        back_populates="song",
        order_by="Segment.index",
        lazy="selectin",
        cascade="all, delete-orphan",
    )
    free_tasks = relationship(
        "FreeTask",
        back_populates="song",
        lazy="selectin",
        cascade="all, delete-orphan",
    )

    def to_dict(self, include_segments: bool = True) -> dict:
        d = {
            "id": self.id,
            "title": self.title,
            "artist": self.artist or "",
            "duration": self.duration,
            "audio_url": self.audio_url,
            "audio_file": self.audio_file,
            "original_filename": self.original_filename,
            "segment_count": self.segment_count,
            "participant_count": self.participant_count,
            "completion": self.completion,
            "has_lyrics": self.has_lyrics,
            "created_at": self.created_at,
            "task_published": self.task_published,
        }
        if self.task_published_at:
            d["task_published_at"] = self.task_published_at
        if self.accompaniment_url:
            d["accompaniment_url"] = self.accompaniment_url
        if self.accompaniment_file:
            d["accompaniment_file"] = self.accompaniment_file
        if self.accompaniment_duration is not None:
            d["accompaniment_duration"] = self.accompaniment_duration
        if include_segments:
            d["segments"] = [seg.to_dict() for seg in self.segments]
        return d
