from sqlalchemy import Column, String, Float, Integer, ForeignKey, Boolean, Text
from sqlalchemy.orm import relationship
from app.core.database import Base


class Segment(Base):
    """唱段"""
    __tablename__ = "segments"

    id = Column(String(64), primary_key=True, index=True)
    song_id = Column(String(32), ForeignKey("songs.id", ondelete="CASCADE"), nullable=False, index=True)
    index = Column(Integer, nullable=False, default=0)
    start_time = Column(Float, nullable=False, default=0.0)
    end_time = Column(Float, nullable=False, default=0.0)
    lyrics = Column(Text, nullable=True)
    difficulty = Column(String(16), default="normal", nullable=False)
    is_chorus = Column(Boolean, default=False, nullable=False)
    status = Column(String(16), default="unassigned", nullable=False)
    claim_count = Column(Integer, default=0, nullable=False)
    submit_count = Column(Integer, default=0, nullable=False)
    created_at = Column(String(32), nullable=True)

    song = relationship("Song", back_populates="segments")
    claims = relationship(
        "SegmentClaim",
        back_populates="segment",
        lazy="selectin",
        cascade="all, delete-orphan",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "song_id": self.song_id,
            "index": self.index,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "lyrics": self.lyrics or "",
            "difficulty": self.difficulty,
            "is_chorus": self.is_chorus,
            "status": self.status,
            "claim_count": self.claim_count,
            "submit_count": self.submit_count,
            "claims": [c.to_dict() for c in self.claims],
        }


class SegmentClaim(Base):
    """唱段认领记录"""
    __tablename__ = "segment_claims"

    id = Column(String(32), primary_key=True, index=True)
    segment_id = Column(String(64), ForeignKey("segments.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(64), nullable=False, index=True)
    user_name = Column(String(255), nullable=False)
    status = Column(String(16), default="claimed", nullable=False)
    created_at = Column(String(32), nullable=True)

    segment = relationship("Segment", back_populates="claims")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "segment_id": self.segment_id,
            "user_id": self.user_id,
            "user_name": self.user_name,
            "status": self.status,
        }
