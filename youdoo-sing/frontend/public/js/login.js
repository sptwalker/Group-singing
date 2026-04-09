// ===== 登录页逻辑 =====
(function () {
    // 如果已登录，直接跳转
    if (getUser()) {
        window.location.href = 'task.html';
        return;
    }

    const btnLogin = document.getElementById('btnLogin');
    const nicknameModal = document.getElementById('nicknameModal');
    const btnUseWx = document.getElementById('btnUseWx');
    const btnCustom = document.getElementById('btnCustom');
    const customInputWrap = document.getElementById('customInputWrap');
    const customName = document.getElementById('customName');
    const btnConfirm = document.getElementById('btnConfirm');
    const songList = document.getElementById('songList');

    let nameType = 'wx';
    const fakeWxName = '微信用户' + Math.floor(Math.random() * 9000 + 1000);

    // 加载歌曲预览
    loadSongPreview();

    async function loadSongPreview() {
        try {
            const res = await apiGet('/songs');
            if (res.success && res.data.length > 0) {
                const emojis = ['🎵', '🎶', '🎸', '🎹', '🎤'];
                songList.innerHTML = res.data.slice(0, 3).map((s, i) => `
                    <div class="song-item">
                        <div class="song-info">
                            <span class="song-emoji">${emojis[i % emojis.length]}</span>
                            <div>
                                <div class="song-name">${s.title}</div>
                                <div class="song-artist">${s.artist}</div>
                            </div>
                        </div>
                        <span class="progress-badge">${s.completion}%</span>
                    </div>
                `).join('');
            } else {
                songList.innerHTML = '<div class="song-item"><div class="song-info"><span class="song-emoji">🎵</span><div><div class="song-name">暂无拼歌任务</div></div></div></div>';
            }
        } catch (e) {
            songList.innerHTML = '<div class="song-item"><div class="song-info"><span class="song-emoji">⚠️</span><div><div class="song-name">服务连接中...</div></div></div></div>';
        }
    }

    // 点击登录
    btnLogin.addEventListener('click', () => {
        nicknameModal.style.display = 'flex';
    });

    // 切换昵称类型
    btnUseWx.addEventListener('click', () => {
        nameType = 'wx';
        btnUseWx.classList.add('active');
        btnCustom.classList.remove('active');
        customInputWrap.style.display = 'none';
    });
    btnCustom.addEventListener('click', () => {
        nameType = 'custom';
        btnCustom.classList.add('active');
        btnUseWx.classList.remove('active');
        customInputWrap.style.display = 'block';
        customName.focus();
    });

    // 点击遮罩关闭
    nicknameModal.addEventListener('click', (e) => {
        if (e.target === nicknameModal) nicknameModal.style.display = 'none';
    });

    // 确认登录
    btnConfirm.addEventListener('click', async () => {
        let nickname = nameType === 'wx' ? fakeWxName : customName.value.trim();
        if (!nickname) {
            showToast('请输入昵称');
            return;
        }

        btnConfirm.textContent = '登录中...';
        btnConfirm.disabled = true;

        try {
            const fd = new FormData();
            fd.append('nickname', nickname);
            const res = await apiPost('/user/login', fd);
            if (res.success) {
                localStorage.setItem('youdoo_user', JSON.stringify(res.data));
                showToast('登录成功');
                setTimeout(() => {
                    window.location.href = 'task.html';
                }, 500);
            }
        } catch (e) {
            showToast('登录失败：' + e.message);
            btnConfirm.textContent = '确认进入';
            btnConfirm.disabled = false;
        }
    });
})();
