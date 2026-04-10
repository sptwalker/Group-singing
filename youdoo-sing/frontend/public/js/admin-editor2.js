// ===== 分段编辑器 - Part2: 交互/拖拽/撤销/菜单/保存 =====

function _getEditorDuration() {
    return editorAudio?.duration || editorWS?.getDuration?.() || editorSong?.duration || 0;
}

function _getEditorCurrentTime() {
    if(editorAudio) return editorAudio.currentTime || 0;
    return editorWS?.getCurrentTime?.() || 0;
}

// ===== 撤销/重做 =====
function _pushHistory() {
    editorHistoryIdx++;
    editorHistory.length = editorHistoryIdx;
    editorHistory.push(JSON.stringify(editorSegments));
    if(editorHistory.length > HIST_MAX) { editorHistory.shift(); editorHistoryIdx--; }
    _updateUndoBtn();
}
function _markDirty() {
    editorDirty = true;
    const dot = document.getElementById('edUnsaved');
    if(dot) dot.style.display = '';
}
function edUndo() {
    if(editorHistoryIdx <= 0) return;
    editorHistoryIdx--;
    editorSegments = JSON.parse(editorHistory[editorHistoryIdx]);
    _markDirty(); _renderSegList(); _renderOverlay(); _updateUndoBtn();
}
function edRedo() {
    if(editorHistoryIdx >= editorHistory.length-1) return;
    editorHistoryIdx++;
    editorSegments = JSON.parse(editorHistory[editorHistoryIdx]);
    _markDirty(); _renderSegList(); _renderOverlay(); _updateUndoBtn();
}
function _updateUndoBtn() {
    const u = document.getElementById('btnUndo'), r = document.getElementById('btnRedo');
    if(u) u.disabled = editorHistoryIdx <= 0;
    if(r) r.disabled = editorHistoryIdx >= editorHistory.length-1;
}
function _commitChange() { _pushHistory(); _markDirty(); _renderSegList(); _renderOverlay(); }

// ===== 拖拽手柄 =====
let _dragInfo = null;
function _startDrag(e) {
    e.preventDefault(); e.stopPropagation();
    const idx = +e.target.dataset.idx, side = e.target.dataset.side;
    if(!editorWS) return;
    const dur = editorWS.getDuration();
    const wrap = document.getElementById('waveformWrap');
    const ww = wrap.scrollWidth;
    _dragInfo = { idx, side, dur, ww, startX: e.clientX, origStart: editorSegments[idx].start_time, origEnd: editorSegments[idx].end_time };
    document.addEventListener('mousemove', _onDrag);
    document.addEventListener('mouseup', _endDrag);
}
function _onDrag(e) {
    if(!_dragInfo) return;
    const { idx, side, dur, ww, startX, origStart, origEnd } = _dragInfo;
    const dx = e.clientX - startX;
    const dt = (dx / ww) * dur;
    const seg = editorSegments[idx];
    if(side === 'left') {
        let newStart = Math.max(0, origStart + dt);
        // 防止与前一段重叠
        if(idx > 0) newStart = Math.max(editorSegments[idx-1].end_time, newStart);
        // 最小时长
        if(seg.end_time - newStart < SEG_MIN_DUR) newStart = seg.end_time - SEG_MIN_DUR;
        seg.start_time = Math.round(newStart * 10) / 10;
    } else {
        let newEnd = Math.min(dur, origEnd + dt);
        if(idx < editorSegments.length-1) newEnd = Math.min(editorSegments[idx+1].start_time, newEnd);
        if(newEnd - seg.start_time < SEG_MIN_DUR) newEnd = seg.start_time + SEG_MIN_DUR;
        seg.end_time = Math.round(newEnd * 10) / 10;
    }
    _renderOverlay();
    // 实时更新列表中的时间输入框
    const cards = document.querySelectorAll('.seg-card');
    if(cards[idx]) {
        const inputs = cards[idx].querySelectorAll('input[type="number"]');
        if(inputs[0]) inputs[0].value = seg.start_time.toFixed(1);
        if(inputs[1]) inputs[1].value = seg.end_time.toFixed(1);
    }
}
function _endDrag() {
    document.removeEventListener('mousemove', _onDrag);
    document.removeEventListener('mouseup', _endDrag);
    if(_dragInfo) { _commitChange(); _dragInfo = null; }
}

// ===== 时间输入框修改 =====
function _onTimeInput(el) {
    const idx = +el.dataset.idx, field = el.dataset.field;
    let val = parseFloat(el.value);
    if(isNaN(val) || val < 0) return;
    const seg = editorSegments[idx];
    const dur = _getEditorDuration() || 9999;
    if(field === 'start_time') {
        val = Math.max(0, val);
        if(idx > 0) val = Math.max(editorSegments[idx-1].end_time, val);
        if(seg.end_time - val < SEG_MIN_DUR) val = seg.end_time - SEG_MIN_DUR;
        seg.start_time = Math.round(val*10)/10;
    } else {
        val = Math.min(dur, val);
        if(idx < editorSegments.length-1) val = Math.min(editorSegments[idx+1].start_time, val);
        if(val - seg.start_time < SEG_MIN_DUR) val = seg.start_time + SEG_MIN_DUR;
        seg.end_time = Math.round(val*10)/10;
    }
    el.value = seg[field].toFixed(1);
    _commitChange();
}

