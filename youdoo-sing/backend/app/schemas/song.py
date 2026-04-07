from pydantic import BaseModel
from datetime import datetime
from typing import List, Optional
from app.schemas.segment import SegmentResponse


class SongBase(BaseModel):
    title: str
    artist: Optional[str] = None


class SongCreate(SongBase):
    pass


class SongResponse(SongBase):
    id: str
    duration: float
    audio_url: str
    segment_count: int
    created_at: datetime
    segments: Optional[List[SegmentResponse]] = None
    
    class Config:
        from_attributes = True
