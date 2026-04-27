(async function () {
    if (hasWechatAuthCallbackParams()) {
        const btnLogin = document.getElementById('btnLogin');
        if (btnLogin) {
            btnLogin.disabled = true;
            btnLogin.innerHTML = '<span class="wechat-icon">&#128241;</span> 登录中...';
        }
        return;
    }

    await initCurrentUser();
    if (getUser()) {
        window.location.href = getPendingLoginTarget('task.html', true);
        return;
    }

    const btnLogin = document.getElementById('btnLogin');
    const songList = document.getElementById('songList');
    const btnPasswordLogin = document.getElementById('btnPasswordLogin');
    const btnRegister = document.getElementById('btnRegister');
    const inputUsername = document.getElementById('inputUsername');
    const inputPassword = document.getElementById('inputPassword');

    loadSongPreview();

    async function loadSongPreview() {
        try {
            const res = await apiGet('/songs');
            if (res.success && Array.isArray(res.data) && res.data.length > 0) {
                const icons = ['&#127925;', '&#127926;', '&#127908;', '&#127911;', '&#127928;'];
                songList.innerHTML = res.data.slice(0, 3).map((song, index) => `
                    <div class="song-item">
                        <div class="song-info">
                            <span class="song-emoji">${icons[index % icons.length]}</span>
                            <div>
                                <div class="song-name">${song.title}</div>
                                <div class="song-artist">${song.artist}</div>
                            </div>
                        </div>
                        <span class="progress-badge">${song.completion}%</span>
                    </div>
                `).join('');
                return;
            }
            songList.innerHTML = '<div class="song-item"><div class="song-info"><span class="song-emoji">&#127925;</span><div><div class="song-name">暂无拼歌任务</div></div></div></div>';
        } catch (error) {
            songList.innerHTML = '<div class="song-item"><div class="song-info"><span class="song-emoji">&#9888;</span><div><div class="song-name">服务连接中...</div></div></div></div>';
        }
    }

    async function doPasswordAuth(isRegister) {
        const username = (inputUsername.value || '').trim();
        const password = (inputPassword.value || '').trim();
        if (!username || !password) {
            showToast('请输入用户名和密码');
            return;
        }
        const fd = new FormData();
        fd.append('username', username);
        fd.append('password', password);
        const endpoint = isRegister ? '/auth/register' : '/auth/login';
        try {
            const res = await fetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                body: fd,
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || (isRegister ? '注册失败' : '登录失败'));
            _currentUser = data.data;
            window.location.href = getPendingLoginTarget('task.html', true);
        } catch (e) {
            showToast(e.message);
        }
    }

    btnPasswordLogin.addEventListener('click', () => doPasswordAuth(false));
    btnRegister.addEventListener('click', () => doPasswordAuth(true));

    inputPassword.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doPasswordAuth(false);
    });

    async function handleWechatLogin() {
        setPendingLoginTarget('task.html');
        btnLogin.disabled = true;
        btnLogin.innerHTML = '<span class="wechat-icon">&#128241;</span> 跳转微信授权...';
        window.location.href = `${API_BASE}/auth/wechat/login?target=${encodeURIComponent('task.html')}`;
    }

    btnLogin.addEventListener('click', async () => {
        setPendingLoginTarget('task.html');

        const config = await getWechatLoginConfig();
        if (!config.enabled) {
            showToast('微信登录未配置');
            return;
        }

        await handleWechatLogin();
    });
})();
