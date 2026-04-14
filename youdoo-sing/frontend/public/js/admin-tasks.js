// ===== 任务管理模块 =====
let _taskSongs = [];
let _taskAllSegs = [];
let _taskSelectedSegId = null;
let _taskSelectedIsChorus = false;

async function renderTasks(container) {
    try {
        const songsRes = await aGet('/admin/songs');
        _taskSongs = songsRes.data;
        container.innerHTML = `
        <div class="editor-toolbar" style="margin-bottom:16px;">
            <label style="font-weight:600;font-size:13px;">选择歌曲：</label>
            <select id="taskSongSelect">
                <option value="">-- 全部 --</option>
                ${_taskSongs.map(s => `<option value="${s.id}">${s.title} - ${s.artist}</option>`).join('')}
            </select>
            <span id="taskFilterInfo" style="font-size:12px;color:var(--text-secondary);"></span>
        </div>
        <div class="card">
            <div class="card-header"><h3>唱段任务</h3><span id="taskSegHint" style="font-size:12px;color:var(--text-light);">点击行查看录音</span></div>
            <div class="card-body" style="padding:0;">
                <div class="table-wrap"><table id="taskTable">
                    <thead><tr><th>#</th><th>歌曲</th><th>歌词</th><th>类型</th><th>时间</th><th>难度</th><th>认领</th><th>录音</th><th>操作</th></tr></thead>
                    <tbody id="taskTableBody"></tbody>
                </table></div>
            </div>
        </div>
        <div class="card" style="margin-top:20px;">
            <div class="card-header"><h3 id="recTableTitle">录音提交</h3><span id="recTableHint" style="font-size:12px;color:var(--text-light);">请先选择上方唱段</span></div>
            <div class="card-body" style="padding:0;">
                <div class="table-wrap"><table>
                    <thead><tr>
                        <th>用户名</th><th>提交时间</th>
                        <th>音准</th><th>音量</th><th>节奏</th><th>音色</th><th>综合</th>
                        <th>已选定</th><th>操作</th>
                    </tr></thead>
                    <tbody id="recTableBody"></tbody>
                </table></div>
            </div>
        </div>`;
        document.getElementById('taskSongSelect').addEventListener('change', () => {
            _taskSelectedSegId = null;
            loadTaskSegments();
        });
        loadTaskSegments();
    } catch (e) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`; }
}

async function loadTaskSegments() {
    const songId = document.getElementById('taskSongSelect').value;
    try {
        _taskAllSegs = [];
        const filteredSongs = songId ? _taskSongs.filter(s => s.id === songId) : _taskSongs;
        for (const s of filteredSongs) {
            const r = await aGet(`/admin/songs/${s.id}`);
            (r.data.segments || []).forEach(seg => _taskAllSegs.push({ ...seg, songTitle: s.title, songId: s.id }));
        }
        const tbody = document.getElementById('taskTableBody');
        document.getElementById('taskFilterInfo').textContent = `${_taskAllSegs.length} 个唱段`;

        tbody.innerHTML = _taskAllSegs.map(seg => {
            const isActive = seg.id === _taskSelectedSegId;
            return `<tr class="task-seg-row${isActive ? ' task-seg-active' : ''}" data-seg-id="${seg.id}" data-is-chorus="${seg.is_chorus ? '1' : '0'}">
            <td>${seg.index}</td>
            <td>${seg.songTitle}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${seg.lyrics||'--'}</td>
            <td>${seg.is_chorus ? '<span class="badge badge-chorus">合唱</span>' : '<span class="badge badge-unassigned">独唱</span>'}</td>
            <td style="font-family:monospace;font-size:12px;">${fmtTimePrecise(seg.start_time)}→${fmtTimePrecise(seg.end_time)}</td>
            <td><span class="badge badge-${seg.difficulty}">${seg.difficulty}</span></td>
            <td>${seg.claim_count||0} 人</td>
            <td>${(seg.recordings||[]).length} 条</td>
            <td>
                ${seg.status==='completed'
                    ?`<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();reopenSegment('${seg.id}')">重新解锁</button>`
                    :`<button class="btn btn-success btn-sm" onclick="event.stopPropagation();markComplete('${seg.id}')" ${(seg.recordings||[]).filter(r=>r.submitted).length === 0 ? 'disabled title="需有提交录音才能完成锁定"' : ''}>完成锁定</button>`
                }
            </td>
        </tr>`;
        }).join('') || '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-light);">暂无数据</td></tr>';

        // 绑定行点击
        tbody.querySelectorAll('.task-seg-row').forEach(row => {
            row.addEventListener('click', () => {
                const segId = row.dataset.segId;
                const isChorus = row.dataset.isChorus === '1';
                // 切换选中
                if (_taskSelectedSegId === segId) {
                    _taskSelectedSegId = null;
                    _taskSelectedIsChorus = false;
                    tbody.querySelectorAll('.task-seg-row').forEach(r => r.classList.remove('task-seg-active'));
                    clearRecTable();
                } else {
                    _taskSelectedSegId = segId;
                    _taskSelectedIsChorus = isChorus;
                    tbody.querySelectorAll('.task-seg-row').forEach(r => r.classList.toggle('task-seg-active', r.dataset.segId === segId));
                    loadRecordingsForSeg(segId, isChorus);
                }
            });
        });

        // 如果有选中的唱段，刷新录音
        if (_taskSelectedSegId) {
            const seg = _taskAllSegs.find(s => s.id === _taskSelectedSegId);
            if (seg) loadRecordingsForSeg(_taskSelectedSegId, seg.is_chorus);
            else clearRecTable();
        } else {
            clearRecTable();
        }
    } catch (e) { showToast(e.message, 'error'); }
}

function clearRecTable() {
    const recBody = document.getElementById('recTableBody');
    if (recBody) recBody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-light);">请先选择上方唱段查看录音</td></tr>';
    const hint = document.getElementById('recTableHint');
    if (hint) hint.textContent = '请先选择上方唱段';
    const title = document.getElementById('recTableTitle');
    if (title) title.textContent = '录音提交';
}

async function loadRecordingsForSeg(segId, isChorus) {
    try {
        // 找到对应唱段获取 songId
        const seg = _taskAllSegs.find(s => s.id === segId);
        if (!seg) return;

        const recRes = await aGet(`/admin/recordings?song_id=${seg.songId}`);
        const allRecs = recRes.data || [];
        const recs = allRecs.filter(r => r.segment_id === segId && r.submitted);

        const title = document.getElementById('recTableTitle');
        if (title) title.textContent = `录音提交 — ${seg.lyrics || '唱段' + seg.index}`;
        const hint = document.getElementById('recTableHint');
        if (hint) hint.textContent = `${recs.length} 条录音${isChorus ? ' · 合唱' : ' · 独唱'}`;

        const recBody = document.getElementById('recTableBody');
        // 销毁旧波形
        _destroyTaskWS();

        recBody.innerHTML = recs.map((r, i) => {
            const d = r.score_detail?.dimensions || {};
            const pitchScore = d.pitch?.score ?? '--';
            const volumeScore = d.volume?.score ?? '--';
            const rhythmScore = d.rhythm?.score ?? '--';
            const toneScore = d.tone?.score ?? '--';
            const composite = r.score_detail?.composite ?? '--';
            return `<tr>
            <td>${r.user_name}</td>
            <td style="font-size:12px;color:var(--text-secondary);font-family:monospace;">${_fmtDateTime(r.created_at)}</td>
            <td class="score-cell">${_fmtScore(pitchScore)}</td>
            <td class="score-cell">${_fmtScore(volumeScore)}</td>
            <td class="score-cell">${_fmtScore(rhythmScore)}</td>
            <td class="score-cell">${_fmtScore(toneScore)}</td>
            <td class="score-cell score-composite">${_fmtScore(composite)}</td>
            <td>${r.selected ? '<span class="badge badge-completed">已选定</span>' : '<span style="color:var(--text-light);">--</span>'}</td>
            <td style="white-space:nowrap;">
                <div style="display:inline-flex;align-items:center;gap:6px;">
                    <div class="rec-wave-mini" id="taskRecWave${i}" style="height:28px;min-width:120px;border-radius:4px;overflow:hidden;"></div>
                    <button class="btn btn-outline btn-sm" onclick="playTaskRec(${i},this)">▶</button>
                    ${_renderSelectBtn(r, isChorus, recs)}
                    <button class="btn btn-danger btn-sm" onclick="deleteRecording('${r.id}')">删除</button>
                </div>
            </td>
        </tr>`;
        }).join('') || '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-light);">该唱段暂无已提交录音</td></tr>';

        // 初始化波形
        _initTaskWaveSurfers(recs);
    } catch (e) { showToast(e.message, 'error'); }
}

function _renderSelectBtn(rec, isChorus, allRecs) {
    if (rec.selected) {
        return `<button class="btn btn-warning btn-sm" onclick="unselectRecording('${rec.id}')">取消选定</button>`;
    }
    // 独唱：已有其他选定时不可再选
    if (!isChorus) {
        const hasSelected = allRecs.some(r => r.selected);
        if (hasSelected) {
            return `<button class="btn btn-outline btn-sm" disabled title="独唱唱段只能选定一条录音">选定</button>`;
        }
    }
    return `<button class="btn btn-success btn-sm" onclick="selectRecording('${rec.id}')">选定</button>`;
}

function _fmtScore(val) {
    if (val === '--' || val == null) return '<span style="color:var(--text-light);">--</span>';
    const n = Number(val);
    let cls = '';
    if (n >= 80) cls = 'score-high';
    else if (n >= 60) cls = 'score-mid';
    else cls = 'score-low';
    return `<span class="score-val ${cls}">${n}</span>`;
}

function _fmtDateTime(dt) {
    if (!dt) return '--';
    try {
        const d = new Date(dt);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return dt; }
}

function _destroyTaskWS() {
    if (window._taskRecWS) {
        window._taskRecWS.forEach(ws => { try { ws.destroy(); } catch(e){} });
    }
    window._taskRecWS = [];
    _taskPlayingIdx = -1;
}

function _initTaskWaveSurfers(recs) {
    window._taskRecWS = [];
    recs.forEach((r, i) => {
        const el = document.getElementById(`taskRecWave${i}`);
        if (!el || typeof WaveSurfer === 'undefined') return;
        const audioUrl = `${API.replace('/api', '')}${r.audio_url}`;
        const ws = WaveSurfer.create({
            container: el,
            waveColor: 'rgba(100,116,139,0.4)',
            progressColor: '#4f46e5',
            cursorWidth: 0,
            height: 28,
            barWidth: 2,
            barGap: 1,
            barRadius: 1,
            normalize: true,
            interact: false,
            hideScrollbar: true,
            url: audioUrl,
        });
        ws._recData = r;
        window._taskRecWS[i] = ws;
    });
}

async function markComplete(segId) {
    try {
        await aPost(`/admin/segments/${segId}/complete`, new FormData());
        showToast('已标记完成', 'success');
        loadTaskSegments();
    } catch (e) { showToast(e.message, 'error'); }
}

async function reopenSegment(segId) {
    try {
        await aPost(`/admin/segments/${segId}/reopen`, new FormData());
        showToast('已重新开放', 'success');
        loadTaskSegments();
    } catch (e) { showToast(e.message, 'error'); }
}

let _taskPlayingIdx = -1;
function playTaskRec(idx, btn) {
    if (_taskPlayingIdx >= 0 && window._taskRecWS[_taskPlayingIdx]) {
        const prev = window._taskRecWS[_taskPlayingIdx];
        if (prev.isPlaying()) prev.stop();
        const prevBtn = document.querySelector(`#taskRecWave${_taskPlayingIdx}`)?.closest('td')?.querySelector('.btn-outline');
        if (prevBtn) prevBtn.textContent = '▶';
    }

    const ws = window._taskRecWS[idx];
    if (!ws) { showToast('波形未就绪'); return; }

    if (_taskPlayingIdx === idx && ws.isPlaying()) {
        ws.stop();
        btn.textContent = '▶';
        _taskPlayingIdx = -1;
        return;
    }

    ws.un('finish');
    ws.on('finish', () => {
        btn.textContent = '▶';
        _taskPlayingIdx = -1;
    });
    ws.play();
    btn.textContent = '⏹';
    _taskPlayingIdx = idx;
}

