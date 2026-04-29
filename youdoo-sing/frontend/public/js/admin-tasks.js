// ===== 任务管理模块 =====
let _taskSongs = [];
let _taskAllSegs = [];
let _taskSelectedSegId = null;
let _taskSelectedIsChorus = false;

async function renderTasks(container) {
    try {
        const songsRes = await aGet('/admin/songs');
        _taskSongs = (songsRes.data || []).filter(s => s.task_published);
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
            <div class="card-header">
                <h3>唱段任务</h3>
                <div style="display:flex;align-items:center;gap:10px;">
                    <span id="taskSegHint" style="font-size:12px;color:var(--text-light);">点击行查看录音</span>
                    <button class="btn btn-primary btn-sm" id="btnAddFreeTask" style="display:none;">+ 新增自由任务</button>
                </div>
            </div>
            <div class="card-body" style="padding:0;">
                <div class="table-wrap task-seg-scroll"><table id="taskTable">
                    <thead><tr><th>#</th><th>歌曲</th><th>歌词</th><th>类型</th><th>时间</th><th>难度</th><th>认领</th><th>录音</th><th>操作</th></tr></thead>
                    <tbody id="taskTableBody"></tbody>
                </table></div>
            </div>
        </div>
        <div id="taskStatsPanel" style="display:none;"></div>
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
        document.getElementById('btnAddFreeTask').addEventListener('click', () => _showFreeTaskDialog());
        loadTaskSegments();
    } catch (e) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`; }
}

async function loadTaskSegments() {
    const songId = document.getElementById('taskSongSelect').value;
    try {
        _taskAllSegs = [];
        let currentSongData = null;
        const filteredSongs = songId ? _taskSongs.filter(s => s.id === songId) : _taskSongs;
        for (const s of filteredSongs) {
            const r = await aGet(`/admin/songs/${s.id}`);
            if (s.id === songId) currentSongData = r.data;
            (r.data.segments || []).forEach(seg => _taskAllSegs.push({ ...seg, songTitle: s.title, songId: s.id }));
            // 加载自由任务
            if (r.data.free_tasks) {
                (r.data.free_tasks || []).forEach((ft, fi) => _taskAllSegs.push({
                    id: ft.id, index: `F${fi + 1}`, lyrics: ft.description || '自由任务',
                    is_chorus: ft.type === 'chorus', difficulty: ft.difficulty || 'normal',
                    start_time: ft.start_time, end_time: ft.end_time,
                    claim_count: 0, recordings: ft.recordings || [], status: 'free_task',
                    songTitle: s.title, songId: s.id, _isFreeTask: true, _freeTask: ft,
                }));
            }
        }

        // 控制新增自由任务按钮显示（仅选中单首歌曲时）
        const btnAddFree = document.getElementById('btnAddFreeTask');
        if (btnAddFree) btnAddFree.style.display = (songId && currentSongData) ? '' : 'none';

        const tbody = document.getElementById('taskTableBody');
        document.getElementById('taskFilterInfo').textContent = `${_taskAllSegs.length} 个唱段`;

        tbody.innerHTML = _taskAllSegs.map(seg => {
            const isActive = seg.id === _taskSelectedSegId;
            if (seg._isFreeTask) {
                return `<tr class="task-seg-row task-seg-free${isActive ? ' task-seg-active' : ''}" data-seg-id="${seg.id}" data-is-chorus="0" data-is-free="1">
                <td><span title="自由任务">${seg.index}</span></td>
                <td>${seg.songTitle}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🎵 ${seg.lyrics||'--'}</td>
                <td><span class="badge badge-free">自由</span></td>
                <td style="font-family:monospace;font-size:12px;">${fmtTimePrecise(seg.start_time)}→${fmtTimePrecise(seg.end_time)}</td>
                <td><span class="badge badge-${seg.difficulty}">${seg.difficulty}</span></td>
                <td>--</td>
                <td>${(seg.recordings||[]).length} 条</td>
                <td>
                    <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();editFreeTask('${seg.songId}','${seg.id}')">编辑</button>
                    <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteFreeTask('${seg.songId}','${seg.id}')">删除</button>
                </td>
            </tr>`;
            }
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
                const isFree = row.dataset.isFree === '1';
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
                    if (isFree) loadRecordingsForFreeTask(segId, songId);
                    else loadRecordingsForSeg(segId, isChorus);
                }
            });
        });

        // 渲染统计信息面板
        _renderTaskStats(songId, currentSongData);

        // 如果有选中的唱段，刷新录音
        if (_taskSelectedSegId) {
            const seg = _taskAllSegs.find(s => s.id === _taskSelectedSegId);
            if (seg) {
                if (seg._isFreeTask) loadRecordingsForFreeTask(_taskSelectedSegId, songId);
                else loadRecordingsForSeg(_taskSelectedSegId, seg.is_chorus);
            }
            else clearRecTable();
        } else {
            clearRecTable();
        }
    } catch (e) { showToast(e.message, 'error'); }
}

// ===== 统计信息 =====
async function _renderTaskStats(songId, songData) {
    const panel = document.getElementById('taskStatsPanel');
    if (!panel || !songId || !songData) { if (panel) panel.style.display='none'; return; }
    try {
        const recRes = await aGet(`/admin/recordings?song_id=${songId}`);
        const allRecs = recRes.data || [];
        const submittedRecs = allRecs.filter(r => r.submitted);

        // 参与人数
        const participantSet = new Set(submittedRecs.map(r => r.user_id));
        const participantCount = participantSet.size;

        // 有提交的唱段数
        const submittedSegIds = new Set(submittedRecs.map(r => r.segment_id));
        const normalSegs = (songData.segments || []).filter(s => !s._isFreeTask);
        const submittedSegCount = normalSegs.filter(s =>
            submittedSegIds.has(s.id) || s.status === 'completed'
        ).length;

        // 提交总数
        const totalCount = submittedRecs.length;

        // Top 3 用户
        const userCounts = {};
        submittedRecs.forEach(r => {
            userCounts[r.user_name] = (userCounts[r.user_name] || 0) + 1;
        });
        const topUsers = Object.entries(userCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);

        panel.style.display = '';
        panel.innerHTML = `
        <div class="task-stats-panel card" style="margin-top:16px;">
            <div style="display:flex;gap:20px;flex-wrap:wrap;padding:10px 14px;font-size:13px;">
                <div><b>参与人数：</b><span style="color:var(--primary);">${participantCount}</span> 人</div>
                <div><b>已交唱段：</b><span style="color:#059669;">${submittedSegCount}/${normalSegs.length}</span> 段</div>
                <div><b>提交总数：</b><span style="color:#d97706;">${totalCount}</span> 条</div>
                ${topUsers.length > 0 ? `<div><b>活跃TOP3：</b>${topUsers.map(([name,c])=>`<span class="badge badge-unassigned" style="margin-left:4px;">${name}(${c})</span>`).join('')}</div>` : ''}
            </div>
        </div>`;
    } catch(e) { panel.style.display='none'; }
}

// ===== 自由任务管理 =====
function _showFreeTaskDialog() {
    const songId = document.getElementById('taskSongSelect').value;
    if (!songId) return;
    window._ftSongId = songId;
    showModal('新增自由任务', `
        <div style="display:flex;flex-direction:column;gap:12px;">
            <div><label>描述文字：</label><input type="text" id="ftDesc" placeholder="例如：副歌高音部分" value="" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;"></div>
            <div style="display:flex;gap:8px;"><div style="flex:1;">
                <label>开始时间（秒）：</label><input type="number" id="ftStart" min="0" step="0.5" value="0" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;"></div>
                <div style="flex:1;">
                <label>结束时间（秒）：</label><input type="number" id="ftEnd" min="0" step="0.5" value="10" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;"></div>
            </div>
            <div style="display:flex;gap:8px;"><div style="flex:1;">
                <label>难度：</label><select id="ftDiff" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;">
                    <option value="easy">简</option>
                    <option value="normal" selected>中</option>
                    <option value="hard">难</option>
                </select></div>
                <div style="flex:1;">
                <label>类型：</label><select id="ftType" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;">
                    <option value="solo">独唱</option>
                    <option value="chorus">合唱</option>
                </select></div>
            </div>
            <p id="ftError" style="color:#ef4444;font-size:12px;display:none;margin:0;"></p>
        </div>
    `, `<button class="btn-login" id="btnFtCreate">创 建</button>`);
    document.getElementById('btnFtCreate').addEventListener('click', async () => {
        const desc = document.getElementById('ftDesc').value.trim();
        const start = parseFloat(document.getElementById('ftStart').value);
        const end = parseFloat(document.getElementById('ftEnd').value);
        const diff = document.getElementById('ftDiff').value;
        const type = document.getElementById('ftType').value;
        const errEl = document.getElementById('ftError');

        if (!desc) { errEl.textContent='请输入描述文字'; errEl.style.display=''; return; }
        if (isNaN(start) || isNaN(end)) { errEl.textContent='请输入有效的时间范围'; errEl.style.display=''; return; }
        if (end - start < 5) { errEl.textContent='时间间隔至少需要5秒'; errEl.style.display=''; return; }

        try {
            await aPost(`/admin/songs/${window._ftSongId}/free-tasks`, { description: desc, start_time: start, end_time: end, difficulty: diff, type: type });
            showToast('自由任务已创建', 'success');
            closeModal();
            loadTaskSegments();
        } catch(e) { errEl.textContent=e.message; errEl.style.display=''; }
    });
}

async function editFreeTask(songId, freeTaskId) {
    const seg = _taskAllSegs.find(s => s._isFreeTask && s.id === freeTaskId && s.songId === songId);
    if (!seg) return;
    const ft = seg._freeTask || seg;
    showModal('编辑自由任务', `
        <div style="display:flex;flex-direction:column;gap:12px;">
            <div><label>描述文字：</label><input type="text" id="ftEditDesc" value="${_escapeAttr(ft.description || seg.lyrics || '')}" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;"></div>
            <div style="display:flex;gap:8px;"><div style="flex:1;">
                <label>开始时间（秒）：</label><input type="number" id="ftEditStart" min="0" step="0.5" value="${Number(ft.start_time ?? seg.start_time) || 0}" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;"></div>
                <div style="flex:1;">
                <label>结束时间（秒）：</label><input type="number" id="ftEditEnd" min="0" step="0.5" value="${Number(ft.end_time ?? seg.end_time) || 0}" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;"></div>
            </div>
            <div style="display:flex;gap:8px;"><div style="flex:1;">
                <label>难度：</label><select id="ftEditDiff" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;">
                    <option value="easy" ${(ft.difficulty || seg.difficulty) === 'easy' ? 'selected' : ''}>简</option>
                    <option value="normal" ${(ft.difficulty || seg.difficulty) === 'normal' ? 'selected' : ''}>中</option>
                    <option value="hard" ${(ft.difficulty || seg.difficulty) === 'hard' ? 'selected' : ''}>难</option>
                </select></div>
                <div style="flex:1;">
                <label>类型：</label><select id="ftEditType" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;">
                    <option value="solo" ${(ft.type || 'solo') === 'solo' ? 'selected' : ''}>独唱</option>
                    <option value="chorus" ${ft.type === 'chorus' ? 'selected' : ''}>合唱</option>
                </select></div>
            </div>
            <p id="ftEditError" style="color:#ef4444;font-size:12px;display:none;margin:0;"></p>
        </div>
    `, `<button class="btn-login" id="btnFtSave">保 存</button>`);
    document.getElementById('btnFtSave').addEventListener('click', async () => {
        const desc = document.getElementById('ftEditDesc').value.trim();
        const start = parseFloat(document.getElementById('ftEditStart').value);
        const end = parseFloat(document.getElementById('ftEditEnd').value);
        const diff = document.getElementById('ftEditDiff').value;
        const type = document.getElementById('ftEditType').value;
        const errEl = document.getElementById('ftEditError');

        if (!desc) { errEl.textContent='请输入描述文字'; errEl.style.display=''; return; }
        if (isNaN(start) || isNaN(end)) { errEl.textContent='请输入有效的时间范围'; errEl.style.display=''; return; }
        if (end - start < 5) { errEl.textContent='时间间隔至少需要5秒'; errEl.style.display=''; return; }

        try {
            await aPut(`/admin/songs/${songId}/free-tasks/${freeTaskId}`, { description: desc, start_time: start, end_time: end, difficulty: diff, type: type });
            showToast('自由任务已更新', 'success');
            closeModal();
            loadTaskSegments();
        } catch(e) { errEl.textContent=e.message; errEl.style.display=''; }
    });
}

function _escapeAttr(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function deleteFreeTask(songId, freeTaskId) {
    if (!confirm('确定删除该自由任务？')) return;
    try {
        await aDel(`/admin/songs/${songId}/free-tasks/${freeTaskId}`);
        showToast('自由任务已删除', 'success');
        loadTaskSegments();
    } catch(e) { showToast(e.message, 'error'); }
}

async function loadRecordingsForFreeTask(freeTaskId, songId) {
    try {
        const recRes = await aGet(`/admin/recordings?song_id=${songId}`);
        const allRecs = recRes.data || [];
        const recs = allRecs.filter(r => r.segment_id === freeTaskId && r.submitted);

        const title = document.getElementById('recTableTitle');
        if (title) title.textContent = `录音提交 — 自由任务`;
        const hint = document.getElementById('recTableHint');
        if (hint) hint.textContent = `${recs.length} 条录音 · 自由任务`;

        const recBody = document.getElementById('recTableBody');
        _destroyTaskWS();

        recBody.innerHTML = recs.map((r, i) => {
            const d = r.score_detail?.dimensions || {};
            const composite = r.score_detail?.composite ?? '--';
            return `<tr>
            <td>${r.user_name}</td>
            <td style="font-size:12px;color:var(--text-secondary);font-family:monospace;">${_fmtDateTime(r.created_at)}</td>
            <td class="score-cell">${_fmtScore(d.pitch?.score ?? '--')}</td>
            <td class="score-cell">${_fmtScore(d.volume?.score ?? '--')}</td>
            <td class="score-cell">${_fmtScore(d.rhythm?.score ?? '--')}</td>
            <td class="score-cell">${_fmtScore(d.tone?.score ?? '--')}</td>
            <td class="score-cell score-composite">${_fmtScore(composite)}</td>
            <td>${r.selected ? '<span class="badge badge-completed">已选定</span>' : '<span style="color:var(--text-light);">--</span>'}</td>
            <td style="white-space:nowrap;">
                <div style="display:inline-flex;align-items:center;gap:6px;">
                    <div class="rec-wave-mini" id="taskRecWave${i}" style="height:28px;min-width:120px;border-radius:4px;overflow:hidden;"></div>
                    <button class="btn btn-outline btn-sm" onclick="playTaskRec(${i},this)">▶</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteRecording('${r.id}')">删除</button>
                </div>
            </td>
        </tr>`;
        }).join('') || '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-light);">该自由任务暂无已提交录音</td></tr>';

        _initTaskWaveSurfers(recs);
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
        if (prev.isPlaying()) prev.pause();
        const prevBtn = document.querySelector(`#taskRecWave${_taskPlayingIdx}`)?.closest('td')?.querySelector('.btn-outline');
        if (prevBtn) prevBtn.textContent = '▶';
    }

    const ws = window._taskRecWS[idx];
    if (!ws) { showToast('波形未就绪'); return; }

    if (_taskPlayingIdx === idx && ws.isPlaying()) {
        ws.pause();
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
let _expFreeTasks = [];     // 自由任务列表（含 recordings）
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
let _expZoom = 100;         // 缩放百分比（100=自适应基准）
let _expBaseWaveWidth = 0;  // 基准波形宽度（100%时的宽度）

// ---- Web Audio API 实时音效预览 ----
let _expAudioCtx = null;       // AudioContext 单例
let _expFxNodes = [];          // 每个录音卡片的音效节点链 [{source, pitchNode, reverbGain, dryGain, wetGain, convolver, gainOut}]
let _expFxBuffers = [];        // 缓存的 AudioBuffer
let _expFxPlaying = null;      // 当前正在播放的音效源 {source, startTime, idx}

function _expGetAudioCtx() {
    if (!_expAudioCtx || _expAudioCtx.state === 'closed') {
        _expAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_expAudioCtx.state === 'suspended') _expAudioCtx.resume();
    return _expAudioCtx;
}

// 创建简易脉冲响应（模拟混响）
function _expCreateReverbIR(ctx, duration, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * duration);
    const ir = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
        const data = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
    }
    return ir;
}

