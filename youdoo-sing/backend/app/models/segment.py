from sqlalchemy import Column, String, Float, ForeignKey, Enum as SQLEnum
import enum
from app.core.database import Base


class SegmentStatus(str, enum.Enum):
    """唱段状态枚举"""
    UNASSIGNED = "unassigned"
    LOCKED = "locked"
    COMPLETED = "completed"


class Segment(Base):
    """唱段模型"""
    __tablename__ = "segments"
    
    id = Column(String, primary_key=True, index=True)
    song_id = Column(String, ForeignKey("songs.id"), nullable=False)
    start_time = Column(Float, nullable=False)
    end_time = Column(Float, nullable=False)
    status = Column(SQLEnum(SegmentStatus), default=SegmentStatus.UNASSIGNED)
    assigned_to = Column(String, nullable=True)
    audio_url = Column(String, nullable=True)
