// 唱段状态枚举
export enum SegmentStatus {
  UNASSIGNED = 'unassigned',   // 未分配
  LOCKED = 'locked',           // 已锁定（某人正在唱）
  COMPLETED = 'completed',     // 已完成
}

// 唱段接口
export interface Segment {
  id: string
  startTime: number      // 开始时间（秒）
  endTime: number        // 结束时间（秒）
  status: SegmentStatus
  assignedTo?: string    // 分配给哪个用户
  audioUrl?: string      // 录制完成的音频URL
}

// 歌曲接口
export interface Song {
  id: string
  title: string
  artist: string
  duration: number       // 总时长（秒）
  audioUrl: string
  segments: Segment[]
  createdAt: string
}

// API响应类型
export interface ApiResponse<T> {
  success: boolean
  data?: T
  message?: string
}