// ===== 微调时间 (←/→) =====
function _nudgeSegTime(dt) {
    if(editorActiveIdx < 0) return;
    const seg = editorSegments[editorActiveIdx];
    const dur = _getEditorDuration() || 9999;
    let ns = seg.start_time + dt, ne = seg.end_time + dt;
    if(ns < 0) { ne -= ns; ns = 0; }
    if(ne > dur) { ns -= (ne-dur); ne = dur; }
    const prev = editorActiveIdx > 0 ? editorSegments[editorActiveIdx-1] : null;
    const next = editorActiveIdx < editorSegments.length-1 ? editorSegments[editorActiveIdx+1] : null;
    if(prev && ns < prev.end_time) return;
    if(next && ne > next.start_time) return;
    seg.start_time = Math.round(ns*10)/10;
    seg.end_time = Math.round(ne*10)/10;
    _commitChange();
}

// ===== 新增唱段 =====
function _addSegAtCursor() {
    if(!editorSong) return;
    const t = _getEditorCurrentTime();
    _addSegAtTime(t);
}
function _addSegAtTime(t) {
    const dur = _getEditorDuration();
    let start = Math.round(t*10)/10;
    let end = Math.min(dur, Math.round((t+5)*10)/10);
    // 检查是否与现有段重叠，找空隙
    for(const s of editorSegments) {
        if(start >= s.start_time && start < s.end_time) start = s.end_time;
    }
    if(end <= start) end = Math.min(dur, start + SEG_MIN_DUR);
    for(const s of editorSegments) {
        if(end > s.start_time && start < s.start_time) end = s.start_time;
    }
    if(end - start < SEG_MIN_DUR) { showToast('没有足够空间添加唱段','error'); return; }
    const newSeg = {
        id: 'new_'+Date.now(),
        index: editorSegments.length + 1,
        lyrics: '',
        start_time: start,
        end_time: end,
        difficulty: 'normal',
        is_chorus: false,
        status: 'unassigned'
    };
    editorSegments.push(newSeg);
    editorSegments.sort((a,b) => a.start_time - b.start_time);
    editorSegments.forEach((s,i) => s.index = i+1);
    editorActiveIdx = editorSegments.indexOf(newSeg);
    _commitChange();
    showToast('已添加唱段','success');
}

// ===== 删除唱段 =====
function _deleteSegment(idx) {
    const seg = editorSegments[idx];
    if(!seg) return;
    showModal('删除唱段', `<p>确定删除唱段 #${seg.index}「${seg.lyrics||''}」？</p>`,
        `<button class="btn btn-outline" onclick="closeModal()">取消</button>
         <button class="btn btn-danger" onclick="_confirmDelete(${idx})">删除</button>`);
}
function _confirmDelete(idx) {
    editorSegments.splice(idx, 1);
    editorSegments.forEach((s,i) => s.index = i+1);
    if(editorActiveIdx >= editorSegments.length) editorActiveIdx = editorSegments.length - 1;
    closeModal();
    _commitChange();
    showToast('已删除','success');
}

// ===== 编辑唱段模态框 =====
function _editSegModal(idx) {
    const seg = editorSegments[idx];
    if(!seg) return;
    showModal('编辑唱段 #'+seg.index, `
        <div class="field"><label>歌词</label><textarea id="segLyrics" rows="2">${seg.lyrics||''}</textarea></div>
        <div class="field-row">
            <div class="field"><label>开始(秒)</label><input id="segStart" type="number" step="0.1" value="${seg.start_time}"></div>
            <div class="field"><label>结束(秒)</label><input id="segEnd" type="number" step="0.1" value="${seg.end_time}"></div>
        </div>
        <div class="field-row">
            <div class="field"><label>难度</label><select id="segDiff">
                <option value="easy" ${seg.difficulty==='easy'?'selected':''}>简单</option>
                <option value="normal" ${seg.difficulty==='normal'?'selected':''}>普通</option>
                <option value="hard" ${seg.difficulty==='hard'?'selected':''}>困难</option>
            </select></div>
            <div class="field"><label>合唱</label><select id="segChorus">
                <option value="false" ${!seg.is_chorus?'selected':''}>否</option>
                <option value="true" ${seg.is_chorus?'selected':''}>是</option>
            </select></div>
        </div>
        <div style="margin-top:8px;">
            <button class="btn btn-outline btn-sm" onclick="_setCursorTime('segStart')">⏱ 光标→开始</button>
            <button class="btn btn-outline btn-sm" onclick="_setCursorTime('segEnd')">⏱ 光标→结束</button>
        </div>
    `, `<button class="btn btn-outline" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="_saveSegModal(${idx})">确定</button>`);
}
function _setCursorTime(inputId) {
    document.getElementById(inputId).value = _getEditorCurrentTime().toFixed(1);
}
function _saveSegModal(idx) {
    const seg = editorSegments[idx];
    seg.lyrics = document.getElementById('segLyrics').value;
    seg.start_time = parseFloat(document.getElementById('segStart').value) || seg.start_time;
    seg.end_time = parseFloat(document.getElementById('segEnd').value) || seg.end_time;
    seg.difficulty = document.getElementById('segDiff').value;
    seg.is_chorus = document.getElementById('segChorus').value === 'true';
    if(seg.end_time - seg.start_time < SEG_MIN_DUR) {
        showToast(`唱段最短${SEG_MIN_DUR}秒`,'error'); return;
    }
    editorSegments.sort((a,b) => a.start_time - b.start_time);
    editorSegments.forEach((s,i) => s.index = i+1);
    closeModal();
    _commitChange();
    showToast('已更新','success');
}

