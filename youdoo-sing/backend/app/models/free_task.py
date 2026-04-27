from sqlalchemy import Column, String, Float, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.core.database import Base


class FreeTask(Base):
    """自由任务（每首歌最多 5 个）"""
    __tablename__ = "free_tasks"

    id = Column(String(32), primary_key=True, index=True)
    owner_admin_id = Column(String(32), nullable=True, index=True)
    song_id = Column(String(32), ForeignKey("songs.id", ondelete="CASCADE"), nullable=False, index=True)
    description = Column(Text, nullable=False)
    start_time = Column(Float, default=0.0, nullable=False)
    end_time = Column(Float, default=0.0, nullable=False)
    difficulty = Column(String(16), default="normal", nullable=False)
    task_type = Column("type", String(16), default="solo", nullable=False)
    created_at = Column(String(32), nullable=True)

    song = relationship("Song", back_populates="free_tasks")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "owner_admin_id": self.owner_admin_id,
            "description": self.description,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "difficulty": self.difficulty,
            "type": self.task_type,
            "created_at": self.created_at,
        }