async function selectRecording(recId) {
    try {
        await aPost(`/admin/recordings/${recId}/select`, {});
        showToast('已选定', 'success');
        if (_taskSelectedSegId) loadRecordingsForSeg(_taskSelectedSegId, _taskSelectedIsChorus);
        else loadTaskSegments();
    } catch (e) { showToast(e.message, 'error'); }
}

async function unselectRecording(recId) {
    try {
        await aPost(`/admin/recordings/${recId}/unselect`, {});
        showToast('已取消选定', 'success');
        if (_taskSelectedSegId) loadRecordingsForSeg(_taskSelectedSegId, _taskSelectedIsChorus);
        else loadTaskSegments();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteRecording(recId) {
    if (!confirm('确定删除该录音？此操作不可恢复。')) return;
    try {
        await aDel(`/admin/recordings/${recId}`);
        showToast('已删除', 'success');
        loadTaskSegments();
    } catch (e) { showToast(e.message, 'error'); }
}

// ===== 合成导出模块 =====
let _expSong = null;       // 当前选中歌曲完整数据
let _expSegs = [];          // 唱段列表（含 recordings）
let _expActiveSegIdx = -1;  // 当前选中唱段索引，-1 表示未选中
let _expWS = null;          // 主波形 WaveSurfer
let _expAudio = null;       // 伴奏 Audio 元素
let _expRecAudios = [];     // 已选定录音 Audio 对象（同步播放）
let _expRecWS = [];         // 底部录音卡片 WaveSurfer 实例
let _expMiniWS = [];        // 迷你胶囊 WaveSurfer 实例
let _expPlayingRecIdx = -1; // 正在播放的录音索引
let _expIsPlaying = false;
let _expRAF = 0;
let _expAccUrl = null;      // 伴奏URL（检测通过后设置）

const EXP_SEG_COLORS = ['#10b981','#3b82f6','#f59e0b','#8b5cf6','#ec4899','#06b6d4'];
const EXP_MIN_SEG_PX = 90; // 最小唱段像素宽度，确保能放迷你卡片

async function renderExport(container) {
    try {
        const songsRes = await aGet('/admin/songs');
        const songs = songsRes.data;
        container.innerHTML = `
        <div class="export-toolbar">
            <label style="font-weight:600;font-size:13px;">选择歌曲：</label>
            <select id="expSongSel">
                <option value="">-- 选择歌曲 --</option>
                ${songs.map(s => `<option value="${s.id}">${s.title} - ${s.artist} (${s.completion||0}%)</option>`).join('')}
            </select>
            <label class="btn btn-outline btn-sm acc-upload-btn" id="expAccBtn" style="display:none;">
                上传伴奏<input type="file" accept=".mp3,.wav,.flac,.ogg,.m4a" id="expAccFile">
            </label>
            <span id="expAccStatus"></span>
            <span id="expStatus" class="export-status"></span>
            <button id="expSynthBtn" class="btn btn-primary btn-sm" disabled style="margin-left:auto;">开始合成</button>
        </div>
        <div id="expPlaybar"></div>
        <div id="expWavePanel"></div>
        <div id="expRecPanel"></div>`;
        document.getElementById('expSongSel').addEventListener('change', _expLoadSong);
        document.getElementById('expSynthBtn').addEventListener('click', _expStartSynth);
        document.getElementById('expAccFile').addEventListener('change', _expUploadAcc);
    } catch (e) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`; }
}

async function _expLoadSong() {
    const songId = document.getElementById('expSongSel').value;
    _expCleanup();
    const accBtn = document.getElementById('expAccBtn');
    const accStatus = document.getElementById('expAccStatus');
    if (!songId) {
        document.getElementById('expPlaybar').innerHTML = '';
        document.getElementById('expWavePanel').innerHTML = '';
        document.getElementById('expRecPanel').innerHTML = '';
        document.getElementById('expStatus').textContent = '';
        if (accBtn) accBtn.style.display = 'none';
        if (accStatus) accStatus.innerHTML = '';
        return;
    }
    try {
        const res = await aGet(`/admin/songs/${songId}`);
        _expSong = res.data;
        _expSegs = _expSong.segments || [];
        // 加载该歌曲所有录音
        const recRes = await aGet(`/admin/recordings?song_id=${songId}`);
        const allRecs = recRes.data || [];
        _expSegs.forEach(seg => {
            seg._recs = allRecs.filter(r => r.segment_id === seg.id && r.submitted);
        });
        // 显示上传伴奏按钮
        if (accBtn) accBtn.style.display = '';
        // 检查是否已有伴奏
        if (_expSong.accompaniment_url) {
            _expAccUrl = _expBuildUrl(_expSong.accompaniment_url);
            if (accStatus) accStatus.innerHTML = `<span class="acc-status pass">伴奏已上传 (${_expSong.accompaniment_duration?.toFixed(1)||'?'}s)</span>
                <button class="btn btn-danger btn-sm" onclick="_expDeleteAcc()" style="margin-left:4px;font-size:11px;padding:2px 8px;">删除</button>`;
            _expRenderPlaybar();
            _expRenderWavePanel();
            _expRenderRecPanel();
        } else {
            _expAccUrl = null;
            if (accStatus) accStatus.innerHTML = '';
            // 无伴奏：显示空白提示
            document.getElementById('expPlaybar').innerHTML = '';
            document.getElementById('expWavePanel').innerHTML = '<div class="export-acc-hint">请先上传伴奏文件，检测通过后将显示波形图和唱段切片</div>';
            document.getElementById('expRecPanel').innerHTML = '';
        }
        _expUpdateStatus();
    } catch (e) { showToast(e.message, 'error'); }
}

function _expCleanup() {
    _expStopAllPlayback();
    _expDestroyRecWS();
    _expDestroyMiniWS();
    if (_expWS) { try { _expWS.destroy(); } catch(e){} _expWS = null; }
    if (_expAudio) { _expAudio.pause(); _expAudio.src = ''; _expAudio = null; }
    _expRecAudios.forEach(a => { try { a.pause(); a.src = ''; } catch(e){} });
    _expRecAudios = [];
    if (_expRAF) { cancelAnimationFrame(_expRAF); _expRAF = 0; }
    _expSong = null; _expSegs = []; _expActiveSegIdx = -1;
    _expIsPlaying = false; _expPlayingRecIdx = -1;
    _expAccUrl = null;
}

function _expDestroyRecWS() {
    _expRecWS.forEach(ws => { try { ws.destroy(); } catch(e){} });
    _expRecWS = [];
}
function _expDestroyMiniWS() {
    _expMiniWS.forEach(ws => { try { ws.destroy(); } catch(e){} });
    _expMiniWS = [];
}
function _expStopAllPlayback() {
    if (_expAudio && !_expAudio.paused) _expAudio.pause();
    _expRecWS.forEach(ws => { try { if(ws.isPlaying()) ws.stop(); } catch(e){} });
    _expMiniWS.forEach(ws => { try { if(ws.isPlaying()) ws.stop(); } catch(e){} });
    _expPlayingRecIdx = -1;
}

function _expBuildUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    const p = path.startsWith('/') ? path : `/${path}`;
    const base = (typeof API === 'string' ? API : '').replace(/\/api\/?$/, '');
    return base ? `${base}${p}` : `${window.location.origin}${p}`;
}

// ---- 播放条 ----
function _expRenderPlaybar() {
    document.getElementById('expPlaybar').innerHTML = `
    <div class="export-playbar">
        <button class="play-btn-main" id="expPlayBtn" title="播放伴奏+录音">▶</button>
        <span class="playbar-time" id="expPbTime">0:00 / ${fmtTime(_expSong.duration||0)}</span>
        <div class="playbar-track" id="expPbTrack"><div class="playbar-fill" id="expPbFill"></div></div>
    </div>`;
    // 创建伴奏 Audio
    _expAudio = new Audio(_expAccUrl || _expBuildUrl(_expSong.audio_url));
    _expAudio.crossOrigin = 'anonymous';
    _expAudio.preload = 'auto';
    _expAudio.addEventListener('play', () => {
        _expIsPlaying = true;
        _expTickPlaybar();
        document.getElementById('expPlayBtn').textContent = '⏸';
    });
    _expAudio.addEventListener('pause', () => {
        _expIsPlaying = false;
        if(_expRAF){cancelAnimationFrame(_expRAF);_expRAF=0;}
        document.getElementById('expPlayBtn').textContent = '▶';
        _expRecAudios.forEach(a => { try { a.pause(); } catch(e){} });
    });
    _expAudio.addEventListener('ended', () => {
        _expIsPlaying = false;
        if(_expRAF){cancelAnimationFrame(_expRAF);_expRAF=0;}
        document.getElementById('expPlayBtn').textContent = '▶';
        _expRecAudios.forEach(a => { try { a.pause(); } catch(e){} });
    });
    document.getElementById('expPlayBtn').addEventListener('click', _expTogglePlay);
    document.getElementById('expPbTrack').addEventListener('click', e => {
        if (!_expAudio || !_expAudio.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        _expAudio.currentTime = ratio * _expAudio.duration;
        _expSyncRecAudios();
        _expUpdatePlaybarUI();
        _expUpdateCursor();
    });
    // 准备已选定录音的 Audio 对象
    _expPrepareRecAudios();
}

function _expTogglePlay() {
    if (!_expAudio) return;
    if (_expIsPlaying) {
        _expAudio.pause();
        _expRecAudios.forEach(a => { try { a.pause(); } catch(e){} });
    } else {
        _expStopRecPlayback();
        _expPrepareRecAudios();
        _expSyncRecAudios();
        _expAudio.play().catch(()=>{});
        _expRecAudios.forEach(a => { a.play().catch(()=>{}); });
    }
}

function _expTickPlaybar() {
    if (!_expIsPlaying) return;
    _expUpdatePlaybarUI();
    _expUpdateCursor();
    _expTickRecAudios();
    _expRAF = requestAnimationFrame(_expTickPlaybar);
}

function _expUpdatePlaybarUI() {
    if (!_expAudio) return;
    const cur = _expAudio.currentTime || 0;
    const dur = _expAudio.duration || _expSong?.duration || 0;
    const t = document.getElementById('expPbTime');
    const f = document.getElementById('expPbFill');
    if (t) t.textContent = `${fmtTimePrecise(cur)} / ${fmtTime(dur)}`;
    if (f) f.style.width = dur ? (cur/dur*100)+'%' : '0%';
}

function _expUpdateCursor() {
    const line = document.getElementById('expCursorLine');
    if (!line || !_expAudio || !_expSong) return;
    const dur = _expAudio.duration || _expSong.duration || 0;
    if (!dur) return;
    const hostW = document.getElementById('expWaveHost')?.scrollWidth || 0;
    if (!hostW) return;
    const left = (_expAudio.currentTime / dur) * hostW;
    line.style.left = `${left}px`;
    line.style.display = '';
}

// ---- 波形 + 唱段覆盖 ----
let _expDragState = null; // 拖拽滚动状态

function _expRenderWavePanel() {
    const panel = document.getElementById('expWavePanel');
    panel.innerHTML = `
    <div class="export-wave-panel">
        <div class="export-wave-scroll" id="expWaveScroll">
            <div class="export-wave-host" id="expWaveHost">
                <div id="expWaveWrap" style="width:100%;height:240px;"></div>
                <div class="export-overlay" id="expOverlay"></div>
                <div class="export-cursor-line" id="expCursorLine" style="display:none;"></div>
            </div>
            <div class="export-timeline" id="expTimeline"></div>
        </div>
    </div>`;
    const scrollEl = document.getElementById('expWaveScroll');
    // 点击空白取消选中 + 点击波形定位播放进度
    scrollEl.addEventListener('click', e => {
        if (e.target.closest('.export-seg-block') || e.target.closest('.mini-rec-capsule')) return;
        // 如果是拖拽结束，不触发点击
        if (_expDragState && _expDragState.moved) return;
        // 点击波形区域定位播放进度
        const host = document.getElementById('expWaveHost');
        if (host && _expAudio) {
            const dur = _expAudio.duration || _expSong?.duration || 0;
            if (dur) {
                const hostRect = host.getBoundingClientRect();
                const x = e.clientX - hostRect.left + scrollEl.scrollLeft;
                const hostW = host.scrollWidth || host.clientWidth || 1;
                const ratio = Math.max(0, Math.min(1, x / hostW));
                _expAudio.currentTime = ratio * dur;
                _expUpdatePlaybarUI();
                _expUpdateCursor();
            }
        }
        _expSelectSeg(-1);
    });
    // 拖拽滚动
    _expBindDragScroll(scrollEl);
    _expInitWS();
}

function _expBindDragScroll(scrollEl) {
    scrollEl.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('.export-seg-block') || e.target.closest('.mini-rec-capsule')) return;
        _expDragState = { startX: e.clientX, scrollLeft: scrollEl.scrollLeft, moved: false };
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!_expDragState) return;
        const dx = e.clientX - _expDragState.startX;
        if (Math.abs(dx) > 3) _expDragState.moved = true;
        scrollEl.scrollLeft = _expDragState.scrollLeft - dx;
    });
    document.addEventListener('mouseup', () => {
        if (_expDragState) {
            setTimeout(() => { _expDragState = null; }, 0);
        }
    });
}

function _expInitWS() {
    if (typeof WaveSurfer === 'undefined') {
        document.getElementById('expWaveWrap').innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8;">波形组件未加载</div>';
        _expRenderOverlay();
        return;
    }
    const url = _expAccUrl || _expBuildUrl(_expSong.audio_url);
    _expWS = WaveSurfer.create({
        container: document.getElementById('expWaveWrap'),
        waveColor: '#c7d2fe',
        progressColor: '#c7d2fe',
        cursorColor: 'transparent',
        cursorWidth: 0,
        height: 240,
        normalize: false,
        minPxPerSec: 0,
        fillParent: true,
        autoScroll: false,
        autoCenter: false,
        interact: false,
        dragToSeek: false,
        hideScrollbar: true,
        url
    });
    _expWS.on('ready', () => {
        _expWS.setMuted?.(true);
        _expApplyZoom();
        _expRenderOverlay();
        _expRenderTimeline();
    });
    _expWS.on('error', () => { _expRenderOverlay(); });
}

function _expApplyZoom() {
    if (!_expWS || !_expSong) return;
    const dur = _expWS.getDuration() || _expSong.duration || 1;
    const scroll = document.getElementById('expWaveScroll');
    const viewW = scroll?.clientWidth || 600;
    // 计算需要的最小总宽度：确保每个唱段至少 EXP_MIN_SEG_PX
    let neededW = viewW;
    _expSegs.forEach(seg => {
        const segDur = seg.end_time - seg.start_time;
        const naturalW = (segDur / dur) * viewW;
        if (naturalW < EXP_MIN_SEG_PX) {
            neededW = Math.max(neededW, (EXP_MIN_SEG_PX / segDur) * dur);
        }
    });
    const pxPerSec = neededW / dur;
    try { _expWS.zoom(pxPerSec); } catch(e){}
    const host = document.getElementById('expWaveHost');
    if (host) host.style.width = `${Math.ceil(neededW)}px`;
    const timeline = document.getElementById('expTimeline');
    if (timeline) timeline.style.width = `${Math.ceil(neededW)}px`;
}

function _expRenderTimeline() {
    const tl = document.getElementById('expTimeline');
    if (!tl) return;
    const dur = (_expWS?.getDuration?.()) || _expSong?.duration || 0;
    const hostEl = document.getElementById('expWaveHost');
    const widthPx = hostEl?.scrollWidth || hostEl?.clientWidth || 0;
    if (!dur || !widthPx) { tl.innerHTML = ''; return; }
    // 自适应刻度间隔
    const pxPerSec = widthPx / dur;
    let step;
    if (pxPerSec > 20) step = 5;
    else if (pxPerSec > 8) step = 10;
    else if (pxPerSec > 3) step = 30;
    else step = 60;
    let html = '';
    for (let t = 0; t <= dur; t += step) {
        const left = (t / dur) * widthPx;
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        const label = `${m}:${String(s).padStart(2,'0')}`;
        html += `<div class="tick" style="left:${left}px;"><span class="tick-label">${label}</span></div>`;
    }
    tl.innerHTML = html;
}

function _expRenderOverlay() {
    const ov = document.getElementById('expOverlay');
    if (!ov) return;
    _expDestroyMiniWS();
    const dur = (_expWS?.getDuration?.()) || _expSong?.duration || 0;
    const hostEl = document.getElementById('expWaveHost');
    const widthPx = hostEl?.scrollWidth || hostEl?.clientWidth || 0;
    if (!dur || !widthPx) { ov.innerHTML = ''; return; }

    ov.innerHTML = _expSegs.map((seg, i) => {
        const left = (seg.start_time / dur) * widthPx;
        const w = Math.max(((seg.end_time - seg.start_time) / dur) * widthPx, 2);
        const color = EXP_SEG_COLORS[i % EXP_SEG_COLORS.length];
        const isActive = i === _expActiveSegIdx;
        const selectedRecs = (seg._recs || []).filter(r => r.selected);
        const miniCards = selectedRecs.slice(0, 5).map((r, ri) =>
            `<span class="mini-rec-capsule" data-seg="${i}" data-rec-id="${r.id}" title="${r.user_name}">
                <span class="mini-wave" id="expMiniW${i}_${ri}"></span>
                <span class="mini-name">${r.user_name}</span>
            </span>`
        ).join('');
        const extra = selectedRecs.length > 5 ? `<span class="mini-rec-capsule" style="background:rgba(255,255,255,.7);">+${selectedRecs.length-5}</span>` : '';
        return `<div class="export-seg-block${isActive?' active':''}" data-idx="${i}"
            style="left:${left}px;width:${w}px;background:${color};">
            <span class="seg-label">${seg.index}. ${seg.lyrics||''}</span>
            <span class="seg-type-badge ${seg.is_chorus?'chorus':'solo'}">${seg.is_chorus?'合唱':'独唱'}</span>
            <div style="display:flex;flex-wrap:wrap;gap:2px;padding:0 2px;">${miniCards}${extra}</div>
        </div>`;
    }).join('');

    // 绑定唱段块点击
    ov.querySelectorAll('.export-seg-block').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            _expSelectSeg(parseInt(el.dataset.idx));
        });
    });
    // 绑定迷你胶囊点击播放
    ov.querySelectorAll('.mini-rec-capsule[data-rec-id]').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const recId = el.dataset.recId;
            _expPlayRecById(recId);
        });
    });
    // 初始化迷你波形
    _expInitMiniWS();
}

function _expInitMiniWS() {
    _expMiniWS = [];
    _expSegs.forEach((seg, i) => {
        const selectedRecs = (seg._recs || []).filter(r => r.selected).slice(0, 5);
        selectedRecs.forEach((r, ri) => {
            const el = document.getElementById(`expMiniW${i}_${ri}`);
            if (!el || typeof WaveSurfer === 'undefined') return;
            const ws = WaveSurfer.create({
                container: el, waveColor:'rgba(100,116,139,.5)', progressColor:'#4f46e5',
                cursorWidth:1, cursorColor:'#ef4444', height:14, barWidth:1, barGap:1,
                normalize:true, interact:false, hideScrollbar:true,
                url: _expBuildUrl(r.audio_url)
            });
            ws._recId = r.id;
            _expMiniWS.push(ws);
        });
    });
}

function _expSelectSeg(idx) {
    if (idx === _expActiveSegIdx) idx = -1; // toggle
    _expActiveSegIdx = idx;
    // 更新覆盖层 active 状态
    document.querySelectorAll('.export-seg-block').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.idx) === idx);
    });
    _expRenderRecDetail();
}

// ---- 底部录音详情 ----
function _expRenderRecPanel() {
    const panel = document.getElementById('expRecPanel');
    panel.innerHTML = `
    <div class="export-rec-panel">
        <div class="export-rec-header">
            <h4 id="expRecTitle">录音详情</h4>
            <span id="expRecHint" style="font-size:12px;color:var(--text-light);">点击上方唱段查看录音</span>
        </div>
        <div class="export-rec-body" id="expRecBody">
            <div class="export-rec-empty">请点击上方唱段卡片查看该唱段的录音</div>
        </div>
    </div>`;
    _expRenderRecDetail();
}

function _expRenderRecDetail() {
    _expDestroyRecWS();
    _expStopRecPlayback();
    const body = document.getElementById('expRecBody');
    const title = document.getElementById('expRecTitle');
    const hint = document.getElementById('expRecHint');
    if (!body) return;

    if (_expActiveSegIdx < 0 || !_expSegs[_expActiveSegIdx]) {
        body.innerHTML = '<div class="export-rec-empty">请点击上方唱段卡片查看该唱段的录音</div>';
        if (title) title.textContent = '录音详情';
        if (hint) hint.textContent = '点击上方唱段查看录音';
        return;
    }

    const seg = _expSegs[_expActiveSegIdx];
    const recs = seg._recs || [];
    const isChorus = seg.is_chorus;
    const selectedCount = recs.filter(r => r.selected).length;

    if (title) title.textContent = `${seg.index}. ${seg.lyrics||'唱段'} — ${isChorus?'合唱':'独唱'}`;
    if (hint) hint.textContent = `${recs.length} 条录音 · 已选 ${selectedCount} 条${isChorus?' (合唱最多20条)':' (独唱仅1条)'}`;

    if (!recs.length) {
        body.innerHTML = '<div class="export-rec-empty">该唱段暂无已提交录音</div>';
        return;
    }

    body.innerHTML = recs.map((r, i) => {
        const score = r.score_detail?.composite ?? '--';
        const checked = r.selected ? 'checked' : '';
        let disabled = '';
        if (!isChorus && !r.selected && recs.some(x => x.selected)) disabled = 'disabled';
        if (isChorus && !r.selected && selectedCount >= 20) disabled = 'disabled';
        return `<div class="rec-card-lg ${r.selected?'selected':''}" data-rec-idx="${i}">
            <div class="rec-top">
                <input type="checkbox" class="rec-check" data-rec-id="${r.id}" ${checked} ${disabled}
                       title="${disabled?'已达选择上限':''}">
                <div class="rec-info">
                    <div class="rec-user">${r.user_name}</div>
                    <div class="rec-time">${_fmtDateTime(r.created_at)}</div>
                </div>
            </div>
            <div class="rec-wave-wrap" id="expRecW${i}"></div>
            <div class="rec-bottom">
                <button class="rec-play-btn" data-idx="${i}" title="播放">▶</button>
                <div class="rec-score">${score !== '--' ? score+'分' : '--'}</div>
            </div>
        </div>`;
    }).join('');

    // 绑定复选框
    body.querySelectorAll('.rec-check').forEach(cb => {
        cb.addEventListener('change', async e => {
            const recId = e.target.dataset.recId;
            try {
                if (e.target.checked) {
                    await aPost(`/admin/recordings/${recId}/select`, {});
                    showToast('已选定', 'success');
                } else {
                    await aPost(`/admin/recordings/${recId}/unselect`, {});
                    showToast('已取消选定', 'success');
                }
                // 刷新数据
                await _expRefreshSegRecs();
            } catch (err) {
                showToast(err.message, 'error');
                e.target.checked = !e.target.checked; // 回滚
            }
        });
    });

    // 绑定播放按钮
    body.querySelectorAll('.rec-play-btn').forEach(btn => {
        btn.addEventListener('click', () => _expPlayRec(parseInt(btn.dataset.idx)));
    });

    // 初始化波形
    _expInitRecWS(recs);
}

function _expInitRecWS(recs) {
    _expRecWS = [];
    recs.forEach((r, i) => {
        const el = document.getElementById(`expRecW${i}`);
        if (!el || typeof WaveSurfer === 'undefined') return;
        const ws = WaveSurfer.create({
            container: el, waveColor:'rgba(100,116,139,.4)', progressColor:'#4f46e5',
            cursorWidth:1, cursorColor:'#ef4444', height:32, barWidth:2, barGap:1, barRadius:1,
            normalize:true, interact:true, hideScrollbar:true,
            url: _expBuildUrl(r.audio_url)
        });
        ws._recData = r;
        ws.on('finish', () => {
            const btn = document.querySelector(`.rec-play-btn[data-idx="${i}"]`);
            if (btn) btn.textContent = '▶';
            _expPlayingRecIdx = -1;
        });
        _expRecWS[i] = ws;
    });
}

function _expStopRecPlayback() {
    if (_expPlayingRecIdx >= 0 && _expRecWS[_expPlayingRecIdx]) {
        try { _expRecWS[_expPlayingRecIdx].stop(); } catch(e){}
        const btn = document.querySelector(`.rec-play-btn[data-idx="${_expPlayingRecIdx}"]`);
        if (btn) btn.textContent = '▶';
    }
    _expPlayingRecIdx = -1;
}

function _expPlayRec(idx) {
    // 暂停全曲
    if (_expAudio && !_expAudio.paused) _expAudio.pause();
    // 停止其他录音
    _expStopRecPlayback();
    const ws = _expRecWS[idx];
    if (!ws) { showToast('波形未就绪'); return; }
    ws.play();
    _expPlayingRecIdx = idx;
    const btn = document.querySelector(`.rec-play-btn[data-idx="${idx}"]`);
    if (btn) btn.textContent = '⏸';
}

function _expPlayRecById(recId) {
    // 查找在底部列表中的索引
    if (_expActiveSegIdx < 0) return;
    const seg = _expSegs[_expActiveSegIdx];
    const recs = seg?._recs || [];
    const idx = recs.findIndex(r => r.id === recId);
    if (idx >= 0 && _expRecWS[idx]) {
        _expPlayRec(idx);
    } else {
        // 如果不在当前选中唱段，找到对应唱段并切换
        for (let si = 0; si < _expSegs.length; si++) {
            const ri = (_expSegs[si]._recs||[]).findIndex(r => r.id === recId);
            if (ri >= 0) { _expSelectSeg(si); break; }
        }
    }
}

async function _expRefreshSegRecs() {
    if (!_expSong) return;
    try {
        const recRes = await aGet(`/admin/recordings?song_id=${_expSong.id}`);
        const allRecs = recRes.data || [];
        _expSegs.forEach(seg => {
            seg._recs = allRecs.filter(r => r.segment_id === seg.id && r.submitted);
        });
        _expRenderOverlay();
        _expRenderRecDetail();
        _expUpdateStatus();
        _expPrepareRecAudios();
    } catch(e) { showToast(e.message, 'error'); }
}

function _expUpdateStatus() {
    const status = document.getElementById('expStatus');
    const btn = document.getElementById('expSynthBtn');
    if (!_expSegs.length) {
        if (status) status.textContent = '';
        if (btn) btn.disabled = true;
        return;
    }
    let allOk = true;
    let info = [];
    _expSegs.forEach((seg, i) => {
        const selCount = (seg._recs||[]).filter(r => r.selected).length;
        if (selCount === 0) { allOk = false; info.push(`#${seg.index}未选`); }
        else if (seg.is_chorus && selCount < 3) { allOk = false; info.push(`#${seg.index}合唱需≥3`); }
    });
    const totalSel = _expSegs.filter(s => (s._recs||[]).some(r => r.selected)).length;
    if (status) status.textContent = allOk ? `${totalSel}/${_expSegs.length} 全部就绪` : `${totalSel}/${_expSegs.length} 已选 · ${info.slice(0,3).join('、')}${info.length>3?'...':''}`;
    if (btn) btn.disabled = !allOk;
}

