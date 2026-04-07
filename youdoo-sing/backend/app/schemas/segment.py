from pydantic import BaseModel
from typing import Optional
from app.models.segment import SegmentStatus


class SegmentBase(BaseModel):
    start_time: float
    end_time: float


class SegmentCreate(SegmentBase):
    song_id: str


class SegmentUpdate(BaseModel):
    status: Optional[SegmentStatus] = None
    assigned_to: Optional[str] = None
    audio_url: Optional[str] = None


class SegmentResponse(SegmentBase):
    id: str
    song_id: str
    status: SegmentStatus
    assigned_to: Optional[str]
    audio_url: Optional[str]
    
    class Config:
        from_attributes = True
