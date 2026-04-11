// ===== 分段编辑器模块 - Part1: 状态/渲染/波形 =====
console.log('[admin] admin-editor.js loaded');
let editorWS = null, editorSong = null, editorSegments = [], editorActiveIdx = -1;
let editorAudio = null, _editorAudioRAF = 0;
let editorDirty = false, editorHistory = [], editorHistoryIdx = -1;
const HIST_MAX = 20, SEG_MIN_DUR = 0.5;
let _loopPlay = false, _playingSegOnly = false;
let _editorEventsBound = false, _editorHighlightedIdx = -1, _editorPlayingIdx = -1;
let _editorOverlayVersion = '';
let _editorPlayingBlock = null;
let _editorWaveMetrics = { width: 0, height: 180 };
let _editorPxPerSec = 0;
let _editorSegListVersion = '';
let _editorZoom = 60;
let _editorBaseWaveWidth = 0;
let _editorCursorLine = null;
let _editorCursorHandle = null;
let _editorTimeline = null;
let _editorAutoFollowEnabled = true;
let _editorAutoFitApplied = false;
let _editorPausedSegIdx = -1;
let _editorPauseOriginSegIdx = -1;
let _editorIsPlaying = false;
let _editorWaveDrag = null;




// ===== 渲染主框架 =====
async function renderEditor(container) {
    let songs;
    try { songs = (await aGet('/admin/songs')).data; } catch(e) {
        container.innerHTML = `<div class="editor-empty"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`;
        return;
    }
    try {
        container.innerHTML = `
    <div class="editor-layout">
        <div class="editor-toolbar">
            <label style="font-weight:600;font-size:13px;">歌曲：</label>
            <select id="edSongSel">
                <option value="">-- 请选择 --</option>
                ${songs.map(s=>`<option value="${s.id}">${s.title} - ${s.artist}</option>`).join('')}
            </select>
            <span class="toolbar-sep"></span>
            <span id="edSongTitle" class="toolbar-title"></span>
            <span id="edUnsaved" class="unsaved-dot" style="display:none;" title="有未保存更改"></span>
            <div class="toolbar-spacer"></div>
            <button class="btn btn-outline btn-sm" id="btnReset" disabled title="重置为AI自动切分方案">🔄 重置</button>
            <button class="btn btn-success btn-sm" id="btnSaveAll" disabled>💾 保存</button>
        </div>
        <div class="editor-main" id="edMain">
            <div class="seg-list-panel" id="segListPanel">
                <div class="seg-list-header"><span>唱段列表</span><span class="seg-count" id="segCount">0 段</span></div>
                <div class="seg-list-body" id="segListBody">
                    <div class="editor-empty"><div class="empty-icon">✂️</div><p>选择歌曲</p></div>
                </div>
            </div>
            <div class="waveform-panel">
                <div class="editor-wave-toolbar">
                    <div class="zoom-control">
                        <button class="btn btn-outline btn-sm" id="btnUndo" disabled title="撤销 Ctrl+Z">↶</button>
                        <button class="btn btn-outline btn-sm" id="btnRedo" disabled title="重做 Ctrl+X">↷</button>
                        <span class="toolbar-sep"></span>
                        <span>缩放</span>
                        <button class="btn btn-outline btn-sm" id="btnZoomOut" type="button">－</button>
                        <input type="range" id="wsZoom" min="20" max="400" step="10" value="60">
                        <button class="btn btn-outline btn-sm" id="btnZoomIn" type="button">＋</button>
                        <span id="wsZoomValue">60%</span>
                    </div>
                </div>
                <div class="waveform-area" id="waveArea">
                    <div class="wave-host" id="waveHost">
                        <div id="waveformWrap" style="min-height:180px;position:relative;">
                            <div class="editor-empty" style="height:180px;"><p>选择歌曲加载波形</p></div>
                        </div>
                        <div class="seg-overlay-container" id="segOverlay"></div>
                    </div>
                </div>
                <div class="seg-detail-panel" id="segDetailPanel">
                    <div class="seg-detail-info" id="segDetailInfo">
                        <span class="seg-detail-empty">选择唱段查看详情</span>
                    </div>
                    <div class="seg-detail-actions" id="segDetailActions">
                        <div class="seg-detail-row">
                            <input type="number" step="0.1" id="segDetailStart" class="seg-detail-time" title="开始时间" disabled>
                            <span class="time-sep">\u2192</span>
                            <input type="number" step="0.1" id="segDetailEnd" class="seg-detail-time" title="结束时间" disabled>
                            <button class="btn btn-outline btn-sm" id="sdBtnPlaySeg" disabled title="从头播放本段">⏮ 从头</button>
                            <button class="btn btn-outline btn-sm" id="sdBtnResumeSeg" disabled title="从进度线播放">▶ 播放</button>
                            <button class="btn btn-outline btn-sm" id="sdBtnPauseSeg" disabled title="暂停">⏸ 暂停</button>
                            <span class="toolbar-sep"></span>
                            <button class="btn btn-outline btn-sm" id="sdBtnAdjust" disabled title="将下一段分界线移到进度线位置">✂️ 调整切分</button>
                            <button class="btn btn-outline btn-sm" id="sdBtnSplit" disabled title="在进度线位置新增拆分">➕ 新增切分</button>
                            <button class="btn btn-outline btn-sm" id="sdBtnMerge" disabled title="与下一段合并">🔗 合并</button>
                            <button class="btn btn-outline btn-sm btn-del-seg" id="sdBtnDelete" disabled title="删除本唱段">🗑 删除</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div class="editor-playbar" id="edPlaybar">
            <button class="btn btn-outline btn-sm" id="btnPlay" disabled>⏮</button>
            <button class="btn btn-outline btn-sm" id="btnResume" disabled>▶</button>
            <button class="btn btn-outline btn-sm" id="btnPause" disabled>⏸</button>
            <button class="btn btn-outline btn-sm" id="btnLoop" disabled title="循环选中段">🔁</button>
            <span class="playbar-time" id="pbTime">0:00 / 0:00</span>
            <div class="playbar-progress" id="pbProgress"><div class="playbar-progress-fill" id="pbFill"></div></div>
            <div class="playbar-volume"><span>🔊</span><input type="range" id="wsVol" min="0" max="100" value="80"></div>
        </div>
    </div>`;
        if (!document.getElementById('ctxMenu')) {
            const cm = document.createElement('div');
            cm.id = 'ctxMenu'; cm.className = 'ctx-menu'; cm.style.display = 'none';
            document.body.appendChild(cm);
        }
        _bindEditorEvents(songs);
    } catch (e) {
        console.error('renderEditor failed:', e);
        container.innerHTML = `<div class="editor-empty"><div class="empty-icon">⚠️</div><p>分段编辑器渲染失败：${e.message}</p></div>`;
    }
}

