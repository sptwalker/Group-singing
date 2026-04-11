// ===== 任务页逻辑 =====
(function () {
    if (!checkLogin()) return;

    const user = getUser();
    let songs = [];
    let currentSongIndex = 0;
    let currentSong = null;
    let sortMode = 'time';
    let focusSegId = null;
    let expandedSegId = null; // 当前展开的歌词标签

    // DOM
    const songTitle = document.getElementById('songTitle');
    const songArtist = document.getElementById('songArtist');
    const userAvatar = document.getElementById('userAvatar');
    const btnPlay = document.getElementById('btnPlay');
    const btnPause = document.getElementById('btnPause');
    const btnStop = document.getElementById('btnStop');
    const progressFill = document.getElementById('progressFill');
    const progressBar = document.getElementById('progressBar');
    const timeLabel = document.getElementById('timeLabel');
    const statCompletion = document.getElementById('statCompletion');
    const statParticipants = document.getElementById('statParticipants');
    const statSegments = document.getElementById('statSegments');
    const lyricsTaskList = document.getElementById('lyricsTaskList');
    const btnRandom = document.getElementById('btnRandom');
    const navPrev = document.getElementById('navPrev');
    const navNext = document.getElementById('navNext');
    const recordingList = document.getElementById('recordingList');

    // 初始化头像
    userAvatar.src = user.avatar;
    userAvatar.addEventListener('click', () => {
        if (confirm('确定退出登录？')) {
            localStorage.removeItem('youdoo_user');
            window.location.href = 'index.html';
        }
    });

    init();

    async function init() {
        try {
            const res = await apiGet('/songs');
            songs = res.data || [];
            if (songs.length === 0) {
                songTitle.textContent = '暂无拼歌任务';
                return;
            }
            loadSong(0);
        } catch (e) {
            showToast('加载失败：' + e.message);
        }
    }

    async function loadSong(index) {
        currentSongIndex = index;
        const songId = songs[index].id;
        try {
            const res = await apiGet(`/songs/${songId}`);
            currentSong = res.data;
        } catch (e) {
            console.error('[task] loadSong API error:', e);
            showToast('加载歌曲失败：' + e.message);
            return;
        }
        try {
            renderSong();
            loadRecordings();
        } catch (e) {
            console.error('[task] renderSong error:', e);
            showToast('渲染失败：' + e.message);
        }
    }

    function renderSong() {
        const s = currentSong;
        songTitle.textContent = s.title;
        songArtist.textContent = s.artist;
        statCompletion.textContent = s.completion + '%';
        statParticipants.textContent = s.participant_count;
        statSegments.textContent = s.segment_count;

        renderLyricsTaskList();
        updateNavButtons();
    }

    // ===== 歌词任务列表 =====
    function renderLyricsTaskList() {
        const segs = currentSong.segments || [];
        expandedSegId = null;

        lyricsTaskList.innerHTML = segs.map((seg, i) => {
            const isCompleted = seg.status === 'completed';
            const submitCount = seg.submit_count || 0;
            const diffLabels = { easy: '简', normal: '中', hard: '难' };
            const diffCls = seg.difficulty;

            return `
                <div class="lyric-task-item ${isCompleted ? 'completed' : ''}" data-seg-id="${seg.id}" data-index="${i}">
                    <div class="lyric-task-main">
                        <span class="lyric-task-num">${seg.index}</span>
                        <span class="lyric-task-diff diff-${diffCls}">${diffLabels[seg.difficulty]}</span>
                        ${seg.is_chorus ? '<span class="lyric-task-chorus">合</span>' : ''}
                        <span class="lyric-task-text">${seg.lyrics || '♪ ♪ ♪'}</span>
                        <span class="lyric-task-count">${submitCount > 0 ? submitCount + '人' : ''}</span>
                    </div>
                    <div class="lyric-task-expand" data-seg-id="${seg.id}" style="display:none;">
                        <button class="lyric-task-btn btn-lt-play" data-seg-id="${seg.id}">▶ 试听</button>
                        <button class="lyric-task-btn btn-lt-record ${isCompleted ? 'disabled' : ''}" data-seg-id="${seg.id}" ${isCompleted ? 'disabled' : ''}>🎤 录音</button>
                    </div>
                </div>
            `;
        }).join('');

        // 绑定点击
        lyricsTaskList.querySelectorAll('.lyric-task-item').forEach(item => {
            item.querySelector('.lyric-task-main').addEventListener('click', () => {
                onLyricItemClick(item);
            });
        });

        // 绑定试听按钮
        lyricsTaskList.querySelectorAll('.btn-lt-play').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                onLyricPreview(btn);
            });
        });

        // 绑定录音按钮
        lyricsTaskList.querySelectorAll('.btn-lt-record').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                onLyricRecord(btn);
            });
        });
    }

    function onLyricItemClick(item) {
        const segId = item.dataset.segId;
        const seg = currentSong.segments.find(s => s.id === segId);
        if (!seg) return;

        // 收起之前展开的
        lyricsTaskList.querySelectorAll('.lyric-task-item').forEach(it => {
            if (it.dataset.segId !== segId) {
                it.classList.remove('expanded');
                it.querySelector('.lyric-task-expand').style.display = 'none';
            }
        });

        // 切换当前展开
        const expandEl = item.querySelector('.lyric-task-expand');
        const isExpanded = item.classList.contains('expanded');
        if (isExpanded) {
            item.classList.remove('expanded');
            expandEl.style.display = 'none';
            expandedSegId = null;
        } else {
            item.classList.add('expanded');
            expandEl.style.display = 'flex';
            expandedSegId = segId;
        }

        // 联动录音列表
        focusSegId = segId;
        sortMode = 'order';
        document.querySelectorAll('.sort-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.sort === 'order');
        });
        renderRecordings();
    }

    function onLyricPreview(btn) {
        const segId = btn.dataset.segId;
        const seg = currentSong.segments.find(s => s.id === segId);
        if (!seg) return;

        if (btn.classList.contains('playing')) {
            AudioManager.stop();
            btn.textContent = '▶ 试听';
            btn.classList.remove('playing');
            return;
        }

        // 停止其他播放按钮
        lyricsTaskList.querySelectorAll('.btn-lt-play.playing').forEach(b => {
            b.textContent = '▶ 试听';
            b.classList.remove('playing');
        });
        resetPlayButtons();
        isFullPlaying = false;

        const audioUrl = `${API_BASE.replace('/api', '')}${currentSong.audio_url}`;
        AudioManager.playRange(audioUrl, seg.start_time, seg.end_time,
            () => {
                btn.textContent = '▶ 试听';
                btn.classList.remove('playing');
            }
        );
        btn.textContent = '⏹ 停止';
        btn.classList.add('playing');
    }

    function onLyricRecord(btn) {
        const segId = btn.dataset.segId;
        const seg = currentSong.segments.find(s => s.id === segId);
        if (!seg || seg.status === 'completed') return;

        // 先认领再进录音页
        claimAndRecord(seg);
    }

    async function claimAndRecord(seg) {
        try {
            const fd = new FormData();
            fd.append('user_id', user.id);
            fd.append('user_name', user.nickname);
            await apiPost(`/segments/${seg.id}/claim`, fd);

            localStorage.setItem('youdoo_record_segment', JSON.stringify(seg));
            localStorage.setItem('youdoo_record_song', JSON.stringify(currentSong));
            window.location.href = 'record.html';
        } catch (e) {
            showToast('认领失败：' + e.message);
        }
    }

    // ===== 整曲播放控制 =====
    let isFullPlaying = false;

    btnPlay.addEventListener('click', () => {
        if (isFullPlaying) return;
        const audioUrl = `${API_BASE.replace('/api', '')}${currentSong.audio_url}`;
        AudioManager.play(audioUrl,
            () => { resetPlayButtons(); isFullPlaying = false; },
            (cur, dur) => {
                progressFill.style.width = (cur / dur * 100) + '%';
                timeLabel.textContent = formatTime(cur);
            }
        );
        isFullPlaying = true;
        btnPlay.classList.add('active');
        btnPause.classList.remove('active');
    });

    btnPause.addEventListener('click', () => {
        const audio = AudioManager.getCurrent();
        if (audio && isFullPlaying) {
            if (audio.paused) {
                audio.play();
                btnPause.classList.remove('active');
                btnPlay.classList.add('active');
            } else {
                audio.pause();
                btnPause.classList.add('active');
                btnPlay.classList.remove('active');
            }
        } else if (audio && !isFullPlaying && audio.paused) {
            // resume from paused preview
            audio.play();
            btnPlay.classList.add('active');
            btnPause.classList.remove('active');
        }
    });

    btnStop.addEventListener('click', () => {
        AudioManager.stop();
        resetPlayButtons();
        isFullPlaying = false;
        progressFill.style.width = '0%';
        timeLabel.textContent = '0:00';
    });

    progressBar.addEventListener('click', (e) => {
        const audio = AudioManager.getCurrent();
        if (audio && isFullPlaying) {
            const rect = progressBar.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            audio.currentTime = ratio * audio.duration;
        }
    });

    function resetPlayButtons() {
        btnPlay.classList.remove('active');
        btnPause.classList.remove('active');
    }

    // ===== 随机领取 =====
    btnRandom.addEventListener('click', async () => {
        try {
            const fd = new FormData();
            fd.append('song_id', currentSong.id);
            fd.append('user_id', user.id);
            fd.append('user_name', user.nickname);
            const res = await apiPost('/segments/random-claim', fd);
            if (res.success) {
                showToast('随机认领成功！');
                const seg = res.data;
                localStorage.setItem('youdoo_record_segment', JSON.stringify(seg));
                localStorage.setItem('youdoo_record_song', JSON.stringify(currentSong));
                setTimeout(() => {
                    window.location.href = 'record.html';
                }, 300);
            }
        } catch (e) {
            showToast('随机认领失败：' + e.message);
        }
    });

    // ===== 翻页 =====
    function updateNavButtons() {
        navPrev.style.opacity = currentSongIndex > 0 ? '1' : '0.3';
        navNext.style.opacity = currentSongIndex < songs.length - 1 ? '1' : '0.3';
    }

    navPrev.addEventListener('click', () => {
        if (currentSongIndex > 0) {
            AudioManager.stop();
            resetPlayButtons();
            isFullPlaying = false;
            progressFill.style.width = '0%';
            timeLabel.textContent = '0:00';
            loadSong(currentSongIndex - 1);
        }
    });

    navNext.addEventListener('click', () => {
        if (currentSongIndex < songs.length - 1) {
            AudioManager.stop();
            resetPlayButtons();
            isFullPlaying = false;
            progressFill.style.width = '0%';
            timeLabel.textContent = '0:00';
            loadSong(currentSongIndex + 1);
        }
    });

    // ===== 排序切换 =====
    document.querySelectorAll('.sort-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.sort-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            sortMode = tab.dataset.sort;
            focusSegId = null;
            renderRecordings();
        });
    });

    // ===== 录音列表 =====
    let recordings = [];

    async function loadRecordings() {
        try {
            const res = await apiGet(`/recordings?song_id=${currentSong.id}`);
            recordings = res.data || [];
            renderRecordings();
        } catch (e) {
            recordings = [];
            renderRecordings();
        }
    }

    function renderRecordings() {
        let list = [...recordings];
        if (sortMode === 'order') {
            list.sort((a, b) => {
                const segA = currentSong.segments.find(s => s.id === a.segment_id);
                const segB = currentSong.segments.find(s => s.id === b.segment_id);
                return (segA?.index || 0) - (segB?.index || 0);
            });
        }

        if (list.length === 0) {
            recordingList.innerHTML = '<div class="empty-recordings">还没有人提交录音，快来第一个吧！</div>';
            return;
        }

        let html = '';
        let lastSegId = null;
        list.forEach((rec) => {
            const seg = currentSong.segments.find(s => s.id === rec.segment_id);
            // 歌词顺序排序时，段切换处插入分隔线（包括第一段之前）
            if (sortMode === 'order' && rec.segment_id !== lastSegId) {
                html += `<div class="rec-seg-separator"><span class="sep-lyrics">${seg ? '#' + seg.index + ' ' + seg.lyrics : ''}</span></div>`;
            }
            lastSegId = rec.segment_id;
            html += `
                <div class="rec-card ${(focusSegId && rec.segment_id === focusSegId) ? 'rec-card-focus' : ''}" data-id="${rec.id}" data-seg-id="${rec.segment_id}">
                    <button class="btn-play-mini" data-url="${API_BASE.replace('/api', '')}${rec.audio_url}" data-id="${rec.id}">▶</button>
                    <div style="flex:1;">
                        <div class="rec-user">${rec.user_name}</div>
                        <div class="rec-seg-num">#${seg ? seg.index : '?'} ${seg ? seg.lyrics : ''}</div>
                    </div>
                    <div class="rec-like" data-id="${rec.id}">
                        ❤ <span>${rec.likes}</span>
                    </div>
                </div>
            `;
        });
        recordingList.innerHTML = html;

        // 绑定播放
        recordingList.querySelectorAll('.btn-play-mini').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const url = btn.dataset.url;
                if (AudioManager.isPlaying()) {
                    AudioManager.stop();
                    recordingList.querySelectorAll('.btn-play-mini').forEach(b => {
                        b.textContent = '▶';
                        b.classList.remove('playing');
                    });
                    resetPlayButtons();
                    isFullPlaying = false;
                } else {
                    AudioManager.stop();
                    resetPlayButtons();
                    isFullPlaying = false;
                    AudioManager.play(url, () => {
                        btn.textContent = '▶';
                        btn.classList.remove('playing');
                    });
                    btn.textContent = '⏹';
                    btn.classList.add('playing');
                }
            });
        });

        // 绑定点赞
        recordingList.querySelectorAll('.rec-like').forEach(el => {
            el.addEventListener('click', async () => {
                const recId = el.dataset.id;
                try {
                    const res = await apiPost(`/recordings/${recId}/like`, new FormData());
                    if (res.success) {
                        el.querySelector('span').textContent = res.data.likes;
                        el.classList.add('liked');
                    }
                } catch (e) {
                    showToast('点赞失败');
                }
            });
        });

        // 滚动到聚焦段
        if (focusSegId) {
            setTimeout(() => {
                const focusCard = recordingList.querySelector(`.rec-card[data-seg-id="${focusSegId}"]`);
                if (focusCard) focusCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }
    }
})();
