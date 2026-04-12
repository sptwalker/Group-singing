// ===== 录音页逻辑 =====
(function () {
    if (!checkLogin()) return;

    const user = getUser();
    const song = JSON.parse(localStorage.getItem('youdoo_record_song'));
    const segment = JSON.parse(localStorage.getItem('youdoo_record_segment'));

    if (!song || !segment) {
        showToast('缺少任务信息');
        setTimeout(() => window.location.href = 'task.html', 1000);
        return;
    }

    // DOM
    const recSongName = document.getElementById('recSongName');
    const recSegInfo = document.getElementById('recSegInfo');
    const lyricsSection = document.getElementById('lyricsSection');
    const btnAudition = document.getElementById('btnAudition');
    const btnRecord = document.getElementById('btnRecord');
    const myRecList = document.getElementById('myRecList');
    const recCount = document.getElementById('recCount');
    const recActions = document.getElementById('recActions');
    const btnRecPlay = document.getElementById('btnRecPlay');
    const btnRecDelete = document.getElementById('btnRecDelete');
    const btnRecSubmit = document.getElementById('btnRecSubmit');
    const quietTip = document.getElementById('quietTip');
    const countdownOverlay = document.getElementById('countdownOverlay');
    const countdownNum = document.getElementById('countdownNum');

    let myRecordings = [];
    let selectedRecIndex = -1;
    let mediaRecorder = null;
    let recordedChunks = [];
    let isRecording = false;
    let _micStream = null;
    let _recPreparing = false;

    // 初始化
    recSongName.textContent = song.title;
    recSegInfo.textContent = `#${segment.index} · ${segment.difficulty === 'easy' ? '简单' : segment.difficulty === 'normal' ? '普通' : '困难'}${segment.is_chorus ? ' · 合唱段' : ''}`;

    const allSegments = song.segments || [];
    const mySegIdx = allSegments.findIndex(s => s.id === segment.id);
    // 显示范围：前3后1（共5行）
    const displayStart = Math.max(0, mySegIdx - 3);
    const displayEnd = Math.min(allSegments.length - 1, mySegIdx + 1);
    const displaySegments = allSegments.slice(displayStart, displayEnd + 1);

    renderLyrics();

    function renderLyrics() {
        lyricsSection.innerHTML = displaySegments.map((seg, i) => {
            const globalIdx = displayStart + i;
            let cls = 'lyric-line';
            if (seg.id === segment.id) cls += ' my-singing-line';
            return `<div class="${cls}" data-seg-id="${seg.id}" data-global-idx="${globalIdx}">${seg.lyrics || '♪ ♪ ♪'}</div>`;
        }).join('');

        setTimeout(() => {
            const myLine = lyricsSection.querySelector('.my-singing-line');
            if (myLine) myLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
    }

    // 返回
    document.getElementById('btnBack').addEventListener('click', () => {
        AudioManager.stop();
        if (isRecording) stopRecording(true);
        releaseMic();
        if (myRecordings.length > 0 && !confirm('有未提交的录音，确定返回？')) return;
        window.location.href = 'task.html';
    });

    // ===== 60fps 精确同步引擎 =====
    let _syncRAF = 0;
    let _syncCallback = null;

    function _startSyncLoop(callback) {
        _syncCallback = callback;
        if (!_syncRAF) _tickSync();
    }

    function _stopSyncLoop() {
        _syncCallback = null;
        if (_syncRAF) { cancelAnimationFrame(_syncRAF); _syncRAF = 0; }
    }

    function _tickSync() {
        _syncRAF = requestAnimationFrame(_tickSync);
        const audio = AudioManager.getCurrent();
        if (!audio) return;
        if (_syncCallback) _syncCallback(audio.currentTime);
    }
    let isAuditioning = false;

    btnAudition.addEventListener('click', () => {
        if (isRecording) return;

        if (isAuditioning) {
            AudioManager.stop();
            _stopSyncLoop();
            btnAudition.className = 'btn-record-ctrl btn-audition';
            btnAudition.textContent = '▶ 播放试唱';
            isAuditioning = false;
            clearLyricsHighlight();
            return;
        }

        const audioUrl = `${API_BASE.replace('/api', '')}${song.audio_url}`;
        const previewStart = Math.max(0, mySegIdx - 3);
        const startTime = allSegments[previewStart].start_time;
        const endTime = segment.end_time;

        AudioManager.playRange(audioUrl, startTime, endTime, () => {
            _stopSyncLoop();
            btnAudition.className = 'btn-record-ctrl btn-audition';
            btnAudition.textContent = '▶ 播放试唱';
            isAuditioning = false;
            clearLyricsHighlight();
        });

        _startSyncLoop(curTime => highlightLyrics(curTime));
        btnAudition.className = 'btn-record-ctrl btn-audition playing';
        btnAudition.textContent = '⏹ 停止试听';
        isAuditioning = true;
    });

    function _applyMtvScan(line, progress, isMySeg) {
        const pct = (progress * 100).toFixed(1);
        line.classList.add('mtv-scan');
        const hiColor = isMySeg ? '#fbbf24' : 'rgba(255,255,255,0.85)';
        const loColor = isMySeg ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.2)';
        line.style.background = `linear-gradient(90deg, ${hiColor} ${pct}%, ${loColor} ${pct}%)`;
        line.style.webkitBackgroundClip = 'text';
        line.style.backgroundClip = 'text';
    }

    function _clearMtvScan(line) {
        line.classList.remove('mtv-scan');
        line.style.background = '';
        line.style.webkitBackgroundClip = '';
        line.style.backgroundClip = '';
        line.style.webkitTextFillColor = '';
    }

    function highlightLyrics(currentTime) {
        const lines = lyricsSection.querySelectorAll('.lyric-line');
        lines.forEach((line) => {
            const gIdx = parseInt(line.dataset.globalIdx);
            const seg = allSegments[gIdx];
            if (!seg) return;
            const isCurrent = currentTime >= seg.start_time && currentTime < seg.end_time;
            const isPast = currentTime >= seg.end_time;
            const isMySeg = seg.id === segment.id;
            line.classList.toggle('active', isCurrent);

            if (isCurrent) {
                const duration = seg.end_time - seg.start_time;
                const elapsed = currentTime - seg.start_time;
                const progress = Math.min(1, Math.max(0, elapsed / duration));
                _applyMtvScan(line, progress, isMySeg);
                line.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (isPast) {
                _applyMtvScan(line, 1, isMySeg);
            } else {
                _clearMtvScan(line);
            }
        });
    }

    function clearLyricsHighlight() {
        lyricsSection.querySelectorAll('.lyric-line').forEach(line => {
            line.classList.remove('active', 'recording-active');
            _clearMtvScan(line);
        });
    }

    // ===== 录音 =====
    btnRecord.addEventListener('click', async () => {
        if (isAuditioning) {
            AudioManager.stop();
            isAuditioning = false;
            btnAudition.className = 'btn-record-ctrl btn-audition';
            btnAudition.textContent = '▶ 播放试唱';
        }

        // 正在录音或准备中 → 停止
        if (isRecording || _recPreparing) {
            stopRecording(isRecording ? false : true);
            return;
        }

        if (myRecordings.length >= 5) {
            showToast('录音已满5条，请删除后再录');
            return;
        }

        // 0. 先获取麦克风权限（在播放音乐之前！避免异步延迟）
        try {
            if (_micStream) {
                _micStream.getTracks().forEach(t => t.stop());
            }
            // 注意：关闭 echoCancellation！否则浏览器会把背景音乐和人声一起消除
            _micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: true,
                }
            });
            console.log('[录音] 麦克风已获取, tracks:', _micStream.getAudioTracks().length,
                'settings:', JSON.stringify(_micStream.getAudioTracks()[0].getSettings()));
        } catch (e) {
            showToast('无法访问麦克风，请授权后重试');
            console.error('[录音] 麦克风获取失败:', e);
            return;
        }

        // 1. 立即显示波形面板（准备状态）
        const wavePanel = document.getElementById('liveWavePanel');
        const waveLabel = document.getElementById('liveWaveLabel');
        const waveCd = document.getElementById('liveWaveCountdown');
        wavePanel.style.display = '';
        wavePanel.classList.remove('is-recording');
        waveLabel.textContent = '请准备';
        waveCd.textContent = '';
        _recPreparing = true;
        btnRecord.disabled = false;
        btnRecord.className = 'btn-record-ctrl btn-record recording';
        btnRecord.textContent = '⏹ 取消';
        btnAudition.disabled = true;

        // 启动麦克风波形（静默状态也有微弱波形）
        startLiveWave(_micStream);

        // 2. 安静提示
        quietTip.style.display = 'flex';
        await sleep(1500);
        quietTip.style.display = 'none';

        // 3. 播放前奏 + 倒计时 + 录音
        const audioUrl = `${API_BASE.replace('/api', '')}${song.audio_url}`;
        // 从前一段歌词开始播放
        const prevSegIdx = Math.max(0, mySegIdx - 1);
        const introStart = allSegments[prevSegIdx].start_time;
        const actualIntro = segment.start_time - introStart;

        _stopHandled = false;
        _recCompleted = false;
        showArrowIndicators();

        AudioManager.playRange(audioUrl, introStart, segment.end_time, () => {
            _stopSyncLoop();
            if (isRecording || _recPreparing) {
                stopRecording(false);
            }
            hideArrowIndicators();
        });

        _startSyncLoop((curTime) => {
            if (isRecording && curTime >= segment.start_time) {
                highlightRecordingLyrics(curTime);
            } else {
                highlightLyrics(curTime);
            }
            updateArrowIndicators(curTime);

            // 倒计时显示
            const timeToSing = segment.start_time - curTime;
            if (timeToSing > 0 && timeToSing <= actualIntro + 0.5) {
                const cd = Math.ceil(timeToSing);
                waveCd.textContent = cd > 0 ? cd : '';
            } else {
                waveCd.textContent = '';
            }

            // 到达录音位置 — 启动 MediaRecorder
            if (curTime >= segment.start_time - 0.3 && _recPreparing && !isRecording) {
                _recPreparing = false;
                wavePanel.classList.add('is-recording');
                waveLabel.textContent = '● 录音中';
                waveCd.textContent = '';
                btnRecord.disabled = false;
                btnRecord.className = 'btn-record-ctrl btn-record recording';
                btnRecord.textContent = '⏹ 停止录音';
                startRecordingWithStream();
            }
        });
    });

    async function doCountdownCorner(introSeconds) {
        const countdownEl = document.getElementById('countdownOverlay');
        const numEl = document.getElementById('countdownNum');
        countdownEl.style.display = 'flex';
        let remaining = Math.ceil(introSeconds);
        if (remaining < 1) remaining = 1;
        for (let i = remaining; i >= 1; i--) {
            numEl.textContent = i;
            numEl.style.animation = 'none';
            void numEl.offsetWidth;
            numEl.style.animation = 'countdown-pop 0.8s ease-out';
            await sleep(1000);
        }
        numEl.textContent = '🎤';
        await sleep(500);
        countdownEl.style.display = 'none';
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // 箭头指示器
    function showArrowIndicators() {
        document.querySelectorAll('.lyrics-arrow').forEach(el => {
            el.style.display = 'flex';
        });
    }
    function hideArrowIndicators() {
        document.querySelectorAll('.lyrics-arrow').forEach(el => {
            el.style.display = 'none';
            el.classList.remove('arrow-bold');
        });
    }
    function updateArrowIndicators(curTime) {
        const arrows = document.querySelectorAll('.lyrics-arrow');
        const isInMySegment = curTime >= segment.start_time && curTime <= segment.end_time;
        arrows.forEach(el => {
            if (isInMySegment) {
                el.classList.add('arrow-bold');
            } else {
                el.classList.remove('arrow-bold');
            }
        });

        // 箭头跟随当前高亮歌词行位置
        const activeLine = lyricsSection.querySelector('.lyric-line.active');
        if (activeLine) {
            const container = document.querySelector('.lyrics-container');
            if (container) {
                const containerRect = container.getBoundingClientRect();
                const lineRect = activeLine.getBoundingClientRect();
                const relativeTop = lineRect.top - containerRect.top + lineRect.height / 2;
                arrows.forEach(el => {
                    el.style.top = relativeTop + 'px';
                    el.style.transform = 'translateY(-50%)';
                });
            }
        }
    }

    // 使用预获取的麦克风流启动录音（同步调用，无异步延迟）
    function startRecordingWithStream() {
        if (!_micStream) {
            console.error('[录音] 没有可用的麦克风流');
            showToast('麦克风未就绪');
            return;
        }
        // 检查 track 是否还活着
        const tracks = _micStream.getAudioTracks();
        if (tracks.length === 0 || tracks[0].readyState !== 'live') {
            console.error('[录音] 麦克风 track 已失效:', tracks.length > 0 ? tracks[0].readyState : 'no tracks');
            showToast('麦克风连接丢失，请重试');
            return;
        }
        try {
            // 优先使用 webm opus，降级到浏览器默认
            let mimeType = 'audio/webm;codecs=opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'audio/webm';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = '';
                }
            }
            console.log('[录音] 使用 mimeType:', mimeType || '浏览器默认');

            const options = mimeType ? { mimeType } : {};
            mediaRecorder = new MediaRecorder(_micStream, options);
            recordedChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    recordedChunks.push(e.data);
                    console.log('[录音] 数据块:', e.data.size, 'bytes, 总块数:', recordedChunks.length);
                }
            };

            mediaRecorder.onstop = null;

            mediaRecorder.onerror = (e) => {
                console.error('[录音] MediaRecorder错误:', e.error);
                showToast('录音出错');
            };

            mediaRecorder.start();
            isRecording = true;
            console.log('[录音] MediaRecorder已启动, state:', mediaRecorder.state);

            // 降低背景音乐音量，但不要太低
            const audio = AudioManager.getCurrent();
            if (audio) audio.volume = 0.15;

        } catch (e) {
            console.error('[录音] MediaRecorder启动失败:', e);
            showToast('录音启动失败：' + e.message);
            isRecording = false;
        }
    }

    let _stopHandled = false;
    let _recCompleted = false;

    function stopRecording(discard) {
        if (_stopHandled) return;
        _stopHandled = true;

        const wasRecording = isRecording;
        isRecording = false;
        _recPreparing = false;
        btnRecord.disabled = false;
        btnRecord.className = 'btn-record-ctrl btn-record';
        btnRecord.textContent = '🎤 录音';
        btnAudition.disabled = false;
        clearLyricsHighlight();
        hideArrowIndicators();
        stopLiveWave();
        _stopSyncLoop();

        // 重置波形面板
        const wavePanel = document.getElementById('liveWavePanel');
        if(wavePanel) { wavePanel.style.display = 'none'; wavePanel.classList.remove('is-recording'); }

        // Stop audio playback
        AudioManager.stop();

        // Stop MediaRecorder
        if (wasRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
            if (discard) {
                _recCompleted = true;
                mediaRecorder.ondataavailable = null;
                mediaRecorder.onstop = () => {
                    _stopHandled = false;
                    _recCompleted = false;
                    releaseMic();
                };
            } else {
                mediaRecorder.onstop = () => {
                    // 等一个微任务让最后的 ondataavailable 先执行
                    setTimeout(() => {
                        if (_recCompleted) { _stopHandled = false; return; }
                        _recCompleted = true;
                        console.log('[录音] onstop, 共', recordedChunks.length, '个数据块');
                        const mimeType = mediaRecorder.mimeType || 'audio/webm;codecs=opus';
                        const blob = new Blob(recordedChunks, { type: mimeType });
                        console.log('[录音] Blob大小:', blob.size, 'bytes, type:', blob.type, 'mimeType:', mimeType);
                        if (recordedChunks.length > 0 && blob.size > 0) {
                            onRecordingComplete(blob);
                        } else {
                            showToast('录音数据为空，请检查麦克风');
                        }
                        _stopHandled = false;
                        _recCompleted = false;
                        setTimeout(releaseMic, 100);
                    }, 50);
                };
            }
            mediaRecorder.stop();
            console.log('[录音] MediaRecorder已停止');
        } else {
            _stopHandled = false;
            _recCompleted = false;
            releaseMic();
        }
    }

    function releaseMic() {
        if (_micStream) {
            _micStream.getTracks().forEach(t => t.stop());
            _micStream = null;
            console.log('[录音] 麦克风已释放');
        }
    }

    // ===== 实时波形可视化 =====
    let _audioCtx = null, _analyser = null, _waveRAF = 0, _sourceNode = null;

    function startLiveWave(stream) {
        const panel = document.getElementById('liveWavePanel');
        const canvas = document.getElementById('liveWaveCanvas');
        if(!panel || !canvas) return;
        panel.style.display = '';
        canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
        canvas.height = 64 * (window.devicePixelRatio || 1);
        const ctx = canvas.getContext('2d');

        try {
            if(!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            _analyser = _audioCtx.createAnalyser();
            _analyser.fftSize = 256;
            _sourceNode = _audioCtx.createMediaStreamSource(stream);
            _sourceNode.connect(_analyser);
        } catch(e) {
            console.warn('[波形] 初始化失败:', e);
            return;
        }

        const bufLen = _analyser.frequencyBinCount;
        const dataArr = new Uint8Array(bufLen);
        const w = canvas.width, h = canvas.height;
        const barW = Math.max(2, (w / bufLen) * 1.8);
        const gap = 1;

        function draw() {
            _waveRAF = requestAnimationFrame(draw);
            _analyser.getByteFrequencyData(dataArr);
            ctx.clearRect(0, 0, w, h);

            const bars = Math.floor(w / (barW + gap));
            const step = Math.max(1, Math.floor(bufLen / bars));
            for(let i = 0; i < bars; i++) {
                const val = dataArr[i * step] / 255;
                const barH = Math.max(2, val * h * 0.9);
                const x = i * (barW + gap);
                const y = (h - barH) / 2;
                const r = Math.min(barW / 2, 3);

                ctx.beginPath();
                ctx.roundRect(x, y, barW, barH, r);
                const intensity = 0.4 + val * 0.6;
                ctx.fillStyle = `rgba(239, 68, 68, ${intensity})`;
                ctx.fill();
            }
        }
        draw();
    }

    function stopLiveWave() {
        if(_waveRAF) { cancelAnimationFrame(_waveRAF); _waveRAF = 0; }
        if(_sourceNode) { try { _sourceNode.disconnect(); } catch(e){} _sourceNode = null; }
        _analyser = null;
        const panel = document.getElementById('liveWavePanel');
        if(panel) panel.style.display = 'none';
    }

    function highlightRecordingLyrics(currentTime) {
        const lines = lyricsSection.querySelectorAll('.lyric-line');
        lines.forEach((line) => {
            const gIdx = parseInt(line.dataset.globalIdx);
            const seg = allSegments[gIdx];
            if (!seg) return;
            const isMySeg = seg.id === segment.id;
            const isPast = currentTime >= seg.end_time;

            if (isMySeg) {
                line.classList.add('active', 'recording-active');
                const duration = segment.end_time - segment.start_time;
                const elapsed = currentTime - segment.start_time;
                const progress = Math.min(1, Math.max(0, elapsed / duration));
                _applyMtvScan(line, progress, true);
                line.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (isPast) {
                line.classList.remove('active', 'recording-active');
                _applyMtvScan(line, 1, false);
            } else {
                line.classList.remove('active', 'recording-active');
                _clearMtvScan(line);
            }
        });
    }

    function onRecordingComplete(blob) {
        console.log('[录音完成] blob:', blob.size, 'bytes, type:', blob.type);
        const score = Math.floor(Math.random() * 3) + 3;
        const url = URL.createObjectURL(blob);
        console.log('[录音完成] blobURL:', url);
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
        const rec = {
            index: myRecordings.length + 1,
            blob: blob,
            url: url,
            score: score,
            time: timeStr,
            id: null,
        };
        myRecordings.push(rec);
        renderMyRecordings();
        showToast('录音完成！');
    }

    function renderMyRecordings() {
        recCount.textContent = myRecordings.length;

        if (myRecordings.length >= 5) {
            btnRecord.disabled = true;
        } else {
            btnRecord.disabled = false;
        }

        if (myRecordings.length === 0) {
            myRecList.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,0.3);padding:20px;font-size:13px;">录音后将在这里显示</div>';
            recActions.style.display = 'none';
            return;
        }

        myRecList.innerHTML = myRecordings.map((rec, i) => {
            let stars = '';
            for (let s = 1; s <= 5; s++) {
                stars += `<span class="star ${s <= rec.score ? 'filled' : ''}">★</span>`;
            }
            return `
                <div class="my-rec-card ${i === selectedRecIndex ? 'selected' : ''}" data-index="${i}">
                    <span class="my-rec-num">#${rec.index}</span>
                    <span class="my-rec-time">${rec.time || ''}</span>
                    <div class="my-rec-wave" id="recWave${i}"></div>
                    <div class="my-rec-score">${stars}</div>
                </div>
            `;
        }).join('');

        // 为每张卡片初始化 WaveSurfer 波形
        myRecordings.forEach((rec, i) => {
            const container = document.getElementById(`recWave${i}`);
            if (!container || !WaveSurfer?.create) return;
            if (rec._ws) { try { rec._ws.destroy(); } catch(e){} }
            rec._ws = WaveSurfer.create({
                container,
                waveColor: 'rgba(255,255,255,0.35)',
                progressColor: '#07c160',
                cursorWidth: 0,
                height: 32,
                barWidth: 2,
                barGap: 1,
                barRadius: 1,
                normalize: true,
                interact: false,
                hideScrollbar: true,
            });
            rec._ws.loadBlob(rec.blob);
        });

        myRecList.querySelectorAll('.my-rec-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = parseInt(card.dataset.index);
                selectedRecIndex = idx;
                renderMyRecordings();
                recActions.style.display = 'flex';
            });
        });

        if (selectedRecIndex >= 0 && selectedRecIndex < myRecordings.length) {
            recActions.style.display = 'flex';
        } else {
            recActions.style.display = 'none';
        }
    }

    // 播放选中录音 — 使用 WaveSurfer 播放（带进度扫描）
    let _recPlaying = false;

    function _stopRecPlayback() {
        const rec = myRecordings[selectedRecIndex];
        if (rec?._ws && rec._ws.isPlaying()) {
            rec._ws.stop();
        }
        _recPlaying = false;
        btnRecPlay.textContent = '▶ 播放';
    }

    btnRecPlay.addEventListener('click', () => {
        if (selectedRecIndex < 0) return;
        const rec = myRecordings[selectedRecIndex];

        if (_recPlaying) {
            _stopRecPlayback();
            return;
        }

        _stopRecPlayback();
        AudioManager.stop();

        if (!rec._ws) {
            showToast('波形未就绪');
            return;
        }

        rec._ws.un('finish');
        rec._ws.on('finish', () => {
            _recPlaying = false;
            btnRecPlay.textContent = '▶ 播放';
        });

        rec._ws.play();
        _recPlaying = true;
        btnRecPlay.textContent = '⏹ 停止';
    });

    // 删除选中录音
    btnRecDelete.addEventListener('click', () => {
        if (selectedRecIndex < 0) return;
        _stopRecPlayback();
        AudioManager.stop();
        const del = myRecordings[selectedRecIndex];
        if (del?._ws) { try { del._ws.destroy(); } catch(e){} }
        if (del?.url) URL.revokeObjectURL(del.url);
        myRecordings.splice(selectedRecIndex, 1);
        myRecordings.forEach((r, i) => r.index = i + 1);
        selectedRecIndex = -1;
        renderMyRecordings();
        showToast('已删除');
    });

    // 提交选中录音
    btnRecSubmit.addEventListener('click', async () => {
        if (selectedRecIndex < 0) return;
        if (btnRecSubmit.disabled) return; // 防重放
        const rec = myRecordings[selectedRecIndex];
        _stopRecPlayback();
        AudioManager.stop();

        btnRecSubmit.textContent = '提交中...';
        btnRecSubmit.disabled = true;

        try {
            const fd = new FormData();
            fd.append('segment_id', segment.id);
            fd.append('song_id', song.id);
            fd.append('user_id', user.id);
            fd.append('user_name', user.nickname);
            fd.append('score', rec.score);
            fd.append('audio', rec.blob, 'recording.webm');

            const uploadRes = await apiPost('/recordings/upload', fd);
            if (!uploadRes.success) throw new Error('上传失败');

            const submitRes = await apiPost(`/recordings/${uploadRes.data.id}/submit`, new FormData());
            if (!submitRes.success) throw new Error('提交失败');

            showToast('提交成功！');

            myRecordings.forEach(r => {
                if (r.url) URL.revokeObjectURL(r.url);
            });
            myRecordings = [];
            selectedRecIndex = -1;

            setTimeout(() => {
                window.location.href = 'task.html';
            }, 800);

        } catch (e) {
            showToast('提交失败：' + e.message);
            btnRecSubmit.textContent = '✓ 提交';
            btnRecSubmit.disabled = false;
        }
    });

    // 初始渲染
    renderMyRecordings();
})();
