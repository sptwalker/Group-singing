// ===== 录音页逻辑 =====
(function () {
    const user = getUser();
    const song = JSON.parse(localStorage.getItem('youdoo_record_song'));
    const segment = JSON.parse(localStorage.getItem('youdoo_record_segment'));

    if (false && (!song || !segment)) {
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

    function renderUnavailable(title, message) {
        recSongName.textContent = title;
        recSegInfo.textContent = message;
        lyricsSection.innerHTML = `<div class="empty-recordings" style="margin:40px 20px;text-align:center;">${message}</div>`;
        document.querySelector('.record-controls').style.display = 'none';
        document.querySelector('.my-recordings-section').style.display = 'none';
        quietTip.style.display = 'none';
        countdownOverlay.style.display = 'none';
    }

    if (!user) {
        renderUnavailable('Login required', 'Open the home page and sign in before recording.');
        return;
    }

    if (!song || !segment) {
        renderUnavailable('No task selected', 'Choose a segment from task.html before opening record.html.');
        return;
    }

    let myRecordings = [];
    let selectedRecIndex = -1;
    let mediaRecorder = null;
    let recordedChunks = [];
    let isRecording = false;
    let _micStream = null;
    let _recPreparing = false;
    let _hasAcc = false;  // 当前歌曲是否有伴奏音�?

    // ===== 升降调控�?=====
    const pitchLabel = document.getElementById('pitchLabel');
    const btnPitchDown = document.getElementById('btnPitchDown');
    const btnPitchUp = document.getElementById('btnPitchUp');

    function updatePitchLabel() {
        const val = AudioManager.getPitch();
        if (val === 0) {
            pitchLabel.textContent = '原调';
            pitchLabel.classList.remove('pitch-shifted');
        } else {
            pitchLabel.textContent = (val > 0 ? '+' : '') + val + ' �?;
            pitchLabel.classList.add('pitch-shifted');
        }
    }
    btnPitchDown.addEventListener('click', () => {
        if (isRecording || _recPreparing) return;
        AudioManager.setPitch(AudioManager.getPitch() - 1);
        updatePitchLabel();
    });
    btnPitchUp.addEventListener('click', () => {
        if (isRecording || _recPreparing) return;
        AudioManager.setPitch(AudioManager.getPitch() + 1);
        updatePitchLabel();
    });
    updatePitchLabel();

    // 初始�?
    recSongName.textContent = song.title;
    recSegInfo.textContent = `#${segment.index} · ${segment.difficulty === 'easy' ? '简�? : segment.difficulty === 'normal' ? '普�? : '困难'}${segment.is_chorus ? ' · 合唱�? : ''}`;

    const allSegments = song.segments || [];
    const mySegIdx = allSegments.findIndex(s => s.id === segment.id);
    // 显示范围：前3�?（共5行）
    const displayStart = Math.max(0, mySegIdx - 3);
    const displayEnd = Math.min(allSegments.length - 1, mySegIdx + 1);
    const displaySegments = allSegments.slice(displayStart, displayEnd + 1);

    renderLyrics();

    function renderLyrics() {
        lyricsSection.innerHTML = displaySegments.map((seg, i) => {
            const globalIdx = displayStart + i;
            let cls = 'lyric-line';
            if (seg.id === segment.id) cls += ' my-singing-line';
            const text = seg.lyrics || '�?�?�?;
            // 将多行歌词拆分为独立�?span，避免多行同时扫�?
            const lines = text.split(/\r?\n/).filter(l => l.trim());
            if (lines.length > 1) {
                const spans = lines.map(l => `<span class="lyric-sub-line">${l}</span>`).join('');
                return `<div class="${cls}" data-seg-id="${seg.id}" data-global-idx="${globalIdx}" data-sub-lines="${lines.length}">${spans}</div>`;
            }
            return `<div class="${cls}" data-seg-id="${seg.id}" data-global-idx="${globalIdx}">${text}</div>`;
        }).join('');

        // 后处理：检�?CSS 自动换行，将过长文本拆为 lyric-sub-line
        _splitWrappedLines(lyricsSection);

        setTimeout(() => {
            const myLine = lyricsSection.querySelector('.my-singing-line');
            if (myLine) myLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
    }

    /**
     * 检测没�?lyric-sub-line �?lyric-line 是否�?CSS 自动换行而占据多行，
     * 如果是则按视觉行拆分�?<span class="lyric-sub-line">，复用已有多行扫描逻辑�?
     */
    function _splitWrappedLines(container) {
        container.querySelectorAll('.lyric-line').forEach(div => {
            if (div.querySelectorAll('.lyric-sub-line').length > 0) return;
            const text = div.textContent || '';
            if (!text.trim()) return;

            // �?line-height 计算单行高度
            const style = getComputedStyle(div);
            const lineH = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.2);
            const contentH = div.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
            const visualLines = Math.round(contentH / lineH);
            if (visualLines <= 1) return;

            // 用临�?span 逐字符测量，找出每行的断�?
            const chars = [...text];
            // 先把文本放入 span 以便测量
            div.innerHTML = chars.map(c => `<span class="_measure">${c}</span>`).join('');
            const spans = div.querySelectorAll('._measure');
            const breakIndices = [0]; // 每行起始字符索引
            let prevTop = null;
            spans.forEach((sp, i) => {
                const top = sp.getBoundingClientRect().top;
                if (prevTop !== null && Math.abs(top - prevTop) > lineH * 0.3) {
                    breakIndices.push(i);
                }
                prevTop = top;
            });

            if (breakIndices.length <= 1) {
                // 没有检测到换行，恢复原文本
                div.textContent = text;
                return;
            }

            // 按断点拆分为 lyric-sub-line
            const lineTexts = [];
            for (let k = 0; k < breakIndices.length; k++) {
                const start = breakIndices[k];
                const end = k + 1 < breakIndices.length ? breakIndices[k + 1] : chars.length;
                lineTexts.push(chars.slice(start, end).join(''));
            }
            div.innerHTML = lineTexts.map(l => `<span class="lyric-sub-line">${l}</span>`).join('');
            div.dataset.subLines = lineTexts.length;
        });
    }

    // 返回
    document.getElementById('btnBack').addEventListener('click', () => {
        AudioManager.stop();
        if (isRecording) stopRecording(true);
        releaseMic();
        if (myRecordings.length > 0 && !confirm('有未提交的录音，确定返回�?)) return;
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
            btnAudition.textContent = '�?播放试唱';
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
            btnAudition.textContent = '�?播放试唱';
            isAuditioning = false;
            clearLyricsHighlight();
        });

        _startSyncLoop(curTime => highlightLyrics(curTime));
        btnAudition.className = 'btn-record-ctrl btn-audition playing';
        btnAudition.textContent = '�?停止试听';
        isAuditioning = true;
    });

    function _applyMtvScan(line, progress, isMySeg) {
        const hiColor = isMySeg ? '#fbbf24' : 'rgba(255,255,255,0.85)';
        const loColor = isMySeg ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.2)';

        const subLines = line.querySelectorAll('.lyric-sub-line');
        if (subLines.length > 1) {
            // 多行歌词：逐行扫描，每行分配等比进�?
            const n = subLines.length;
            subLines.forEach((sl, idx) => {
                const lineStart = idx / n;
                const lineEnd = (idx + 1) / n;
                let lineProg;
                if (progress >= lineEnd) {
                    lineProg = 1;
                } else if (progress <= lineStart) {
                    lineProg = 0;
                } else {
                    lineProg = (progress - lineStart) / (lineEnd - lineStart);
                }
                const pct = (lineProg * 100).toFixed(1);
                sl.style.webkitTextFillColor = 'transparent';
                sl.style.background = `linear-gradient(90deg, ${hiColor} ${pct}%, ${loColor} ${pct}%)`;
                sl.style.webkitBackgroundClip = 'text';
                sl.style.backgroundClip = 'text';
            });
            line.classList.add('mtv-scan');
        } else {
            // 单行歌词：直接对整个 div 应用扫描
            const pct = (progress * 100).toFixed(1);
            line.style.webkitTextFillColor = 'transparent';
            line.style.background = `linear-gradient(90deg, ${hiColor} ${pct}%, ${loColor} ${pct}%)`;
            line.style.webkitBackgroundClip = 'text';
            line.style.backgroundClip = 'text';
            line.classList.add('mtv-scan');
        }
    }

    function _clearMtvScan(line) {
        line.classList.remove('mtv-scan');
        line.style.background = '';
        line.style.webkitBackgroundClip = '';
        line.style.backgroundClip = '';
        line.style.webkitTextFillColor = '';
        // 清除子行的扫描样�?
        line.querySelectorAll('.lyric-sub-line').forEach(sl => {
            sl.style.background = '';
            sl.style.webkitBackgroundClip = '';
            sl.style.backgroundClip = '';
            sl.style.webkitTextFillColor = '';
        });
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

            if (isCurrent) {
                const duration = seg.end_time - seg.start_time;
                const elapsed = currentTime - seg.start_time;
                const progress = Math.min(1, Math.max(0, elapsed / duration));
                // 先应�?mtv-scan（设�?text-fill-color: transparent），再加 active，避免闪�?
                _applyMtvScan(line, progress, isMySeg);
                line.classList.add('active');
                line.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (isPast) {
                _applyMtvScan(line, 1, isMySeg);
                line.classList.remove('active');
            } else {
                line.classList.remove('active');
                _clearMtvScan(line);
            }
        });
    }

    function clearLyricsHighlight() {
        lyricsSection.querySelectorAll('.lyric-line').forEach(line => {
            line.classList.remove('active', 'recording-active', 'singing-now');
            _clearMtvScan(line);
        });
    }

    // ===== 录音 =====
    let _recCancelled = false;  // 标记录音流程是否被取�?
    let _stopping = false;      // 标记正在执行停止流程，防止重入和误启�?
    let _recSessionId = 0;      // 每次录音流程的唯一标识，用于防止旧流程继续执行
    let _autoStopTimer = null;  // 安全兜底定时�?

    btnRecord.addEventListener('click', async () => {
        console.log('[录音按钮] 点击, isRecording=', isRecording, '_recPreparing=', _recPreparing, '_stopping=', _stopping);

        if (isAuditioning) {
            AudioManager.stop();
            isAuditioning = false;
            btnAudition.className = 'btn-record-ctrl btn-audition';
            btnAudition.textContent = '�?播放试唱';
        }

        // 正在停止流程中，忽略点击
        if (_stopping) {
            console.log('[录音按钮] _stopping=true, 忽略点击');
            return;
        }

        // 正在录音或准备中 �?停止
        if (isRecording || _recPreparing) {
            console.log('[录音按钮] 触发停止, isRecording=', isRecording);
            _recCancelled = true;
            stopRecording(isRecording ? false : true);
            return;
        }

        if (myRecordings.length >= 5) {
            showToast('录音已满5条，请删除后再录');
            return;
        }

        // 开始新的录音流�?
        const sessionId = ++_recSessionId;
        _recCancelled = false;
        console.log('[录音] 开始新流程, sessionId=', sessionId);

        // 0. 先获取麦克风权限（在播放音乐之前！避免异步延迟）
        try {
            if (_micStream) {
                _micStream.getTracks().forEach(t => t.stop());
            }
            // 注意：关�?echoCancellation！否则浏览器会把背景音乐和人声一起消�?
            _micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            });
        } catch (e) {
            showToast('无法访问麦克风，请授权后重试');
            console.error('[录音] 麦克风获取失�?', e);
            return;
        }

        // 如果�?getUserMedia 期间被取消或有新流程，直接退�?
        if (_recCancelled || _stopping || sessionId !== _recSessionId) {
            console.log('[录音] getUserMedia后检测到取消, sessionId=', sessionId, 'current=', _recSessionId);
            releaseMic();
            return;
        }

        // 1. 立即显示波形面板（准备状态）
        const wavePanel = document.getElementById('liveWavePanel');
        const waveLabel = document.getElementById('liveWaveLabel');
        const waveCd = document.getElementById('liveWaveCountdown');
        wavePanel.style.display = '';
        wavePanel.classList.remove('is-recording');
        waveLabel.textContent = '请准�?;
        waveCd.textContent = '';
        _recPreparing = true;
        btnRecord.disabled = false;
        btnRecord.className = 'btn-record-ctrl btn-record recording';
        btnRecord.textContent = '�?取消';
        btnAudition.disabled = true;

        // 启动麦克风波形（静默状态也有微弱波形）
        startLiveWave(_micStream);

        // 2. 安静提示
        quietTip.style.display = 'flex';
        await sleep(1500);
        quietTip.style.display = 'none';

        // 如果�?sleep 期间被取消（用户点了停止），直接退出并清理
        if (_recCancelled || _stopping || sessionId !== _recSessionId) {
            console.log('[录音] sleep后检测到取消, sessionId=', sessionId, 'current=', _recSessionId);
            // 清理：stopRecording 可能已经清理过，但以防万一
            if (!_stopping) {
                stopLiveWave();
                const wp = document.getElementById('liveWavePanel');
                if (wp) { wp.style.display = 'none'; wp.classList.remove('is-recording'); }
                _recPreparing = false;
                btnRecord.className = 'btn-record-ctrl btn-record';
                btnRecord.textContent = '🎤 录音';
                btnAudition.disabled = false;
                releaseMic();
            }
            return;
        }

        // 3. 播放前奏 + 倒计�?+ 录音
        // 录音时优先使用伴奏（无人声），避免原唱被麦克风录�?
        const baseUrl = API_BASE.replace('/api', '');
        _hasAcc = !!song.accompaniment_url;
        const recAudioUrl = _hasAcc
            ? `${baseUrl}${song.accompaniment_url}`
            : `${baseUrl}${song.audio_url}`;
        // 计算播放起始点：从前两句歌词开�?
        const leadSegs = 2;  // 提前播放的句�?
        const leadSegIdx = Math.max(0, mySegIdx - leadSegs);
        const leadSegStart = allSegments[leadSegIdx].start_time;
        const gapToLead = segment.start_time - leadSegStart;
        // 如果前两句距�?1秒或>15秒（太远），则从3秒前开�?
        const maxLeadIn = 3;
        let playStart;
        if (mySegIdx === 0 || gapToLead < 1 || gapToLead > 15) {
            playStart = Math.max(0, segment.start_time - maxLeadIn);
        } else {
            playStart = leadSegStart;
        }
        const leadTime = segment.start_time - playStart;

        showArrowIndicators();

        waveLabel.textContent = leadTime > 3 ? '前奏准备' : '请准�?;

        // 设置安全兜底定时器：无论如何，到�?end_time 后一定停�?
        if (_autoStopTimer) clearTimeout(_autoStopTimer);
        const maxDuration = (segment.end_time - playStart + 2) * 1000;  // 额外2秒容�?
        _autoStopTimer = setTimeout(() => {
            console.log('[录音] 安全兜底定时器触�? isRecording=', isRecording, '_recPreparing=', _recPreparing);
            if (isRecording || _recPreparing) {
                stopRecording(false);
            }
        }, maxDuration);

        AudioManager.playRange(recAudioUrl, playStart, segment.end_time, () => {
            console.log('[录音] playRange onEnd 触发, isRecording=', isRecording, '_recPreparing=', _recPreparing, '_stopping=', _stopping);
            _stopSyncLoop();
            if (isRecording || _recPreparing) {
                stopRecording(false);
            }
            hideArrowIndicators();
        });

        _startSyncLoop((curTime) => {
            // 安全边界：录音中且已超过唱段结束时间 �?强制停止
            if (isRecording && curTime >= segment.end_time - 0.05) {
                console.log('[录音] syncLoop安全边界触发, curTime=', curTime, 'endTime=', segment.end_time);
                _stopSyncLoop();
                stopRecording(false);
                hideArrowIndicators();
                return;
            }

            if (isRecording && curTime >= segment.start_time) {
                highlightRecordingLyrics(curTime);
            } else {
                highlightLyrics(curTime);
            }
            updateArrowIndicators(curTime);

            // 倒计时显�?
            const timeToSing = segment.start_time - curTime;
            if (timeToSing > 0) {
                const cd = Math.ceil(timeToSing);
                waveCd.textContent = cd > 0 ? cd : '';
            } else {
                waveCd.textContent = '';
            }

            // 到达录音位置 �?启动 MediaRecorder
            if (curTime >= segment.start_time - 0.3 && _recPreparing && !isRecording) {
                _recPreparing = false;
                wavePanel.classList.add('is-recording');
                waveLabel.textContent = '�?录音�?;
                waveCd.textContent = '';
                btnRecord.disabled = false;
                btnRecord.className = 'btn-record-ctrl btn-record recording';
                btnRecord.textContent = '�?停止录音';
                // 演唱歌词变亮
                const myLine = lyricsSection.querySelector('.my-singing-line');
                if (myLine) myLine.classList.add('singing-now');
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

    // 箭头指示�?
    const _arrowEl = document.querySelector('.lyrics-arrow-left');
    function showArrowIndicators() {
        if (_arrowEl) _arrowEl.style.display = 'block';
    }
    function hideArrowIndicators() {
        if (_arrowEl) {
            _arrowEl.style.display = 'none';
            _arrowEl.classList.remove('arrow-bold');
        }
    }
    function updateArrowIndicators(curTime) {
        if (!_arrowEl) return;
        const isInMySegment = curTime >= segment.start_time && curTime <= segment.end_time;
        _arrowEl.classList.toggle('arrow-bold', isInMySegment);

        // 箭头跟随当前高亮歌词行位�?
        const activeLine = lyricsSection.querySelector('.lyric-line.active');
        if (activeLine) {
            const container = document.querySelector('.lyrics-container');
            if (container) {
                const containerRect = container.getBoundingClientRect();
                const lineRect = activeLine.getBoundingClientRect();
                const relativeTop = lineRect.top - containerRect.top + lineRect.height / 2;
                _arrowEl.style.top = relativeTop + 'px';
            }
        }
    }

    // 使用预获取的麦克风流启动录音（同步调用，无异步延迟）
    function startRecordingWithStream() {
        // 优先使用处理后的流（降噪+美化），降级到原始麦克风�?
        const recStream = _processedStream || _micStream;
        if (!recStream) {
            console.error('[录音] 没有可用的音频流');
            showToast('麦克风未就绪');
            return;
        }
        // 检�?track 是否还活着
        const tracks = recStream.getAudioTracks();
        if (tracks.length === 0 || tracks[0].readyState !== 'live') {
            console.error('[录音] 音频 track 已失�?', tracks.length > 0 ? tracks[0].readyState : 'no tracks');
            showToast('麦克风连接丢失，请重�?);
            return;
        }
        try {
            // 优先使用 webm opus，降级到浏览器默�?
            let mimeType = 'audio/webm;codecs=opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'audio/webm';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = '';
                }
            }

            const options = mimeType ? { mimeType } : {};
            mediaRecorder = new MediaRecorder(recStream, options);
            recordedChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    recordedChunks.push(e.data);
                }
            };

            mediaRecorder.onstop = null;

            mediaRecorder.onerror = (e) => {
                console.error('[录音] MediaRecorder错误:', e.error);
                showToast('录音出错');
            };

            mediaRecorder.start();
            isRecording = true;

            // 降低背景音量：有伴奏时适度降低，无伴奏（原唱）时大幅降低以减少人声串入
            const audio = AudioManager.getCurrent();
            if (audio) audio.volume = _hasAcc ? 0.25 : 0.08;

        } catch (e) {
            console.error('[录音] MediaRecorder启动失败:', e);
            showToast('录音启动失败�? + e.message);
            isRecording = false;
        }
    }

    function stopRecording(discard) {
        console.log('[stopRecording] 调用, discard=', discard, '_stopping=', _stopping, 'isRecording=', isRecording, '_recPreparing=', _recPreparing);
        // 防止重入：如果已在停止流程中，直接返�?
        if (_stopping) {
            console.log('[stopRecording] 已在停止流程中，忽略');
            return;
        }
        _stopping = true;

        // 清除安全兜底定时�?
        if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

        const wasRecording = isRecording;
        isRecording = false;
        _recPreparing = false;
        _recCancelled = true;  // 确保 async click handler 中的 await 点也能感知到停止
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
            console.log('[stopRecording] 停止MediaRecorder, state=', mediaRecorder.state, 'discard=', discard);
            if (discard) {
                mediaRecorder.ondataavailable = null;
                mediaRecorder.onstop = () => {
                    console.log('[stopRecording] MediaRecorder.onstop (discard)');
                    releaseMic();
                    _stopping = false;
                };
            } else {
                mediaRecorder.onstop = () => {
                    console.log('[stopRecording] MediaRecorder.onstop (save), chunks=', recordedChunks.length);
                    // 等一个微任务让最后的 ondataavailable 先执�?
                    setTimeout(() => {
                        const mimeType = mediaRecorder.mimeType || 'audio/webm;codecs=opus';
                        const blob = new Blob(recordedChunks, { type: mimeType });
                        if (recordedChunks.length > 0 && blob.size > 0) {
                            onRecordingComplete(blob);
                        } else {
                            showToast('录音数据为空，请检查麦克风');
                        }
                        releaseMic();
                        _stopping = false;
                        console.log('[stopRecording] 完成, _stopping=false');
                    }, 50);
                };
            }
            mediaRecorder.stop();
        } else {
            console.log('[stopRecording] 无需停止MediaRecorder, wasRecording=', wasRecording);
            releaseMic();
            _stopping = false;
        }
    }

    function releaseMic() {
        if (_micStream) {
            _micStream.getTracks().forEach(t => t.stop());
            _micStream = null;
        }
    }

    // ===== 实时波形可视�?=====
    let _audioCtx = null, _analyser = null, _waveRAF = 0, _sourceNode = null;

    // ===== 音频处理引擎（降�?+ 人声美化�?=====
    let _processedStream = null;  // 处理后的 MediaStream（给 MediaRecorder 用）
    let _procNodes = [];          // 处理链节点引用，用于断开

    /**
     * 构建音频处理链：
     * micSource �?highpass(降噪) �?lowpass(去高频噪�? �?compressor(动态压�? �?midBoost(人声EQ) �?presenceBoost(亮度) �?destination
     * 同时分支�?analyser 做波形可视化
     */
    function buildAudioProcessingChain(stream) {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        const source = _audioCtx.createMediaStreamSource(stream);

        // 1. 高通滤�?�?去除 100Hz 以下低频噪声（空调、风扇、嗡嗡声�?
        const highpass = _audioCtx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 100;
        highpass.Q.value = 0.7;

        // 2. 低通滤�?�?去除 14kHz 以上高频噪声（电流声、嘶嘶声�?
        const lowpass = _audioCtx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 14000;
        lowpass.Q.value = 0.7;

        // 3. 动态压缩器 �?轻度压缩，保留动态范围，防止爆音
        const compressor = _audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -18;   // 提高阈值，减少过度压缩
        compressor.knee.value = 15;         // 柔和过渡
        compressor.ratio.value = 2.5;       // 降低压缩比，保留自然动�?
        compressor.attack.value = 0.005;    // 稍慢响应，避免吃掉瞬�?
        compressor.release.value = 0.2;     // 适中释放

        // 4. 中频提升 �?增强人声核心频段�?.5kHz），让声音更清晰
        const midBoost = _audioCtx.createBiquadFilter();
        midBoost.type = 'peaking';
        midBoost.frequency.value = 2500;
        midBoost.Q.value = 1.2;
        midBoost.gain.value = 4;  // +4dB

        // 5. 临场感提�?�?轻微提升 5kHz，增加声音亮�?
        const presenceBoost = _audioCtx.createBiquadFilter();
        presenceBoost.type = 'peaking';
        presenceBoost.frequency.value = 5000;
        presenceBoost.Q.value = 1.0;
        presenceBoost.gain.value = 2;  // +2dB

        // 6. 增益补偿 �?提高整体录音音量
        const makeupGain = _audioCtx.createGain();
        makeupGain.gain.value = 2.0;

        // 连接处理�?
        source.connect(highpass);
        highpass.connect(lowpass);
        lowpass.connect(compressor);
        compressor.connect(midBoost);
        midBoost.connect(presenceBoost);
        presenceBoost.connect(makeupGain);

        // 输出�?MediaStreamDestination（给 MediaRecorder�?
        const destination = _audioCtx.createMediaStreamDestination();
        makeupGain.connect(destination);

        // 分支�?analyser（波形可视化�?
        _analyser = _audioCtx.createAnalyser();
        _analyser.fftSize = 256;
        makeupGain.connect(_analyser);

        _sourceNode = source;
        _processedStream = destination.stream;
        _procNodes = [source, highpass, lowpass, compressor, midBoost, presenceBoost, makeupGain, destination];

        return { analyser: _analyser, processedStream: _processedStream };
    }

    function destroyAudioProcessingChain() {
        _procNodes.forEach(node => { try { node.disconnect(); } catch(e){} });
        _procNodes = [];
        _processedStream = null;
        _sourceNode = null;
        _analyser = null;
    }

    function startLiveWave(stream) {
        const panel = document.getElementById('liveWavePanel');
        const canvas = document.getElementById('liveWaveCanvas');
        if(!panel || !canvas) return;
        panel.style.display = '';
        canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
        canvas.height = 64 * (window.devicePixelRatio || 1);
        const ctx = canvas.getContext('2d');

        try {
            // 构建完整音频处理链（降噪+美化+波形分析�?
            buildAudioProcessingChain(stream);
        } catch(e) {
            console.warn('[波形] 初始化失�?', e);
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
        destroyAudioProcessingChain();
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
                const duration = segment.end_time - segment.start_time;
                const elapsed = currentTime - segment.start_time;
                const progress = Math.min(1, Math.max(0, elapsed / duration));
                _applyMtvScan(line, progress, true);
                line.classList.add('active', 'recording-active');
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

    // ===== 录音音频分析评分系统 =====
    async function analyzeRecording(blob) {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            const channelData = audioBuffer.getChannelData(0);
            const sampleRate = audioBuffer.sampleRate;
            const duration = audioBuffer.duration;

            // 1. 音量分析 �?计算 RMS 和动态范�?
            const volumeAnalysis = analyzeVolume(channelData, sampleRate);
            // 2. 音准分析 �?基频稳定�?
            const pitchAnalysis = analyzePitch(channelData, sampleRate);
            // 3. 节奏分析 �?能量包络的规律�?
            const rhythmAnalysis = analyzeRhythm(channelData, sampleRate);
            // 4. 音色分析 �?频谱丰富�?
            const toneAnalysis = analyzeTone(channelData, sampleRate);

            // 综合评分（加权平均）
            const weights = { volume: 0.2, pitch: 0.35, rhythm: 0.25, tone: 0.2 };
            const composite = Math.round(
                volumeAnalysis.score * weights.volume +
                pitchAnalysis.score * weights.pitch +
                rhythmAnalysis.score * weights.rhythm +
                toneAnalysis.score * weights.tone
            );
            // 映射�?-5�?
            const starScore = Math.max(1, Math.min(5, Math.round(composite / 20)));

            audioCtx.close();

            return {
                star: starScore,
                composite: composite,
                dimensions: {
                    volume: { score: volumeAnalysis.score, label: '音量', icon: '🔊', detail: volumeAnalysis.detail },
                    pitch: { score: pitchAnalysis.score, label: '音准', icon: '🎵', detail: pitchAnalysis.detail },
                    rhythm: { score: rhythmAnalysis.score, label: '节奏', icon: '🥁', detail: rhythmAnalysis.detail },
                    tone: { score: toneAnalysis.score, label: '音色', icon: '🎶', detail: toneAnalysis.detail },
                },
                duration: Math.round(duration * 10) / 10,
            };
        } catch (e) {
            console.error('[评分] 音频分析失败:', e);
            return null;
        }
    }

    function analyzeVolume(data, sampleRate) {
        // 将音频分成小帧计算每�?RMS
        const frameSize = Math.floor(sampleRate * 0.05); // 50ms �?
        const frames = [];
        for (let i = 0; i < data.length - frameSize; i += frameSize) {
            let sum = 0;
            for (let j = 0; j < frameSize; j++) sum += data[i + j] * data[i + j];
            frames.push(Math.sqrt(sum / frameSize));
        }
        if (frames.length === 0) return { score: 0, detail: '无音频数�? };

        // 整体 RMS
        const avgRMS = frames.reduce((a, b) => a + b, 0) / frames.length;
        // 有效帧（排除静音�?
        const threshold = avgRMS * 0.15;
        const activeFrames = frames.filter(f => f > threshold);
        const activeRatio = activeFrames.length / frames.length;

        // 动态范围（有效帧的标准�?/ 均�?�?越小越稳定）
        let score = 0;
        let detail = '';
        if (activeFrames.length < 3) {
            score = 10;
            detail = '音量过低';
        } else {
            const mean = activeFrames.reduce((a, b) => a + b, 0) / activeFrames.length;
            const variance = activeFrames.reduce((a, b) => a + (b - mean) ** 2, 0) / activeFrames.length;
            const cv = Math.sqrt(variance) / mean; // 变异系数

            // 音量适中得分（RMS �?0.05~0.3 范围最佳）
            let levelScore;
            if (avgRMS < 0.01) levelScore = 20;
            else if (avgRMS < 0.03) levelScore = 50;
            else if (avgRMS < 0.05) levelScore = 70;
            else if (avgRMS <= 0.35) levelScore = 100;
            else if (avgRMS <= 0.5) levelScore = 80;
            else levelScore = 60;

            // 稳定性得分（cv 越小越好�?
            let stabilityScore;
            if (cv < 0.3) stabilityScore = 100;
            else if (cv < 0.5) stabilityScore = 80;
            else if (cv < 0.8) stabilityScore = 60;
            else stabilityScore = 40;

            // 演唱覆盖率（有声帧占比）
            let coverageScore = Math.min(100, activeRatio * 120);

            score = Math.round(levelScore * 0.35 + stabilityScore * 0.35 + coverageScore * 0.3);

            if (avgRMS < 0.03) detail = '音量偏低，可靠近麦克�?;
            else if (avgRMS > 0.5) detail = '音量偏大，注意控制气�?;
            else if (cv > 0.6) detail = '音量起伏较大';
            else if (activeRatio < 0.4) detail = '演唱间断较多';
            else detail = '音量控制良好';
        }
        return { score: Math.min(100, Math.max(0, score)), detail };
    }

    function analyzePitch(data, sampleRate) {
        // 使用自相关法检测基�?
        const frameSize = Math.floor(sampleRate * 0.04); // 40ms
        const hopSize = Math.floor(sampleRate * 0.02); // 20ms hop
        const pitches = [];

        for (let start = 0; start < data.length - frameSize; start += hopSize) {
            const frame = data.slice(start, start + frameSize);
            // 检查帧能量是否足够
            let energy = 0;
            for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
            energy = Math.sqrt(energy / frame.length);
            if (energy < 0.02) continue; // 静音帧跳�?

            const pitch = detectPitchACF(frame, sampleRate);
            if (pitch > 60 && pitch < 1200) pitches.push(pitch); // 人声范围
        }

        if (pitches.length < 5) {
            return { score: 30, detail: '未检测到足够的音高信�? };
        }

        // 将音高转�?MIDI 半音（对数域），分析稳定�?
        const midiNotes = pitches.map(f => 12 * Math.log2(f / 440) + 69);

        // 音高跳变分析：相邻帧的半音差
        const intervals = [];
        for (let i = 1; i < midiNotes.length; i++) {
            intervals.push(Math.abs(midiNotes[i] - midiNotes[i - 1]));
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        // 大跳变比例（>3半音�?
        const bigJumps = intervals.filter(d => d > 3).length / intervals.length;

        // 音高范围
        const sortedMidi = [...midiNotes].sort((a, b) => a - b);
        const range = sortedMidi[Math.floor(sortedMidi.length * 0.95)] - sortedMidi[Math.floor(sortedMidi.length * 0.05)];

        let score = 0;
        // 平均跳变越小越稳定（歌唱中合理范�?0.3~1.5 半音�?
        if (avgInterval < 0.5) score += 40;
        else if (avgInterval < 1.0) score += 35;
        else if (avgInterval < 1.5) score += 28;
        else if (avgInterval < 2.5) score += 20;
        else score += 10;

        // 大跳变比�?
        if (bigJumps < 0.05) score += 30;
        else if (bigJumps < 0.1) score += 25;
        else if (bigJumps < 0.2) score += 18;
        else score += 8;

        // 音域范围（合理范�?5~20 半音�?
        if (range >= 5 && range <= 24) score += 30;
        else if (range >= 3 && range <= 30) score += 22;
        else score += 12;

        let detail;
        if (score >= 80) detail = '音准稳定，表现出�?;
        else if (score >= 60) detail = '音准较好，偶有偏�?;
        else if (score >= 40) detail = '音准有波动，可多练习';
        else detail = '音准需要加强练�?;

        return { score: Math.min(100, Math.max(0, score)), detail };
    }

    function detectPitchACF(frame, sampleRate) {
        // 自相关法基频检�?
        const n = frame.length;
        const minLag = Math.floor(sampleRate / 1200); // 最�?1200Hz
        const maxLag = Math.floor(sampleRate / 60);   // 最�?60Hz
        let bestLag = 0, bestCorr = -1;

        for (let lag = minLag; lag <= Math.min(maxLag, n - 1); lag++) {
            let corr = 0, norm1 = 0, norm2 = 0;
            for (let i = 0; i < n - lag; i++) {
                corr += frame[i] * frame[i + lag];
                norm1 += frame[i] * frame[i];
                norm2 += frame[i + lag] * frame[i + lag];
            }
            const normFactor = Math.sqrt(norm1 * norm2);
            if (normFactor > 0) corr /= normFactor;
            if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
        }
        if (bestCorr < 0.4 || bestLag === 0) return 0; // 不够可信
        return sampleRate / bestLag;
    }

    function analyzeRhythm(data, sampleRate) {
        // 计算能量包络，分析节奏规律�?
        const frameSize = Math.floor(sampleRate * 0.03); // 30ms
        const envelope = [];
        for (let i = 0; i < data.length - frameSize; i += frameSize) {
            let sum = 0;
            for (let j = 0; j < frameSize; j++) sum += Math.abs(data[i + j]);
            envelope.push(sum / frameSize);
        }
        if (envelope.length < 10) return { score: 50, detail: '片段过短' };

        // 计算能量变化的一阶差�?
        const diffs = [];
        for (let i = 1; i < envelope.length; i++) {
            diffs.push(Math.abs(envelope[i] - envelope[i - 1]));
        }
        const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;

        // 检测onset（能量突增点�?
        const threshold = avgDiff * 2;
        const onsets = [];
        for (let i = 0; i < diffs.length; i++) {
            if (diffs[i] > threshold) onsets.push(i);
        }

        // 分析onset间隔的规律�?
        let rhythmScore = 50;
        let detail = '';
        if (onsets.length >= 3) {
            const intervals = [];
            for (let i = 1; i < onsets.length; i++) {
                intervals.push(onsets[i] - onsets[i - 1]);
            }
            const meanInt = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            const varInt = intervals.reduce((a, b) => a + (b - meanInt) ** 2, 0) / intervals.length;
            const cvInt = meanInt > 0 ? Math.sqrt(varInt) / meanInt : 1;

            // 节奏规律性（cv 越小越规律）
            if (cvInt < 0.3) rhythmScore = 95;
            else if (cvInt < 0.5) rhythmScore = 80;
            else if (cvInt < 0.7) rhythmScore = 65;
            else if (cvInt < 1.0) rhythmScore = 50;
            else rhythmScore = 35;

            // 节奏密度适中加分（不太快不太慢）
            const avgIntervalMs = meanInt * 30; // 30ms per frame
            if (avgIntervalMs >= 200 && avgIntervalMs <= 800) rhythmScore = Math.min(100, rhythmScore + 5);

            if (rhythmScore >= 80) detail = '节奏稳定，把握准�?;
            else if (rhythmScore >= 60) detail = '节奏感较�?;
            else if (rhythmScore >= 45) detail = '节奏有些不稳';
            else detail = '节奏需要加�?;
        } else {
            rhythmScore = 55;
            detail = '节奏点较少，演唱较平';
        }
        return { score: Math.min(100, Math.max(0, rhythmScore)), detail };
    }

    function analyzeTone(data, sampleRate) {
        // 频谱分析 �?使用简化方法计算频谱特�?
        const frameSize = 1024;
        const spectra = [];

        for (let start = 0; start + frameSize < data.length; start += frameSize * 2) {
            const frame = data.slice(start, start + frameSize);
            let energy = 0;
            for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
            if (Math.sqrt(energy / frame.length) < 0.015) continue;

            // 使用自相关频谱估计（比DFT快得多）
            const magnitudes = [];
            const bins = 128;
            for (let k = 0; k < bins; k++) {
                let corr = 0;
                const lag = k;
                for (let n = 0; n < frameSize - lag; n++) {
                    corr += frame[n] * frame[n + lag];
                }
                magnitudes.push(Math.abs(corr));
            }
            spectra.push(magnitudes);
        }

        if (spectra.length === 0) return { score: 40, detail: '音频信号不足' };

        // 平均频谱
        const avgSpectrum = new Array(spectra[0].length).fill(0);
        spectra.forEach(s => s.forEach((v, i) => avgSpectrum[i] += v));
        avgSpectrum.forEach((v, i) => avgSpectrum[i] = v / spectra.length);

        // 自相关衰减率（谐波丰富度指标�?
        const peak = avgSpectrum[0] || 1;
        let harmonicPeaks = 0;
        for (let i = 2; i < avgSpectrum.length - 1; i++) {
            if (avgSpectrum[i] > avgSpectrum[i-1] && avgSpectrum[i] > avgSpectrum[i+1] && avgSpectrum[i] > peak * 0.1) {
                harmonicPeaks++;
            }
        }

        // 衰减速度（快速衰�?噪声少）
        const midEnergy = avgSpectrum.slice(30, 60).reduce((a, b) => a + b, 0);
        const earlyEnergy = avgSpectrum.slice(1, 15).reduce((a, b) => a + b, 0);
        const decayRatio = earlyEnergy > 0 ? midEnergy / earlyEnergy : 1;

        // 评分
        let score = 50;
        // 谐波峰越�?�?音色越丰�?
        if (harmonicPeaks >= 5) score += 25;
        else if (harmonicPeaks >= 3) score += 20;
        else if (harmonicPeaks >= 1) score += 12;
        else score += 5;

        // 衰减比适中（不太快也不太慢�?
        if (decayRatio >= 0.05 && decayRatio <= 0.4) score += 25;
        else if (decayRatio >= 0.02 && decayRatio <= 0.6) score += 18;
        else score += 8;

        let detail;
        if (score >= 80) detail = '音色饱满清亮';
        else if (score >= 60) detail = '音色较好';
        else if (score >= 45) detail = '音色表现一�?;
        else detail = '可注意发声技�?;

        return { score: Math.min(100, Math.max(0, score)), detail };
    }

    // ===== 评分结果弹窗 =====
    function showScorePanel(scoreResult) {
        // 移除已有面板
        const old = document.getElementById('scorePanelOverlay');
        if (old) old.remove();

        const dims = scoreResult.dimensions;
        const dimKeys = ['pitch', 'volume', 'rhythm', 'tone'];

        let starsHtml = '';
        for (let i = 1; i <= 5; i++) {
            starsHtml += `<span class="score-star ${i <= scoreResult.star ? 'filled' : ''}" style="animation-delay:${i * 0.12}s">�?/span>`;
        }

        let dimsHtml = dimKeys.map(key => {
            const d = dims[key];
            const barColor = d.score >= 80 ? '#10b981' : d.score >= 60 ? '#f59e0b' : d.score >= 40 ? '#f97316' : '#ef4444';
            return `
                <div class="score-dim-row">
                    <span class="score-dim-icon">${d.icon}</span>
                    <span class="score-dim-label">${d.label}</span>
                    <div class="score-dim-bar-bg">
                        <div class="score-dim-bar" style="width:0%;background:${barColor};" data-target="${d.score}"></div>
                    </div>
                    <span class="score-dim-val">${d.score}</span>
                    <span class="score-dim-detail">${d.detail}</span>
                </div>`;
        }).join('');

        const overlay = document.createElement('div');
        overlay.id = 'scorePanelOverlay';
        overlay.className = 'score-panel-overlay';
        overlay.innerHTML = `
            <div class="score-panel">
                <div class="score-panel-title">演唱评分</div>
                <div class="score-stars-row">${starsHtml}</div>
                <div class="score-composite">综合得分 <strong>${scoreResult.composite}</strong><span>/100</span></div>
                <div class="score-dims">${dimsHtml}</div>
                <button class="score-panel-close" id="scoreCloseBtn">确定</button>
            </div>
        `;
        document.body.appendChild(overlay);

        // 动画：渐�?+ 条形图动�?
        requestAnimationFrame(() => {
            overlay.classList.add('show');
            setTimeout(() => {
                overlay.querySelectorAll('.score-dim-bar').forEach(bar => {
                    bar.style.width = bar.dataset.target + '%';
                });
            }, 300);
        });

        document.getElementById('scoreCloseBtn').addEventListener('click', () => {
            overlay.classList.remove('show');
            setTimeout(() => overlay.remove(), 300);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.remove('show');
                setTimeout(() => overlay.remove(), 300);
            }
        });
    }

    function onRecordingComplete(blob) {
        const url = URL.createObjectURL(blob);
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;

        // 先创建录音记录（评分中状态）
        const rec = {
            index: myRecordings.length + 1,
            blob: blob,
            url: url,
            score: 0,
            scoreResult: null,
            time: timeStr,
            id: null,
        };
        const recIdx = myRecordings.length;
        myRecordings.push(rec);
        renderMyRecordings();
        showToast('录音完成，正在分�?..');

        // 异步分析评分
        analyzeRecording(blob).then(result => {
            if (result) {
                rec.score = result.star;
                rec.scoreResult = result;
                renderMyRecordings();
                showScorePanel(result);
            } else {
                // 分析失败，给默认�?
                rec.score = 3;
                rec.scoreResult = null;
                renderMyRecordings();
                showToast('评分分析失败，已给予默认评分');
            }
        });
    }

    function renderMyRecordings() {
        recCount.textContent = myRecordings.length;

        if (myRecordings.length >= 5) {
            btnRecord.disabled = true;
        } else {
            btnRecord.disabled = false;
        }

        if (myRecordings.length === 0) {
            myRecList.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,0.3);padding:20px;font-size:13px;">录音后将在这里显�?/div>';
            recActions.style.display = 'none';
            return;
        }

        myRecList.innerHTML = myRecordings.map((rec, i) => {
            let stars = '';
            if (rec.score === 0 && !rec.scoreResult) {
                stars = '<span class="score-analyzing">分析�?..</span>';
            } else {
                for (let s = 1; s <= 5; s++) {
                    stars += `<span class="star ${s <= rec.score ? 'filled' : ''}">�?/span>`;
                }
            }
            const detailBtn = rec.scoreResult ? `<button class="btn-score-detail" data-rec-idx="${i}" title="查看详细评分">📊</button>` : '';
            return `
                <div class="my-rec-card ${i === selectedRecIndex ? 'selected' : ''}" data-index="${i}">
                    <span class="my-rec-num">#${rec.index}</span>
                    <span class="my-rec-time">${rec.time || ''}</span>
                    <div class="my-rec-wave" id="recWave${i}"></div>
                    <div class="my-rec-score">${stars}${detailBtn}</div>
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

        // 详细评分按钮
        myRecList.querySelectorAll('.btn-score-detail').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.recIdx);
                const rec = myRecordings[idx];
                if (rec?.scoreResult) showScorePanel(rec.scoreResult);
            });
        });

        if (selectedRecIndex >= 0 && selectedRecIndex < myRecordings.length) {
            recActions.style.display = 'flex';
        } else {
            recActions.style.display = 'none';
        }
    }

    // 播放选中录音 �?使用 WaveSurfer 播放（带进度扫描�?
    let _recPlaying = false;

    function _stopRecPlayback() {
        const rec = myRecordings[selectedRecIndex];
        if (rec?._ws && rec._ws.isPlaying()) {
            rec._ws.stop();
        }
        _recPlaying = false;
        btnRecPlay.textContent = '�?播放';
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
            showToast('波形未就�?);
            return;
        }

        rec._ws.un('finish');
        rec._ws.on('finish', () => {
            _recPlaying = false;
            btnRecPlay.textContent = '�?播放';
        });

        rec._ws.play();
        _recPlaying = true;
        btnRecPlay.textContent = '�?停止';
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
        showToast('已删�?);
    });

    // 提交选中录音
    btnRecSubmit.addEventListener('click', async () => {
        if (selectedRecIndex < 0) return;
        if (btnRecSubmit.disabled) return; // 防重�?
        const rec = myRecordings[selectedRecIndex];
        _stopRecPlayback();
        AudioManager.stop();

        btnRecSubmit.textContent = '提交�?..';
        btnRecSubmit.disabled = true;

        try {
            const fd = new FormData();
            fd.append('segment_id', segment.id);
            fd.append('song_id', song.id);
            fd.append('user_id', user.id);
            fd.append('user_name', user.nickname);
            fd.append('user_avatar', user.avatar || '');
            fd.append('score', rec.score);
            // 传递多维度评分详情
            if (rec.scoreResult) {
                fd.append('score_detail', JSON.stringify(rec.scoreResult));
            }
            fd.append('audio', rec.blob, 'recording.webm');

            const uploadRes = await apiPost('/recordings/upload', fd);
            if (!uploadRes.success) throw new Error('上传失败');

            const submitRes = await apiPost(`/recordings/${uploadRes.data.id}/submit`, new FormData());
            if (!submitRes.success) throw new Error('提交失败');

            showToast('提交成功�?);

            myRecordings.forEach(r => {
                if (r.url) URL.revokeObjectURL(r.url);
            });
            myRecordings = [];
            selectedRecIndex = -1;

            setTimeout(() => {
                window.location.href = 'task.html';
            }, 800);

        } catch (e) {
            showToast('提交失败�? + e.message);
            btnRecSubmit.textContent = '�?提交';
            btnRecSubmit.disabled = false;
        }
    });

    // 初始渲染
    renderMyRecordings();
})();
