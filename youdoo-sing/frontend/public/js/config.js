// ===== 全局配置 =====
const API_BASE = 'http://sing.youdoogo.com:8000/api';

// ===== 全局音频管理器（强制互斥） =====
const AudioManager = {
    _current: null,
    _onStop: null,
    _pitchSemitones: 0,
    _rangeRAF: 0,

    /** 设置升降调（半音数），范围 -6 ~ +6 */
    setPitch(semitones) {
        this._pitchSemitones = Math.max(-6, Math.min(6, semitones));
        if (this._current) {
            this._current.preservesPitch = false;
            this._current.playbackRate = Math.pow(2, this._pitchSemitones / 12);
        }
    },

    getPitch() { return this._pitchSemitones; },

    _applyPitch(audio) {
        if (this._pitchSemitones !== 0) {
            audio.preservesPitch = false;
            audio.playbackRate = Math.pow(2, this._pitchSemitones / 12);
        }
    },

    play(src, onEnd, onTimeUpdate) {
        this.stop();
        const audio = new Audio(src);
        if (!src.startsWith('blob:')) audio.crossOrigin = 'anonymous';
        this._applyPitch(audio);
        this._current = audio;
        audio.onplay = () => {
            if (this._onStop) this._onStop('playing');
        };
        audio.onpause = () => {
            // 手动暂停不清空 _current，允许恢复播放
            // stop() 会先清 onpause 再 pause()，所以 stop 不会触发这里
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
        this._applyPitch(audio);
        this._current = audio;
        let _rangeEnded = false;  // 标记是否已由 finishRange 触发结束

        const self = this;
        // 清理上一次的 RAF
        if (self._rangeRAF) { cancelAnimationFrame(self._rangeRAF); self._rangeRAF = 0; }

        const finishRange = () => {
            if (_rangeEnded) return;
            _rangeEnded = true;
            if (self._rangeRAF) { cancelAnimationFrame(self._rangeRAF); self._rangeRAF = 0; }
            audio.onpause = null;
            audio.ontimeupdate = null;
            audio.onended = null;
            audio.pause();
            self._current = null;
            if (self._onStop) self._onStop();
            self._onStop = null;
            if (onEnd) onEnd();
        };

        // 高频 RAF 检测循环（~60fps），确保精确检测 endTime
        const tickRange = () => {
            if (_rangeEnded) return;
            if (audio.currentTime >= endTime) {
                console.log('[playRange] RAF检测到达endTime, cur=', audio.currentTime, 'end=', endTime);
                finishRange();
                return;
            }
            if (onTimeUpdate) onTimeUpdate(audio.currentTime, audio.duration);
            self._rangeRAF = requestAnimationFrame(tickRange);
        };

        audio.onplay = () => {
            if (self._onStop) self._onStop('playing');
            // 启动 RAF 检测循环
            if (!self._rangeRAF && !_rangeEnded) {
                self._rangeRAF = requestAnimationFrame(tickRange);
            }
        };
        audio.onpause = () => {
            // 停止 RAF 循环
            if (self._rangeRAF) { cancelAnimationFrame(self._rangeRAF); self._rangeRAF = 0; }
            // 仅在非 finishRange 触发的 pause 时清除（如外部调用 stop()）
            if (!_rangeEnded) {
                self._current = null;
                self._onStop = null;
            }
        };
        audio.onended = () => {
            if (_rangeEnded) return;
            console.log('[playRange] onended 触发');
            finishRange();
        };
        audio.onerror = () => {
            if (self._rangeRAF) { cancelAnimationFrame(self._rangeRAF); self._rangeRAF = 0; }
            _rangeEnded = true;
            self._current = null;
            if (self._onStop) self._onStop();
            self._onStop = null;
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
        // 清理 playRange 的 RAF 循环
        if (this._rangeRAF) { cancelAnimationFrame(this._rangeRAF); this._rangeRAF = 0; }
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
