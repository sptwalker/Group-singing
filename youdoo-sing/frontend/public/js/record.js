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
    let _recordingStarted = false;

    // 初始化
    recSongName.textContent = song.title;
    recSegInfo.textContent = `#${segment.index} · ${segment.difficulty === 'easy' ? '简单' : segment.difficulty === 'normal' ? '普通' : '困难'}${segment.is_chorus ? ' · 合唱段' : ''}`;

    // 渲染歌词
    renderLyrics();

    function renderLyrics() {
        const segments = song.segments || [];

        lyricsSection.innerHTML = segments.map((seg, i) => {
            let cls = 'lyric-line';
            if (seg.id === segment.id) cls += ' current-segment active my-singing-line';
            return `<div class="${cls}" data-seg-id="${seg.id}" data-index="${i}">${seg.lyrics || '♪ ♪ ♪'}</div>`;
        }).join('');

        // 滚动到当前段
        setTimeout(() => {
            const activeLine = lyricsSection.querySelector('.active');
            if (activeLine) {
                activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
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

    // ===== 播放试唱 =====
    let isAuditioning = false;

    btnAudition.addEventListener('click', () => {
        if (isRecording) return;

        if (isAuditioning) {
            AudioManager.stop();
            btnAudition.className = 'btn-record-ctrl btn-audition';
            btnAudition.textContent = '▶ 播放试唱';
            isAuditioning = false;
            clearLyricsHighlight();
            return;
        }

        const audioUrl = `${API_BASE.replace('/api', '')}${song.audio_url}`;
        const segments = song.segments || [];
        const curIdx = segments.findIndex(s => s.id === segment.id);
        const previewStart = Math.max(0, curIdx - 3);
        const startTime = segments[previewStart].start_time;
        const endTime = segment.end_time;

        AudioManager.playRange(audioUrl, startTime, endTime,
            () => {
                btnAudition.className = 'btn-record-ctrl btn-audition';
                btnAudition.textContent = '▶ 播放试唱';
                isAuditioning = false;
                clearLyricsHighlight();
            },
            (curTime) => {
                highlightLyrics(curTime);
            }
        );

        btnAudition.className = 'btn-record-ctrl btn-audition playing';
        btnAudition.textContent = '⏹ 停止试听';
        isAuditioning = true;
    });

    function highlightLyrics(currentTime) {
        const lines = lyricsSection.querySelectorAll('.lyric-line');
        const segments = song.segments || [];
        lines.forEach((line, i) => {
            const seg = segments[i];
            if (!seg) return;
            line.classList.remove('active');
            if (currentTime >= seg.start_time && currentTime < seg.end_time) {
                line.classList.add('active');
                line.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }

    function clearLyricsHighlight() {
        lyricsSection.querySelectorAll('.lyric-line').forEach(l => l.classList.remove('active'));
        const curLine = lyricsSection.querySelector(`[data-seg-id="${segment.id}"]`);
        if (curLine) {
            curLine.classList.add('active', 'current-segment');
        }
    }

    // ===== 录音 =====
    btnRecord.addEventListener('click', async () => {
        if (isAuditioning) {
            AudioManager.stop();
            isAuditioning = false;
            btnAudition.className = 'btn-record-ctrl btn-audition';
            btnAudition.textContent = '▶ 播放试唱';
        }

        if (isRecording) {
            stopRecording(false);
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

        // 1. 安静提示
        quietTip.style.display = 'flex';
        await sleep(1500);
        quietTip.style.display = 'none';

        // 2. 播放前奏 + 倒计时 + 录音 — 音乐全程不中断
        const audioUrl = `${API_BASE.replace('/api', '')}${song.audio_url}`;
        const introSeconds = 5;
        const introStart = Math.max(0, segment.start_time - introSeconds);
        const actualIntro = segment.start_time - introStart;

        _recordingStarted = false;
        showArrowIndicators();
        doCountdownCorner(actualIntro);

        AudioManager.playRange(audioUrl, introStart, segment.end_time,
            () => {
                if (isRecording) stopRecording(false);
                hideArrowIndicators();
            },
            (curTime) => {
                // 录音中使用 MTV 逐字高亮，否则用普通高亮
                if (isRecording && curTime >= segment.start_time) {
                    highlightRecordingLyrics(curTime);
                } else {
                    highlightLyrics(curTime);
                }
                updateArrowIndicators(curTime);
                if (curTime >= segment.start_time - 0.3 && !isRecording && !_recordingStarted) {
                    _recordingStarted = true;
                    startRecordingWithStream();
                }
            }
        );
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

            mediaRecorder.onstop = () => {
                console.log('[录音] onstop, 共', recordedChunks.length, '个数据块');
                const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                console.log('[录音] Blob大小:', blob.size, 'bytes, type:', blob.type);
                if (recordedChunks.length > 0 && blob.size > 0) {
                    onRecordingComplete(blob);
                } else {
                    showToast('录音数据为空，请检查麦克风');
                }
            };

            mediaRecorder.onerror = (e) => {
                console.error('[录音] MediaRecorder错误:', e.error);
                showToast('录音出错');
            };

            mediaRecorder.start(200);
            isRecording = true;
            btnRecord.className = 'btn-record-ctrl btn-record recording';
            btnRecord.textContent = '⏹ 停止录音';
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

    function stopRecording(discard) {
        isRecording = false;
        _recordingStarted = false;
        btnRecord.className = 'btn-record-ctrl btn-record';
        btnRecord.textContent = '🎤 录音';
        clearLyricsHighlight();
        hideArrowIndicators();

        // 先停音频播放（不影响麦克风流）
        AudioManager.stop();

        // 再停 MediaRecorder — 它会异步触发 onstop
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            if (discard) {
                mediaRecorder.ondataavailable = null;
                mediaRecorder.onstop = () => {
                    // discard 时也要释放麦克风
                    releaseMic();
                };
            } else {
                // 保存原有 onstop，追加释放麦克风
                const origOnStop = mediaRecorder.onstop;
                mediaRecorder.onstop = function () {
                    if (origOnStop) origOnStop.call(this);
                    // onstop 完成后再释放麦克风
                    setTimeout(releaseMic, 100);
                };
            }
            mediaRecorder.stop();
            console.log('[录音] MediaRecorder已停止');
        } else {
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

    function highlightRecordingLyrics(currentTime) {
        const lines = lyricsSection.querySelectorAll('.lyric-line');
        const segments = song.segments || [];

        // 先清除所有行的 active/recording-active
        lines.forEach((line, i) => {
            const seg = segments[i];
            if (!seg) return;
            if (seg.id === segment.id) {
                // 当前演唱段 — MTV 逐字高亮
                line.classList.add('active', 'recording-active');
                line.scrollIntoView({ behavior: 'smooth', block: 'center' });

                const text = segment.lyrics || '';
                const duration = segment.end_time - segment.start_time;
                const elapsed = currentTime - segment.start_time;
                const progress = Math.min(1, Math.max(0, elapsed / duration));
                const charCount = Math.floor(progress * text.length);

                let html = '';
                for (let c = 0; c < text.length; c++) {
                    const cls = c < charCount ? 'lyric-char highlighted' : 'lyric-char';
                    html += `<span class="${cls}">${text[c]}</span>`;
                }
                line.innerHTML = html;
            } else {
                line.classList.remove('active', 'recording-active');
                // 恢复纯文本（如果之前被 MTV 化了）
                if (line.querySelector('.lyric-char')) {
                    line.textContent = seg.lyrics || '♪ ♪ ♪';
                }
            }
        });
    }

    function onRecordingComplete(blob) {
        const score = Math.floor(Math.random() * 3) + 3;
        const rec = {
            index: myRecordings.length + 1,
            blob: blob,
            url: URL.createObjectURL(blob),
            score: score,
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
                    <div class="my-rec-wave">${generateWaveformBars(18, false)}</div>
                    <div class="my-rec-score">${stars}</div>
                </div>
            `;
        }).join('');

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

    // 播放选中录音
    let _recPlaying = false; // 录音卡片的播放状态
    btnRecPlay.addEventListener('click', () => {
        if (selectedRecIndex < 0) return;
        const rec = myRecordings[selectedRecIndex];
        if (_recPlaying) {
            AudioManager.stop();
            _recPlaying = false;
            btnRecPlay.textContent = '▶ 播放';
        } else {
            AudioManager.play(rec.url, () => {
                _recPlaying = false;
                btnRecPlay.textContent = '▶ 播放';
            });
            _recPlaying = true;
            btnRecPlay.textContent = '⏹ 停止';
        }
    });

    // 删除选中录音
    btnRecDelete.addEventListener('click', () => {
        if (selectedRecIndex < 0) return;
        AudioManager.stop();
        _recPlaying = false;
        btnRecPlay.textContent = '▶ 播放';
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
        AudioManager.stop();
        _recPlaying = false;
        btnRecPlay.textContent = '▶ 播放';

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
