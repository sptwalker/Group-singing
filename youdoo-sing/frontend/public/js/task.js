// ===== 任务页逻辑 =====
(function () {
    const user = getUser();
    if (!user) {
        if (hasWechatAuthCallbackParams() || window.__YOUDOO_WECHAT_AUTH_PENDING) {
            return;
        }
        setPendingLoginTarget(getCurrentPageTarget('task.html'));
        window.location.replace('index.html');
        return;
    }

    let songs = [];
    let currentSongIndex = 0;
    let currentSong = null;
    let sortMode = 'time';
    let focusSegId = null;
    let expandedSegId = null; // 当前展开的歌词标�?

    // DOM
    const songTitle = document.getElementById('songTitle');
    const songArtist = document.getElementById('songArtist');
    const btnLogout = document.getElementById('btnLogout');
    const btnPlayPause = document.getElementById('btnPlayPause');
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

    // WaveSurfer 可视化实�?
    let _visualizerWS = null;

    // 退出登�?
    btnLogout.addEventListener('click', () => {
        if (confirm('确定退出登录？')) {
            localStorage.removeItem('youdoo_user');
            window.location.href = 'index.html';
        }
    });

    function requireUser(message) {
        if (user) return user;
        showToast(message || 'Please sign in first');
        setPendingLoginTarget(getCurrentPageTarget('task.html'));
        window.location.replace('index.html');
        return null;
    }

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
            if (currentSong.published_final) {
                renderPublishedView();
            } else {
                restoreTaskView();
                renderSong();
            }
            loadRecordings();
        } catch (e) {
            console.error('[task] renderSong error:', e);
            showToast('渲染失败：' + e.message);
        }
    }

    // ===== 已发布成曲视�?=====
    let _publishedAudio = null;
    let _publishedRAF = 0;
    let _publishedAudioCtx = null;
    let _publishedAnalyser = null;
    let _publishedSource = null;
    let _publishedWaveRAF = 0;

    function _getPublishedAudioCtx() {
        if (!_publishedAudioCtx) _publishedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (_publishedAudioCtx.state === 'suspended') _publishedAudioCtx.resume();
        return _publishedAudioCtx;
    }

    function _stopPublishedPlayback() {
        if (_publishedRAF) { cancelAnimationFrame(_publishedRAF); _publishedRAF = 0; }
        if (_publishedWaveRAF) { cancelAnimationFrame(_publishedWaveRAF); _publishedWaveRAF = 0; }
        if (_publishedSource) { try { _publishedSource.disconnect(); } catch(e){} _publishedSource = null; }
        _publishedAnalyser = null;
        if (_publishedAudio) {
            _publishedAudio.pause();
            _publishedAudio.src = '';
            _publishedAudio = null;
        }
    }

    function renderPublishedView() {
        _stopPublishedPlayback();
        AudioManager.stop();
        if (_visualizerWS) { try { _visualizerWS.destroy(); } catch(e){} _visualizerWS = null; }

        const s = currentSong;
        const pf = s.published_final;
        songTitle.textContent = s.title;
        songArtist.textContent = s.artist;

        // 隐藏任务区的元素
        document.querySelector('.lyrics-list-section').style.display = 'none';
        document.querySelector('.header-stats').style.display = 'none';
        document.querySelector('.play-controls').style.display = 'none';
        navPrev.style.display = currentSongIndex > 0 ? '' : 'none';
        navNext.style.display = currentSongIndex < songs.length - 1 ? '' : 'none';
        btnPlayPause.style.display = 'none';
        btnStop.style.display = 'none';

        // 修改录音区标�?
        const recHeader = document.querySelector('.recordings-header');
        if (recHeader) {
            recHeader.querySelector('.recordings-title').textContent = '🎧 全部录音';
            const sortTabs = recHeader.querySelector('.sort-tabs');
            if (sortTabs) sortTabs.style.display = 'none';
        }
        // 强制按歌词顺序排�?
        sortMode = 'order';
        focusSegId = null;

        // 插入已发布成曲播放器
        let playerSection = document.getElementById('publishedPlayerSection');
        if (!playerSection) {
            playerSection = document.createElement('div');
            playerSection.id = 'publishedPlayerSection';
            const taskHeader = document.querySelector('.task-header');
            taskHeader.parentNode.insertBefore(playerSection, taskHeader.nextSibling);
        }

        const finalAudioUrl = `${API_BASE.replace('/api', '')}${pf.audio_url}`;
        playerSection.innerHTML = `
            <div class="published-banner">
                <div class="published-badge">全曲已完成，请欣赏！</div>
                <div class="published-player">
                    <button class="published-play-btn" id="pubPlayBtn">▶</button>
                    <div class="published-info-col">
                        <canvas class="published-wave-canvas" id="pubWaveCanvas" width="800" height="44"></canvas>
                        <div class="published-progress-row">
                            <div class="published-progress-track" id="pubProgressTrack">
                                <div class="published-progress-fill" id="pubProgressFill"></div>
                            </div>
                            <span class="published-time" id="pubTimeLabel">0:00 / ${formatTime(pf.duration || 0)}</span>
                        </div>
                    </div>
                    <a class="published-download-btn" href="${finalAudioUrl}" download title="下载">⬇</a>
                </div>
            </div>`;

        // 播放按钮事件
        const pubPlayBtn = document.getElementById('pubPlayBtn');
        const pubProgressTrack = document.getElementById('pubProgressTrack');

        pubPlayBtn.addEventListener('click', () => {
            if (_publishedAudio && !_publishedAudio.paused) {
                _publishedAudio.pause();
                pubPlayBtn.textContent = '▶';
                pubPlayBtn.classList.remove('playing');
                return;
            }
            if (_publishedAudio && _publishedAudio.paused && _publishedAudio.currentTime > 0) {
                _publishedAudio.play();
                pubPlayBtn.textContent = '⏸';
                pubPlayBtn.classList.add('playing');
                _startPublishedTick();
                _startPublishedWave();
                return;
            }
            // 新播�?
            _stopPublishedPlayback();
            const audio = new Audio(finalAudioUrl);
            audio.crossOrigin = 'anonymous';
            _publishedAudio = audio;

            const ctx = _getPublishedAudioCtx();
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.75;
            _publishedAnalyser = analyser;

            audio.addEventListener('canplay', () => {
                if (!_publishedSource && _publishedAudio === audio) {
                    try {
                        const src = ctx.createMediaElementSource(audio);
                        src.connect(analyser);
                        analyser.connect(ctx.destination);
                        _publishedSource = src;
                    } catch(e) {}
                }
            }, { once: true });

            audio.addEventListener('ended', () => {
                pubPlayBtn.textContent = '▶';
                pubPlayBtn.classList.remove('playing');
                _stopPublishedPlayback();
                const fill = document.getElementById('pubProgressFill');
                if (fill) fill.style.width = '0%';
                const tl = document.getElementById('pubTimeLabel');
                if (tl) tl.textContent = `0:00 / ${formatTime(pf.duration || 0)}`;
            });

            audio.play().catch(() => {});
            pubPlayBtn.textContent = '⏸';
            pubPlayBtn.classList.add('playing');
            _startPublishedTick();
            _startPublishedWave();
        });

        // 进度�?seek
        pubProgressTrack.addEventListener('click', (e) => {
            if (!_publishedAudio) return;
            const rect = pubProgressTrack.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            _publishedAudio.currentTime = ratio * (_publishedAudio.duration || pf.duration || 0);
        });
    }

    function _startPublishedTick() {
        function tick() {
            if (!_publishedAudio) return;
            _publishedRAF = requestAnimationFrame(tick);
            const cur = _publishedAudio.currentTime || 0;
            const dur = _publishedAudio.duration || 0;
            const tl = document.getElementById('pubTimeLabel');
            if (tl) tl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
            const fill = document.getElementById('pubProgressFill');
            if (fill) fill.style.width = dur ? (cur / dur * 100) + '%' : '0%';
        }
        tick();
    }

    function _startPublishedWave() {
        const canvas = document.getElementById('pubWaveCanvas');
        if (!canvas || !_publishedAnalyser) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        const cCtx = canvas.getContext('2d');
        cCtx.scale(dpr, dpr);
        const W = rect.width, H = rect.height;
        const bufLen = _publishedAnalyser.frequencyBinCount;
        const dataArr = new Uint8Array(bufLen);

        function draw() {
            if (!_publishedAudio || _publishedAudio.paused) return;
            _publishedWaveRAF = requestAnimationFrame(draw);
            _publishedAnalyser.getByteFrequencyData(dataArr);
            cCtx.clearRect(0, 0, W, H);
            const barCount = Math.min(bufLen, Math.floor(W / 3));
            const barW = W / barCount;
            for (let i = 0; i < barCount; i++) {
                const v = dataArr[i] / 255;
                const barH = Math.max(1, v * H * 0.9);
                const x = i * barW;
                const y = (H - barH) / 2;
                const hue = 140 + v * 40;
                cCtx.fillStyle = `hsla(${hue}, 70%, ${45 + v * 30}%, ${0.6 + v * 0.4})`;
                cCtx.fillRect(x + 0.5, y, barW - 1, barH);
            }
        }
        draw();
    }

    function restoreTaskView() {
        _stopPublishedPlayback();
        // 移除发布播放�?
        const playerSection = document.getElementById('publishedPlayerSection');
        if (playerSection) playerSection.remove();
        // 恢复任务区元�?
        document.querySelector('.lyrics-list-section').style.display = '';
        document.querySelector('.header-stats').style.display = '';
        document.querySelector('.play-controls').style.display = '';
        btnPlayPause.style.display = '';
        btnStop.style.display = '';
        navPrev.style.display = '';
        navNext.style.display = '';
        const recHeader = document.querySelector('.recordings-header');
        if (recHeader) {
            recHeader.querySelector('.recordings-title').textContent = '🎧 大家的录音';
            const sortTabs = recHeader.querySelector('.sort-tabs');
            if (sortTabs) sortTabs.style.display = '';
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
        const freeTasks = currentSong.free_tasks || [];
        expandedSegId = null;

        let html = segs.map((seg, i) => {
            const isCompleted = seg.status === 'completed';
            const submitCount = seg.submit_count || 0;
            const diffLabels = { easy: '简', normal: '中', hard: '难' };
            const diffCls = seg.difficulty;

            return `
                <div class="lyric-task-item ${isCompleted ? 'completed' : ''}" data-seg-id="${seg.id}" data-index="${i}">
                    <div class="lyric-task-main">
                        <span class="lyric-task-num">${seg.index}</span>
                        <span class="lyric-task-diff diff-${diffCls}">${diffLabels[seg.difficulty]}</span>
                        ${seg.is_chorus ? '<span class="lyric-task-chorus">合唱</span>' : ''}
                        <span class="lyric-task-text">${seg.lyrics || '...'}</span>
                        <span class="lyric-task-count ${submitCount > 0 ? 'has-submit' : ''}">${submitCount}人次</span>
                    </div>
                    <div class="lyric-task-expand" data-seg-id="${seg.id}" style="display:none;">
                        <button class="lyric-task-btn btn-lt-play" data-seg-id="${seg.id}">▶ 试听</button>
                        <button class="lyric-task-btn btn-lt-record ${isCompleted ? 'disabled' : ''}" data-seg-id="${seg.id}" ${isCompleted ? 'disabled' : ''}>🎤 录音</button>
                    </div>
                </div>
            `;
        }).join('');

        // 自由任务（排在唱段之后）
        if (freeTasks.length > 0) {
            html += `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);">🎵 自由任务</div>`;
            html += freeTasks.map((ft, fi) => {
                const diffLabels = { easy: '简', normal: '中', hard: '难' };
                return `
                    <div class="lyric-task-item lyric-task-free" data-ft-id="${ft.id}" data-ft-idx="${fi}">
                        <div class="lyric-task-main">
                            <span class="lyric-task-num" style="background:#16a34a;">F</span>
                            <span class="lyric-task-diff diff-${ft.difficulty}">${diffLabels[ft.difficulty]}</span>
                            <span class="lyric-task-text">${ft.description || '自由任务'}</span>
                            <span class="lyric-task-text" style="font-size:11px;color:var(--text-light);font-family:monospace;">${formatTime(ft.start_time)}→${formatTime(ft.end_time)}</span>
                        </div>
                        <div class="lyric-task-expand" data-ft-id="${ft.id}" style="display:none;">
                            <button class="lyric-task-btn btn-ft-preview" data-ft-idx="${fi}">▶ 试唱预览</button>
                            <button class="lyric-task-btn btn-ft-record" data-ft-idx="${fi}">🎤 录音</button>
                        </div>
                    </div>`;
            }).join('');
        }

        lyricsTaskList.innerHTML = html;

        // 绑定点击
        lyricsTaskList.querySelectorAll('.lyric-task-item:not(.lyric-task-free)').forEach(item => {
            item.querySelector('.lyric-task-main').addEventListener('click', () => {
                onLyricItemClick(item);
            });
        });
        // 自由任务点击展开
        lyricsTaskList.querySelectorAll('.lyric-task-free .lyric-task-main').forEach(el => {
            el.addEventListener('click', () => {
                const parent = el.closest('.lyric-task-free');
                const expandEl = parent.querySelector('.lyric-task-expand');
                const isExpanded = parent.classList.contains('expanded');
                lyricsTaskList.querySelectorAll('.lyric-task-item').forEach(it => {
                    it.classList.remove('expanded');
                    it.querySelector('.lyric-task-expand').style.display = 'none';
                });
                if (isExpanded) {
                    parent.classList.remove('expanded');
                    expandEl.style.display = 'none';
                } else {
                    parent.classList.add('expanded');
                    expandEl.style.display = 'flex';
                }
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

        // 绑定自由任务按钮
        lyricsTaskList.querySelectorAll('.btn-ft-preview').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                onFreeTaskPreview(btn);
            });
        });
        lyricsTaskList.querySelectorAll('.btn-ft-record').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                onFreeTaskRecord(parseInt(btn.dataset.ftIdx));
            });
        });
    }

    function onLyricItemClick(item) {
        const segId = item.dataset.segId;
        const seg = currentSong.segments.find(s => s.id === segId);
        if (!seg) return;

        // 收起之前展开�?
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
        ensureVisualizer(audioUrl);
        AudioManager.playRange(audioUrl, seg.start_time, seg.end_time,
            () => {
                btn.textContent = '▶ 试听';
                btn.classList.remove('playing');
                if (_visualizerWS) _visualizerWS.seekTo(0);
            },
            (cur, dur) => {
                if (_visualizerWS && _visualizerWS.getDuration() > 0) {
                    _visualizerWS.seekTo(cur / _visualizerWS.getDuration());
                }
            }
        );
        btn.textContent = '■ 停止';
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
        const currentUser = requireUser('Please sign in before claiming a segment');
        if (!currentUser) return;
        try {
            const fd = new FormData();
            fd.append('user_id', currentUser.id);
            fd.append('user_name', currentUser.nickname);
            await apiPost(`/segments/${seg.id}/claim`, fd);

            localStorage.setItem('youdoo_record_segment', JSON.stringify(seg));
            localStorage.setItem('youdoo_record_song', JSON.stringify(currentSong));
            window.location.href = 'record.html';
        } catch (e) {
            showToast('认领失败：' + e.message);
        }
    }

    // ===== 自由任务处理 =====
    function onFreeTaskPreview(btn) {
        const ftIdx = parseInt(btn.dataset.ftIdx);
        const ft = (currentSong.free_tasks || [])[ftIdx];
        if (!ft) return;

        if (btn.classList.contains('playing')) {
            AudioManager.stop();
            btn.textContent = '▶ 试唱预览';
            btn.classList.remove('playing');
            return;
        }

        lyricsTaskList.querySelectorAll('.btn-ft-preview.playing').forEach(b => {
            b.textContent = '▶ 试唱预览';
            b.classList.remove('playing');
        });
        resetPlayButtons();
        isFullPlaying = false;

        // 试唱预览：从任务开始前5秒播放到结束时间
        const audioUrl = `${API_BASE.replace('/api', '')}${currentSong.audio_url}`;
        const previewStart = Math.max(0, ft.start_time - 5);

        ensureVisualizer(audioUrl);
        AudioManager.playRange(audioUrl, previewStart, ft.end_time,
            () => {
                btn.textContent = '▶ 试唱预览';
                btn.classList.remove('playing');
                if (_visualizerWS) _visualizerWS.seekTo(0);
            },
            (cur, dur) => {
                if (_visualizerWS && _visualizerWS.getDuration() > 0) {
                    _visualizerWS.seekTo(cur / _visualizerWS.getDuration());
                }
            }
        );
        btn.textContent = '■ 停止';
        btn.classList.add('playing');
    }

    function onFreeTaskRecord(ftIdx) {
        const ft = (currentSong.free_tasks || [])[ftIdx];
        if (!ft) return;
        const currentUser = requireUser('Please sign in before recording a free task');
        if (!currentUser) return;

        // 构造一个类似segment的对象供record.js使用
        const freeSegObj = {
            id: ft.id,
            index: 'F',
            lyrics: ft.description || '自由任务',
            is_chorus: ft.type === 'chorus',
            difficulty: ft.difficulty || 'normal',
            start_time: ft.start_time,
            end_time: ft.end_time,
            status: 'free_task',
            _isFreeTask: true,
        };
        localStorage.setItem('youdoo_record_segment', JSON.stringify(freeSegObj));
        localStorage.setItem('youdoo_record_song', JSON.stringify(currentSong));
        window.location.href = 'record.html';
    }

    // ===== 整曲播放控制 =====
    let isFullPlaying = false;

    function ensureVisualizer(audioUrl) {
        const container = document.getElementById('waveVisualizer');
        if (!container || typeof WaveSurfer === 'undefined') return;
        if (_visualizerWS) {
            try { _visualizerWS.destroy(); } catch(e) {}
            _visualizerWS = null;
        }
        _visualizerWS = WaveSurfer.create({
            container: container,
            waveColor: 'rgba(255,255,255,0.25)',
            progressColor: '#07c160',
            cursorColor: 'rgba(255,255,255,0.5)',
            cursorWidth: 1,
            height: 56,
            barWidth: 3,
            barGap: 2,
            barRadius: 2,
            normalize: true,
            interact: true,
            hideScrollbar: true,
            url: audioUrl,
        });
        _visualizerWS.on('interaction', (time) => {
            const audio = AudioManager.getCurrent();
            if (audio && isFullPlaying) {
                audio.currentTime = time;
            }
        });
    }

    btnPlayPause.addEventListener('click', () => {
        const audio = AudioManager.getCurrent();
        // 当前正在播放 �?暂停
        if (audio && isFullPlaying && !audio.paused) {
            audio.pause();
            btnPlayPause.textContent = '▶';
            btnPlayPause.classList.remove('active');
            return;
        }
        // 当前已暂停 → 恢复
        if (audio && isFullPlaying && audio.paused) {
            audio.play();
            btnPlayPause.textContent = '⏸';
            btnPlayPause.classList.add('active');
            return;
        }
        // 未在播放 �?开始播�?
        if (!currentSong) return;
        const audioUrl = `${API_BASE.replace('/api', '')}${currentSong.audio_url}`;
        ensureVisualizer(audioUrl);
        AudioManager.play(audioUrl,
            () => {
                resetPlayButtons();
                isFullPlaying = false;
                if (_visualizerWS) _visualizerWS.seekTo(0);
            },
            (cur, dur) => {
                progressFill.style.width = (cur / dur * 100) + '%';
                timeLabel.textContent = formatTime(cur);
                if (_visualizerWS && _visualizerWS.getDuration() > 0) {
                    _visualizerWS.seekTo(cur / _visualizerWS.getDuration());
                }
            }
        );
        isFullPlaying = true;
        btnPlayPause.textContent = '⏸';
        btnPlayPause.classList.add('active');
    });

    btnStop.addEventListener('click', () => {
        AudioManager.stop();
        resetPlayButtons();
        isFullPlaying = false;
        progressFill.style.width = '0%';
        timeLabel.textContent = '0:00';
        if (_visualizerWS) _visualizerWS.seekTo(0);
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
        btnPlayPause.textContent = '▶';
        btnPlayPause.classList.remove('active');
    }

    // ===== 随机领取 =====
    btnRandom.addEventListener('click', async () => {
        const currentUser = requireUser('Please sign in before random claim');
        if (!currentUser) return;
        try {
            const fd = new FormData();
            fd.append('song_id', currentSong.id);
            fd.append('user_id', currentUser.id);
            fd.append('user_name', currentUser.nickname);
            const res = await apiPost('/segments/random-claim', fd);
            if (res.success) {
                showToast('随机认领成功');
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
            _stopPublishedPlayback();
            AudioManager.stop();
            resetPlayButtons();
            isFullPlaying = false;
            progressFill.style.width = '0%';
            timeLabel.textContent = '0:00';
            if (_visualizerWS) { try { _visualizerWS.destroy(); } catch(e){} _visualizerWS = null; }
            loadSong(currentSongIndex - 1);
        }
    });

    navNext.addEventListener('click', () => {
        if (currentSongIndex < songs.length - 1) {
            _stopPublishedPlayback();
            AudioManager.stop();
            resetPlayButtons();
            isFullPlaying = false;
            progressFill.style.width = '0%';
            timeLabel.textContent = '0:00';
            if (_visualizerWS) { try { _visualizerWS.destroy(); } catch(e){} _visualizerWS = null; }
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
    let _playingIdx = -1;

    function stopRecordingPlayback(resetButton = true) {
        if (_playingIdx < 0) return;
        const prevWs = _taskRecWsList[_playingIdx];
        if (prevWs && prevWs.isPlaying()) prevWs.stop();
        if (resetButton) {
            const prevBtn = recordingList.querySelector(`.btn-play-mini[data-rec-idx="${_playingIdx}"]`);
            if (prevBtn) {
                prevBtn.textContent = '▶';
                prevBtn.classList.remove('playing');
            }
        }
        _playingIdx = -1;
    }

    async function loadRecordings() {
        try {
            const res = await apiGet(`/recordings?song_id=${currentSong.id}`);
            recordings = res.data || [];
            renderRecordings();
            updateLyricsSubmitCounts();
        } catch (e) {
            recordings = [];
            renderRecordings();
        }
    }

    function updateLyricsSubmitCounts() {
        // �?recordings 数组统计每个 segment_id 的提交人�?
        const countMap = {};
        recordings.forEach(r => {
            countMap[r.segment_id] = (countMap[r.segment_id] || 0) + 1;
        });
        lyricsTaskList.querySelectorAll('.lyric-task-item').forEach(item => {
            const segId = item.dataset.segId;
            const count = countMap[segId] || 0;
            const el = item.querySelector('.lyric-task-count');
            if (el) {
                el.textContent = count + '人次';
                el.classList.toggle('has-submit', count > 0);
            }
        });
    }

    // WaveSurfer 实例管理
    let _taskRecWsList = [];
    function _destroyTaskRecWS() {
        _taskRecWsList.forEach(ws => { try { ws.destroy(); } catch(e){} });
        _taskRecWsList = [];
    }

    function renderRecordings() {
        stopRecordingPlayback();
        _destroyTaskRecWS();
        let list = [...recordings];
        if (sortMode === 'order') {
            list.sort((a, b) => {
                const segA = currentSong.segments.find(s => s.id === a.segment_id);
                const segB = currentSong.segments.find(s => s.id === b.segment_id);
                return (segA?.index || 0) - (segB?.index || 0);
            });
        }

        if (list.length === 0) {
            recordingList.innerHTML = '<div class="empty-recordings">还没有人提交录音，快来第一个吧</div>';
            return;
        }

        let html = '';
        let lastSegId = null;
        list.forEach((rec, i) => {
            const seg = currentSong.segments.find(s => s.id === rec.segment_id);
            if (sortMode === 'order' && rec.segment_id !== lastSegId) {
                html += `<div class="rec-seg-separator" data-sep-seg-id="${rec.segment_id}"><span class="sep-lyrics">${seg ? '#' + seg.index + ' ' + seg.lyrics : ''}</span></div>`;
            }
            lastSegId = rec.segment_id;
            const timeStr = rec.created_at ? rec.created_at : '';
            const avatarUrl = rec.user_avatar || `https://api.dicebear.com/7.x/fun-emoji/svg?seed=${encodeURIComponent(rec.user_name)}`;
            const datePart = timeStr ? timeStr.split(' ')[0] : '';
            const timePart = timeStr ? timeStr.split(' ')[1] || '' : '';
            html += `
                <div class="rec-card ${(focusSegId && rec.segment_id === focusSegId) ? 'rec-card-focus' : ''}" data-id="${rec.id}" data-seg-id="${rec.segment_id}" data-rec-idx="${i}">
                    <div class="rec-card-top">
                        <img class="rec-avatar" src="${avatarUrl}" alt="" onerror="this.src='https://api.dicebear.com/7.x/fun-emoji/svg?seed=default'">
                        <div class="rec-info">
                            <div class="rec-info-header">
                                <span class="rec-user">${rec.user_name}</span>
                                <span class="rec-date">${datePart} ${timePart}</span>
                            </div>
                            <div class="rec-seg-num">#${seg ? seg.index : '?'} ${seg ? seg.lyrics : ''}</div>
                        </div>
                        <div class="rec-like" data-id="${rec.id}">
                            ❤<span>${rec.likes}</span>
                        </div>
                    </div>
                    <div class="rec-card-bottom">
                        <button class="btn-play-mini" data-rec-idx="${i}">▶</button>
                        <div class="rec-wave-container" id="taskRecW${i}"></div>
                    </div>
                </div>
            `;
        });
        recordingList.innerHTML = html;

        list.forEach((rec, i) => {
            const el = document.getElementById(`taskRecW${i}`);
            if (!el || typeof WaveSurfer === 'undefined') return;
            const audioUrl = `${API_BASE.replace('/api', '')}${rec.audio_url}`;
            const ws = WaveSurfer.create({
                container: el,
                waveColor: '#cbd5e1',
                progressColor: '#07c160',
                cursorWidth: 0,
                height: 36,
                barWidth: 2,
                barGap: 1,
                barRadius: 1,
                normalize: true,
                interact: false,
                hideScrollbar: true,
            });
            ws.load(audioUrl);
            _taskRecWsList[i] = ws;
        });

        recordingList.querySelectorAll('.btn-play-mini').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.recIdx);
                const ws = _taskRecWsList[idx];

                stopRecordingPlayback();
                AudioManager.stop();
                resetPlayButtons();
                isFullPlaying = false;

                if (_playingIdx === idx) {
                    return;
                }

                if (!ws) return;
                ws.un('finish');
                ws.on('finish', () => {
                    btn.textContent = '▶';
                    btn.classList.remove('playing');
                    _playingIdx = -1;
                });
                ws.play();
                btn.textContent = '⏸';
                btn.classList.add('playing');
                _playingIdx = idx;
            });
        });

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

        if (focusSegId) {
            setTimeout(() => {
                const sep = recordingList.querySelector(`.rec-seg-separator[data-sep-seg-id="${focusSegId}"]`);
                if (sep) {
                    sep.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    return;
                }
                const focusCard = recordingList.querySelector(`.rec-card[data-seg-id="${focusSegId}"]`);
                if (focusCard) focusCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    }
})();
