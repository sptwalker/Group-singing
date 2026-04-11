// ===== 分段编辑器模块 - Part1: 状态/渲染/波形 =====
window.__EDITOR_PART1_OK__ = true;
let editorWS = null, editorSong = null, editorSegments = [], editorActiveIdx = -1;

let editorAudio = null, _editorAudioRAF = 0;
let editorDirty = false, editorHistory = [], editorHistoryIdx = -1;
const HIST_MAX = 20, SEG_MIN_DUR = 0.5;
let _loopPlay = false, _playingSegOnly = false;
let _editorEventsBound = false, _editorHighlightedIdx = -1, _editorPlayingIdx = -1;
let _editorOverlayVersion = '';
let _editorPlayingBlock = null;
let _editorWaveMetrics = { width: 0, height: 180 };

function _resolveMediaUrl(url) {
    if(!url) return '';
    if(/^https?:\/\//i.test(url) || url.startsWith('blob:') || url.startsWith('data:')) return url;
    if(url.startsWith('/')) return `${API.replace('/api', '')}${url}`;
    return `${API.replace('/api', '')}/${url.replace(/^\.\//, '')}`;
}

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
            <div class="undo-redo">
                <button class="btn btn-outline btn-sm" id="btnUndo" disabled title="撤销 Ctrl+Z">↶ 撤销</button>
                <button class="btn btn-outline btn-sm" id="btnRedo" disabled title="重做 Ctrl+X">↷ 重做</button>
            </div>
            <button class="btn btn-primary btn-sm" id="btnAddSeg" disabled>＋ 新增</button>
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
                <div class="waveform-area" id="waveArea">
                    <div class="wave-host" id="waveHost">
                        <div id="waveformWrap" style="min-height:180px;position:relative;">
                            <div id="waveform"></div>
                            <div id="playhead"></div>
                            <div id="segOverlay" class="seg-overlay-container"></div>
                        </div>
                    </div>
                </div>
                <div class="waveform-controls compact-controls">
                    <button class="btn btn-outline btn-sm" id="btnWSPlay" disabled onclick="_toggleMainPlay()">▶</button>
                    <button class="btn btn-outline btn-sm" id="btnZoomOut" onclick="_zoomWave(-10)">－</button>
                    <input type="range" id="wsZoom" min="40" max="250" value="90" oninput="_onZoomWave(this.value)">
                    <button class="btn btn-outline btn-sm" id="btnZoomIn" onclick="_zoomWave(10)">＋</button>
                    <span id="wsZoomLabel" class="zoom-label">90 px/s</span>
                    <div class="time-display" id="wsTime">00:00 / 00:00</div>
                    <div class="toolbar-spacer"></div>
                    <label class="vol-label">🔊</label>
                    <input type="range" id="wsVol" min="0" max="100" value="100" oninput="_setWSVol(this.value)">
                </div>
                <div class="edit-form-panel" id="segEditPanel">
                    <div class="editor-empty"><div class="empty-icon">📝</div><p>选择唱段查看详情</p></div>
                </div>
            </div>
        </div>
    </div>`;
        editorSong = null;
        editorSegments = [];
        editorActiveIdx = -1;
        editorDirty = false;
        _editorOverlayVersion = '';
        _editorPlayingIdx = -1;
        _editorPlayingBlock = null;
        _updateUnsaved();
        _bindEditorEvents();
        _resetHistory();
        if(editorAudio) {
            editorAudio.pause();
            editorAudio.src = '';
        }
        if(editorWS && editorWS.destroy) {
            editorWS.destroy();
            editorWS = null;
        }
        const songSel = document.getElementById('edSongSel');
        songSel.onchange = () => _loadSong(songSel.value);
        if(songs.length) {
            songSel.value = songs[0].id;
            await _loadSong(songs[0].id);
        }
    } catch(e) {
        container.innerHTML = `<div class="editor-empty"><div class="empty-icon">⚠️</div><p>渲染编辑器失败：${e.message}</p></div>`;
    }
}

function _bindEditorEvents() {
    if(_editorEventsBound) return;
    _editorEventsBound = true;
    window.addEventListener('keydown', async e => {
        const active = document.activeElement;
        const inInput = active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName);
        if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if(e.shiftKey) {
                _redoHistory();
            } else {
                _undoHistory();
            }
        }
        if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && !inInput) {
            e.preventDefault();
            _redoHistory();
        }
        if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            const btn = document.getElementById('btnSaveAll');
            if(btn && !btn.disabled) {
                e.preventDefault();
                await _saveAll();
            }
        }
        if(e.key === 'Escape') {
            _editorHighlightedIdx = -1;
            _renderOverlay();
        }
    });
    window.addEventListener('beforeunload', e => {
        if(editorDirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

function _resetHistory() {
    editorHistory = [];
    editorHistoryIdx = -1;
    _pushHistory('初始状态', true);
}

function _pushHistory(label, replace = false) {
    const snapshot = JSON.stringify(editorSegments);
    if(replace && editorHistory.length) {
        editorHistory[editorHistory.length - 1] = { label, snapshot };
        editorHistoryIdx = editorHistory.length - 1;
        _updateHistoryButtons();
        return;
    }
    if(editorHistoryIdx < editorHistory.length - 1) editorHistory = editorHistory.slice(0, editorHistoryIdx + 1);
    if(editorHistory.length && editorHistory[editorHistory.length - 1].snapshot === snapshot) return;
    editorHistory.push({ label, snapshot });
    if(editorHistory.length > HIST_MAX) editorHistory.shift();
    editorHistoryIdx = editorHistory.length - 1;
    _updateHistoryButtons();
}

function _applyHistory(idx) {
    if(idx < 0 || idx >= editorHistory.length) return;
    editorHistoryIdx = idx;
    editorSegments = JSON.parse(editorHistory[idx].snapshot);
    if(editorActiveIdx >= editorSegments.length) editorActiveIdx = editorSegments.length - 1;
    _markDirty(true, false);
    _renderSegList();
    _renderOverlay();
    _renderEditPanel();
    if(typeof _refreshTimelineScale === 'function') _refreshTimelineScale();
    _updateHistoryButtons();
    showToast(`已${editorHistory[idx].label.includes('撤销') ? '' : ''}恢复：${editorHistory[idx].label}`, 'success');
}

function _undoHistory() {
    if(editorHistoryIdx <= 0) return;
    _applyHistory(editorHistoryIdx - 1);
}

function _redoHistory() {
    if(editorHistoryIdx >= editorHistory.length - 1) return;
    _applyHistory(editorHistoryIdx + 1);
}

function _updateHistoryButtons() {
    const undo = document.getElementById('btnUndo');
    const redo = document.getElementById('btnRedo');
    if(undo) undo.disabled = editorHistoryIdx <= 0;
    if(redo) redo.disabled = editorHistoryIdx >= editorHistory.length - 1;
}

function _markDirty(v = true, pushHistory = true, label = '修改片段') {
    editorDirty = v;
    _updateUnsaved();
    if(v && pushHistory) _pushHistory(label);
}

function _updateUnsaved() {
    const dot = document.getElementById('edUnsaved');
    const saveBtn = document.getElementById('btnSaveAll');
    if(dot) dot.style.display = editorDirty ? 'inline-block' : 'none';
    if(saveBtn) saveBtn.disabled = !editorSong || !editorDirty;
}

async function _loadSong(songId) {
    if(!songId) return;
    if(editorDirty) {
        const ok = await confirmModal('当前有未保存更改，切换歌曲将丢失，是否继续？');
        if(!ok) {
            document.getElementById('edSongSel').value = editorSong?.id || '';
            return;
        }
    }
    try {
        const songRes = await aGet(`/admin/songs/${songId}`);
        editorSong = songRes.data;
        editorSegments = ((editorSong.segments || [])).sort((a,b)=>a.start_time-b.start_time).map(seg => ({ ...seg }));
        editorActiveIdx = editorSegments.length ? 0 : -1;
        editorDirty = false;
        _editorOverlayVersion = '';
        _editorPlayingIdx = -1;
        _editorPlayingBlock = null;
        _updateUnsaved();
        _resetHistory();
        document.getElementById('edSongTitle').textContent = `${editorSong.title} / ${editorSong.artist || '未知歌手'}`;
        document.getElementById('btnAddSeg').disabled = false;
        _renderSegList();
        _renderEditPanel();
        await _initWS(_resolveMediaUrl(editorSong.file_url || editorSong.audio_url || editorSong.file_path || ''));
    } catch(e) {
        showToast(`加载歌曲失败：${e.message}`, 'error');
    }
}

function _ensureEditorAudio() {
    if(editorAudio) return editorAudio;
    editorAudio = new Audio();
    editorAudio.preload = 'auto';
    editorAudio.addEventListener('timeupdate', () => {
        _updatePlayhead();
        _syncWaveTime();
        if(_playingSegOnly && editorSegments[_editorPlayingIdx]) {
            if(editorAudio.currentTime >= editorSegments[_editorPlayingIdx].end_time) {
                if(_loopPlay) {
                    editorAudio.currentTime = editorSegments[_editorPlayingIdx].start_time;
                    editorAudio.play().catch(() => {});
                } else {
                    editorAudio.pause();
                    _playingSegOnly = false;
                    _editorPlayingIdx = -1;
                    if(_editorPlayingBlock) {
                        _editorPlayingBlock.classList.remove('playing');
                        _editorPlayingBlock = null;
                    }
                    _syncPlayButtons();
                }
            }
        }
    });
    editorAudio.addEventListener('play', _syncPlayButtons);
    editorAudio.addEventListener('pause', _syncPlayButtons);
    editorAudio.addEventListener('ended', () => {
        _playingSegOnly = false;
        _editorPlayingIdx = -1;
        if(_editorPlayingBlock) {
            _editorPlayingBlock.classList.remove('playing');
            _editorPlayingBlock = null;
        }
        _syncPlayButtons();
    });
    return editorAudio;
}

async function _initWS(url) {
    const wrap = document.getElementById('waveformWrap');
    const node = document.getElementById('waveform');
    if(!wrap || !node) return;
    if(editorWS && editorWS.destroy) {
        editorWS.destroy();
        editorWS = null;
    }
    node.innerHTML = '';
    const playBtn = document.getElementById('btnWSPlay');
    if(playBtn) playBtn.disabled = true;
    const audio = _ensureEditorAudio();
    if(url) {
        audio.src = url;
        audio.load();
    }
    if(typeof WaveSurfer === 'undefined') {
        _syncWaveMetrics();
        _renderOverlay();
        return;
    }
    try {
        editorWS = WaveSurfer.create({
            container: node,
            url,
            waveColor: '#8fb3ff',
            progressColor: '#4f7cff',
            cursorColor: '#ff6b6b',
            height: 180,
            normalize: true,
            minPxPerSec: +document.getElementById('wsZoom')?.value || 90,
            autoScroll: true,
            hideScrollbar: false
        });
        editorWS.on('ready', () => {
            _syncWaveMetrics();
            _renderOverlay();
            _syncWaveTime();
            _updatePlayhead();
            if(playBtn) playBtn.disabled = false;
            requestAnimationFrame(() => {
                _syncWaveMetrics();
                _renderOverlay();
                _updatePlayhead();
            });
            setTimeout(() => {
                _syncWaveMetrics();
                _renderOverlay();
                _updatePlayhead();
            }, 120);
        });
        editorWS.on('decode', () => {
            _syncWaveMetrics();
            _renderOverlay();
        });
        editorWS.on('scroll', () => {
            _syncWaveMetrics();
            _renderOverlay();
        });
        editorWS.on('zoom', () => {
            _syncWaveMetrics();
            _renderOverlay();
        });
        editorWS.on('interaction', () => {
            const t = editorWS.getCurrentTime();
            audio.currentTime = t;
            _updatePlayhead();
            _syncWaveTime();
        });
    } catch(e) {
        console.warn('WaveSurfer init failed', e);
        _syncWaveMetrics();
        _renderOverlay();
    }
}

function _ensureWaveOverlayHost() {
    const wrap = document.getElementById('waveformWrap');
    if(!wrap) return null;
    let ov = document.getElementById('segOverlay');
    if(!ov) {
        ov = document.createElement('div');
        ov.id = 'segOverlay';
        ov.className = 'seg-overlay-container';
        wrap.appendChild(ov);
    } else if(ov.parentElement !== wrap) {
        wrap.appendChild(ov);
    }
    return ov;
}

function _syncWaveMetrics() {
    const wrap = document.getElementById('waveformWrap');
    const host = document.getElementById('waveHost');
    const ov = _ensureWaveOverlayHost();
    const dur = Number(editorSong?.duration || editorAudio?.duration || editorWS?.getDuration?.() || 0);
    const zoom = +document.getElementById('wsZoom')?.value || 90;
    const viewportWidth = host?.clientWidth || wrap?.clientWidth || 0;
    const calcWidth = dur > 0 ? Math.max(Math.round(dur * zoom), viewportWidth) : viewportWidth;
    const width = Math.max(calcWidth || 0, wrap?.scrollWidth || 0, viewportWidth || 0);
    const height = Math.max(host?.offsetHeight || 0, 180);
    _editorWaveMetrics = { width, height };
    if(wrap) {
        wrap.style.minHeight = `${height}px`;
        wrap.style.width = width ? `${width}px` : '100%';
    }
    if(ov) {
        ov.style.width = width ? `${width}px` : '100%';
        ov.style.height = `${height}px`;
    }
}

function _renderOverlay() {
    const ov = _ensureWaveOverlayHost();
    if(!ov) return;
    const dur = Number(editorSong?.duration || editorAudio?.duration || editorWS?.getDuration?.() || 0);
    if(!dur || !editorSegments.length) {
        ov.innerHTML = '';
        return;
    }
    _syncWaveMetrics();
    const width = _editorWaveMetrics.width || 1;
    const height = _editorWaveMetrics.height || 180;
    ov.style.width = `${width}px`;
    ov.style.height = `${height}px`;
    const version = `${editorSegments.length}|${editorActiveIdx}|${_editorHighlightedIdx}|${_editorPlayingIdx}|${width}|${height}|${editorSegments.map(s => `${s.start_time}-${s.end_time}-${s.difficulty || ''}-${s.is_chorus ? 1 : 0}`).join(';')}`;
    if(version === _editorOverlayVersion) return;
    _editorOverlayVersion = version;
    ov.innerHTML = '';
    const blocks = [];
    editorSegments.forEach((seg, idx) => {
        const left = Math.max(0, (seg.start_time / dur) * width);
        const segWidth = Math.max(8, ((seg.end_time - seg.start_time) / dur) * width);
        const block = document.createElement('button');
        const laneCount = Math.max(1, Math.min(3, Math.ceil(height / 44)));
        const lane = idx % laneCount;
        const blockHeight = 28;
        const top = Math.max(10, Math.min(height - blockHeight - 10, 12 + lane * 36));
        block.type = 'button';
        block.className = `seg-block diff-${seg.difficulty || 'normal'}${seg.is_chorus ? ' is-chorus' : ''}${idx === editorActiveIdx ? ' active' : ''}${idx === _editorHighlightedIdx ? ' hover' : ''}${idx === _editorPlayingIdx ? ' playing' : ''}`;
        block.style.left = `${left}px`;
        block.style.width = `${segWidth}px`;
        block.style.top = `${top}px`;
        block.style.height = `${blockHeight}px`;
        block.style.zIndex = '55';
        block.textContent = `${idx + 1}`;
        block.title = `${seg.lyrics || `唱段 ${idx + 1}`} ${seg.start_time.toFixed(1)}s - ${seg.end_time.toFixed(1)}s`;
        block.onmouseenter = () => {
            _editorHighlightedIdx = idx;
            _editorOverlayVersion = '';
            _renderOverlay();
        };
        block.onmouseleave = () => {
            if(_editorHighlightedIdx === idx) {
                _editorHighlightedIdx = -1;
                _editorOverlayVersion = '';
                _renderOverlay();
            }
        };
        block.onclick = () => _selectSeg(idx, true);
        blocks.push(block);
        ov.appendChild(block);
    });
    if(_editorPlayingIdx >= 0) _editorPlayingBlock = blocks[_editorPlayingIdx] || null;
}


function _renderSegList() {
    const body = document.getElementById('segListBody');
    const count = document.getElementById('segCount');
    if(count) count.textContent = `${editorSegments.length} 段`;
    if(!body) return;
    if(!editorSong) {
        body.innerHTML = `<div class="editor-empty"><div class="empty-icon">✂️</div><p>选择歌曲</p></div>`;
        return;
    }
    if(!editorSegments.length) {
        body.innerHTML = `<div class="editor-empty"><div class="empty-icon">🧩</div><p>暂无唱段，点击右上角“新增”创建</p></div>`;
        return;
    }
    body.innerHTML = editorSegments.map((seg, i) => {
        return `<div class="seg-card ${i===editorActiveIdx?'active':''} ${seg.is_chorus?'chorus-seg':''}" onclick="_selectSeg(${i})">
            <div class="seg-card-top">
                <div class="seg-card-idx">${i + 1}</div>
                <div class="seg-card-lyrics">${seg.lyrics || '未填写歌词'}</div>
                <div class="seg-card-badges">
                    <span class="badge seg-diff-${seg.difficulty || 'normal'}">${seg.difficulty || 'normal'}</span>
                    ${seg.is_chorus?'<span class="badge badge-chorus">合唱</span>':''}
                </div>
            </div>
            <div class="seg-card-time">
                <input type="number" step="0.1" value="${seg.start_time.toFixed(1)}" data-idx="${i}" data-field="start_time"
                    onchange="_onTimeInput(this)" onclick="event.stopPropagation()">
                <span class="time-sep">→</span>
                <input type="number" step="0.1" value="${seg.end_time.toFixed(1)}" data-idx="${i}" data-field="end_time"
                    onchange="_onTimeInput(this)" onclick="event.stopPropagation()">
                <div class="seg-card-actions">
                    <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();_playSeg(${i})" title="试听">${_editorPlayingIdx === i && !editorAudio?.paused ? '⏸' : '▶'}</button>
                    <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();_editSegModal(${i})" title="编辑">✏️</button>
                    <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();_deleteSegment(${i})" title="删除">🗑</button>
                </div>
            </div>
        </div>`;
    }).join('');
}


function _renderEditPanel() {
    const panel = document.getElementById('segEditPanel');
    if(!panel) return;
    if(editorActiveIdx < 0 || !editorSegments[editorActiveIdx]) {
        panel.innerHTML = `<div class="editor-empty"><div class="empty-icon">📝</div><p>选择唱段查看详情</p></div>`;
        return;
    }
    const seg = editorSegments[editorActiveIdx];
    panel.innerHTML = `<div class="edit-form-panel-header">
        <div>
            <div class="edit-form-title">唱段 ${editorActiveIdx + 1}</div>
            <div class="edit-form-subtitle">${seg.start_time.toFixed(1)}s - ${seg.end_time.toFixed(1)}s</div>
        </div>
        <button class="btn btn-outline btn-sm" onclick="_editSegModal(${editorActiveIdx})" type="button">弹窗编辑</button>
    </div>
    <div class="edit-form">
        <div class="form-row">
            <label>标签</label>
            <input id="edLabel" value="${seg.label || ''}" oninput="_patchActiveField('label', this.value)">
        </div>
        <div class="form-row two-cols">
            <div>
                <label>开始时间</label>
                <input type="number" step="0.1" id="edStart" value="${seg.start_time.toFixed(1)}" oninput="_patchActiveField('start_time', +this.value)">
            </div>
            <div>
                <label>结束时间</label>
                <input type="number" step="0.1" id="edEnd" value="${seg.end_time.toFixed(1)}" oninput="_patchActiveField('end_time', +this.value)">
            </div>
        </div>
        <div class="form-row two-cols">
            <div>
                <label>角色</label>
                <select id="edRole" onchange="_patchActiveField('role', this.value)">
                    ${['lead','support','chorus'].map(r => `<option value="${r}" ${seg.role===r?'selected':''}>${r}</option>`).join('')}
                </select>
            </div>
            <div>
                <label>合唱</label>
                <label class="checkbox-inline"><input type="checkbox" id="edChorus" ${seg.is_chorus?'checked':''} onchange="_patchActiveField('is_chorus', this.checked)"> 参与合唱</label>
            </div>
        </div>
        <div class="form-row">
            <label>歌词</label>
            <textarea id="edLyrics" rows="6" oninput="_patchActiveField('lyrics', this.value)">${seg.lyrics || ''}</textarea>
        </div>
    </div>`;
}

function _patchActiveField(field, value) {
    if(editorActiveIdx < 0 || !editorSegments[editorActiveIdx]) return;
    const seg = editorSegments[editorActiveIdx];
    if(field === 'start_time' || field === 'end_time') {
        value = Number(value);
        if(Number.isNaN(value)) return;
    }
    seg[field] = value;
    if(field === 'start_time' && seg.end_time - seg.start_time < SEG_MIN_DUR) seg.end_time = seg.start_time + SEG_MIN_DUR;
    if(field === 'end_time' && seg.end_time - seg.start_time < SEG_MIN_DUR) seg.start_time = seg.end_time - SEG_MIN_DUR;
    _markDirty(true, true, `编辑${field}`);
    _renderSegList();
    _renderOverlay();
    if(typeof _refreshTimelineScale === 'function') _refreshTimelineScale();
}

function _onTimeInput(el) {
    const idx = +el.dataset.idx;
    const field = el.dataset.field;
    if(!editorSegments[idx]) return;
    let value = Number(el.value);
    if(Number.isNaN(value)) return;
    editorSegments[idx][field] = value;
    if(field === 'start_time' && editorSegments[idx].end_time - value < SEG_MIN_DUR) {
        editorSegments[idx].end_time = value + SEG_MIN_DUR;
    }
    if(field === 'end_time' && value - editorSegments[idx].start_time < SEG_MIN_DUR) {
        editorSegments[idx].start_time = value - SEG_MIN_DUR;
    }
    _markDirty(true, true, `调整${field}`);
    if(idx === editorActiveIdx) _renderEditPanel();
    _renderSegList();
    _renderOverlay();
}

function _selectSeg(idx, seek = true) {
    if(editorActiveIdx === idx) {
        if(seek && idx>=0 && editorAudio) editorAudio.currentTime = editorSegments[idx].start_time;
        return;
    }
    editorActiveIdx = idx;
    _editorHighlightedIdx = idx;
    _renderSegList();
    _renderOverlay();
    _renderEditPanel();
    if(seek && idx>=0 && editorAudio) editorAudio.currentTime = editorSegments[idx].start_time;
}

function _formatEditorTime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function _syncWaveTime() {
    const timeEl = document.getElementById('wsTime');
    if(!timeEl) return;
    const current = editorAudio?.currentTime || editorWS?.getCurrentTime?.() || 0;
    const duration = editorAudio?.duration || editorWS?.getDuration?.() || editorSong?.duration || 0;
    timeEl.textContent = `${_formatEditorTime(current)} / ${_formatEditorTime(duration)}`;
}

function _syncPlayButtons() {
    const audio = _ensureEditorAudio();
    const mainBtn = document.getElementById('btnWSPlay');
    if(mainBtn) {
        mainBtn.textContent = audio.paused ? '▶' : '⏸';
        mainBtn.disabled = !editorSong;
    }
    document.querySelectorAll('.seg-card').forEach((card, i) => {
        const btn = card.querySelector('.seg-card-actions .btn-outline');
        if(btn) btn.textContent = _playingSegOnly && _editorPlayingIdx === i && !audio.paused ? '⏸' : '▶';
    });
}

function _updatePlayhead() {
    const playhead = document.getElementById('playhead');
    const wrap = document.getElementById('waveformWrap');
    if(!playhead || !wrap) return;
    const duration = editorAudio?.duration || editorWS?.getDuration?.() || editorSong?.duration || 0;
    const current = editorAudio?.currentTime || 0;
    const width = _editorWaveMetrics.width || wrap.scrollWidth || wrap.clientWidth || 0;
    playhead.style.position = 'absolute';
    playhead.style.top = '0';
    playhead.style.bottom = '0';
    playhead.style.width = '2px';
    playhead.style.background = '#ff4d4f';
    playhead.style.zIndex = '40';
    playhead.style.pointerEvents = 'none';
    playhead.style.left = duration > 0 ? `${Math.max(0, Math.min(width, current / duration * width))}px` : '0px';
}

function _setWSVol(value) {
    const audio = _ensureEditorAudio();
    audio.volume = Math.max(0, Math.min(1, (+value || 0) / 100));
}

function _onZoomWave(value) {
    const zoom = Math.max(40, Math.min(250, +value || 90));
    const input = document.getElementById('wsZoom');
    const label = document.getElementById('wsZoomLabel');
    if(input && +input.value !== zoom) input.value = String(zoom);
    if(label) label.textContent = `${zoom} px/s`;
    if(editorWS?.zoom) {
        try { editorWS.zoom(zoom); } catch(_) {}
    }
    _editorOverlayVersion = '';
    _syncWaveMetrics();
    _renderOverlay();
    _updatePlayhead();
}

function _zoomWave(delta) {
    const input = document.getElementById('wsZoom');
    const next = (+input?.value || 90) + delta;
    _onZoomWave(next);
}

function _toggleMainPlay() {
    if(!editorSong) return false;
    const audio = _ensureEditorAudio();
    if(audio.paused) {
        const p = audio.play();
        if(p && typeof p.catch === 'function') p.catch(() => {});
    } else {
        _playingSegOnly = false;
        _editorPlayingIdx = -1;
        _editorPlayingBlock?.classList.remove('playing');
        _editorPlayingBlock = null;
        audio.pause();
    }
    _syncPlayButtons();
    return false;
}

function _highlightAtTime() {
    return;
}

function _playSeg(idx) {
    if(!editorSegments[idx] || !editorSong) return false;
    const audio = _ensureEditorAudio();
    const currentSeg = editorSegments[idx];
    if(_playingSegOnly && _editorPlayingIdx === idx && !audio.paused) {
        _playingSegOnly = false;
        _editorPlayingIdx = -1;
        _editorPlayingBlock?.classList.remove('playing');
        _editorPlayingBlock = null;
        audio.pause();
        _syncPlayButtons();
        return false;
    }
    if(_editorPlayingBlock) {
        _editorPlayingBlock.classList.remove('playing');
        _editorPlayingBlock = null;
    }
    _selectSeg(idx, false);
    _playingSegOnly = true;
    const ov = document.getElementById('segOverlay');
    const blocks = ov ? Array.from(ov.children) : [];
    _editorPlayingIdx = idx;
    _editorPlayingBlock = blocks[idx] || null;
    if(_editorPlayingBlock) _editorPlayingBlock.classList.add('playing');
    audio.pause();
    audio.currentTime = currentSeg.start_time;
    audio.volume = (+document.getElementById('wsVol')?.value || 0) / 100;
    _syncPlayButtons();
    const p = audio.play();
    if(p && typeof p.catch === 'function') p.catch(() => {});
    return false;
}

