// ===== 分段编辑器模块 =====
let editorWS = null; // wavesurfer instance
let editorSong = null;
let editorSegments = [];
let editorActiveSegIdx = -1;

async function renderEditor(container) {
    let songsRes;
    try { songsRes = await aGet('/admin/songs'); } catch (e) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`;
        return;
    }
    const songs = songsRes.data;
    container.innerHTML = `
    <div class="editor-toolbar">
        <label style="font-weight:600;font-size:13px;">选择歌曲：</label>
        <select id="editorSongSelect">
            <option value="">-- 请选择 --</option>
            ${songs.map(s => `<option value="${s.id}">${s.title} - ${s.artist}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" id="btnAddSeg" disabled>＋ 新增唱段</button>
        <button class="btn btn-success btn-sm" id="btnSaveAll" disabled>💾 保存全部</button>
    </div>
    <div class="waveform-container">
        <div class="waveform-header">
            <span class="song-info" id="editorSongInfo">请选择歌曲</span>
            <span class="time-display" id="editorTimeDisplay">0:00 / 0:00</span>
        </div>
        <div id="waveformWrap"></div>
        <div class="waveform-controls">
            <button class="btn btn-outline btn-sm" id="btnWsPlay">▶ 播放</button>
            <button class="btn btn-outline btn-sm" id="btnWsStop">⏹ 停止</button>
            <div class="zoom-control">
                <span>缩放</span>
                <input type="range" id="wsZoom" min="10" max="200" value="50">
            </div>
        </div>
    </div>
    <div class="segments-panel card" id="segmentsPanel" style="margin-top:16px;">
        <div class="card-header"><h3>唱段列表</h3><span id="segCount" style="font-size:12px;color:var(--text-secondary);"></span></div>
        <div class="card-body" id="segListBody" style="padding:0;">
            <div class="empty-state"><div class="empty-icon">✂️</div><p>选择歌曲后显示唱段</p></div>
        </div>
    </div>`;

    // 事件绑定
    document.getElementById('editorSongSelect').addEventListener('change', onEditorSongChange);
    document.getElementById('btnWsPlay').addEventListener('click', () => { if (editorWS) { editorWS.playPause(); } });
    document.getElementById('btnWsStop').addEventListener('click', () => { if (editorWS) { editorWS.stop(); } });
    document.getElementById('wsZoom').addEventListener('input', (e) => { if (editorWS) editorWS.zoom(Number(e.target.value)); });
    document.getElementById('btnAddSeg').addEventListener('click', addNewSegment);
    document.getElementById('btnSaveAll').addEventListener('click', saveAllSegments);
}

async function onEditorSongChange() {
    const songId = document.getElementById('editorSongSelect').value;
    if (!songId) return;
    try {
        const res = await aGet(`/admin/songs/${songId}`);
        editorSong = res.data;
        editorSegments = editorSong.segments || [];
        editorActiveSegIdx = -1;
        document.getElementById('editorSongInfo').textContent = `${editorSong.title} - ${editorSong.artist}`;
        document.getElementById('btnAddSeg').disabled = false;
        document.getElementById('btnSaveAll').disabled = false;
        initWavesurfer();
        renderSegmentList();
    } catch (e) { showToast(e.message, 'error'); }
}

function initWavesurfer() {
    if (editorWS) { editorWS.destroy(); editorWS = null; }
    const wrap = document.getElementById('waveformWrap');
    wrap.innerHTML = '<div class="loading">加载波形中</div>';
    const audioUrl = `${API.replace('/api', '')}${editorSong.audio_url}`;
    editorWS = WaveSurfer.create({
        container: wrap,
        waveColor: '#c7d2fe',
        progressColor: '#4f46e5',
        cursorColor: '#ef4444',
        cursorWidth: 2,
        height: 128,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        url: audioUrl,
    });
    editorWS.on('ready', () => {
        wrap.querySelector('.loading')?.remove();
        document.getElementById('editorTimeDisplay').textContent = `0:00 / ${fmtTime(editorWS.getDuration())}`;
        editorWS.zoom(Number(document.getElementById('wsZoom').value));
    });
    editorWS.on('timeupdate', (t) => {
        document.getElementById('editorTimeDisplay').textContent = `${fmtTimePrecise(t)} / ${fmtTime(editorWS.getDuration())}`;
        highlightActiveSegment(t);
    });
    editorWS.on('click', (progress) => {
        const t = progress * editorWS.getDuration();
        // 找到包含该时间的唱段
        const idx = editorSegments.findIndex(s => t >= s.start_time && t < s.end_time);
        if (idx >= 0) selectSegment(idx);
    });
    const playBtn = document.getElementById('btnWsPlay');
    editorWS.on('play', () => { playBtn.textContent = '⏸ 暂停'; });
    editorWS.on('pause', () => { playBtn.textContent = '▶ 播放'; });
}

function highlightActiveSegment(t) {
    const rows = document.querySelectorAll('.segment-row');
    editorSegments.forEach((seg, i) => {
        if (rows[i]) rows[i].classList.toggle('active', t >= seg.start_time && t < seg.end_time);
    });
}

function selectSegment(idx) {
    editorActiveSegIdx = idx;
    const rows = document.querySelectorAll('.segment-row');
    rows.forEach((r, i) => r.classList.toggle('active', i === idx));
    if (editorWS && editorSegments[idx]) {
        const seg = editorSegments[idx];
        editorWS.setTime(seg.start_time);
    }
}

function renderSegmentList() {
    const body = document.getElementById('segListBody');
    document.getElementById('segCount').textContent = `${editorSegments.length} 段`;
    if (!editorSegments.length) {
        body.innerHTML = '<div class="empty-state"><p>暂无唱段，点击"新增唱段"添加</p></div>';
        return;
    }
    body.innerHTML = editorSegments.map((seg, i) => `
        <div class="segment-row ${i === editorActiveSegIdx ? 'active' : ''}" data-idx="${i}">
            <div class="seg-index">${seg.index}</div>
            <div class="seg-lyrics">${seg.lyrics || '(空)'}</div>
            <span class="badge badge-${seg.difficulty}">${seg.difficulty}</span>
            ${seg.is_chorus ? '<span class="badge badge-chorus">合唱</span>' : ''}
            <span class="badge badge-${seg.status}">${seg.status === 'unassigned' ? '未分配' : seg.status === 'claimed' ? '已认领' : '已完成'}</span>
            <div class="seg-time">${fmtTimePrecise(seg.start_time)} → ${fmtTimePrecise(seg.end_time)}</div>
            <div class="seg-actions">
                <button class="btn btn-outline btn-sm" onclick="playSegment(${i})" title="试听">▶</button>
                <button class="btn btn-outline btn-sm" onclick="editSegment(${i})" title="编辑">✏️</button>
                <button class="btn btn-danger btn-sm" onclick="deleteSegment(${i})" title="删除">🗑</button>
            </div>
        </div>
    `).join('');
    body.querySelectorAll('.segment-row').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('.seg-actions')) return;
            selectSegment(parseInt(row.dataset.idx));
        });
        row.addEventListener('dblclick', (e) => {
            if (e.target.closest('.seg-actions')) return;
            editSegment(parseInt(row.dataset.idx));
        });
    });
}

