// ===== 分段编辑器模块 - Part1: 状态/渲染/波形 =====
let editorWS = null, editorSong = null, editorSegments = [], editorActiveIdx = -1;
let editorAudio = null, _editorAudioRAF = 0;
let editorDirty = false, editorHistory = [], editorHistoryIdx = -1;
const HIST_MAX = 20, SEG_MIN_DUR = 0.5;
let _loopPlay = false, _playingSegOnly = false;
let _editorEventsBound = false, _editorHighlightedIdx = -1, _editorPlayingIdx = -1;
let _editorOverlayVersion = '';
let _editorPlayingBlock = null;
let _editorWaveMetrics = { width: 0, height: 180 };

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
                            <div class="editor-empty" style="height:180px;"><p>选择歌曲加载波形</p></div>
                        </div>
                        <div class="seg-overlay-container" id="segOverlay"></div>
                    </div>
                </div>
            </div>
        </div>
        <div class="editor-playbar" id="edPlaybar">
            <button class="btn btn-outline btn-sm" id="btnPlay" disabled>▶</button>
            <button class="btn btn-outline btn-sm" id="btnLoop" disabled title="循环选中段">🔁</button>
            <span class="playbar-time" id="pbTime">0:00 / 0:00</span>
            <div class="playbar-progress" id="pbProgress"><div class="playbar-progress-fill" id="pbFill"></div></div>
            <div class="zoom-control"><span>缩放</span><input type="range" id="wsZoom" min="10" max="200" value="50"></div>
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

function _stopEditorAudio(resetPlaybar = false) {
    if(_editorAudioRAF) {
        cancelAnimationFrame(_editorAudioRAF);
        _editorAudioRAF = 0;
    }
    if(editorAudio) {
        editorAudio.pause();
        editorAudio.onplay = null;
        editorAudio.onpause = null;
        editorAudio.onended = null;
        editorAudio.ontimeupdate = null;
        editorAudio = null;
    }
    document.getElementById('btnPlay')?.textContent = '▶';
    _playingSegOnly = false;
    _editorPlayingIdx = -1;
    _editorPlayingBlock?.classList.remove('playing');
    _editorPlayingBlock = null;
    if(resetPlaybar) _updatePlaybar(0);
}

function _tickEditorAudio() {
    if(!editorAudio) return;
    _updatePlaybar(editorAudio.currentTime || 0);
    if(_playingSegOnly && editorActiveIdx>=0) {
        const seg = editorSegments[editorActiveIdx];
        if(seg && editorAudio.currentTime >= seg.end_time) {
            if(_loopPlay) {
                editorAudio.currentTime = seg.start_time;
            } else {
                editorAudio.pause();
                return;
            }
        }
    }
    _editorAudioRAF = requestAnimationFrame(_tickEditorAudio);
}

function _ensureEditorAudio() {
    const url = `${API.replace('/api','')}${editorSong.audio_url}`;
    if(editorAudio?.src === url) return editorAudio;
    _stopEditorAudio(false);
    editorAudio = new Audio(url);
    editorAudio.preload = 'auto';
    editorAudio.addEventListener('play', () => {
        document.getElementById('btnPlay').textContent = '⏸';
        if(!_editorAudioRAF) _tickEditorAudio();
    });
    editorAudio.addEventListener('pause', () => {
        document.getElementById('btnPlay').textContent = '▶';
        if(_editorAudioRAF) {
            cancelAnimationFrame(_editorAudioRAF);
            _editorAudioRAF = 0;
        }
        _playingSegOnly = false;
    });
    editorAudio.addEventListener('ended', () => {
        document.getElementById('btnPlay').textContent = '▶';
        if(_editorAudioRAF) {
            cancelAnimationFrame(_editorAudioRAF);
            _editorAudioRAF = 0;
        }
        _playingSegOnly = false;
        _updatePlaybar(editorAudio?.duration || 0);
    });
    return editorAudio;
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
    return ov;
}

function _syncWaveMetrics() {
    const wrap = document.getElementById('waveformWrap');
    const host = document.getElementById('waveHost');
    const ov = document.getElementById('segOverlay');
    if(!wrap || !host || !ov) return;
    const width = Math.max(wrap.scrollWidth, wrap.clientWidth, 1);
    const height = Math.max(wrap.offsetHeight, 180);
    if(width === _editorWaveMetrics.width && height === _editorWaveMetrics.height) return;
    _editorWaveMetrics = { width, height };
    host.style.width = width + 'px';
    host.style.height = height + 'px';
    ov.style.width = width + 'px';
    ov.style.height = height + 'px';
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
    const left = (seg.start_time / dur) * 100;
    const width = ((seg.end_time - seg.start_time) / dur) * 100;
    el.dataset.idx = String(i);
    el.style.left = `${left}%`;
    el.style.width = `${width}%`;
    el.className = `seg-block diff-${seg.difficulty} ${seg.is_chorus?'is-chorus':''} ${i===editorActiveIdx?'active':''} ${i===_editorPlayingIdx?'playing':''}`.trim();
    const label = el.querySelector('.seg-block-label');
    if(label) label.textContent = seg.index;
    const leftHandle = el.querySelector('.seg-handle-left');
    const rightHandle = el.querySelector('.seg-handle-right');
    if(leftHandle) leftHandle.dataset.idx = String(i);
    if(rightHandle) rightHandle.dataset.idx = String(i);
}

