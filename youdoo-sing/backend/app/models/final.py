from sqlalchemy import Column, String, Float, Integer, Boolean
from app.core.database import Base


class Final(Base):
    """最终成曲"""
    __tablename__ = "finals"

    id = Column(String(32), primary_key=True, index=True)
    song_id = Column(String(32), nullable=False, index=True)
    song_title = Column(String(255), nullable=True)
    song_artist = Column(String(255), nullable=True)
    duration = Column(Float, nullable=True, default=0.0)
    audio_file = Column(String(255), nullable=True)
    audio_url = Column(String(512), nullable=True)
    metadata_file = Column(String(255), nullable=True)
    recordings_dir = Column(String(255), nullable=True)
    track_count = Column(Integer, default=0, nullable=False)
    segment_count = Column(Integer, default=0, nullable=False)
    published = Column(Boolean, default=False, nullable=False, index=True)
    published_at = Column(String(32), nullable=True)
    created_at = Column(String(32), nullable=True)

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "song_id": self.song_id,
            "song_title": self.song_title or "",
            "song_artist": self.song_artist or "",
            "duration": self.duration or 0,
            "audio_file": self.audio_file or "",
            "audio_url": self.audio_url or "",
            "metadata_file": self.metadata_file or "",
            "recordings_dir": self.recordings_dir or "",
            "track_count": self.track_count,
            "segment_count": self.segment_count,
            "published": self.published,
            "created_at": self.created_at,
        }
        if self.published_at:
            d["published_at"] = self.published_at
        return d
