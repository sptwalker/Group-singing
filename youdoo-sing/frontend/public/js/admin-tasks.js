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
                    <thead><tr><th>#</th><th>歌曲</th><th>歌词</th><th>类型</th><th>时间</th><th>难度</th><th>状态</th><th>认领</th><th>录音</th><th>操作</th></tr></thead>
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
            <td><span class="badge badge-${seg.status}">${seg.status==='unassigned'?'未分配':seg.status==='claimed'?'已认领':'已完成'}</span></td>
            <td>${seg.claim_count||0} 人</td>
            <td>${(seg.recordings||[]).length} 条</td>
            <td>
                ${seg.status==='completed'
                    ?`<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();reopenSegment('${seg.id}')">重新解锁</button>`
                    :`<button class="btn btn-success btn-sm" onclick="event.stopPropagation();markComplete('${seg.id}')" ${(seg.recordings||[]).filter(r=>r.submitted).length === 0 ? 'disabled title="需有提交录音才能完成锁定"' : ''}>完成锁定</button>`
                }
            </td>
        </tr>`;
        }).join('') || '<tr><td colspan="10" style="text-align:center;padding:30px;color:var(--text-light);">暂无数据</td></tr>';

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
        await aPost(`/segments/${segId}/complete`, new FormData());
        showToast('已标记完成', 'success');
        loadTaskSegments();
    } catch (e) { showToast(e.message, 'error'); }
}

async function reopenSegment(segId) {
    try {
        await aPost(`/segments/${segId}/reopen`, new FormData());
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
        await aDel(`/recordings/${recId}`);
        showToast('已删除', 'success');
        loadTaskSegments();
    } catch (e) { showToast(e.message, 'error'); }
}

// ===== 合成导出模块 =====
async function renderExport(container) {
    try {
        const songsRes = await aGet('/admin/songs');
        const songs = songsRes.data;
        container.innerHTML = `
        <div class="card" style="margin-bottom:20px;">
            <div class="card-header"><h3>合成与导出</h3></div>
            <div class="card-body">
                <p style="color:var(--text-secondary);margin-bottom:20px;">选择歌曲查看各唱段的录音选定状态，选定完成后可导出合成。</p>
                <select id="exportSongSelect" style="padding:8px 14px;border:1.5px solid var(--border);border-radius:6px;font-size:14px;min-width:240px;">
                    <option value="">-- 选择歌曲 --</option>
                    ${songs.map(s => `<option value="${s.id}">${s.title} - ${s.artist} (${s.completion||0}%)</option>`).join('')}
                </select>
            </div>
        </div>
        <div id="exportDetail"></div>`;
        document.getElementById('exportSongSelect').addEventListener('change', loadExportDetail);
    } catch (e) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`; }
}

async function loadExportDetail() {
    const songId = document.getElementById('exportSongSelect').value;
    const detail = document.getElementById('exportDetail');
    if (!songId) { detail.innerHTML = ''; return; }
    try {
        const res = await aGet(`/admin/songs/${songId}`);
        const song = res.data;
        const segs = song.segments || [];
        const allSelected = segs.every(seg => (seg.recordings||[]).some(r => r.selected));
        const selectedCount = segs.filter(seg => (seg.recordings||[]).some(r => r.selected)).length;

        detail.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3>${song.title} — 唱段选定状态</h3>
                <span style="font-size:13px;color:var(--text-secondary);">${selectedCount}/${segs.length} 已选定</span>
            </div>
            <div class="card-body" style="padding:0;">
                <div class="table-wrap"><table>
                    <thead><tr><th>#</th><th>歌词</th><th>时间</th><th>录音数</th><th>选定录音</th><th>状态</th></tr></thead>
                    <tbody>${segs.map(seg => {
                        const recs = seg.recordings || [];
                        const selected = recs.find(r => r.selected);
                        return `<tr>
                            <td>${seg.index}</td>
                            <td>${seg.lyrics||'--'}</td>
                            <td style="font-family:monospace;font-size:12px;">${fmtTimePrecise(seg.start_time)}→${fmtTimePrecise(seg.end_time)}</td>
                            <td>${recs.length}</td>
                            <td>${selected ? `<span class="badge badge-completed">${selected.user_name}</span>` : '<span class="badge badge-unassigned">未选定</span>'}</td>
                            <td>${seg.status==='completed'?'<span class="badge badge-completed">完成</span>':'<span class="badge badge-unassigned">进行中</span>'}</td>
                        </tr>`;
                    }).join('')}</tbody>
                </table></div>
            </div>
        </div>
        <div style="margin-top:20px;text-align:center;">
            <button class="btn btn-primary" ${allSelected?'':'disabled'} onclick="showToast('合成功能开发中...','warning')">
                合成导出${allSelected?'':'（需全部选定）'}
            </button>
            <p style="font-size:12px;color:var(--text-light);margin-top:8px;">合成功能将在后续版本中实现</p>
        </div>`;
    } catch (e) { showToast(e.message, 'error'); }
}
