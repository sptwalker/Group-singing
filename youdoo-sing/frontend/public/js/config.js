// ===== 全局配置 =====
const API_BASE = 'http://127.0.0.1:8000/api';

// ===== 全局音频管理器（强制互斥） =====
const AudioManager = {
    _current: null,
    _onStop: null,

    play(src, onEnd, onTimeUpdate) {
        this.stop();
        const audio = new Audio(src);
        if (!src.startsWith('blob:')) audio.crossOrigin = 'anonymous';
        this._current = audio;
        audio.onplay = () => {
            if (this._onStop) this._onStop('playing');
        };
        audio.onpause = () => {
            // 手动暂停或自然暂停：通知 UI 重置按钮状态（但 stop() 会先清 _onStop 再同步调用）
            this._current = null;
            if (this._onStop) this._onStop();
            this._onStop = null;
        };
        audio.onended = () => {
            this._current = null;
            if (this._onStop) this._onStop();
            this._onStop = null;
            if (onEnd) onEnd();
        };
        audio.onerror = () => {
            this._current = null;
            if (this._onStop) this._onStop();
            this._onStop = null;
            showToast('音频加载失败');
        };
        if (onTimeUpdate) {
            audio.ontimeupdate = () => onTimeUpdate(audio.currentTime, audio.duration);
        }
        audio.play().catch(() => showToast('播放失败，请重试'));
        return audio;
    },

    playRange(src, startTime, endTime, onEnd, onTimeUpdate) {
        this.stop();
        const audio = new Audio(src);
        if (!src.startsWith('blob:')) audio.crossOrigin = 'anonymous';
        this._current = audio;

        const checkTime = () => {
            if (audio.currentTime >= endTime) {
                audio.pause();
                this._current = null;
                if (this._onStop) this._onStop();
                this._onStop = null;
                if (onEnd) onEnd();
            }
            if (onTimeUpdate) onTimeUpdate(audio.currentTime, audio.duration);
        };
        audio.ontimeupdate = checkTime;
        audio.onplay = () => {
            if (this._onStop) this._onStop('playing');
        };
        audio.onpause = () => {
            this._current = null;
            this._onStop = null;
        };
        audio.onended = () => {
            this._current = null;
            if (this._onStop) this._onStop();
            this._onStop = null;
            if (onEnd) onEnd();
        };
        audio.onerror = () => {
            this._current = null;
            if (this._onStop) this._onStop();
            this._onStop = null;
            showToast('音频加载失败');
        };

        const doPlay = () => {
            const doSeekAndPlay = () => {
                if (Math.abs(audio.currentTime - startTime) > 0.5) {
                    audio.addEventListener('seeked', () => {
                        audio.play().catch(() => showToast('播放失败'));
                    }, { once: true });
                    audio.currentTime = startTime;
                } else {
                    audio.currentTime = startTime;
                    audio.play().catch(() => showToast('播放失败'));
                }
            };
            doSeekAndPlay();
        };
        if (audio.readyState >= 1) {
            doPlay();
        } else {
            audio.preload = 'auto';
            audio.addEventListener('loadedmetadata', doPlay, { once: true });
        }
        return audio;
    },

    stop() {
        if (this._current) {
            this._current.onpause = null;
            this._current.ontimeupdate = null;
            this._current.onended = null;
            this._current.pause();
            this._current = null;
        }
        if (this._onStop) {
            this._onStop();
            this._onStop = null;
        }
    },

    isPlaying() {
        return this._current && !this._current.paused;
    },

    getCurrent() {
        return this._current;
    },

    setOnStop(fn) {
        this._onStop = fn;
    }
};

// ===== 工具函数 =====
function showToast(msg, duration = 2000) {
    let t = document.querySelector('.toast');
    if (!t) {
        t = document.createElement('div');
        t.className = 'toast';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function getUser() {
    const u = localStorage.getItem('youdoo_user');
    return u ? JSON.parse(u) : null;
}

function checkLogin() {
    if (!getUser()) {
        window.location.href = 'index.html';
        return false;
    }
    return true;
}

function generateWaveformBars(count = 20, playing = false) {
    let html = '<div class="waveform">';
    for (let i = 0; i < count; i++) {
        const h = Math.random() * 18 + 6;
        const delay = (Math.random() * 0.8).toFixed(2);
        const style = playing
            ? `animation-delay:${delay}s;`
            : `height:${h}px;animation:none;`;
        html += `<span class="bar" style="${style}"></span>`;
    }
    html += '</div>';
    return html;
}

async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '请求失败');
    }
    return res.json();
}

async function apiPost(path, formData) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        body: formData,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '请求失败');
    }
    return res.json();
}

async function apiDelete(path) {
    const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '请求失败');
    }
    return res.json();
}
