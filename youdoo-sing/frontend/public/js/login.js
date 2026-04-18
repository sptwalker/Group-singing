(function () {
    if (getUser()) {
        window.location.href = getPendingLoginTarget('task.html', true);
        return;
    }

    const btnLogin = document.getElementById('btnLogin');
    const songList = document.getElementById('songList');

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