function playSegment(idx) {
    const seg = editorSegments[idx];
    if (!seg || !editorWS) return;
    editorWS.setTime(seg.start_time);
    editorWS.play();
    // 自动停在 end_time
    const checkStop = () => {
        if (editorWS.getCurrentTime() >= seg.end_time) {
            editorWS.pause();
            editorWS.un('timeupdate', checkStop);
        }
    };
    editorWS.on('timeupdate', checkStop);
    selectSegment(idx);
}

function editSegment(idx) {
    const seg = editorSegments[idx];
    if (!seg) return;
    showModal('编辑唱段 #' + seg.index, `
        <div class="field"><label>歌词</label><textarea id="segLyrics" rows="2">${seg.lyrics || ''}</textarea></div>
        <div class="field-row">
            <div class="field"><label>开始时间(秒)</label><input id="segStart" type="number" step="0.1" value="${seg.start_time}"></div>
            <div class="field"><label>结束时间(秒)</label><input id="segEnd" type="number" step="0.1" value="${seg.end_time}"></div>
        </div>
        <div class="field-row">
            <div class="field"><label>难度</label><select id="segDiff"><option value="easy" ${seg.difficulty==='easy'?'selected':''}>简单</option><option value="normal" ${seg.difficulty==='normal'?'selected':''}>普通</option><option value="hard" ${seg.difficulty==='hard'?'selected':''}>困难</option></select></div>
            <div class="field"><label>合唱段</label><select id="segChorus"><option value="false" ${!seg.is_chorus?'selected':''}>否</option><option value="true" ${seg.is_chorus?'selected':''}>是</option></select></div>
        </div>
        <div class="field"><label>状态</label><select id="segStatus"><option value="unassigned" ${seg.status==='unassigned'?'selected':''}>未分配</option><option value="claimed" ${seg.status==='claimed'?'selected':''}>已认领</option><option value="completed" ${seg.status==='completed'?'selected':''}>已完成</option></select></div>
        <div style="margin-top:12px;">
            <button class="btn btn-outline btn-sm" onclick="setSegTimeFromCursor('segStart')">⏱ 从光标设开始</button>
            <button class="btn btn-outline btn-sm" onclick="setSegTimeFromCursor('segEnd')">⏱ 从光标设结束</button>
        </div>
    `, `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="saveSegment(${idx})">保存</button>`);
}