window.renderEditor = renderEditor;
console.log('[admin] renderEditor assigned to window:', typeof window.renderEditor);

function _stopEditorAudio(resetPlaybar = false) {
    if(_editorAudioRAF) {
        cancelAnimationFrame(_editorAudioRAF);
        _editorAudioRAF = 0;
    }
    _editorPauseOriginSegIdx = -1;
    _editorIsPlaying = false;
    if(editorAudio) {
        editorAudio.pause();
        editorAudio.onplay = null;
        editorAudio.onpause = null;
        editorAudio.onended = null;
        editorAudio.ontimeupdate = null;
        editorAudio = null;
    }
    _setPlayButtonState(false);
    _playingSegOnly = false;
    _setSegmentPlayingState(-1);
    if(resetPlaybar) _updatePlaybar(0);
}



function _tickEditorAudio() {
    if(!editorAudio) return;
    const currentTime = editorAudio.currentTime || 0;
    _updatePlaybar(currentTime);
    if(_playingSegOnly && editorActiveIdx>=0) {
        const seg = editorSegments[editorActiveIdx];
        if(seg && currentTime >= seg.end_time) {
            if(_loopPlay) {
                editorAudio.currentTime = seg.start_time;
            } else {
                _playingSegOnly = false;
                _editorPauseOriginSegIdx = -1;
                editorAudio.pause();
                return;
            }
        }
    }
    _editorAudioRAF = requestAnimationFrame(_tickEditorAudio);
}

function _buildEditorMediaUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const apiBase = (typeof API === 'string' ? API : '').replace(/\/api\/?$/, '');
    if (apiBase) return `${apiBase}${normalizedPath}`;
    return `${window.location.origin}${normalizedPath}`;
}

function _ensureEditorAudio() {
    const url = _buildEditorMediaUrl(editorSong.audio_url);
    if(editorAudio && editorAudio._editorUrl === url) return editorAudio;
    _stopEditorAudio(false);
    editorAudio = new Audio(url);
    editorAudio._editorUrl = url;
    editorAudio.crossOrigin = 'anonymous';
    editorAudio.preload = 'auto';
    editorAudio.addEventListener('play', () => {
        console.log('[editor-audio] play', { url, currentTime: editorAudio?.currentTime, paused: editorAudio?.paused });
        _editorIsPlaying = true;
        _setAutoFollowEnabled(true);
        _refreshPlayingState();
        if(!_editorAudioRAF) _tickEditorAudio();
    });
    editorAudio.addEventListener('pause', () => {
        console.log('[editor-audio] pause', { url, currentTime: editorAudio?.currentTime, ended: editorAudio?.ended, readyState: editorAudio?.readyState });
        if(_editorAudioRAF) {
            cancelAnimationFrame(_editorAudioRAF);
            _editorAudioRAF = 0;
        }
        _editorIsPlaying = false;
        _editorPausedSegIdx = _editorPauseOriginSegIdx;
        _editorPauseOriginSegIdx = -1;
        _refreshPlayingState();
    });

    editorAudio.addEventListener('ended', () => {
        console.log('[editor-audio] ended', { url, duration: editorAudio?.duration });
        if(_editorAudioRAF) {
            cancelAnimationFrame(_editorAudioRAF);
            _editorAudioRAF = 0;
        }
        _editorIsPlaying = false;
        _playingSegOnly = false;
        _editorPauseOriginSegIdx = -1;
        _editorPausedSegIdx = -1;
        _refreshPlayingState();
        _updatePlaybar(editorAudio?.duration || 0);
    });
    editorAudio.addEventListener('loadedmetadata', () => {
        console.log('[editor-audio] loadedmetadata', { url, duration: editorAudio?.duration, readyState: editorAudio?.readyState });
    });
    editorAudio.addEventListener('canplay', () => {
        console.log('[editor-audio] canplay', { url, currentTime: editorAudio?.currentTime, readyState: editorAudio?.readyState });
    });
    editorAudio.addEventListener('stalled', () => {
        console.warn('[editor-audio] stalled', { url, currentTime: editorAudio?.currentTime, networkState: editorAudio?.networkState });
    });
    editorAudio.addEventListener('error', () => {
        const err = editorAudio?.error;
        const msg = err ? `音频加载失败(${err.code})` : '音频加载失败';
        console.error('[editor-audio] error', { url, code: err?.code, message: err?.message, networkState: editorAudio?.networkState, readyState: editorAudio?.readyState });
        _editorIsPlaying = false;
        _playingSegOnly = false;
        _editorPauseOriginSegIdx = -1;
        _editorPausedSegIdx = -1;
        _refreshPlayingState();
        showToast(`${msg}：${url}`, 'error');
    });

    return editorAudio;
}


function _pauseEditorAudio() {
    if(!editorAudio) return;
    _editorPauseOriginSegIdx = _playingSegOnly ? editorActiveIdx : -1;
    _playingSegOnly = false;
    _editorIsPlaying = false;
    _setPlayButtonState(false);
    editorAudio.pause();
}

function _pauseSegmentAudio(idx) {
    if(!editorAudio || editorAudio.paused || !Number.isInteger(idx) || idx < 0) return;
    const seg = editorSegments[idx];
    if(!seg) return;
    _editorPauseOriginSegIdx = idx;
    _editorIsPlaying = false;
    _setPlayButtonState(false);
    editorAudio.pause();
}


function _setPlayButtonState(isPlaying) {
    const btnPlay = document.getElementById('btnPlay');
    if(btnPlay) btnPlay.textContent = '⏮';
    btnPlay?.classList.toggle('btn-primary', !isPlaying);
    btnPlay?.classList.toggle('btn-outline', isPlaying);
    const btnResume = document.getElementById('btnResume');
    if(btnResume) btnResume.textContent = '▶';
    btnResume?.classList.toggle('btn-primary', isPlaying);
    btnResume?.classList.toggle('btn-outline', !isPlaying);
    const btnPause = document.getElementById('btnPause');
    btnPause?.classList.toggle('btn-primary', isPlaying);
    btnPause?.classList.toggle('btn-outline', !isPlaying);
}

function _setLoopButtonState() {
    const btnLoop = document.getElementById('btnLoop');
    if(!btnLoop) return;
    btnLoop.classList.toggle('btn-primary', _loopPlay);
    btnLoop.classList.toggle('btn-outline', !_loopPlay);
    btnLoop.title = _playingSegOnly ? '循环当前选中唱段' : '仅在单段试听时生效';
}