// ===== 右键菜单 =====
function _showCtx(e, idx) {
    e.preventDefault(); e.stopPropagation();
    _selectSeg(idx);
    const cm = document.getElementById('ctxMenu');
    cm.innerHTML = `
        <div class="ctx-menu-item" onclick="_playSeg(${idx});_hideCtx()">▶ 试听此段</div>
        <div class="ctx-menu-item" onclick="_editSegModal(${idx});_hideCtx()">✏️ 编辑属性</div>
        <div class="ctx-menu-sep"></div>
        <div class="ctx-menu-item" onclick="_splitSeg(${idx});_hideCtx()">✂️ 从光标处拆分</div>
        <div class="ctx-menu-item" onclick="_mergeWithNext(${idx});_hideCtx()">🔗 与下一段合并</div>
        <div class="ctx-menu-sep"></div>
        <div class="ctx-menu-item danger" onclick="_deleteSegment(${idx});_hideCtx()">🗑 删除此段</div>`;
    cm.style.display = 'block';
    cm.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    cm.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';
}
function _hideCtx() {
    const cm = document.getElementById('ctxMenu');
    if(cm) cm.style.display = 'none';
}

// ===== 拆分唱段 =====
function _splitSeg(idx) {
    const seg = editorSegments[idx];
    if(!seg) return;
    const t = _getEditorCurrentTime();
    if(t <= seg.start_time + SEG_MIN_DUR || t >= seg.end_time - SEG_MIN_DUR) {
        showToast('光标位置不适合拆分（距边界太近）','error'); return;
    }
    const splitTime = Math.round(t*10)/10;
    const newSeg = {
        id: 'new_'+Date.now(),
        index: 0,
        lyrics: '',
        start_time: splitTime,
        end_time: seg.end_time,
        difficulty: seg.difficulty,
        is_chorus: seg.is_chorus,
        status: 'unassigned'
    };
    seg.end_time = splitTime;
    editorSegments.splice(idx+1, 0, newSeg);
    editorSegments.forEach((s,i) => s.index = i+1);
    _commitChange();
    showToast('已拆分','success');
}

// ===== 合并唱段 =====
function _mergeWithNext(idx) {
    if(idx >= editorSegments.length - 1) { showToast('没有下一段可合并','error'); return; }
    const seg = editorSegments[idx], next = editorSegments[idx+1];
    seg.end_time = next.end_time;
    if(next.lyrics) seg.lyrics = (seg.lyrics||'') + ' ' + next.lyrics;
    editorSegments.splice(idx+1, 1);
    editorSegments.forEach((s,i) => s.index = i+1);
    _commitChange();
    showToast('已合并','success');
}

// ===== 保存全部 =====
async function _saveAll() {
    if(!editorSong) return;
    // 验证
    for(let i=0; i<editorSegments.length; i++) {
        const s = editorSegments[i];
        if(s.end_time - s.start_time < SEG_MIN_DUR) {
            showToast(`唱段#${s.index}时长不足${SEG_MIN_DUR}秒`,'error'); return;
        }
        if(i>0 && s.start_time < editorSegments[i-1].end_time) {
            showToast(`唱段#${s.index}与前一段重叠`,'error'); return;
        }
    }
    try {
        await aPut(`/admin/songs/${editorSong.id}/segments/batch`, { segments: editorSegments });
        editorDirty = false;
        document.getElementById('edUnsaved').style.display = 'none';
        showToast('全部保存成功','success');
        // 刷新数据
        const res = await aGet(`/admin/songs/${editorSong.id}`);
        editorSong = res.data;
        editorSegments = JSON.parse(JSON.stringify(editorSong.segments||[]));
        editorHistory = []; editorHistoryIdx = -1; _pushHistory();
        _renderSegList(); _renderOverlay();
    } catch(e) { showToast(e.message,'error'); }
}

// ===== 供歌曲库模块调用 =====
function openEditorForSong(songId) {
    switchModule('editor');
    setTimeout(() => {
        const sel = document.getElementById('edSongSel');
        if(sel) { sel.value = songId; _loadSong(songId); }
    }, 500);
}