// 缓存不同混响等级的IR
let _expReverbIRCache = {};
function _expGetReverbIR(ctx, reverbPct) {
    // 将混响百分比映射到持续时间和衰减
    const duration = 0.5 + (reverbPct / 100) * 2.5; // 0.5s ~ 3s
    const decay = 3 - (reverbPct / 100) * 1.5;       // 3 ~ 1.5
    const key = `${Math.round(duration*10)}_${Math.round(decay*10)}`;
    if (!_expReverbIRCache[key]) {
        _expReverbIRCache[key] = _expCreateReverbIR(ctx, duration, decay);
    }
    return _expReverbIRCache[key];
}

// 加载音频文件到 AudioBuffer
async function _expLoadAudioBuffer(url) {
    const ctx = _expGetAudioCtx();
    const resp = await fetch(url);
    const arrayBuf = await resp.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuf);
}

// 使用 Web Audio API 播放录音（带音效）
async function _expPlayRecWithFx(idx) {
    const seg = _expSegs[_expActiveSegIdx];
    if (!seg) return;
    const recs = seg._recs || [];
    const rec = recs[idx];
    if (!rec) return;

    const ctx = _expGetAudioCtx();
    const url = _expBuildUrl(_expGetRecAudioUrl(rec));

    // 加载或使用缓存的 AudioBuffer
    if (!_expFxBuffers[idx]) {
        try {
            _expFxBuffers[idx] = await _expLoadAudioBuffer(url);
        } catch (e) {
            showToast('音频加载失败', 'error');
            return;
        }
    }
    const buffer = _expFxBuffers[idx];

    // 停止之前的播放
    _expStopFxPlayback();

    // 创建音效链：source → gainNode → dry/wet split → convolver → merge → destination
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // 音高：通过 detune 实现半音偏移（100 cents = 1 semitone），不改变速度
    const pitchShift = rec._pitchShift || 0;
    source.detune.value = pitchShift * 100; // cents

    // 增益控制
    const gainNode = ctx.createGain();
    const gainDb = rec._gain || 0;
    gainNode.gain.value = Math.pow(10, gainDb / 20); // dB → 线性

    // 混响效果
    const reverbPct = rec._reverb || 0;
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();
    const convolver = ctx.createConvolver();
    const merger = ctx.createGain();

    // 干湿比
    const wetRatio = reverbPct / 100;
    dryGain.gain.value = 1 - wetRatio * 0.5; // 干声保持较高
    wetGain.gain.value = wetRatio;

    if (reverbPct > 0) {
        convolver.buffer = _expGetReverbIR(ctx, reverbPct);
    }

    // 连接：source → gainNode → dryGain → merger → destination
    //        source → gainNode → convolver → wetGain → merger
    source.connect(gainNode);
    gainNode.connect(dryGain);
    dryGain.connect(merger);

    if (reverbPct > 0) {
        gainNode.connect(convolver);
        convolver.connect(wetGain);
        wetGain.connect(merger);
    }

    merger.connect(ctx.destination);

    source.start(0);

    _expFxPlaying = {
        source, idx, dryGain, wetGain, convolver, merger, gainNode,
        startTime: ctx.currentTime,
        duration: buffer.duration
    };

    // 同步 WaveSurfer 进度显示
    const ws = _expRecWS[idx];
    if (ws) {
        // 用 RAF 同步 WaveSurfer 的进度条
        const totalDur = buffer.duration;
        const tick = () => {
            if (!_expFxPlaying || _expFxPlaying.idx !== idx) return;
            const elapsed = ctx.currentTime - _expFxPlaying.startTime;
            if (elapsed >= totalDur) {
                // 播放结束
                const btn = document.querySelector(`.rec-play-btn[data-idx="${idx}"]`);
                if (btn) btn.textContent = '▶';
                _expPlayingRecIdx = -1;
                _expFxPlaying = null;
                try { ws.seekTo(0); } catch(e){}
                return;
            }
            try { ws.seekTo(elapsed / totalDur); } catch(e){}
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    source.onended = () => {
        if (_expFxPlaying && _expFxPlaying.idx === idx) {
            const btn = document.querySelector(`.rec-play-btn[data-idx="${idx}"]`);
            if (btn) btn.textContent = '▶';
            _expPlayingRecIdx = -1;
            _expFxPlaying = null;
        }
    };
}

function _expStopFxPlayback() {
    if (_expFxPlaying) {
        try { _expFxPlaying.source.stop(); } catch(e){}
        try { _expFxPlaying.source.disconnect(); } catch(e){}
        try { _expFxPlaying.gainNode.disconnect(); } catch(e){}
        try { _expFxPlaying.dryGain.disconnect(); } catch(e){}
        try { _expFxPlaying.wetGain.disconnect(); } catch(e){}
        try { _expFxPlaying.convolver.disconnect(); } catch(e){}
        try { _expFxPlaying.merger.disconnect(); } catch(e){}
        _expFxPlaying = null;
    }
}

// 实时更新正在播放的音效参数
function _expUpdateFxParams(idx, rec) {
    if (!_expFxPlaying || _expFxPlaying.idx !== idx) return;
    const ctx = _expGetAudioCtx();

    // 更新音高
    const pitchShift = rec._pitchShift || 0;
    try { _expFxPlaying.source.detune.value = pitchShift * 100; } catch(e){}

    // 更新增益
    const gainDb = rec._gain || 0;
    try { _expFxPlaying.gainNode.gain.setValueAtTime(Math.pow(10, gainDb / 20), ctx.currentTime); } catch(e){}

    // 更新混响干湿比
    const reverbPct = rec._reverb || 0;
    const wetRatio = reverbPct / 100;
    _expFxPlaying.dryGain.gain.setValueAtTime(1 - wetRatio * 0.5, ctx.currentTime);
    _expFxPlaying.wetGain.gain.setValueAtTime(wetRatio, ctx.currentTime);

    // 如果之前没有混响但现在需要，需要重新连接
    if (reverbPct > 0 && _expFxPlaying.convolver.buffer === null) {
        _expFxPlaying.convolver.buffer = _expGetReverbIR(ctx, reverbPct);
        try {
            _expFxPlaying.gainNode.connect(_expFxPlaying.convolver);
            _expFxPlaying.convolver.connect(_expFxPlaying.wetGain);
            _expFxPlaying.wetGain.connect(_expFxPlaying.merger);
        } catch(e){}
    }
}

const EXP_SEG_COLORS = ['#10b981','#3b82f6','#f59e0b','#8b5cf6','#ec4899','#06b6d4'];
const EXP_MIN_SEG_PX = 90; // 最小唱段像素宽度，确保能放迷你卡片

async function renderExport(container) {
    try {
        const songsRes = await aGet('/admin/songs');
        const songs = songsRes.data || [];
        container.innerHTML = `
        <div class="export-toolbar">
            <label style="font-weight:600;font-size:13px;">选择歌曲：</label>
            <select id="expSongSel">
                ${songs.length ? songs.map(s => `<option value="${s.id}">${s.title} - ${s.artist} (${s.completion||0}%)</option>`).join('') : '<option value="" disabled>暂无歌曲</option>'}
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
        <div id="expMiniRecOps" class="exp-mini-rec-ops" style="display:none;"></div>
        <div id="expRecPanel"></div>`;
        document.getElementById('expSongSel').addEventListener('change', _expLoadSong);
        document.getElementById('expSynthBtn').addEventListener('click', _expStartSynth);
        document.getElementById('expAccFile').addEventListener('change', _expUploadAcc);
        if (songs.length) _expLoadSong();
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
        // 自由任务列表
        _expFreeTasks = (_expSong.free_tasks || []).map(ft => ({ ...ft, songId }));
        // 加载该歌曲所有录音
        const recRes = await aGet(`/admin/recordings?song_id=${songId}`);
        const allRecs = recRes.data || [];
        _expSegs.forEach(seg => {
            seg._recs = allRecs.filter(r => r.segment_id === seg.id && r.submitted);
        });
        // 自由任务录音
        _expFreeTasks.forEach(ft => {
            ft._recs = allRecs.filter(r => r.segment_id === ft.id && r.submitted);
        });
        // 显示上传伴奏按钮
        if (accBtn) accBtn.style.display = '';
        // 检查是否已有伴奏
        if (_expSong.accompaniment_url) {
            _expAccUrl = _expBuildUrl(_expSong.accompaniment_url);
            if (accStatus) accStatus.innerHTML = '';
            _expRenderPlaybar();
            _expRenderWavePanel();
            _expRenderRecPanel();
        } else {
            _expAccUrl = null;
    _expZoom = 100;
    _expBaseWaveWidth = 0;
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
    _expStopFxPlayback();
    _expDestroyRecWS();
    _expDestroyMiniWS();
    if (_expWS) { try { _expWS.destroy(); } catch(e){} _expWS = null; }
    if (_expAudio) { _expAudio.pause(); _expAudio.src = ''; _expAudio = null; }
    _expRecAudios.forEach(a => { try { a.pause(); a.src = ''; } catch(e){} });
    _expRecAudios = [];
    if (_expRAF) { cancelAnimationFrame(_expRAF); _expRAF = 0; }
    _expSong = null; _expSegs = []; _expFreeTasks = []; _expActiveSegIdx = -1;
    _expIsPlaying = false; _expPlayingRecIdx = -1;
    _expAccUrl = null;
    _expZoom = 100; _expBaseWaveWidth = 0;
    _expZoom = 100;
    _expBaseWaveWidth = 0;
    _expFxBuffers = [];
    _expFxNodes = [];
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
    _expStopFxPlayback();
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
        <div class="zoom-control exp-zoom-control">
            <span>缩放</span>
            <button class="btn btn-outline btn-sm" id="expZoomOut" type="button">－</button>
            <input type="range" id="expZoomSlider" min="20" max="400" step="10" value="${_expZoom}">
            <button class="btn btn-outline btn-sm" id="expZoomIn" type="button">＋</button>
            <span id="expZoomValue">${_expZoom}%</span>
        </div>
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
    // 缩放控件事件
    document.getElementById('expZoomSlider').addEventListener('input', e => _expSetZoom(Number(e.target.value)));
    document.getElementById('expZoomOut').addEventListener('click', () => _expSetZoom(_expZoom - 10));
    document.getElementById('expZoomIn').addEventListener('click', () => _expSetZoom(_expZoom + 10));
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
                <div class="export-cursor-line" id="expCursorLine" style="display:none;"><div class="export-cursor-handle" id="expCursorHandle"></div></div>
            </div>
            <div class="export-free-track" id="expFreeTrack">
                <span class="export-free-track-label">Free Track</span>
                <div id="expFreeTrackItems"></div>
            </div>
            <div class="export-timeline" id="expTimeline"></div>
        </div>
    </div>`;
    _expRenderFreeTrack();
    const scrollEl = document.getElementById('expWaveScroll');
    // 点击空白取消选中 + 点击波形定位播放进度
    scrollEl.addEventListener('click', e => {
        if (e.target.closest('.export-seg-block') || e.target.closest('.mini-rec-capsule') || e.target.closest('.export-cursor-handle')) return;
        // 如果是拖拽结束，不触发点击
        if (_expDragState && _expDragState.moved) return;
        if (_expHandleDragging) return;
        // 点击波形区域定位播放进度
        const host = document.getElementById('expWaveHost');
        if (host && _expAudio) {
            const dur = _expAudio.duration || _expSong?.duration || 0;
            if (dur) {
        const hostRect = host.getBoundingClientRect();
                const x = e.clientX - hostRect.left;
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
    // 进度线手柄拖拽
    _expBindCursorHandleDrag(scrollEl);
    // Ctrl+滚轮缩放
    scrollEl.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        _expSetZoom(_expZoom + (e.deltaY < 0 ? 10 : -10));
    }, { passive: false });
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

let _expHandleDragging = false;

function _expBindCursorHandleDrag(scrollEl) {
    const handle = document.getElementById('expCursorHandle');
    const line = document.getElementById('expCursorLine');
    if (!handle || !line) return;

    handle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        _expHandleDragging = true;
        line.classList.add('dragging');
    });

    document.addEventListener('mousemove', e => {
        if (!_expHandleDragging) return;
        e.preventDefault();
        const host = document.getElementById('expWaveHost');
        if (!host || !_expAudio) return;
        const dur = _expAudio.duration || _expSong?.duration || 0;
        if (!dur) return;
        const hostRect = host.getBoundingClientRect();
        const x = e.clientX - hostRect.left;
        const hostW = host.scrollWidth || host.clientWidth || 1;
        const ratio = Math.max(0, Math.min(1, x / hostW));
        _expAudio.currentTime = ratio * dur;
        _expUpdateCursor();
        _expUpdatePlaybarUI();
    });

    document.addEventListener('mouseup', () => {
        if (!_expHandleDragging) return;
        _expHandleDragging = false;
        line.classList.remove('dragging');
        _expSyncRecAudios();
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
        _expApplyZoom({ fit: true });
        _expRenderOverlay();
        _expRenderFreeTrack();
        _expRenderTimeline();
    });
    _expWS.on('error', () => { _expRenderOverlay(); });
}

function _expApplyZoom({ fit = false } = {}) {
    if (!_expWS || !_expSong) return;
    const dur = _expWS.getDuration() || _expSong.duration || 1;
    const scroll = document.getElementById('expWaveScroll');
    const viewW = scroll?.clientWidth || 600;
    // 计算基准宽度：确保每个唱段至少 EXP_MIN_SEG_PX
    let baseW = viewW;
    _expSegs.forEach(seg => {
        const segDur = seg.end_time - seg.start_time;
        const naturalW = (segDur / dur) * viewW;
        if (naturalW < EXP_MIN_SEG_PX) {
            baseW = Math.max(baseW, (EXP_MIN_SEG_PX / segDur) * dur);
        }
    });
    _expBaseWaveWidth = baseW;
    // 首次加载时设置 zoom=100
    if (fit) _expZoom = 100;
    const neededW = fit ? baseW : Math.max(baseW, baseW * (_expZoom / 100));
    const pxPerSec = neededW / dur;
    // 记录缩放前滚动中心比例
    const beforeLeft = scroll?.scrollLeft || 0;
    const beforeCenter = scroll ? beforeLeft + scroll.clientWidth / 2 : 0;
    const oldHostW = document.getElementById('expWaveHost')?.scrollWidth || neededW;
    const beforeCenterRatio = oldHostW > 0 ? beforeCenter / oldHostW : 0;
    try { _expWS.zoom(pxPerSec); } catch(e){}
    const host = document.getElementById('expWaveHost');
    if (host) host.style.width = `${Math.ceil(neededW)}px`;
    const freeTrack = document.getElementById('expFreeTrack');
    if (freeTrack) freeTrack.style.width = `${Math.ceil(neededW)}px`;
    const timeline = document.getElementById('expTimeline');
    if (timeline) timeline.style.width = `${Math.ceil(neededW)}px`;
    // 缩放后保持视觉中心
    requestAnimationFrame(() => {
        if (scroll && neededW > scroll.clientWidth) {
            const targetCenter = beforeCenterRatio * neededW;
            scroll.scrollLeft = Math.max(0, targetCenter - scroll.clientWidth / 2);
        } else if (scroll) {
            scroll.scrollLeft = 0;
        }
        _expRenderOverlay();
        _expRenderFreeTrack();
        _expRenderTimeline();
        _expUpdateCursor();
    });
}

function _expSetZoom(value) {
    const next = Math.max(20, Math.min(400, Math.round((Number(value) || 100) / 10) * 10));
    _expZoom = next;
    const slider = document.getElementById('expZoomSlider');
    const valueEl = document.getElementById('expZoomValue');
    if (slider) slider.value = String(next);
    if (valueEl) valueEl.textContent = `${next}%`;
    _expApplyZoom();
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

// ---- 自由轨道区 ----
function _expRenderFreeTrack() {
    const container = document.getElementById('expFreeTrackItems');
    if (!container) return;
    const freeTrack = document.getElementById('expFreeTrack');
    if (!_expFreeTasks || _expFreeTasks.length === 0) {
        container.innerHTML = '';
        if (freeTrack) freeTrack.style.display = 'none';
        return;
    }
    if (freeTrack) freeTrack.style.display = '';
    const dur = (_expWS?.getDuration?.()) || _expSong?.duration || 0;
    const hostEl = document.getElementById('expWaveHost');
    const widthPx = hostEl?.scrollWidth || hostEl?.clientWidth || 0;
    if (!dur || !widthPx) { container.innerHTML = ''; return; }

    container.innerHTML = _expFreeTasks.map((ft, fi) => {
        // 找已选定的录音
        const selectedRecs = (ft._recs || []).filter(r => r.selected);
        const left = (ft.start_time / dur) * widthPx;
        const w = Math.max(((ft.end_time - ft.start_time) / dur) * widthPx, 40);
        const names = selectedRecs.map(r => r.user_name).join(', ') || (selectedRecs.length > 0 ? `${selectedRecs.length}人` : '未放置');
        return `<div class="export-free-track-item" data-ft-idx="${fi}" style="left:${left}px;width:${w}px;"
            title="${ft.description || ''} (${fmtTimePrecise(ft.start_time)}-${fmtTimePrecise(ft.end_time)})">
            <span class="free-track-name">${names}</span>
            <span class="free-track-time">${fmtTimePrecise(ft.start_time)}</span>
        </div>`;
    }).join('');
}

function _expGetRecTimelineStart(seg, rec) {
    return rec._startOffset != null ? Number(rec._startOffset) || 0 : (seg?.start_time || 0);
}

function _expGetRecTimelineDuration(seg, rec) {
    const segDur = Math.max(0.1, (seg?.end_time || 0) - (seg?.start_time || 0));
    return Math.max(0.1, Number(rec.duration || rec.audio_duration || rec.score_detail?.duration || rec._duration || segDur) || segDur);
}

function _expGetRecTimelineEnd(seg, rec) {
    return _expGetRecTimelineStart(seg, rec) + _expGetRecTimelineDuration(seg, rec);
}

function _expGetRecAudioUrl(rec) {
    const url = rec?.audio_url || '';
    if (!url) return '';
    const ver = rec._audioVersion || rec.updated_at || '';
    if (!ver) return url;
    return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(ver);
}

function _expRenderOverlay() {
    const ov = document.getElementById('expOverlay');
    if (!ov) return;
    _expDestroyMiniWS();
    const dur = (_expWS?.getDuration?.()) || _expSong?.duration || 0;
    const hostEl = document.getElementById('expWaveHost');
    const widthPx = hostEl?.scrollWidth || hostEl?.clientWidth || 0;
    if (!dur || !widthPx) { ov.innerHTML = ''; return; }

    const segHtml = _expSegs.map((seg, i) => {
        const left = (seg.start_time / dur) * widthPx;
        const w = Math.max(((seg.end_time - seg.start_time) / dur) * widthPx, 2);
        const color = EXP_SEG_COLORS[i % EXP_SEG_COLORS.length];
        const isActive = i === _expActiveSegIdx;
        return `<div class="export-seg-block${isActive?' active':''}" data-idx="${i}"
            style="left:${left}px;width:${w}px;background:${color};">
            <span class="seg-label">${seg.index}. ${seg.lyrics||''}</span>
            <span class="seg-type-badge ${seg.is_chorus?'chorus':'solo'}">${seg.is_chorus?'合唱':'独唱'}</span>
        </div>`;
    }).join('');

    const recItems = [];
    _expSegs.forEach((seg, i) => {
        const selectedRecs = (seg._recs || []).filter(r => r.selected).slice(0, 5);
        selectedRecs.forEach((r, ri) => {
            const start = Math.max(0, Math.min(dur, _expGetRecTimelineStart(seg, r)));
            const recDur = _expGetRecTimelineDuration(seg, r);
            const left = (start / dur) * widthPx;
            const w = Math.max((recDur / dur) * widthPx, 48);
            const safeW = Math.min(w, widthPx - left);
            recItems.push({
                left, width: safeW, right: left + safeW, segIdx: i, recIdx: ri, rec: r,
                html: laneTop => `<span class="mini-rec-capsule" data-seg="${i}" data-rec-id="${r.id}"
                    title="${r.user_name} ${fmtTimePrecise(start)}-${fmtTimePrecise(Math.min(dur, start + recDur))}"
                    style="left:${left}px;width:${safeW}px;top:${laneTop}px;">
                    <span class="mini-wave" id="expMiniW${i}_${ri}"></span>
                    <span class="mini-name">${r.user_name}</span>
                </span>`
            });
        });
        const selectedCount = (seg._recs || []).filter(r => r.selected).length;
        if (selectedCount > 5) {
            const left = (seg.start_time / dur) * widthPx;
            recItems.push({
                left, width: 48, right: left + 48, segIdx: i, recIdx: 5, rec: null,
                html: laneTop => `<span class="mini-rec-capsule mini-rec-extra" style="left:${left}px;top:${laneTop}px;width:48px;">+${selectedCount - 5}</span>`
            });
        }
    });

    const recHtml = [];
    const laneEnds = [];
    recItems.sort((a, b) => a.left - b.left || a.segIdx - b.segIdx || a.recIdx - b.recIdx);
    recItems.forEach(item => {
        const gap = 8;
        let lane = laneEnds.findIndex(end => item.left >= end + gap);
        if (lane < 0) {
            lane = laneEnds.length < 6 ? laneEnds.length : laneEnds.indexOf(Math.min(...laneEnds));
        }
        laneEnds[lane] = Math.max(laneEnds[lane] || 0, item.right);
        recHtml.push(item.html(54 + lane * 22));
    });

    ov.innerHTML = segHtml + recHtml.join('');

    // 绑定唱段块点击
    ov.querySelectorAll('.export-seg-block').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            _expSelectSeg(parseInt(el.dataset.idx));
        });
    });
    // 绑定迷你胶囊点击 → 显示信息操作区
    ov.querySelectorAll('.mini-rec-capsule[data-rec-id]').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const segIdx = parseInt(el.dataset.seg);
            const recId = el.dataset.recId;
            _expShowMiniRecOps(segIdx, recId);
        });
    });
    // 初始化迷你波形
    _expInitMiniWS();
}

// ---- 迷你录音信息操作区 ----
let _expMiniOpsRecId = null; // 当前操作区对应的录音ID

function _expShowMiniRecOps(segIdx, recId) {
    const panel = document.getElementById('expMiniRecOps');
    if (!panel) return;
    // 再次点击同一个 → 关闭
    if (_expMiniOpsRecId === recId) { _expHideMiniRecOps(); return; }
    _expMiniOpsRecId = recId;
    // 查找录音数据
    const seg = _expSegs[segIdx];
    if (!seg) { _expHideMiniRecOps(); return; }
    const rec = (seg._recs || []).find(r => r.id === recId);
    if (!rec) { _expHideMiniRecOps(); return; }

    const pitchShift = rec._pitchShift || 0;
    const gain = rec._gain || 0;
    const reverb = rec._reverb || 0;
    const fadeOut = rec._fadeOut || 0;
    const startT = _expGetRecTimelineStart(seg, rec);
    const durationT = _expGetRecTimelineDuration(seg, rec);
    rec._startOffset = startT;
    rec._endOffset = startT + durationT;

    // 高亮当前胶囊
    document.querySelectorAll('.mini-rec-capsule').forEach(el => el.classList.remove('mini-active'));
    const capsule = document.querySelector(`.mini-rec-capsule[data-rec-id="${recId}"]`);
    if (capsule) capsule.classList.add('mini-active');

    panel.style.display = '';
    panel.innerHTML = `
    <div class="mini-ops-inner">
        <div class="mini-ops-header">
            <span class="mini-ops-name">${rec.user_name}</span>
            <span class="mini-ops-seg">${seg.index}. ${seg.lyrics || ''}</span>
            <button class="mini-ops-play" id="miniOpsPlay" title="播放">▶</button>
            <button class="mini-ops-close" id="miniOpsClose" title="关闭">✕</button>
        </div>
        <div class="mini-ops-controls">
            <div class="mini-ops-group">
                <label>起始</label>
                <input type="number" class="mini-ops-input" id="miniOpsStart" value="${startT.toFixed(2)}" step="0.1" min="0">
            </div>
            <div class="mini-ops-group mini-ops-duration">
                <label>时长</label>
                <span class="mini-ops-duration-val" id="miniOpsDuration">${fmtTimePrecise(durationT)}</span>
            </div>
            <div class="mini-ops-sep"></div>
            <div class="mini-ops-group">
                <label>升降调</label>
                <div class="mini-ops-pitch">
                    <button class="btn btn-outline btn-xs" id="miniOpsPitchDown">-</button>
                    <span id="miniOpsPitchVal">${pitchShift > 0 ? '+' + pitchShift : pitchShift}</span>
                    <button class="btn btn-outline btn-xs" id="miniOpsPitchUp">+</button>
                </div>
            </div>
            <div class="mini-ops-group">
                <label>增益</label>
                <input type="range" id="miniOpsGain" min="-20" max="20" value="${gain}" class="mini-ops-slider">
                <span id="miniOpsGainVal">${gain > 0 ? '+' + gain : gain}dB</span>
            </div>
            <div class="mini-ops-group">
                <label>混响</label>
                <input type="range" id="miniOpsReverb" min="0" max="100" value="${reverb}" class="mini-ops-slider">
                <span id="miniOpsReverbVal">${reverb}%</span>
            </div>
            <div class="mini-ops-group">
                <label>渐弱</label>
                <input type="range" id="miniOpsFadeOut" min="0" max="5000" step="100" value="${fadeOut}" class="mini-ops-slider">
                <span id="miniOpsFadeOutVal">${fadeOut}ms</span>
            </div>
        </div>
    </div>`;

    // 绑定事件
    _expBindMiniOpsEvents(segIdx, recId);
}

function _expBindMiniOpsEvents(segIdx, recId) {
    const seg = _expSegs[segIdx];
    const rec = (seg?._recs || []).find(r => r.id === recId);
    if (!rec) return;

    document.getElementById('miniOpsClose')?.addEventListener('click', _expHideMiniRecOps);
    document.getElementById('miniOpsPlay')?.addEventListener('click', () => {
        // 确保当前唱段被选中，然后播放
        if (_expActiveSegIdx !== segIdx) _expSelectSeg(segIdx);
        const recs = seg._recs || [];
        const idx = recs.findIndex(r => r.id === recId);
        if (idx >= 0) _expPlayRec(idx);
    });

    // 起始时间：保持录音时长不变，结束时间自动同步
    document.getElementById('miniOpsStart')?.addEventListener('change', e => {
        const dur = _expGetRecTimelineDuration(seg, rec);
        const songDur = _expSong?.duration || 0;
        const maxStart = songDur > dur ? songDur - dur : 0;
        const start = Math.max(0, Math.min(maxStart, parseFloat(e.target.value) || 0));
        rec._startOffset = start;
        rec._endOffset = start + dur;
        e.target.value = start.toFixed(2);
        _expRenderOverlay();
        _expPrepareRecAudios();
        _expMiniOpsRecId = null;
        _expShowMiniRecOps(segIdx, recId);
    });

    // 升降调
    const updatePitch = (dir) => {
        rec._pitchShift = Math.max(-12, Math.min(12, (rec._pitchShift || 0) + dir));
        const el = document.getElementById('miniOpsPitchVal');
        if (el) el.textContent = rec._pitchShift > 0 ? '+' + rec._pitchShift : String(rec._pitchShift);
        // 同步底部面板
        _expSyncBottomRecCtrl(segIdx, recId, rec);
    };
    document.getElementById('miniOpsPitchDown')?.addEventListener('click', () => updatePitch(-1));
    document.getElementById('miniOpsPitchUp')?.addEventListener('click', () => updatePitch(1));

    // 增益
    document.getElementById('miniOpsGain')?.addEventListener('input', e => {
        rec._gain = parseInt(e.target.value);
        const el = document.getElementById('miniOpsGainVal');
        if (el) el.textContent = (rec._gain > 0 ? '+' + rec._gain : rec._gain) + 'dB';
        _expSyncBottomRecCtrl(segIdx, recId, rec);
    });

    // 混响
    document.getElementById('miniOpsReverb')?.addEventListener('input', e => {
        rec._reverb = parseInt(e.target.value);
        const el = document.getElementById('miniOpsReverbVal');
        if (el) el.textContent = rec._reverb + '%';
        _expSyncBottomRecCtrl(segIdx, recId, rec);
    });

    // 渐弱
    document.getElementById('miniOpsFadeOut')?.addEventListener('input', e => {
        rec._fadeOut = parseInt(e.target.value);
        const el = document.getElementById('miniOpsFadeOutVal');
        if (el) el.textContent = rec._fadeOut + 'ms';
    });
}

function _expSyncBottomRecCtrl(segIdx, recId, rec) {
    // 如果底部面板正好显示同一唱段，同步控件值
    if (_expActiveSegIdx !== segIdx) return;
    const seg = _expSegs[segIdx];
    const recs = seg?._recs || [];
    const idx = recs.findIndex(r => r.id === recId);
    if (idx < 0) return;
    const pitchEl = document.getElementById(`expPitch${idx}`);
    if (pitchEl) pitchEl.textContent = (rec._pitchShift || 0) > 0 ? '+' + rec._pitchShift : String(rec._pitchShift || 0);
    const gainEl = document.getElementById(`expGain${idx}`);
    const gainSlider = document.querySelector(`.rec-gain-slider[data-idx="${idx}"]`);
    if (gainEl) gainEl.textContent = ((rec._gain || 0) > 0 ? '+' + rec._gain : (rec._gain || 0)) + 'dB';
    if (gainSlider) gainSlider.value = rec._gain || 0;
    const reverbEl = document.getElementById(`expReverb${idx}`);
    const reverbSlider = document.querySelector(`.rec-reverb-slider[data-idx="${idx}"]`);
    if (reverbEl) reverbEl.textContent = (rec._reverb || 0) + '%';
    if (reverbSlider) reverbSlider.value = rec._reverb || 0;
    // 实时更新音效
    _expUpdateFxParams(idx, rec);
}

function _expHideMiniRecOps() {
    _expMiniOpsRecId = null;
    const panel = document.getElementById('expMiniRecOps');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    document.querySelectorAll('.mini-rec-capsule').forEach(el => el.classList.remove('mini-active'));
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
                url: _expBuildUrl(_expGetRecAudioUrl(r))
            });
            ws._recId = r.id;
            _expMiniWS.push(ws);
        });
    });
}

function _expSelectSeg(idx) {
    if (idx === _expActiveSegIdx) idx = -1; // toggle
    _expActiveSegIdx = idx;
    _expHideMiniRecOps();
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
    _expStopFxPlayback();
    _expFxBuffers = [];  // 切换唱段时清理音频缓存
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
        const pitchShift = r._pitchShift || 0;
        const reverb = r._reverb || 0;
        const gain = r._gain || 0;
        return `<div class="rec-card-lg ${r.selected?'selected':''}" data-rec-idx="${i}">
            <div class="rec-top">
                <input type="checkbox" class="rec-check" data-rec-id="${r.id}" ${checked} ${disabled}
                       title="${disabled?'已达选择上限':''}">
                <div class="rec-info">
                    <div class="rec-user">${r.user_name} <span class="rec-score">${score !== '--' ? score+'分' : '--'}</span></div>
                    <div class="rec-time">${_fmtDateTime(r.created_at)}</div>
                </div>
                <button class="rec-trim-btn" data-idx="${i}" title="裁剪">✂</button>
            </div>
            <div class="rec-wave-wrap" id="expRecW${i}"></div>
            <div class="rec-bottom">
                <button class="rec-play-btn" data-idx="${i}" title="播放">▶</button>
                <div class="rec-ctrl-group">
                    <span class="rec-ctrl-label">升降调</span>
                    <button class="rec-pitch-btn" data-idx="${i}" data-dir="-1" title="降调">-</button>
                    <span class="rec-pitch-val" id="expPitch${i}">${pitchShift > 0 ? '+' + pitchShift : pitchShift}</span>
                    <button class="rec-pitch-btn" data-idx="${i}" data-dir="1" title="升调">+</button>
                </div>
                <div class="rec-ctrl-group rec-ctrl-gain">
                    <span class="rec-ctrl-label">增益</span>
                    <input type="range" class="rec-gain-slider" data-idx="${i}" min="-20" max="20" value="${gain}">
                    <span class="rec-gain-val" id="expGain${i}">${gain > 0 ? '+' + gain : gain}dB</span>
                </div>
                <div class="rec-ctrl-group rec-ctrl-reverb">
                    <span class="rec-ctrl-label">混响</span>
                    <input type="range" class="rec-reverb-slider" data-idx="${i}" min="0" max="100" value="${reverb}">
                    <span class="rec-reverb-val" id="expReverb${i}">${reverb}%</span>
                </div>
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

    // 绑定升降调按钮
    body.querySelectorAll('.rec-pitch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const dir = parseInt(btn.dataset.dir);
            const rec = recs[idx];
            if (!rec) return;
            rec._pitchShift = (rec._pitchShift || 0) + dir;
            rec._pitchShift = Math.max(-12, Math.min(12, rec._pitchShift));
            const el = document.getElementById(`expPitch${idx}`);
            if (el) el.textContent = rec._pitchShift > 0 ? '+' + rec._pitchShift : String(rec._pitchShift);
            // 实时更新音效
            _expUpdateFxParams(idx, rec);
        });
    });

    // 绑定增益滑块
    body.querySelectorAll('.rec-gain-slider').forEach(slider => {
        slider.addEventListener('input', () => {
            const idx = parseInt(slider.dataset.idx);
            const rec = recs[idx];
            if (!rec) return;
            rec._gain = parseInt(slider.value);
            const el = document.getElementById(`expGain${idx}`);
            if (el) el.textContent = (rec._gain > 0 ? '+' + rec._gain : rec._gain) + 'dB';
            _expUpdateFxParams(idx, rec);
        });
    });

    // 绑定混响滑块
    body.querySelectorAll('.rec-reverb-slider').forEach(slider => {
        slider.addEventListener('input', () => {
            const idx = parseInt(slider.dataset.idx);
            const rec = recs[idx];
            if (!rec) return;
            rec._reverb = parseInt(slider.value);
            const el = document.getElementById(`expReverb${idx}`);
            if (el) el.textContent = rec._reverb + '%';
            _expUpdateFxParams(idx, rec);
        });
    });

    // 绑定裁剪按钮
    body.querySelectorAll('.rec-trim-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            _expToggleTrim(idx, btn);
        });
    });

    // 初始化波形
    _expInitRecWS(recs);
}