function _syncLoopAvailability() {
    const btnLoop = document.getElementById('btnLoop');
    if(!btnLoop) return;
    btnLoop.disabled = !editorSong;
    btnLoop.classList.toggle('is-inactive', !_playingSegOnly);
    _setLoopButtonState();
}

function _setAutoFollowEnabled(enabled) {
    _editorAutoFollowEnabled = enabled !== false;
    document.getElementById('waveArea')?.classList.toggle('user-scrolling', !_editorAutoFollowEnabled);
}

function _scheduleAutoFollowResume() {
    clearTimeout(_scheduleAutoFollowResume._timer);
    _scheduleAutoFollowResume._timer = setTimeout(() => _setAutoFollowEnabled(true), 900);
}

function _setSegmentPlayingState(idx) {
    _editorPlayingIdx = Number.isInteger(idx) ? idx : -1;
    _editorSegListVersion = '';
    _syncLoopAvailability();
    _renderSegList();
    _renderOverlay();
}

function _isSegmentActuallyPlaying(idx) {
    const audio = editorAudio;
    if(!Number.isInteger(idx) || idx < 0 || !audio || audio.paused || audio.ended || !_playingSegOnly) return false;
    const seg = editorSegments[idx];
    return !!(seg && audio.currentTime >= seg.start_time && audio.currentTime < seg.end_time);
}

function _refreshPlayingState() {
    const audio = editorAudio;
    const isPlaying = !!(_editorIsPlaying && audio && !audio.paused && !audio.ended && audio.readyState >= 2);
    _setPlayButtonState(isPlaying);
    _setSegmentPlayingState(isPlaying && _playingSegOnly ? editorActiveIdx : -1);
    return isPlaying;
}



function _getEditorCurrentSegment() {
    return editorActiveIdx >= 0 ? editorSegments[editorActiveIdx] : null;
}

function _playEditorAudioFrom(time, { segmentIdx = -1, resume = false } = {}) {
    if(!editorSong) return;
    const audio = _ensureEditorAudio();
    const seg = segmentIdx >= 0 ? editorSegments[segmentIdx] : null;
    if(seg) {
        const maxStart = Math.max(seg.start_time, Math.min(seg.end_time - 0.01, Number(time) || seg.start_time));
        audio.currentTime = maxStart;
        _playingSegOnly = true;
        _editorPauseOriginSegIdx = -1;
        _editorPausedSegIdx = -1;
        _selectSeg(segmentIdx, false);
        _setSegmentPlayingState(segmentIdx);
    } else {
        const dur = _getEditorDuration() || editorSong?.duration || 0;
        const target = Math.max(0, Math.min(dur || 0, Number(time) || 0));
        audio.currentTime = target;
        _playingSegOnly = false;
        _editorPauseOriginSegIdx = -1;
        _editorPausedSegIdx = -1;
        _setSegmentPlayingState(-1);
    }

    _editorIsPlaying = true;
    _setPlayButtonState(true);
    _setAutoFollowEnabled(true);
    _updatePlaybar(audio.currentTime || 0);

    audio.volume = (+document.getElementById('wsVol')?.value || 0) / 100;
    const playPromise = audio.play();
    if(playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
            console.log('[editor-audio] play() resolved', { currentTime: audio.currentTime, paused: audio.paused, segmentIdx, resume });
            _refreshPlayingState();
        }).catch(err => {
            console.error('[editor-audio] play() rejected', { err, url: audio.src, segmentIdx, resume });
            _editorIsPlaying = false;
            _playingSegOnly = false;
            _editorPauseOriginSegIdx = -1;
            _editorPausedSegIdx = -1;
            _setPlayButtonState(false);
            showToast(`播放失败：${err?.message || err || '未知错误'}`, 'error');
        });


    } else {
        _refreshPlayingState();
    }
}

function _seekEditorAudio(time, { keepPlayingState = true } = {}) {
    if(!editorSong) return;
    const audio = _ensureEditorAudio();
    const dur = _getEditorDuration() || editorSong?.duration || 0;
    const target = Math.max(0, Math.min(dur || time, Number(time) || 0));
    audio.currentTime = target;
    if(keepPlayingState) {
        const activeSeg = _getEditorCurrentSegment();
        const inActiveSeg = _playingSegOnly && activeSeg && target >= activeSeg.start_time && target < activeSeg.end_time;
        if(_playingSegOnly && !inActiveSeg) {
            _playingSegOnly = false;
            _editorPausedSegIdx = -1;
            _setSegmentPlayingState(-1);
        }
    } else {
        _playingSegOnly = false;
        _editorPausedSegIdx = -1;
        _setSegmentPlayingState(-1);
    }
    _updatePlaybar(target);
}

function _seekWaveByClientX(clientX, { keepPlayingState = false } = {}) {
    const host = document.getElementById('waveHost');
    const waveArea = document.getElementById('waveArea');
    const dur = _getEditorDuration() || editorSong?.duration || 0;
    const width = _editorWaveMetrics.width || host?.clientWidth || 0;
    if(!host || !dur || !width) return;
    const rect = waveArea?.getBoundingClientRect() || host.getBoundingClientRect();
    const rawX = clientX - rect.left + (waveArea?.scrollLeft || 0);
    const x = Math.max(0, Math.min(width, rawX));
    _seekEditorAudio((x / width) * dur, { keepPlayingState });
}


function _handleEditorWheelZoom(e) {
    if(!e.ctrlKey || !editorSong) return;
    e.preventDefault();
    e.stopPropagation();
    _setAutoFollowEnabled(false);
    _applyEditorZoom(_editorZoom + (e.deltaY < 0 ? 10 : -10));
    _scheduleAutoFollowResume();
}



