from sqlalchemy import Column, String, Float, DateTime, Integer, Text
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base


class Song(Base):
    """歌曲模型"""
    __tablename__ = "songs"

    id = Column(String, primary_key=True, index=True)
    title = Column(String, nullable=False)
    artist = Column(String, nullable=True)
    duration = Column(Float, nullable=False)
    audio_url = Column(String, nullable=False)
    segment_count = Column(Integer, default=0)
    participant_count = Column(Integer, default=0)
    completion = Column(Float, default=0.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    segments = relationship("Segment", back_populates="song", lazy="selectin")