// ===== 事件绑定 =====
function _bindEditorEvents() {

    const $ = id => document.getElementById(id);
    $('edSongSel').onchange = () => _loadSong($('edSongSel').value);
    $('btnPlay').onclick = async () => {
        if(!editorSong) return;
        const audio = _ensureEditorAudio();
        if(audio.paused) {
            try {
                audio.volume = (+$('wsVol').value || 0) / 100;
                await audio.play();
            } catch(e) {}
        } else {
            audio.pause();
        }
    };
    $('btnLoop').onclick = () => { _loopPlay = !_loopPlay; $('btnLoop').classList.toggle('btn-primary', _loopPlay); $('btnLoop').classList.toggle('btn-outline', !_loopPlay); };
    $('wsZoom').oninput = () => {};
    $('wsVol').oninput = e => {
        if(editorAudio) editorAudio.volume = +e.target.value/100;
    };
    $('btnUndo').onclick = edUndo;
    $('btnRedo').onclick = edRedo;
    $('btnAddSeg').onclick = _addSegAtCursor;
    $('btnSaveAll').onclick = _saveAll;
    $('pbProgress').onclick = e => {
        if(!editorAudio) return;
        const r = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - r.left) / r.width;
        const audio = _ensureEditorAudio();
        const dur = audio.duration || editorSong?.duration || 0;
        if(dur) {
            audio.currentTime = Math.max(0, Math.min(dur, ratio * dur));
            _updatePlaybar(audio.currentTime);
        }
    };
    if(!_editorEventsBound) {
        document.addEventListener('keydown', _edKeydown);
        document.addEventListener('click', _hideCtx);
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
        _editorWaveMetrics = { width: 0, height: 180 };
        editorDirty = false;
        editorHistory = []; editorHistoryIdx = -1;
        _pushHistory();
        document.getElementById('edSongTitle').textContent = `${editorSong.title} - ${editorSong.artist}`;
        document.getElementById('edUnsaved').style.display = 'none';
        document.getElementById('btnAddSeg').disabled = false;
        document.getElementById('btnSaveAll').disabled = false;
        document.getElementById('btnPlay').disabled = false;
        document.getElementById('btnLoop').disabled = false;
        _initWS();
        _renderSegList();
    } catch(e) { showToast(e.message,'error'); }
}

// ===== WaveSurfer 初始化 =====
function _initWS() {
    if(editorWS) { editorWS.destroy(); editorWS = null; }
    _stopEditorAudio(true);
    const wrap = document.getElementById('waveformWrap');
    wrap.innerHTML = '<div class="loading" style="padding:60px;">加载波形中</div>';
    _editorOverlayVersion = '';
    const url = `${API.replace('/api','')}${editorSong.audio_url}`;

    if(typeof WaveSurfer === 'undefined' || !WaveSurfer?.create) {
        wrap.innerHTML = '<div class="editor-empty" style="height:180px;"><p>波形组件加载失败，请刷新页面重试</p></div>';
        _ensureWaveOverlayHost();
        _ensureEditorAudio();
        _updatePlaybar(0);
        return;
    }

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
        console.error('WaveSurfer init failed:', e);
        wrap.innerHTML = `<div class="editor-empty" style="height:180px;"><p>波形初始化失败：${e.message}</p></div>`;
        _ensureWaveOverlayHost();
        _ensureEditorAudio();
        _updatePlaybar(0);
        return;
    }

    editorWS.on('ready', () => {
        wrap.querySelector('.loading')?.remove();
        _ensureWaveOverlayHost();
        editorWS.setMuted?.(true);
        _syncWaveMetrics();
        _renderOverlay();
        _ensureEditorAudio();
        _updatePlaybar(0);
    });
    editorWS.on('error', err => {
        console.error('WaveSurfer error:', err);
        wrap.innerHTML = '<div class="editor-empty" style="height:180px;"><p>波形加载失败，但仍可继续编辑唱段</p></div>';
        _ensureWaveOverlayHost();
        _ensureEditorAudio();
        _updatePlaybar(0);
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
        return;
    }
    body.innerHTML = editorSegments.map((seg,i) => {
        const ac = i===editorActiveIdx ? 'active' : '';
        const ch = seg.is_chorus ? 'chorus-seg' : '';
        return `<div class="seg-card ${ac} ${ch}" data-idx="${i}" onclick="_selectSeg(${i})" oncontextmenu="event.preventDefault();_showCtx(event,${i})">
            <div class="seg-card-top">
                <div class="seg-card-idx seg-diff-${seg.difficulty}">${seg.index}</div>
                <div class="seg-card-lyrics">${seg.lyrics||'(空)'}</div>
                <div class="seg-card-badges">
                    <span class="badge badge-${seg.difficulty}">${seg.difficulty}</span>
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
                    <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();_playSeg(${i})" title="试听">▶</button>
                    <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();_editSegModal(${i})" title="编辑">✏️</button>
                    <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();_deleteSegment(${i})" title="删除">🗑</button>
                </div>
            </div>
        </div>`;
    }).join('');
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
    if(seek && idx>=0 && editorAudio) editorAudio.currentTime = editorSegments[idx].start_time;
}

function _highlightAtTime() {
    return;
}

function _playSeg(idx) {
    if(!editorSegments[idx] || !editorSong) return;
    _selectSeg(idx, false);
    _playingSegOnly = true;
    const audio = _ensureEditorAudio();
    audio.currentTime = editorSegments[idx].start_time;
    audio.volume = (+document.getElementById('wsVol')?.value || 0) / 100;
    audio.play().catch(() => {});
}
