// ===== 任务管理模块 =====
async function renderTasks(container) {
    try {
        const songsRes = await aGet('/admin/songs');
        const songs = songsRes.data;
        container.innerHTML = `
        <div class="editor-toolbar" style="margin-bottom:16px;">
            <label style="font-weight:600;font-size:13px;">选择歌曲：</label>
            <select id="taskSongSelect">
                <option value="">-- 全部 --</option>
                ${songs.map(s => `<option value="${s.id}">${s.title} - ${s.artist}</option>`).join('')}
            </select>
            <span id="taskFilterInfo" style="font-size:12px;color:var(--text-secondary);"></span>
        </div>
        <div class="card">
            <div class="card-header"><h3>唱段任务</h3></div>
            <div class="card-body" style="padding:0;">
                <div class="table-wrap"><table id="taskTable">
                    <thead><tr><th>#</th><th>歌曲</th><th>歌词</th><th>时间</th><th>难度</th><th>状态</th><th>认领</th><th>录音</th><th>操作</th></tr></thead>
                    <tbody id="taskTableBody"></tbody>
                </table></div>
            </div>
        </div>
        <div class="card" style="margin-top:20px;">
            <div class="card-header"><h3>录音提交</h3></div>
            <div class="card-body" style="padding:0;">
                <div class="table-wrap"><table>
                    <thead><tr><th>用户</th><th>唱段</th><th>歌曲</th><th>评分</th><th>已提交</th><th>已选定</th><th>赞</th><th>操作</th></tr></thead>
                    <tbody id="recTableBody"></tbody>
                </table></div>
            </div>
        </div>`;
        document.getElementById('taskSongSelect').addEventListener('change', () => loadTaskData(songs));
        loadTaskData(songs);
    } catch (e) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`; }
}

async function loadTaskData(songs) {
    const songId = document.getElementById('taskSongSelect').value;
    try {
        // 加载唱段
        let allSegs = [];
        const filteredSongs = songId ? songs.filter(s => s.id === songId) : songs;
        for (const s of filteredSongs) {
            const r = await aGet(`/admin/songs/${s.id}`);
            (r.data.segments || []).forEach(seg => allSegs.push({ ...seg, songTitle: s.title }));
        }
        const tbody = document.getElementById('taskTableBody');
        document.getElementById('taskFilterInfo').textContent = `${allSegs.length} 个唱段`;
        tbody.innerHTML = allSegs.map(seg => `<tr>
            <td>${seg.index}</td>
            <td>${seg.songTitle}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${seg.lyrics||'--'}</td>
            <td style="font-family:monospace;font-size:12px;">${fmtTimePrecise(seg.start_time)}→${fmtTimePrecise(seg.end_time)}</td>
            <td><span class="badge badge-${seg.difficulty}">${seg.difficulty}</span></td>
            <td><span class="badge badge-${seg.status}">${seg.status==='unassigned'?'未分配':seg.status==='claimed'?'已认领':'已完成'}</span></td>
            <td>${seg.claim_count||0} 人</td>
            <td>${(seg.recordings||[]).length} 条</td>
            <td>
                ${seg.status==='completed'
                    ?`<button class="btn btn-outline btn-sm" onclick="reopenSegment('${seg.id}')">🔓 发布</button>`
                    :`<button class="btn btn-success btn-sm" onclick="markComplete('${seg.id}')" ${(seg.recordings||[]).filter(r=>r.submitted).length === 0 ? 'disabled title="需有提交录音才能完成"' : ''}>✓ 完成</button>`
                }
            </td>
        </tr>`).join('') || '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-light);">暂无数据</td></tr>';

        // 加载录音
        const recPath = songId ? `/admin/recordings?song_id=${songId}` : '/admin/recordings';
        const recRes = await aGet(recPath);
        const recs = recRes.data || [];
        const recBody = document.getElementById('recTableBody');
        recBody.innerHTML = recs.map(r => `<tr>
            <td>${r.user_name}</td>
            <td>${r.segment_id}</td>
            <td>${r.song_id}</td>
            <td>⭐ ${r.score}</td>
            <td>${r.submitted ? '<span class="badge badge-submitted">已提交</span>' : '<span class="badge badge-unassigned">未提交</span>'}</td>
            <td>${r.selected ? '<span class="badge badge-completed">已选定</span>' : '--'}</td>
            <td>${r.likes}</td>
            <td>
                <button class="btn btn-outline btn-sm" onclick="playRecording('${r.audio_url}',this)">▶</button>
                ${!r.selected?`<button class="btn btn-success btn-sm" onclick="selectRecording('${r.id}')">选定</button>`:''}
                <button class="btn btn-danger btn-sm" onclick="deleteRecording('${r.id}')">删除</button>
            </td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--text-light);">暂无录音</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function markComplete(segId) {
    try {
        await aPost(`/segments/${segId}/complete`, new FormData());
        showToast('已标记完成', 'success');
        renderTasks(document.getElementById('moduleContainer'));
    } catch (e) { showToast(e.message, 'error'); }
}

async function reopenSegment(segId) {
    try {
        await aPost(`/segments/${segId}/reopen`, new FormData());
        showToast('已重新开放', 'success');
        renderTasks(document.getElementById('moduleContainer'));
    } catch (e) { showToast(e.message, 'error'); }
}

let _taskAudio = null;
function playRecording(url, btn) {
    if (_taskAudio) { _taskAudio.pause(); _taskAudio = null; btn.textContent = '▶'; return; }
    const fullUrl = `${API.replace('/api', '')}${url}`;
    _taskAudio = new Audio(fullUrl);
    _taskAudio.onerror = () => { _taskAudio = null; btn.textContent = '▶'; showToast('音频加载失败'); };
    _taskAudio.onended = () => { _taskAudio = null; btn.textContent = '▶'; };
    _taskAudio.play().catch(() => { _taskAudio = null; btn.textContent = '▶'; });
    btn.textContent = '⏹';
}

async function selectRecording(recId) {
    try {
        await aPost(`/admin/recordings/${recId}/select`, {});
        showToast('已选定', 'success');
        renderTasks(document.getElementById('moduleContainer'));
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteRecording(recId) {
    try {
        await aDel(`/recordings/${recId}`);
        showToast('已删除', 'success');
        renderTasks(document.getElementById('moduleContainer'));
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
                🎬 合成导出${allSelected?'':'（需全部选定）'}
            </button>
            <p style="font-size:12px;color:var(--text-light);margin-top:8px;">合成功能将在后续版本中实现</p>
        </div>`;
    } catch (e) { showToast(e.message, 'error'); }
}
