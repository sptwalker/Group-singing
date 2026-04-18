// ===== 全局配置 =====
const API_BASE = (window.YOUDOO_API_BASE || '/api').replace(/\/$/, '');
let _loginRedirectTimer = 0;

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

    if (!getUser() && /Please sign in/i.test(String(msg || '')) && !_loginRedirectTimer) {
        const target = getCurrentPageTarget('task.html');
        _loginRedirectTimer = setTimeout(() => {
            _loginRedirectTimer = 0;
            startLoginFlow(target);
        }, 250);
    }
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

const LOGIN_TARGET_KEY = 'youdoo_login_target';
let _wechatLoginConfigPromise = null;
let _wechatCallbackPromise = null;

function getCurrentPageTarget(defaultTarget = 'task.html') {
    const path = window.location.pathname.split('/').pop() || defaultTarget;
    const search = window.location.search || '';
    const hash = window.location.hash || '';
    return `${path}${search}${hash}`;
}

function normalizeLoginTarget(target, defaultTarget = 'task.html') {
    const raw = (target || '').trim();
    if (!raw) return defaultTarget;
    if (/^[a-z]+:/i.test(raw) || raw.startsWith('//')) return defaultTarget;

    try {
        const url = new URL(raw, window.location.origin + '/');
        const path = url.pathname.replace(/^\/+/, '') || defaultTarget;
        const allowed = new Set(['index.html', 'task.html', 'record.html']);
        if (!allowed.has(path)) return defaultTarget;
        return `${path}${url.search}${url.hash}`;
    } catch (error) {
        return defaultTarget;
    }
}

function setPendingLoginTarget(target) {
    localStorage.setItem(LOGIN_TARGET_KEY, normalizeLoginTarget(target, getCurrentPageTarget()));
}

function getPendingLoginTarget(defaultTarget = 'task.html', consume = false) {
    const stored = localStorage.getItem(LOGIN_TARGET_KEY);
    const target = normalizeLoginTarget(stored, defaultTarget);
    if (consume) {
        localStorage.removeItem(LOGIN_TARGET_KEY);
    }
    return target;
}

function getWechatCallbackParams() {
    const params = new URLSearchParams(window.location.search || '');
    return {
        code: params.get('code') || '',
        state: params.get('state') || '',
        appid: params.get('appid') || '',
        from: params.get('from') || '',
        isappinstalled: params.get('isappinstalled') || '',
    };
}

function hasWechatAuthCallbackParams() {
    const params = getWechatCallbackParams();
    return !!params.code;
}

function clearWechatCallbackParams() {
    const url = new URL(window.location.href);
    ['code', 'state', 'appid', 'from', 'isappinstalled'].forEach((key) => {
        url.searchParams.delete(key);
    });
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, document.title, nextUrl);
}

function isWeChatBrowser() {
    return /MicroMessenger/i.test(navigator.userAgent || '');
}

async function getWechatLoginConfig() {
    if (!_wechatLoginConfigPromise) {
        _wechatLoginConfigPromise = apiGet('/auth/wechat/config')
            .then(res => res.data || { enabled: false })
            .catch(() => ({ enabled: false }));
    }
    return _wechatLoginConfigPromise;
}

async function startLoginFlow(target) {
    const safeTarget = normalizeLoginTarget(target, getCurrentPageTarget());
    setPendingLoginTarget(safeTarget);

    const config = await getWechatLoginConfig();
    if (config.enabled) {
        window.location.href = `${API_BASE}/auth/wechat/login?target=${encodeURIComponent(safeTarget)}`;
        return true;
    }

    window.location.href = 'index.html';
    return false;
}

async function handleWechatAuthCallback() {
    if (_wechatCallbackPromise) return _wechatCallbackPromise;
    if (!hasWechatAuthCallbackParams()) return null;

    const params = getWechatCallbackParams();
    const safeTarget = normalizeLoginTarget(
        params.state,
        getPendingLoginTarget(getCurrentPageTarget('task.html'))
    );
    setPendingLoginTarget(safeTarget);

    _wechatCallbackPromise = apiGet(
        `/auth/wechat/callback?mode=json&code=${encodeURIComponent(params.code)}&state=${encodeURIComponent(safeTarget)}`
    ).then((res) => {
        const data = res.data || {};
        const user = data.user || null;
        const target = normalizeLoginTarget(data.target || safeTarget, safeTarget);
        if (!user || !user.id) {
            throw new Error('Missing WeChat user info');
        }
        localStorage.setItem('youdoo_user', JSON.stringify(user));
        setPendingLoginTarget(target);
        clearWechatCallbackParams();
        return { user, target };
    }).catch((error) => {
        clearWechatCallbackParams();
        throw error;
    });

    return _wechatCallbackPromise;
}

function installGuestTaskLoginHandler() {
    if (getUser()) return;
    if (!/^task\.html(?:[?#]|$)/i.test(getCurrentPageTarget('task.html'))) return;

    const btnLogout = document.getElementById('btnLogout');
    if (!btnLogout || btnLogout.dataset.loginBound === '1') return;

    btnLogout.dataset.loginBound = '1';
    btnLogout.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        startLoginFlow('task.html');
    }, true);
}

function enhanceRecordLoginState() {
    if (getUser()) return;
    if (!/^record\.html(?:[?#]|$)/i.test(getCurrentPageTarget('record.html'))) return;

    const emptyState = document.querySelector('.empty-recordings');
    if (!emptyState || document.getElementById('btnRecordLogin')) return;

    const actionWrap = document.createElement('div');
    actionWrap.style.marginTop = '16px';
    actionWrap.innerHTML = '<button type="button" id="btnRecordLogin" class="btn-record-ctrl btn-record">Sign in</button>';
    emptyState.appendChild(actionWrap);

    const btnRecordLogin = document.getElementById('btnRecordLogin');
    if (btnRecordLogin) {
        btnRecordLogin.addEventListener('click', () => startLoginFlow('record.html'));
    }
}

installGuestTaskLoginHandler();

setTimeout(() => {
    installGuestTaskLoginHandler();
    enhanceRecordLoginState();
}, 0);

window.addEventListener('load', () => {
    installGuestTaskLoginHandler();
    enhanceRecordLoginState();
});

if (hasWechatAuthCallbackParams()) {
    window.__YOUDOO_WECHAT_AUTH_PENDING = true;
    handleWechatAuthCallback()
        .then(({ target }) => {
            window.__YOUDOO_WECHAT_AUTH_PENDING = false;
            window.location.replace(target || getPendingLoginTarget('task.html', true));
        })
        .catch((error) => {
            window.__YOUDOO_WECHAT_AUTH_PENDING = false;
            showToast(error.message || 'WeChat login failed');
            setTimeout(() => {
                window.location.replace('index.html');
            }, 800);
        });
} else {
    window.__YOUDOO_WECHAT_AUTH_PENDING = false;
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