function _applyEditorZoom(value, { fit = false } = {}) {
    const slider = document.getElementById('wsZoom');
    const valueEl = document.getElementById('wsZoomValue');
    const waveArea = document.getElementById('waveArea');
    if(fit) value = 100;
    const next = Math.max(20, Math.min(400, Math.round((Number(value) || 60) / 10) * 10));
    const currentTime = _getEditorCurrentTime();
    _editorZoom = next;
    if(slider) slider.value = String(next);
    if(valueEl) valueEl.textContent = `${next}%`;
    if(editorWS?.zoom) {
        const duration = Math.max(_getEditorDuration() || 1, 1);
        const containerWidth = Math.max(waveArea?.clientWidth || 0, 1);
        const baseWidth = Math.max(_editorBaseWaveWidth || containerWidth, 1);
        const targetWidth = fit ? containerWidth : Math.max(1, baseWidth * (next / 100));
        const pxPerSec = Math.max(0.1, targetWidth / duration);
        _editorPxPerSec = pxPerSec;
        const beforeLeft = waveArea?.scrollLeft || 0;
        const beforeCenter = waveArea ? beforeLeft + waveArea.clientWidth / 2 : 0;
        const beforeCenterRatio = (_editorWaveMetrics.width || 0) > 0 ? beforeCenter / _editorWaveMetrics.width : (currentTime / duration);
        editorWS.zoom(pxPerSec);
        requestAnimationFrame(() => {
            _syncWaveMetrics();
            if(waveArea && _editorWaveMetrics.width > 0) {
                if(fit || _editorWaveMetrics.width <= waveArea.clientWidth) {
                    waveArea.scrollLeft = 0;
                } else {
                    const targetCenter = beforeCenterRatio * _editorWaveMetrics.width;
                    waveArea.scrollLeft = Math.max(0, targetCenter - waveArea.clientWidth / 2);
                }
            }
            _renderOverlay();
            _renderTimelineTicks();
            _updateCursorLine(currentTime);
        });
    }
}

function _updateCursorLine(currentTime, { autoFollow = true } = {}) {
    const line = _editorCursorLine || document.getElementById('waveProgressLine');
    const handle = _editorCursorHandle || document.getElementById('waveProgressHandle');
    const host = document.getElementById('waveHost');
    const waveArea = document.getElementById('waveArea');
    const dur = editorWS?.getDuration?.() || editorAudio?.duration || editorSong?.duration || 0;
    if(!line || !host || !dur) {
        if(line) line.style.display = 'none';
        if(handle) handle.style.display = 'none';
        return;
    }
    const clamped = Math.max(0, Math.min(dur, Number(currentTime) || 0));
    const width = _editorWaveMetrics.width || host.clientWidth || 0;
    const left = Math.max(0, Math.min(width, (clamped / dur) * width));
    line.style.display = '';
    line.style.left = `${left}px`;
    if(handle) {
        handle.style.display = '';
        handle.style.left = `${left}px`;
    }
    if(waveArea && autoFollow && _editorAutoFollowEnabled) {
        const viewLeft = waveArea.scrollLeft;
        const viewRight = viewLeft + waveArea.clientWidth;
        const padding = Math.min(96, Math.max(48, waveArea.clientWidth * 0.18));
        if(left > viewRight - padding) waveArea.scrollLeft = Math.max(0, left - waveArea.clientWidth + padding);
        else if(left < viewLeft + padding) waveArea.scrollLeft = Math.max(0, left - padding);
    }
}








function _renderTimelineTicks() {
    const timeline = _editorTimeline || document.getElementById('waveTimeline');
    const host = document.getElementById('waveHost');
    const dur = _getEditorDuration() || editorSong?.duration || 0;
    const width = _editorWaveMetrics.width || host?.clientWidth || 0;
    if(!timeline || !host || !dur || !width) {
        if(timeline) timeline.innerHTML = '';
        return;
    }
    timeline.style.width = `${width}px`;
    const minGapPx = 72;
    const roughStep = dur / Math.max(1, Math.floor(width / minGapPx));
    const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = candidates.find(v => v >= roughStep) || Math.max(300, Math.ceil(roughStep / 60) * 60);
    const marks = [];
    for(let t = 0; t <= dur + 0.001; t += step) {
        const left = Math.max(0, Math.min(width, (t / dur) * width));
        marks.push(`<div class="wave-tick" style="left:${left}px"><span>${fmtTime(t)}</span></div>`);
    }
    const endLabel = fmtTime(dur);
    if(marks.length === 0 || !marks[marks.length - 1].includes(`>${endLabel}<`)) {
        marks.push(`<div class="wave-tick wave-tick-end" style="left:${width}px"><span>${endLabel}</span></div>`);
    }
    timeline.innerHTML = marks.join('');
}

function _bindWaveAreaAutoFollow() {
    const waveArea = document.getElementById('waveArea');
    if(!waveArea || waveArea.dataset.followBound === '1') return;

    waveArea.dataset.followBound = '1';
    let dragging = false;
    const pauseFollow = e => {
        if(e?.ctrlKey) return;
        _setAutoFollowEnabled(false);
        _scheduleAutoFollowResume();
    };
    waveArea.addEventListener('wheel', pauseFollow, { passive: true });
    waveArea.addEventListener('touchstart', pauseFollow, { passive: true });
    waveArea.addEventListener('pointerdown', () => {
        dragging = true;
        _setAutoFollowEnabled(false);
    });
    window.addEventListener('pointerup', () => {
        if(!dragging) return;
        dragging = false;
        _scheduleAutoFollowResume();
    });
    waveArea.addEventListener('scroll', () => {
        if(dragging) return;
        if(!_editorAutoFollowEnabled) _scheduleAutoFollowResume();
    }, { passive: true });
}

function _bindWaveDrag() {
    const waveArea = document.getElementById('waveArea');
    const host = document.getElementById('waveHost');
    const timeline = _editorTimeline || document.getElementById('waveTimeline');
    if(!waveArea || !host) return;
    if(waveArea.dataset.dragBound === '1') return;
    waveArea.dataset.dragBound = '1';

    const canStart = target => {
        if(!target) return false;
        if(target.closest('.seg-handle, .wave-progress-handle, input, button, select, textarea')) return false;
        return !!(target.closest('#waveformWrap') || target.closest('#waveTimeline'));
    };

    const onPointerDown = event => {
        if(event.button !== 0 || !canStart(event.target)) return;
        _editorWaveDrag = {
            startX: event.clientX,
            startScrollLeft: waveArea.scrollLeft
        };
        _setAutoFollowEnabled(false);
        waveArea.classList.add('is-dragging-wave');
        event.preventDefault();
    };

    const onPointerMove = event => {
        if(!_editorWaveDrag) return;
        const deltaX = event.clientX - _editorWaveDrag.startX;
        waveArea.scrollLeft = Math.max(0, _editorWaveDrag.startScrollLeft - deltaX);
        event.preventDefault();
    };

    const onPointerEnd = () => {
        if(!_editorWaveDrag) return;
        _editorWaveDrag = null;
        waveArea.classList.remove('is-dragging-wave');
        _scheduleAutoFollowResume();
    };

    host.addEventListener('mousedown', onPointerDown);
    timeline?.addEventListener('mousedown', onPointerDown);
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerEnd);
}