function _expStartSynth() {
    showToast('合成功能开发中...', 'warning');
}

// ---- 伴奏上传 ----
async function _expUploadAcc() {
    const fileInput = document.getElementById('expAccFile');
    const file = fileInput?.files?.[0];
    if (!file || !_expSong) return;
    const accStatus = document.getElementById('expAccStatus');
    if (accStatus) accStatus.innerHTML = '<span class="acc-status uploading">上传中...</span>';
    try {
        const fd = new FormData();
        fd.append('audio', file);
        const res = await adminFetch(`/admin/songs/${_expSong.id}/accompaniment`, { method: 'POST', body: fd });
        if (!res.success) throw new Error(res.detail || '上传失败');
        showToast('伴奏歌曲检测通过', 'success');
        // 重新加载歌曲
        await _expLoadSong();
    } catch (e) {
        if (accStatus) accStatus.innerHTML = `<span class="acc-status fail">${e.message}</span>`;
        showToast(e.message, 'error');
    }
    if (fileInput) fileInput.value = '';
}

async function _expDeleteAcc() {
    if (!_expSong) return;
    if (!confirm('确定删除伴奏文件？')) return;
    try {
        await aDel(`/admin/songs/${_expSong.id}/accompaniment`);
        showToast('伴奏已删除', 'success');
        await _expLoadSong();
    } catch (e) { showToast(e.message, 'error'); }
}