function setSegTimeFromCursor(inputId) {
    if (!editorWS) return;
    document.getElementById(inputId).value = editorWS.getCurrentTime().toFixed(1);
}

async function saveSegment(idx) {
    const seg = editorSegments[idx];
    try {
        await aPut(`/admin/segments/${seg.id}`, {
            lyrics: document.getElementById('segLyrics').value,
            start_time: parseFloat(document.getElementById('segStart').value),
            end_time: parseFloat(document.getElementById('segEnd').value),
            difficulty: document.getElementById('segDiff').value,
            is_chorus: document.getElementById('segChorus').value === 'true',
            status: document.getElementById('segStatus').value,
        });
        closeModal(); showToast('已保存', 'success');
        await onEditorSongChange(); // 刷新
    } catch (e) { showToast(e.message, 'error'); }
}

async function addNewSegment() {
    if (!editorSong) return;
    const curTime = editorWS ? editorWS.getCurrentTime() : 0;
    showModal('新增唱段', `
        <div class="field"><label>歌词</label><textarea id="segLyrics" rows="2" placeholder="输入歌词"></textarea></div>
        <div class="field-row">
            <div class="field"><label>开始时间(秒)</label><input id="segStart" type="number" step="0.1" value="${curTime.toFixed(1)}"></div>
            <div class="field"><label>结束时间(秒)</label><input id="segEnd" type="number" step="0.1" value="${(curTime+5).toFixed(1)}"></div>
        </div>
        <div class="field-row">
            <div class="field"><label>难度</label><select id="segDiff"><option value="easy">简单</option><option value="normal" selected>普通</option><option value="hard">困难</option></select></div>
            <div class="field"><label>合唱段</label><select id="segChorus"><option value="false" selected>否</option><option value="true">是</option></select></div>
        </div>
        <div style="margin-top:12px;">
            <button class="btn btn-outline btn-sm" onclick="setSegTimeFromCursor('segStart')">⏱ 从光标设开始</button>
            <button class="btn btn-outline btn-sm" onclick="setSegTimeFromCursor('segEnd')">⏱ 从光标设结束</button>
        </div>
    `, `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="confirmAddSegment()">添加</button>`);
}

async function confirmAddSegment() {
    try {
        await aPost(`/admin/songs/${editorSong.id}/segments`, {
            lyrics: document.getElementById('segLyrics').value,
            start_time: parseFloat(document.getElementById('segStart').value),
            end_time: parseFloat(document.getElementById('segEnd').value),
            difficulty: document.getElementById('segDiff').value,
            is_chorus: document.getElementById('segChorus').value === 'true',
        });
        closeModal(); showToast('已添加', 'success');
        await onEditorSongChange();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteSegment(idx) {
    const seg = editorSegments[idx];
    if (!seg) return;
    showModal('删除唱段', `<p>确定删除唱段 #${seg.index}「${seg.lyrics || ''}」？</p>`,
        `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="confirmDeleteSegment('${seg.id}')">删除</button>`);
}
async function confirmDeleteSegment(segId) {
    try {
        await aDel(`/admin/segments/${segId}`);
        closeModal(); showToast('已删除', 'success');
        await onEditorSongChange();
    } catch (e) { showToast(e.message, 'error'); }
}

async function saveAllSegments() {
    if (!editorSong) return;
    try {
        await aPut(`/admin/songs/${editorSong.id}/segments/batch`, { segments: editorSegments });
        showToast('全部保存成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}