function _ensureWaveOverlayHost() {
    const host = document.getElementById('waveHost');
    if(!host) return null;
    let ov = document.getElementById('segOverlay');
    if(!ov) {
        ov = document.createElement('div');
        ov.id = 'segOverlay';
        ov.className = 'seg-overlay-container';
        host.appendChild(ov);
    }
    let timeline = document.getElementById('waveTimeline');
    if(!timeline) {
        timeline = document.createElement('div');
        timeline.id = 'waveTimeline';
        timeline.className = 'wave-timeline';
        host.appendChild(timeline);
    }
    let cursor = document.getElementById('waveProgressLine');
    if(!cursor) {
        cursor = document.createElement('div');
        cursor.id = 'waveProgressLine';
        cursor.className = 'wave-progress-line';
        cursor.style.display = 'none';
        host.appendChild(cursor);
    }
    let handle = document.getElementById('waveProgressHandle');
    if(!handle) {
        handle = document.createElement('button');
        handle.id = 'waveProgressHandle';
        handle.className = 'wave-progress-handle';
        handle.type = 'button';
        handle.title = '拖动定位播放光标';
        host.appendChild(handle);
        let dragging = false;
        const onMove = event => {
            if(!dragging) return;
            _seekWaveByClientX(event.clientX, { keepPlayingState: false });
        };
        handle.addEventListener('pointerdown', event => {
            event.preventDefault();
            event.stopPropagation();
            dragging = true;
            handle.setPointerCapture?.(event.pointerId);
            _setAutoFollowEnabled(false);
            onMove(event);
        });
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', event => {
            if(!dragging) return;
            dragging = false;
            handle.releasePointerCapture?.(event.pointerId);
            _scheduleAutoFollowResume();
        });
        handle.addEventListener('pointercancel', event => {
            dragging = false;
            handle.releasePointerCapture?.(event.pointerId);
            _scheduleAutoFollowResume();
        });
    }
    _editorTimeline = timeline;
    _editorCursorLine = cursor;
    _editorCursorHandle = handle;
    return ov;
}



function _getWaveRenderWidth() {
    const waveArea = document.getElementById('waveArea');
    const duration = Math.max(_getEditorDuration() || editorSong?.duration || 0, 0);
    const viewportWidth = Math.max(waveArea?.clientWidth || 0, 1);
    if(duration <= 0) return Math.max(_editorWaveMetrics.width || 0, viewportWidth);
    if(_editorPxPerSec > 0) {
        return Math.max(viewportWidth, _editorPxPerSec * duration);
    }
    return Math.max(_editorWaveMetrics.width || 0, viewportWidth);
}



function _syncWaveMetrics() {
    const wrap = document.getElementById('waveformWrap');
    const host = document.getElementById('waveHost');
    const ov = document.getElementById('segOverlay');
    const timeline = _editorTimeline || document.getElementById('waveTimeline');
    const waveArea = document.getElementById('waveArea');
    if(!wrap || !host || !ov) return;
    const wsScrollable = wrap.querySelector('.wavesurfer-scroll, .scroll, [part="scroll"]');
    const waveEl = wrap.querySelector('wave');
    const canvas = wrap.querySelector('canvas');
    const svg = wrap.querySelector('svg');
    const width = _getWaveRenderWidth();
    const height = Math.max(wrap.offsetHeight, wsScrollable?.getBoundingClientRect?.().height || 0, waveEl?.getBoundingClientRect?.().height || 0, canvas?.getBoundingClientRect?.().height || 0, svg?.getBoundingClientRect?.().height || 0, 180);
    const viewportWidth = Math.max(waveArea?.clientWidth || 0, 1);
    const widthChanged = width !== _editorWaveMetrics.width || height !== _editorWaveMetrics.height;
    _editorWaveMetrics = { width, height };
    host.style.width = `${width}px`;
    host.style.minWidth = `${viewportWidth}px`;
    host.style.height = `${height}px`;
    wrap.style.width = `${width}px`;
    wrap.style.minWidth = `${width}px`;
    ov.style.width = `${width}px`;
    ov.style.height = `${height}px`;
    if(timeline) timeline.style.width = `${width}px`;
    if(_editorCursorLine) {
        _editorCursorLine.style.height = `${height}px`;
    }
    if(widthChanged) _renderTimelineTicks();
}






function _createOverlayBlock(i) {
    const block = document.createElement('div');
    block.className = 'seg-block';
    block.innerHTML = `<div class="seg-handle seg-handle-left" data-side="left"></div><span class="seg-block-label"></span><div class="seg-handle seg-handle-right" data-side="right"></div>`;
    _bindOverlayBlock(block, i);
    return block;
}

function _overlaySignature() {
    return editorSegments.map((seg, i) => [
        i,
        seg?.id ?? '',
        seg?.index ?? i + 1,
        Number(seg?.start_time ?? 0),
        Number(seg?.end_time ?? 0),
        seg?.difficulty ?? '',
        seg?.is_chorus ? 1 : 0
    ].join('|')).join('||');
}

function _syncOverlayBlocks(ov) {
    const signature = _overlaySignature();
    if(signature !== _editorOverlayVersion) {
        while(ov.children.length > editorSegments.length) {
            ov.lastElementChild?.remove();
        }
        while(ov.children.length < editorSegments.length) {
            ov.appendChild(_createOverlayBlock(ov.children.length));
        }
        Array.from(ov.children).forEach((el, i) => _bindOverlayBlock(el, i));
        _editorOverlayVersion = signature;
    }
    return Array.from(ov.children);
}

function _updateOverlayBlock(el, seg, i, dur) {
    const widthPx = _editorWaveMetrics.width || document.getElementById('waveHost')?.clientWidth || 0;
    const left = widthPx > 0 ? (seg.start_time / dur) * widthPx : 0;
    const blockWidth = widthPx > 0 ? ((seg.end_time - seg.start_time) / dur) * widthPx : 0;
    el.dataset.idx = String(i);
    const SEG_COLORS = ['#10b981', '#3b82f6', '#f59e0b'];
    el.style.left = `${left}px`;
    el.style.width = `${Math.max(blockWidth, 2)}px`;
    el.style.background = SEG_COLORS[i % 3];
    el.className = `seg-block ${seg.is_chorus?'is-chorus':''} ${i===editorActiveIdx?'active':''} ${i===_editorPlayingIdx?'playing':''}`.trim();
    const label = el.querySelector('.seg-block-label');
    if(label) label.textContent = seg.index;
    const leftHandle = el.querySelector('.seg-handle-left');
    const rightHandle = el.querySelector('.seg-handle-right');
    if(leftHandle) leftHandle.dataset.idx = String(i);
    if(rightHandle) rightHandle.dataset.idx = String(i);
}


