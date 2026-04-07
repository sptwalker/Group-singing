import { useState, useRef } from 'react'

interface AudioUploaderProps {
  onUpload?: (file: File) => void
}

function AudioUploader({ onUpload }: AudioUploaderProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    
    const files = e.dataTransfer.files
    if (files.length > 0) {
      handleFile(files[0])
    }
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      handleFile(files[0])
    }
  }

  const handleFile = (file: File) => {
    if (!file.type.startsWith('audio/')) {
      alert('请上传音频文件')
      return
    }
    onUpload?.(file)
  }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
        transition-colors duration-200
        ${isDragging 
          ? 'border-blue-500 bg-blue-50' 
          : 'border-gray-300 hover:border-gray-400'
        }
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        onChange={handleFileInput}
        className="hidden"
      />
      <div className="text-4xl mb-2">🎵</div>
      <p className="text-gray-600">
        点击或拖拽音频文件到此处上传
      </p>
      <p className="text-gray-400 text-sm mt-1">
        支持 MP3, WAV, M4A 等格式
      </p>
    </div>
  )
}

export default AudioUploader
