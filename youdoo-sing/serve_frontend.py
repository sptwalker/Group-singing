"""简单的前端静态文件服务器"""
import http.server
import os

PORT = 3000
DIRECTORY = os.path.join(os.path.dirname(__file__), "frontend", "public")

os.chdir(DIRECTORY)

handler = http.server.SimpleHTTPRequestHandler
with http.server.HTTPServer(("0.0.0.0", PORT), handler) as httpd:
    print(f"前端服务运行在 http://localhost:{PORT}")
    print(f"服务目录: {DIRECTORY}")
    httpd.serve_forever()