// ========== 裁剪功能 ==========
let _expTrimActive = {}; // { idx: { overlay, leftHandle, rightHandle, trimStart, trimEnd, duration } }

function _expToggleTrim(idx, btn) {
    if (_expTrimActive[idx]) {
        // 已激活 → 确认裁剪并关闭
        _expConfirmTrim(idx, btn);
        return;
    }
    // 激活裁剪模式
    const waveWrap = document.getElementById(`expRecW${idx}`);
    if (!waveWrap) return;
    const ws = _expRecWS[idx];
    if (!ws) return;

    const seg = _expSegs[_expActiveSegIdx];
    const rec = (seg?._recs || [])[idx];
    if (!rec) return;

    const duration = ws.getDuration() || 1;
    const trimStart = rec._trimStart || 0;
    const trimEnd = rec._trimEnd || 0;

    btn.classList.add('active');

    // 创建裁剪覆盖层
    const overlay = document.createElement('div');
    overlay.className = 'rec-trim-overlay';
    overlay.innerHTML = `
        <div class="trim-region trim-left" style="width:${(trimStart / duration) * 100}%">
            <div class="trim-handle trim-handle-left" data-side="left"></div>
        </div>
        <div class="trim-region trim-right" style="width:${(trimEnd / duration) * 100}%">
            <div class="trim-handle trim-handle-right" data-side="right"></div>
        </div>
    `;
    waveWrap.style.position = 'relative';
    waveWrap.appendChild(overlay);

    const leftRegion = overlay.querySelector('.trim-left');
    const rightRegion = overlay.querySelector('.trim-right');

    _expTrimActive[idx] = {
        overlay, leftRegion, rightRegion,
        trimStart, trimEnd, duration
    };

    // 拖拽处理
    const onPointerDown = (e) => {
        const handle = e.target.closest('.trim-handle');
        if (!handle) return;
        e.preventDefault();
        e.stopPropagation();
        const side = handle.dataset.side;
        const rect = waveWrap.getBoundingClientRect();
        const totalW = rect.width;

        const onMove = (ev) => {
            const x = (ev.clientX || ev.touches?.[0]?.clientX || 0) - rect.left;
            const pct = Math.max(0, Math.min(1, x / totalW));
            const state = _expTrimActive[idx];
            if (!state) return;
            if (side === 'left') {
                const maxPct = 1 - (state.trimEnd / state.duration);
                const clampedPct = Math.min(pct, maxPct - 0.02);
                state.trimStart = Math.max(0, clampedPct * state.duration);
                leftRegion.style.width = (clampedPct * 100) + '%';
            } else {
                const minPct = state.trimStart / state.duration;
                const clampedPct = Math.max(1 - pct, 0);
                const effectivePct = Math.min(clampedPct, 1 - minPct - 0.02);
                state.trimEnd = Math.max(0, effectivePct * state.duration);
                rightRegion.style.width = (effectivePct * 100) + '%';
            }
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    };

    overlay.addEventListener('mousedown', onPointerDown);
    overlay.addEventListener('touchstart', onPointerDown, { passive: false });
}

async function _expConfirmTrim(idx, btn) {
    const state = _expTrimActive[idx];
    if (!state) return;

    const seg = _expSegs[_expActiveSegIdx];
    const rec = (seg?._recs || [])[idx];
    if (!rec) return;

    const trimStart = Math.round(state.trimStart * 1000) / 1000;
    const trimEnd = Math.round(state.trimEnd * 1000) / 1000;

    // 保存裁剪参数到录音对象
    rec._trimStart = trimStart;
    rec._trimEnd = trimEnd;

    // 如果有实际裁剪量，调用后端 API 执行裁剪
    if (trimStart > 0.01 || trimEnd > 0.01) {
        try {
            btn.disabled = true;
            btn.textContent = '⏳';
            rec._trimStart = trimStart;
            rec._trimEnd = trimEnd;
            rec._audioVersion = Date.now();

            await aPost(`/admin/recordings/${rec.id}/trim`, {
                trim_start: trimStart,
                trim_end: trimEnd
            });
            showToast('裁剪成功', 'success');
            // 清除音频缓存以重新加载
            _expFxBuffers[idx] = null;
            // 清理裁剪状态
            _expCleanupTrim(idx, btn);
            // 刷新录音数据和波形
            await _expRefreshSegRecs();
            return;
        } catch (e) {
            showToast('裁剪失败: ' + e.message, 'error');
            btn.disabled = false;
            btn.textContent = '✂';
        }
    }

    // 无实际裁剪，直接关闭
    _expCleanupTrim(idx, btn);
}

function _expCleanupTrim(idx, btn) {
    const state = _expTrimActive[idx];
    if (state && state.overlay && state.overlay.parentNode) {
        state.overlay.parentNode.removeChild(state.overlay);
    }
    delete _expTrimActive[idx];
    if (btn) {
        btn.classList.remove('active');
        btn.disabled = false;
        btn.textContent = '✂';
    }
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
            url: _expBuildUrl(_expGetRecAudioUrl(r))
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
    _expStopFxPlayback();
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

    // 如果点击正在播放的录音，停止播放（toggle）
    if (_expPlayingRecIdx === idx) {
        _expStopRecPlayback();
        return;
    }

    // 停止其他录音（包括音效播放）
    _expStopRecPlayback();

    // 始终使用 Web Audio API 播放（支持实时音效预览）
    _expPlayingRecIdx = idx;
    const btn = document.querySelector(`.rec-play-btn[data-idx="${idx}"]`);
    if (btn) btn.textContent = '⏸';
    _expPlayRecWithFx(idx).catch(e => {
        showToast('播放失败: ' + e.message, 'error');
        _expPlayingRecIdx = -1;
        if (btn) btn.textContent = '▶';
    });
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
        const prevById = new Map();
        _expSegs.forEach(seg => {
            (seg._recs || []).forEach(r => {
                prevById.set(r.id, {
                    _pitchShift: r._pitchShift,
                    _reverb: r._reverb,
                    _gain: r._gain,
                    _fadeOut: r._fadeOut,
                    _trimStart: r._trimStart,
                    _trimEnd: r._trimEnd,
                    _startOffset: r._startOffset,
                    _endOffset: r._endOffset,
                    _duration: r._duration,
                    _audioVersion: r._audioVersion,
                });
            });
        });
        const recRes = await aGet(`/admin/recordings?song_id=${_expSong.id}`);
        const allRecs = (recRes.data || []).map(r => Object.assign(r, prevById.get(r.id) || {}));
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

async function _expStartSynth() {
    if (!_expSong || !_expSegs.length) return;
    // 收集所有录音的升降调和混响参数
    const recParams = {};
    _expSegs.forEach(seg => {
        (seg._recs || []).forEach(r => {
            if (r.selected) {
                recParams[r.id] = {
                    pitchShift: r._pitchShift || 0,
                    reverb: r._reverb || 0,
                    gain: r._gain || 0,
                    trimStart: r._trimStart || 0,
                    trimEnd: r._trimEnd || 0,
                    startOffset: _expGetRecTimelineStart(seg, r),
                    duration: _expGetRecTimelineDuration(seg, r),
                };
            }
        });
    });
    // 显示合成进度对话框
    showModal('合成进度', `
        <div class="synth-progress-wrap">
            <div class="synth-step-list" id="synthStepList"></div>
            <div class="synth-progress-bar"><div class="synth-progress-fill" id="synthProgressFill"></div></div>
            <div class="synth-progress-text" id="synthProgressText">准备中...</div>
        </div>
    `, '');
    _renderSynthSteps(0);
    try {
        await aPost(`/admin/songs/${_expSong.id}/synthesize`, { rec_params: recParams });
        // 开始轮询状态
        _pollSynthStatus(_expSong.id);
    } catch (e) {
        closeModal();
        showToast(e.message, 'error');
    }
}

const _SYNTH_STEP_NAMES = ['降噪处理', '节奏对齐', '音高修正', '响度均衡', '人声增强', '空间效果', '合唱增强', '最终混音'];

function _renderSynthSteps(currentStep) {
    const list = document.getElementById('synthStepList');
    if (!list) return;
    list.innerHTML = _SYNTH_STEP_NAMES.map((name, i) => {
        let cls = 'synth-step';
        if (i < currentStep) cls += ' done';
        else if (i === currentStep) cls += ' active';
        return `<div class="${cls}"><span class="synth-step-num">${i + 1}</span><span>${name}</span></div>`;
    }).join('');
}

let _synthPollTimer = null;
function _pollSynthStatus(songId) {
    if (_synthPollTimer) clearInterval(_synthPollTimer);
    _synthPollTimer = setInterval(async () => {
        try {
            const res = await aGet(`/admin/songs/${songId}/synth-status`);
            const data = res.data;
            if (!data || data.status === 'none') return;
            // 更新进度
            const fill = document.getElementById('synthProgressFill');
            const text = document.getElementById('synthProgressText');
            if (fill) fill.style.width = (data.progress || 0) + '%';
            if (text) text.textContent = data.message || '';
            _renderSynthSteps(data.step || 0);

            if (data.status === 'done') {
                clearInterval(_synthPollTimer);
                _synthPollTimer = null;
                setTimeout(() => {
                    closeModal();
                    showToast('合成完成！', 'success');
                    // 跳转到最终成曲页面
                    switchModule('finals');
                }, 1200);
            } else if (data.status === 'error') {
                clearInterval(_synthPollTimer);
                _synthPollTimer = null;
                closeModal();
                showToast(`合成失败: ${data.error || '未知错误'}`, 'error');
            }
        } catch (e) {
            console.error('poll synth status error:', e);
        }
    }, 1000);
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
            const a = new Audio(_expBuildUrl(_expGetRecAudioUrl(r)));
            a.crossOrigin = 'anonymous';
            a.preload = 'auto';
            a._segStartTime = _expGetRecTimelineStart(seg, r);
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

// ===== 最终成曲模块 =====
let _finalsPlayingAudio = null;
let _finalsPlayingId = null;
let _finalsAudioCtx = null;
let _finalsAnalyser = null;
let _finalsSource = null;
let _finalsWaveRAF = 0;
let _finalsTimeRAF = 0;

function _getFinalsAudioCtx() {
    if (!_finalsAudioCtx) _finalsAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_finalsAudioCtx.state === 'suspended') _finalsAudioCtx.resume();
    return _finalsAudioCtx;
}

async function renderFinals(container) {
    _stopFinalsPlayback();
    try {
        const res = await aGet('/admin/finals');
        const finals = res.data || [];
        container.innerHTML = `
        <div class="finals-header">
            <h3>最终成曲列表</h3>
            <span class="finals-count">${finals.length} 首成曲</span>
        </div>
        <div class="finals-list" id="finalsList">
            ${finals.length ? finals.map(f => _renderFinalCard(f)).join('') : '<div class="empty-state"><div class="empty-icon">🎵</div><p>暂无成曲，请在"合成导出"页面完成合成</p></div>'}
        </div>`;
        _bindFinalsEvents();
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`;
    }
}

function _renderFinalCard(f) {
    const statusBadge = f.published
        ? '<span class="badge badge-completed">已发布</span>'
        : '<span class="badge badge-unassigned">未发布</span>';
    const publishBtn = f.published
        ? `<button class="btn btn-outline btn-sm" data-action="unpublish" data-id="${f.id}">取消发布</button>`
        : `<button class="btn btn-success btn-sm" data-action="publish" data-id="${f.id}">发布</button>`;
    return `
    <div class="final-card" data-final-id="${f.id}">
        <div class="final-card-body">
            <div class="final-card-top">
                <button class="final-play-btn" data-action="play" data-id="${f.id}" data-url="${f.audio_url}" data-dur="${f.duration || 0}" title="播放">▶</button>
                <div class="final-info">
                    <div class="final-title">${f.song_title || '未命名'} <span class="final-artist">${f.song_artist || ''}</span></div>
                    <div class="final-meta">
                        ${statusBadge}
                        <span>${f.segment_count || 0} 唱段</span>
                        <span>${f.track_count || 0} 轨</span>
                        <span>${fmtTime(f.duration || 0)}</span>
                        <span class="final-date">${f.created_at || ''}</span>
                    </div>
                </div>
                <div class="final-card-right">
                    ${publishBtn}
                    <button class="btn btn-danger btn-sm" data-action="delete" data-id="${f.id}">删除</button>
                </div>
            </div>
            <div class="final-player-row" id="finalPlayer_${f.id}" style="display:none;">
                <canvas class="final-wave-canvas" id="finalWave_${f.id}" width="800" height="40"></canvas>
                <div class="final-time-bar">
                    <div class="final-progress-track" id="finalTrack_${f.id}">
                        <div class="final-progress-fill" id="finalFill_${f.id}"></div>
                    </div>
                    <span class="final-time-label" id="finalTime_${f.id}">0:00 / ${fmtTime(f.duration || 0)}</span>
                </div>
            </div>
        </div>
    </div>`;
}

function _bindFinalsEvents() {
    const list = document.getElementById('finalsList');
    if (!list) return;
    list.addEventListener('click', async e => {
        // 进度条点击 seek
        const track = e.target.closest('.final-progress-track');
        if (track && _finalsPlayingAudio) {
            const rect = track.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            _finalsPlayingAudio.currentTime = ratio * (_finalsPlayingAudio.duration || 0);
            return;
        }
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'play') {
            _toggleFinalPlay(btn, id, btn.dataset.url, parseFloat(btn.dataset.dur) || 0);
        } else if (action === 'publish') {
            try {
                await aPost(`/admin/finals/${id}/publish`, {});
                showToast('已发布', 'success');
                renderFinals(document.getElementById('moduleContainer'));
            } catch (e) { showToast(e.message, 'error'); }
        } else if (action === 'unpublish') {
            try {
                await aPost(`/admin/finals/${id}/unpublish`, {});
                showToast('已取消发布', 'success');
                renderFinals(document.getElementById('moduleContainer'));
            } catch (e) { showToast(e.message, 'error'); }
        } else if (action === 'delete') {
            if (!confirm('确定删除该成曲？此操作不可恢复。')) return;
            try {
                await aDel(`/admin/finals/${id}`);
                showToast('已删除', 'success');
                renderFinals(document.getElementById('moduleContainer'));
            } catch (e) { showToast(e.message, 'error'); }
        }
    });
}

function _stopFinalsPlayback() {
    if (_finalsWaveRAF) { cancelAnimationFrame(_finalsWaveRAF); _finalsWaveRAF = 0; }
    if (_finalsTimeRAF) { cancelAnimationFrame(_finalsTimeRAF); _finalsTimeRAF = 0; }
    if (_finalsSource) { try { _finalsSource.disconnect(); } catch(e){} _finalsSource = null; }
    _finalsAnalyser = null;
    if (_finalsPlayingAudio) {
        _finalsPlayingAudio.pause();
        _finalsPlayingAudio.src = '';
        const prevBtn = document.querySelector(`.final-play-btn[data-id="${_finalsPlayingId}"]`);
        if (prevBtn) prevBtn.textContent = '▶';
        const prevPlayer = document.getElementById(`finalPlayer_${_finalsPlayingId}`);
        if (prevPlayer) prevPlayer.style.display = 'none';
        _finalsPlayingAudio = null;
        _finalsPlayingId = null;
    }
}

function _toggleFinalPlay(btn, id, url, dur) {
    const wasSame = _finalsPlayingId === id;
    _stopFinalsPlayback();
    if (wasSame) return;

    // 显示播放器行
    const playerRow = document.getElementById(`finalPlayer_${id}`);
    if (playerRow) playerRow.style.display = '';

    const fullUrl = _expBuildUrl(url);
    const audio = new Audio(fullUrl);
    audio.crossOrigin = 'anonymous';

    // Web Audio 连接
    const ctx = _getFinalsAudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;

    audio.addEventListener('canplay', () => {
        if (_finalsPlayingId !== id) return;
        try {
            if (!_finalsSource) {
                const src = ctx.createMediaElementSource(audio);
                src.connect(analyser);
                analyser.connect(ctx.destination);
                _finalsSource = src;
            }
        } catch(e) {}
    }, { once: true });

    audio.addEventListener('ended', () => {
        _stopFinalsPlayback();
    });

    audio.play().catch(() => {});
    btn.textContent = '⏸';
    _finalsPlayingAudio = audio;
    _finalsPlayingId = id;
    _finalsAnalyser = analyser;

    // 波形绘制循环
    const canvas = document.getElementById(`finalWave_${id}`);
    if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        const cCtx = canvas.getContext('2d');
        cCtx.scale(dpr, dpr);
        const W = rect.width, H = rect.height;
        const bufLen = analyser.frequencyBinCount;
        const dataArr = new Uint8Array(bufLen);

        function drawWave() {
            if (_finalsPlayingId !== id) return;
            _finalsWaveRAF = requestAnimationFrame(drawWave);
            analyser.getByteFrequencyData(dataArr);
            cCtx.clearRect(0, 0, W, H);

            const barCount = Math.min(bufLen, Math.floor(W / 3));
            const barW = W / barCount;
            const gap = 1;
            for (let i = 0; i < barCount; i++) {
                const v = dataArr[i] / 255;
                const barH = Math.max(1, v * H * 0.9);
                const x = i * barW;
                const y = (H - barH) / 2;
                const hue = 240 + v * 60;
                cCtx.fillStyle = `hsla(${hue}, 80%, ${55 + v * 25}%, ${0.6 + v * 0.4})`;
                cCtx.fillRect(x + gap / 2, y, barW - gap, barH);
            }
        }
        drawWave();
    }

    // 时间更新循环
    function tickTime() {
        if (_finalsPlayingId !== id) return;
        _finalsTimeRAF = requestAnimationFrame(tickTime);
        const cur = audio.currentTime || 0;
        const total = audio.duration || dur || 0;
        const timeEl = document.getElementById(`finalTime_${id}`);
        if (timeEl) timeEl.textContent = `${fmtTime(cur)} / ${fmtTime(total)}`;
        const fillEl = document.getElementById(`finalFill_${id}`);
        if (fillEl) fillEl.style.width = total ? (cur / total * 100) + '%' : '0%';
    }
    tickTime();
}