function _bindOverlayBlock(el, i) {
    el.oncontextmenu = event => { event.preventDefault(); _showCtx(event, i); };
    el.onclick = () => _selectSeg(i);
    el.ondblclick = () => _editSegModal(i);
    const leftHandle = el.querySelector('.seg-handle-left');
    const rightHandle = el.querySelector('.seg-handle-right');
    if(leftHandle) {
        leftHandle.dataset.idx = String(i);
        leftHandle.onmousedown = _startDrag;
    }
    if(rightHandle) {
        rightHandle.dataset.idx = String(i);
        rightHandle.onmousedown = _startDrag;
    }
}
// ===== 事件绑定 =====
function _bindEditorEvents() {

    const $ = id => document.getElementById(id);
    _setLoopButtonState();
    _syncLoopAvailability();
    _applyEditorZoom(_editorZoom);
    _bindWaveAreaAutoFollow();
    _bindWaveDrag();

    $('edSongSel').onchange = () => _loadSong($('edSongSel').value);
    $('btnPlay').onclick = async () => {
        if(!editorSong) return;
        _playEditorAudioFrom(0, { segmentIdx: -1, resume: false });
    };
    $('btnResume').onclick = async () => {
        if(!editorSong) return;
        const audio = _ensureEditorAudio();
        const resumeTime = audio.currentTime || 0;
        _playEditorAudioFrom(resumeTime, { segmentIdx: -1, resume: true });
    };
    $('btnPause').onclick = () => {
        if(!editorSong) return;
        _pauseEditorAudio();
    };



    $('btnLoop').onclick = () => {
        if(!editorSong) return;
        _loopPlay = !_loopPlay;
        _syncLoopAvailability();
    };

    $('wsZoom').oninput = e => _applyEditorZoom(e.target.value);
    $('btnZoomOut').onclick = () => _applyEditorZoom(_editorZoom - 10);
    $('btnZoomIn').onclick = () => _applyEditorZoom(_editorZoom + 10);
    $('waveArea').removeEventListener?.('wheel', _handleEditorWheelZoom);
    $('waveArea').addEventListener('wheel', _handleEditorWheelZoom, { passive: false });


    $('wsVol').oninput = e => {
        if(editorAudio) editorAudio.volume = +e.target.value/100;
    };
    $('btnUndo').onclick = edUndo;
    $('btnRedo').onclick = edRedo;
    $('btnReset').onclick = _resetSegments;
    $('btnSaveAll').onclick = _saveAll;

    // seg detail panel buttons
    $('segDetailStart').dataset.field = 'start_time';
    $('segDetailEnd').dataset.field = 'end_time';
    $('segDetailStart').onchange = function() {
        this.dataset.idx = String(editorActiveIdx);
        if(editorActiveIdx>=0) _onTimeInput(this);
        _renderSegDetail();
    };
    $('segDetailEnd').onchange = function() {
        this.dataset.idx = String(editorActiveIdx);
        if(editorActiveIdx>=0) _onTimeInput(this);
        _renderSegDetail();
    };

    $('sdBtnPlaySeg').onclick = () => { if(editorActiveIdx>=0) _playSeg(editorActiveIdx); };
    $('sdBtnResumeSeg').onclick = () => {
        if(!editorSong || editorActiveIdx < 0) return;
        const audio = _ensureEditorAudio();
        const seg = editorSegments[editorActiveIdx];
        if(seg) _playEditorAudioFrom(audio.currentTime || seg.start_time, { segmentIdx: editorActiveIdx, resume: true });
    };
    $('sdBtnPauseSeg').onclick = () => { if(editorActiveIdx>=0) _pauseSegmentAudio(editorActiveIdx); };
    $('sdBtnAdjust').onclick = () => {
        if(editorActiveIdx < 0 || editorActiveIdx >= editorSegments.length - 1) return;
        const t = Math.round(_getEditorCurrentTime() * 10) / 10;
        const seg = editorSegments[editorActiveIdx];
        const next = editorSegments[editorActiveIdx + 1];
        if(t <= seg.start_time + SEG_MIN_DUR || t >= next.end_time - SEG_MIN_DUR) {
            showToast('进度线位置不适合调整切分','error'); return;
        }
        seg.end_time = t;
        next.start_time = t;
        _commitChange();
        _renderSegDetail();
        showToast('已调整切分','success');
    };
    $('sdBtnSplit').onclick = () => { if(editorActiveIdx>=0) _splitSeg(editorActiveIdx); };
    $('sdBtnMerge').onclick = () => { if(editorActiveIdx>=0) _mergeWithNext(editorActiveIdx); };
    $('sdBtnDelete').onclick = () => { if(editorActiveIdx>=0) _deleteSegment(editorActiveIdx); };
    $('pbProgress').onclick = e => {
        if(!editorSong) return;
        const r = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - r.left) / r.width;
        const dur = _getEditorDuration() || editorSong?.duration || 0;
        if(dur) {
            _seekEditorAudio(ratio * dur, { keepPlayingState: false });
        }
    };

    if(!_editorEventsBound) {
        document.addEventListener('keydown', _edKeydown);
        document.addEventListener('click', _hideCtx);
        window.addEventListener('resize', () => {
            _syncWaveMetrics();
            _updateCursorLine(_getEditorCurrentTime());
        });
        window.addEventListener('beforeunload', e => { if(editorDirty){ e.preventDefault(); e.returnValue=''; } });
        _editorEventsBound = true;
    }
}

function _edKeydown(e) {
    if(!editorSong) return;
    const tag = (e.target.tagName||'').toLowerCase();
    if(tag==='input'||tag==='textarea'||tag==='select') return;
    if(e.key===' ') { e.preventDefault(); document.getElementById('btnPlay')?.click(); }
    if(e.key==='Delete'&&editorActiveIdx>=0) { e.preventDefault(); _deleteSegment(editorActiveIdx); }
    if(e.key==='ArrowLeft') { e.preventDefault(); _nudgeSegTime(-0.1); }
    if(e.key==='ArrowRight') { e.preventDefault(); _nudgeSegTime(0.1); }
    if(e.ctrlKey&&e.key==='z') { e.preventDefault(); edUndo(); }
    if(e.ctrlKey&&e.key==='x') { e.preventDefault(); edRedo(); }
}

