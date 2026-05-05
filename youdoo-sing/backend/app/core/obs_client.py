import io
import os
from typing import Optional

try:
    import obs as huaweiobs
    _OBS_AVAILABLE = True
except ImportError:
    _OBS_AVAILABLE = False

_client: Optional[object] = None
_bucket: str = ""


def _init():
    global _client, _bucket
    if not _OBS_AVAILABLE:
        raise RuntimeError("esdk-obs-python 未安装，请执行: pip install esdk-obs-python")
    ak = os.environ.get("OBS_ACCESS_KEY", "")
    sk = os.environ.get("OBS_SECRET_KEY", "")
    endpoint = os.environ.get("OBS_ENDPOINT", "")
    bucket = os.environ.get("OBS_BUCKET", "")
    if not all([ak, sk, endpoint, bucket]):
        raise RuntimeError("OBS 未配置，请在 .env 中设置 OBS_ACCESS_KEY / OBS_SECRET_KEY / OBS_ENDPOINT / OBS_BUCKET")
    _client = huaweiobs.ObsClient(
        access_key_id=ak,
        secret_access_key=sk,
        server=endpoint,
    )
    _bucket = bucket


def _get_client():
    global _client, _bucket
    if _client is None:
        _init()
    return _client, _bucket


def obs_upload_file(local_path: str, obs_key: str) -> bool:
    """上传本地文件到 OBS"""
    client, bucket = _get_client()
    resp = client.putFile(bucketName=bucket, objectKey=obs_key, file_path=local_path)
    if resp.status >= 300:
        print(f"[obs] upload failed: key={obs_key} status={resp.status} err={getattr(resp, 'errorMessage', '')}")
    return resp.status < 300


def obs_download_file(obs_key: str, local_path: str) -> bool:
    """从 OBS 下载文件到本地"""
    client, bucket = _get_client()
    resp = client.getObject(bucketName=bucket, objectKey=obs_key, downloadPath=local_path)
    if resp.status >= 300:
        print(f"[obs] download failed: key={obs_key} status={resp.status}")
    return resp.status < 300


def obs_delete_object(obs_key: str) -> None:
    """删除 OBS 对象（失败仅记录日志）"""
    if not obs_key:
        return
    try:
        client, bucket = _get_client()
        client.deleteObject(bucketName=bucket, objectKey=obs_key)
    except Exception as e:
        print(f"[obs] delete failed: key={obs_key} err={e}")


def obs_delete_prefix(prefix: str) -> None:
    """删除 OBS 中所有以 prefix 开头的对象"""
    if not prefix:
        return
    try:
        client, bucket = _get_client()
        marker = None
        while True:
            kwargs = {"bucketName": bucket, "prefix": prefix}
            if marker:
                kwargs["marker"] = marker
            resp = client.listObjects(**kwargs)
            if resp.status != 200 or not resp.body.contents:
                break
            for obj in resp.body.contents:
                client.deleteObject(bucketName=bucket, objectKey=obj.key)
            if resp.body.is_truncated:
                marker = resp.body.next_marker
            else:
                break
    except Exception as e:
        print(f"[obs] delete prefix failed: prefix={prefix} err={e}")


def obs_get_presigned_url(obs_key: str, expires: int = 3600) -> str:
    """生成 OBS 对象的临时预签名下载 URL"""
    client, bucket = _get_client()
    resp = client.createSignedUrl(
        method="GET",
        bucketName=bucket,
        objectKey=obs_key,
        expires=expires,
    )
    return resp.signedUrl


def url_to_obs_key(audio_url: str) -> str:
    """将 API URL 转换为 OBS 对象 key
    /api/uploads/abc.mp3 → uploads/abc.mp3
    /api/finals/final_xxx.mp3 → finals/final_xxx.mp3
    """
    if not audio_url:
        return ""
    if "/api/uploads/" in audio_url:
        return "uploads/" + audio_url.split("/api/uploads/")[-1]
    if "/api/finals/" in audio_url:
        return "finals/" + audio_url.split("/api/finals/")[-1]
    return ""