// ---- 录音同步播放 ----
function _expPrepareRecAudios() {
    _expRecAudios.forEach(a => { try { a.pause(); a.src = ''; } catch(e){} });
    _expRecAudios = [];
    if (!_expSegs.length) return;
    _expSegs.forEach(seg => {
        const selectedRecs = (seg._recs || []).filter(r => r.selected);
        selectedRecs.forEach(r => {
            const a = new Audio(_expBuildUrl(r.audio_url));
            a.crossOrigin = 'anonymous';
            a.preload = 'auto';
            a._segStartTime = seg.start_time || 0;
            _expRecAudios.push(a);
        });
    });
}

function _expSyncRecAudios() {
    if (!_expAudio) return;
    const mainTime = _expAudio.currentTime || 0;
    _expRecAudios.forEach(a => {
        const offset = mainTime - (a._segStartTime || 0);
        if (offset >= 0 && offset < (a.duration || 9999)) {
            a.currentTime = offset;
        } else {
            a.currentTime = 0;
            try { a.pause(); } catch(e){}
        }
    });
}

function _expTickRecAudios() {
    if (!_expAudio || !_expIsPlaying) return;
    const mainTime = _expAudio.currentTime || 0;
    _expRecAudios.forEach(a => {
        const offset = mainTime - (a._segStartTime || 0);
        const dur = a.duration || 0;
        if (offset >= 0 && offset < dur) {
            if (a.paused) { a.currentTime = offset; a.play().catch(()=>{}); }
        } else {
            if (!a.paused) { try { a.pause(); } catch(e){} }
        }
    });
}