// ===== 加载歌曲 =====
async function _loadSong(songId) {
    if(!songId) return;
    try {
        const res = await aGet(`/admin/songs/${songId}`);
        editorSong = res.data;
        editorSegments = JSON.parse(JSON.stringify(editorSong.segments||[]));
        editorActiveIdx = -1;
        _editorHighlightedIdx = -1;
        _editorPlayingIdx = -1;
        _editorPlayingBlock = null;
        _editorAutoFitApplied = false;
        _editorPausedSegIdx = -1;
        _editorPauseOriginSegIdx = -1;
        _setAutoFollowEnabled(true);



        _loopPlay = false;
        _setLoopButtonState();
        editorHistory = []; editorHistoryIdx = -1;
        _pushHistory();
        document.getElementById('edSongTitle').textContent = `${editorSong.title} - ${editorSong.artist}`;
        document.getElementById('edUnsaved').style.display = 'none';
        const _en = id => { const el = document.getElementById(id); if(el) el.disabled = false; };
        _en('btnSaveAll'); _en('btnReset'); _en('btnPlay'); _en('btnResume'); _en('btnPause'); _en('btnLoop');
        _syncToolbarSegButtons();
        _initWS();
        _renderSegList();
    } catch(e) { showToast(e.message,'error'); }
}

// ===== WaveSurfer 初始化 =====
function _initWS() {
    const prevWS = editorWS;
    editorWS = null;
    if (prevWS) {
        prevWS.unAll?.();
        try { prevWS.destroy(); } catch (e) {}
    }
    _stopEditorAudio(true);
    const wrap = document.getElementById('waveformWrap');
    const waveArea = document.getElementById('waveArea');
    if(waveArea) waveArea.scrollLeft = 0;
    _editorOverlayVersion = '';
    _ensureWaveOverlayHost();
    if(_editorCursorLine) _editorCursorLine.style.display = 'none';
    const url = _buildEditorMediaUrl(editorSong.audio_url);

    console.log('[admin] init waveform url:', url);

    if(typeof WaveSurfer === 'undefined' || !WaveSurfer?.create) {
        wrap.innerHTML = '<div class="editor-empty" style="height:180px;"><p>波形组件加载失败，请刷新页面重试</p></div>';
        _ensureWaveOverlayHost();
        _ensureEditorAudio();
        _updatePlaybar(0);
        return;
    }

    let handled = false;
    wrap.innerHTML = '<div class="loading" style="padding:60px;">加载波形中</div>';
    const failWave = (message, err, { silentAbort = false } = {}) => {
        if (handled) return;
        handled = true;
        if (!silentAbort && err) console.error('WaveSurfer error:', err);
        if (editorWS) {
            editorWS.unAll?.();
            try { editorWS.destroy(); } catch (e) {}
            editorWS = null;
        }
        wrap.innerHTML = `<div class="editor-empty" style="height:180px;"><p>${message}</p></div>`;
        _ensureWaveOverlayHost();
        _ensureEditorAudio();
        _updatePlaybar(0);
    };

    try {
        editorWS = WaveSurfer.create({
            container: wrap,
            waveColor:'#c7d2fe',
            progressColor:'#c7d2fe',
            cursorColor:'transparent',
            cursorWidth:0,
            height:160,
            normalize:false,
            minPxPerSec:0,
            fillParent:true,
            autoScroll:false,
            autoCenter:false,
            interact:false,
            dragToSeek:false,
            hideScrollbar:true,
            url
        });
    } catch (e) {
        failWave(`波形初始化失败：${e.message}`, e);
        return;
    }

    editorWS.on('ready', () => {
        if (handled) return;
        handled = true;
        wrap.querySelector('.loading')?.remove();
        _ensureWaveOverlayHost();
        editorWS.setMuted?.(true);
        _syncWaveMetrics();
        _editorBaseWaveWidth = Math.max(_editorWaveMetrics.width || waveArea?.clientWidth || 0, waveArea?.clientWidth || 0);
        if(!_editorAutoFitApplied) {
            _applyEditorZoom(100, { fit: true });
            _editorAutoFitApplied = true;
        } else {
            _applyEditorZoom(_editorZoom);
        }
        _renderOverlay();
        _ensureEditorAudio();
        _updatePlaybar(0);
        _renderTimelineTicks();
    });
    editorWS.on('error', err => {
        const msg = String(err?.message || err || '');
        if (/AbortError|aborted/i.test(msg)) {
            failWave('加载已取消', null, { silentAbort: true });
            return;
        }
        failWave('波形加载失败，但仍可继续编辑唱段', err);
    });
    editorWS.on('click', () => {});
    wrap.addEventListener('dblclick', () => {
        if(!editorAudio||!editorSong) return;
        const t = editorAudio.currentTime || 0;
        const inSeg = editorSegments.some(s => t>=s.start_time && t<s.end_time);
        if(!inSeg) _addSegAtTime(t);
    });
}

function _updatePlaybar(t) {
    const audio = editorAudio;
    const cur = t ?? audio?.currentTime ?? 0;
    const dur = audio?.duration || editorSong?.duration || 0;
    const pbTime = document.getElementById('pbTime');
    const pbFill = document.getElementById('pbFill');
    if(pbTime) pbTime.textContent = `${fmtTimePrecise(cur)} / ${fmtTime(dur)}`;
    if(pbFill) pbFill.style.width = dur ? (cur/dur*100)+'%' : '0%';
    _updateCursorLine(cur);
    _syncDetailWithCursor(cur);
}

function _syncDetailWithCursor(cur) {
    if(!editorSong || !editorSegments.length) return;
    const foundIdx = editorSegments.findIndex(s => cur >= s.start_time && cur < s.end_time);
    if(foundIdx >= 0 && foundIdx !== editorActiveIdx) {
        editorActiveIdx = foundIdx;
        _editorHighlightedIdx = foundIdx;
        _updateSegListActiveState();
        _renderOverlay();
    }
    _renderSegDetail();
}

// ===== 唱段覆盖层渲染 =====
function _renderOverlay() {
    const ov = _ensureWaveOverlayHost();
    if(!ov||!editorWS) return;
    _syncWaveMetrics();
    const dur = editorWS.getDuration();
    if(!dur) {
        ov.replaceChildren();
        _editorOverlayVersion = '';
        return;
    }
    const blocks = _syncOverlayBlocks(ov);
    blocks.forEach((el, i) => {
        const seg = editorSegments[i];
        if(seg) _updateOverlayBlock(el, seg, i, dur);
    });
}

