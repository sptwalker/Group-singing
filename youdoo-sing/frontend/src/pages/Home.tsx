import { useState, useEffect } from 'react'
import axios from 'axios'

<<<<<<< HEAD
=======
const API_BASE_URL = 'http://sing.youdoogo.com:8000'

>>>>>>> 107b13014f86ae4e2e0abc7e2581d8b42efd756d
function Home() {
  const [health, setHealth] = useState<string>('checking...')

  useEffect(() => {
    checkHealth()
  }, [])

  const checkHealth = async () => {
    try {
      const response = await axios.get('/health')
      setHealth(response.data.status)
    } catch (error) {
      setHealth('disconnected')
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4">欢迎使用 YouDoo Sing</h2>
        <p className="text-gray-600 mb-4">
          这是一个多人拼歌系统，您可以上传歌曲，系统将自动进行乐句切分，
          然后邀请朋友们一起完成各自的唱段。
        </p>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">后端状态:</span>
          <span className={`px-2 py-1 rounded text-sm font-medium ${
            health === 'healthy' 
              ? 'bg-green-100 text-green-800' 
              : 'bg-red-100 text-red-800'
          }`}>
            {health}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-3">🎵 上传歌曲</h3>
          <p className="text-gray-500 text-sm">即将上线：上传您的歌曲进行自动乐句切分</p>
        </div>
        
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-3">🎤 录制唱段</h3>
          <p className="text-gray-500 text-sm">即将上线：在浏览器中录制您的唱段</p>
        </div>
      </div>
    </div>
  )
}

export default Home
