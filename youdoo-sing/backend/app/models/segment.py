from sqlalchemy import Column, String, Float, Integer, ForeignKey, Enum as SQLEnum, Boolean, Text, DateTime
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
import enum
from app.core.database import Base


class SegmentStatus(str, enum.Enum):
    UNASSIGNED = "unassigned"
    CLAIMED = "claimed"
    COMPLETED = "completed"


class SegmentDifficulty(str, enum.Enum):
    EASY = "easy"
    NORMAL = "normal"
    HARD = "hard"


class Segment(Base):
    """唱段模型"""
    __tablename__ = "segments"

    id = Column(String, primary_key=True, index=True)
    song_id = Column(String, ForeignKey("songs.id"), nullable=False)
    index = Column(Integer, nullable=False)
    start_time = Column(Float, nullable=False)
    end_time = Column(Float, nullable=False)
    lyrics = Column(Text, nullable=True)
    difficulty = Column(SQLEnum(SegmentDifficulty), default=SegmentDifficulty.NORMAL)
    is_chorus = Column(Boolean, default=False)
    status = Column(SQLEnum(SegmentStatus), default=SegmentStatus.UNASSIGNED)
    claim_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    song = relationship("Song", back_populates="segments")
    claims = relationship("SegmentClaim", back_populates="segment", lazy="selectin")


class SegmentClaim(Base):
    """唱段认领记录"""
    __tablename__ = "segment_claims"

    id = Column(String, primary_key=True, index=True)
    segment_id = Column(String, ForeignKey("segments.id"), nullable=False)
    user_id = Column(String, nullable=False)
    user_name = Column(String, nullable=False)
    status = Column(String, default="claimed")  # claimed / submitted
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    segment = relationship("Segment", back_populates="claims")


class Recording(Base):
    """录音记录"""
    __tablename__ = "recordings"

    id = Column(String, primary_key=True, index=True)
    segment_id = Column(String, ForeignKey("segments.id"), nullable=False)
    song_id = Column(String, nullable=False)
    user_id = Column(String, nullable=False)
    user_name = Column(String, nullable=False)
    audio_url = Column(String, nullable=True)
    score = Column(Float, default=0.0)
    likes = Column(Integer, default=0)
    submitted = Column(Boolean, default=False)
    selected = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