// ===== 左侧唱段列表 =====
function _renderSegList() {
    const body = document.getElementById('segListBody');
    document.getElementById('segCount').textContent = `${editorSegments.length} 段`;
    if(!editorSegments.length) {
        body.innerHTML = '<div class="editor-empty" style="padding:40px;"><p>暂无唱段</p></div>';
        _editorSegListVersion = 'empty';
        return;
    }
    const signature = editorSegments.map((seg, i) => [
        i,
        seg?.id ?? '',
        seg?.index ?? i + 1,
        seg?.lyrics ?? '',
        Number(seg?.start_time ?? 0),
        Number(seg?.end_time ?? 0),
        seg?.difficulty ?? '',
        seg?.is_chorus ? 1 : 0,
        i === editorActiveIdx ? 1 : 0,
        i === _editorPlayingIdx ? 1 : 0
    ].join('|')).join('||');
    if(signature === _editorSegListVersion) return;
    _editorSegListVersion = signature;
    const SEG_COLORS = ['#10b981', '#3b82f6', '#f59e0b'];
    body.innerHTML = editorSegments.map((seg,i) => {
        const ac = i===editorActiveIdx ? 'active' : '';
        const pl = i===_editorPlayingIdx ? 'playing' : '';
        const idxColor = SEG_COLORS[i % 3];
        return `<div class="seg-card ${ac} ${pl}" data-idx="${i}" onclick="_selectSeg(${i})" oncontextmenu="event.preventDefault();_showCtx(event,${i})">
            <div class="seg-card-top">
                <div class="seg-card-idx" style="background:${idxColor};color:#fff;">${seg.index}</div>
                <div class="seg-card-content">
                    <div class="seg-card-lyrics">${seg.lyrics||'(空)'}</div>
                    <div class="seg-card-badges">
                        <span class="badge badge-${seg.difficulty}">${seg.difficulty}</span>
                        ${seg.is_chorus?'<span class="badge badge-chorus">合唱</span>':'<span class="badge">独唱</span>'}
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}

function _updateSegListActiveState() {
    document.querySelectorAll('#segListBody .seg-card').forEach((card, i) => {
        card.classList.toggle('active', i === editorActiveIdx);
    });
    _editorSegListVersion = '';
}


function _selectSeg(idx, seek = true) {
    if(editorActiveIdx === idx) {
        if(seek && idx >= 0) {
            const targetTime = editorSegments[idx].start_time;
            _seekEditorAudio(targetTime, { keepPlayingState: true });
            _setAutoFollowEnabled(true);
        }
        return;
    }
    editorActiveIdx = idx;
    _editorHighlightedIdx = idx;
    _updateSegListActiveState();
    _renderOverlay();
    _syncToolbarSegButtons();
    if(seek && idx >= 0) {
        const targetTime = editorSegments[idx].start_time;
        _seekEditorAudio(targetTime, { keepPlayingState: true });
        _setAutoFollowEnabled(true);
    }
}


function _syncToolbarSegButtons() {
    const hasActive = editorActiveIdx >= 0 && editorActiveIdx < editorSegments.length;
    const btnEdit = document.getElementById('btnEditSeg');
    const btnDel = document.getElementById('btnDelSeg');
    if(btnEdit) btnEdit.disabled = !hasActive;
    if(btnDel) btnDel.disabled = !hasActive;
    _renderSegDetail();
}

function _renderSegDetail() {
    const info = document.getElementById('segDetailInfo');
    const startEl = document.getElementById('segDetailStart');
    const endEl = document.getElementById('segDetailEnd');
    if(!info) return;
    const idx = editorActiveIdx;
    const seg = idx >= 0 ? editorSegments[idx] : null;
    const hasSeg = !!seg;
    const hasNext = idx >= 0 && idx < editorSegments.length - 1;
    const hasPrev = idx > 0;

    const t = _getEditorCurrentTime();
    const inAnySeg = editorSegments.some(s => t >= s.start_time && t < s.end_time);
    const isBlank = editorSong && !inAnySeg;

    const navBtns = `<span class="sd-nav-group">`
        + `<button class="btn btn-outline btn-sm sd-nav-btn" id="sdBtnPrev" ${!editorSong||!hasPrev?'disabled':''} onclick="_selectSeg(editorActiveIdx-1)">◀</button>`
        + `<button class="btn btn-outline btn-sm sd-nav-btn" id="sdBtnNext" ${!editorSong||!hasNext?'disabled':''} onclick="_selectSeg(editorActiveIdx+1)">▶</button>`
        + `</span>`;

    if(hasSeg) {
        const dur = (seg.end_time - seg.start_time).toFixed(1);
        const type = seg.is_chorus ? '合唱' : '独唱';
        const diffMap = {easy:'简单',normal:'普通',hard:'困难'};
        const diff = diffMap[seg.difficulty] || seg.difficulty;
        const SEG_COLORS = ['#10b981', '#3b82f6', '#f59e0b'];
        const c = SEG_COLORS[idx % 3];
        info.innerHTML = `<span class="sd-idx" style="background:${c}">${seg.index}</span>`
            + `<span class="sd-type">${type}</span>`
            + `<span class="sd-lyrics">${seg.lyrics||'(无歌词)'}</span>`
            + `<button class="btn btn-outline btn-sm sd-edit-btn" onclick="_editSegModal(${idx})" title="编辑属性">✏️</button>`
            + navBtns
            + `<span class="sd-spacer"></span>`
            + `<span class="sd-dur">${dur}s</span>`
            + `<span class="sd-diff badge badge-${seg.difficulty}">${diff}</span>`;
    } else if(isBlank) {
        info.innerHTML = '<span class="seg-detail-empty">空白段</span>' + navBtns;
    } else {
        info.innerHTML = '<span class="seg-detail-empty">选择唱段查看详情</span>' + navBtns;
    }

    if(startEl) { startEl.style.visibility = hasSeg ? '' : 'hidden'; startEl.disabled = !hasSeg; startEl.value = hasSeg ? seg.start_time.toFixed(1) : ''; }
    if(endEl) { endEl.style.visibility = hasSeg ? '' : 'hidden'; endEl.disabled = !hasSeg; endEl.value = hasSeg ? seg.end_time.toFixed(1) : ''; }
    const timeSep = startEl?.parentElement?.querySelector('.time-sep');
    if(timeSep) timeSep.style.visibility = hasSeg ? '' : 'hidden';

    const alwaysIds = ['sdBtnAdjust', 'sdBtnSplit'];
    alwaysIds.forEach(id => { const b = document.getElementById(id); if(b) b.disabled = !editorSong; });

    const segOnlyIds = ['sdBtnPlaySeg', 'sdBtnResumeSeg', 'sdBtnPauseSeg', 'sdBtnDelete'];
    segOnlyIds.forEach(id => { const b = document.getElementById(id); if(b) b.disabled = !hasSeg; });

    const btnMerge = document.getElementById('sdBtnMerge');
    if(btnMerge) btnMerge.disabled = !hasNext;
}

function _highlightAtTime() {
    return;
}

function _playSeg(idx) {
    if(!editorSegments[idx] || !editorSong) return;
    const seg = editorSegments[idx];
    _playEditorAudioFrom(seg.start_time, { segmentIdx: idx, resume: false });
}

