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
function _normalizeSegmentChain() {
    const dur = _getEditorDuration() || 9999;
    editorSegments.sort((a, b) => a.start_time - b.start_time);
    editorSegments.forEach((seg, i) => {
        const prev = i > 0 ? editorSegments[i - 1] : null;
        seg.start_time = Math.max(0, Math.round((Number(seg.start_time) || 0) * 10) / 10);
        seg.end_time = Math.round(Math.min(dur, Math.max(seg.start_time + SEG_MIN_DUR, Number(seg.end_time) || 0)) * 10) / 10;
        if(prev && seg.start_time < prev.end_time) {
            seg.start_time = prev.end_time;
            if(seg.end_time < seg.start_time + SEG_MIN_DUR) seg.end_time = Math.min(dur, seg.start_time + SEG_MIN_DUR);
        }
        seg.start_time = Math.round(seg.start_time * 10) / 10;
        seg.end_time = Math.round(seg.end_time * 10) / 10;
        seg.index = i + 1;
    });
}
function _syncAdjacentBoundary(idx, boundary, value) {
    const dur = _getEditorDuration() || 9999;
    const seg = editorSegments[idx];
    if(!seg) return false;
    let changed = false;
    const rounded = Math.round(Math.max(0, Math.min(dur, value)) * 10) / 10;
    if(boundary === 'start') {
        const prev = idx > 0 ? editorSegments[idx - 1] : null;
        let newStart = Math.max(0, Math.min(rounded, seg.end_time - SEG_MIN_DUR));
        if(prev) {
            const linked = _linkedPairs.has(`${idx-1}:${idx}`);
            if(linked) {
                const minPrevEnd = prev.start_time + SEG_MIN_DUR;
                newStart = Math.max(minPrevEnd, newStart);
                if(prev.end_time !== newStart) {
                    prev.end_time = newStart;
                    changed = true;
                }
            } else {
                newStart = Math.max(prev.end_time, newStart);
            }
        }
        changed = seg.start_time !== newStart || changed;
        seg.start_time = newStart;
    } else {
        const next = idx < editorSegments.length - 1 ? editorSegments[idx + 1] : null;
        let newEnd = Math.min(dur, Math.max(rounded, seg.start_time + SEG_MIN_DUR));
        if(next) {
            const linked = _linkedPairs.has(`${idx}:${idx+1}`);
            if(linked) {
                const maxNextStart = next.end_time - SEG_MIN_DUR;
                newEnd = Math.min(maxNextStart, newEnd);
                if(next.start_time !== newEnd) {
                    next.start_time = newEnd;
                    changed = true;
                }
            } else {
                newEnd = Math.min(next.start_time, newEnd);
            }
        }
        changed = seg.end_time !== newEnd || changed;
        seg.end_time = newEnd;
    }
    seg.start_time = Math.round(seg.start_time * 10) / 10;
    seg.end_time = Math.round(seg.end_time * 10) / 10;
    editorSegments.forEach((item, i) => item.index = i + 1);
    return changed;
}
function edUndo() {
    if(editorHistoryIdx <= 0) return;
    editorHistoryIdx--;
    editorSegments = JSON.parse(editorHistory[editorHistoryIdx]);
    _rebuildLinkedPairs();
    _markDirty(); _renderSegList(); _renderOverlay(); _updateUndoBtn();
}

function edRedo() {
    if(editorHistoryIdx >= editorHistory.length-1) return;
    editorHistoryIdx++;
    editorSegments = JSON.parse(editorHistory[editorHistoryIdx]);
    _rebuildLinkedPairs();
    _markDirty(); _renderSegList(); _renderOverlay(); _updateUndoBtn();
}
function _updateUndoBtn() {
    const u = document.getElementById('btnUndo'), r = document.getElementById('btnRedo');
    if(u) u.disabled = editorHistoryIdx <= 0;
    if(r) r.disabled = editorHistoryIdx >= editorHistory.length-1;
}
function _commitChange() {
    _pushHistory();
    _markDirty();
    _rebuildLinkedPairs();
    _editorSegListVersion = '';
    _editorOverlayVersion = '';
    _renderSegList();
    _renderOverlay();
}

// ===== 拖拽手柄 =====
let _dragInfo = null;
function _startDrag(e) {
    if (_editorLocked) return;
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
        const newStart = Math.max(0, origStart + dt);
        _syncAdjacentBoundary(idx, 'start', newStart);
    } else {
        const newEnd = Math.min(dur, origEnd + dt);
        _syncAdjacentBoundary(idx, 'end', newEnd);
    }
    _renderOverlay();
    _renderSegList();
}
function _endDrag() {
    document.removeEventListener('mousemove', _onDrag);
    document.removeEventListener('mouseup', _endDrag);
    if(_dragInfo) {
        const { idx, side } = _dragInfo;
        _dragInfo = null;
        _rebuildLinkedPairs();
        _checkSmallGapAfterEdit(idx, side);
        _pushHistory();
        _markDirty();
        _editorSegListVersion = '';
        _editorOverlayVersion = '';
        _renderSegList();
        _renderOverlay();
        _updateUndoBtn();
    }
}

function _checkSmallGapAfterEdit(idx, side) {
    const seg = editorSegments[idx];
    if(!seg) return;
    // 检查start侧（与前一段的间隙）
    if(idx > 0) {
        const prev = editorSegments[idx - 1];
        const gap = Math.round((seg.start_time - prev.end_time) * 10) / 10;
        if(gap > 0.05 && gap < 0.5) {
            showModal('空白段过小', `<p>检测到唱段 #${prev.index} 与 #${seg.index} 之间空白仅 ${gap.toFixed(1)} 秒（小于0.5s），是否直接删除空白贴合唱段？</p>`,
                `<button class="btn btn-outline" onclick="closeModal()">保留空白</button>
                 <button class="btn btn-primary" onclick="_mergeGap(${idx},'start')">贴合</button>`);
            return;
        }
    }
    // 检查end侧（与后一段的间隙）
    if(idx < editorSegments.length - 1) {
        const next = editorSegments[idx + 1];
        const gap = Math.round((next.start_time - seg.end_time) * 10) / 10;
        if(gap > 0.05 && gap < 0.5) {
            showModal('空白段过小', `<p>检测到唱段 #${seg.index} 与 #${next.index} 之间空白仅 ${gap.toFixed(1)} 秒（小于0.5s），是否直接删除空白贴合唱段？</p>`,
                `<button class="btn btn-outline" onclick="closeModal()">保留空白</button>
                 <button class="btn btn-primary" onclick="_mergeGap(${idx},'end')">贴合</button>`);
            return;
        }
    }
}

function _mergeGap(idx, side) {
    closeModal();
    const seg = editorSegments[idx];
    if(!seg) return;
    if(side === 'start' && idx > 0) {
        const prev = editorSegments[idx - 1];
        // 直接贴合：将前一段end移到当前段start
        prev.end_time = seg.start_time;
    }
    if(side === 'end' && idx < editorSegments.length - 1) {
        const next = editorSegments[idx + 1];
        // 直接贴合：将下一段start移到当前段end
        next.start_time = seg.end_time;
    }
    _commitChange();
}

// ===== 时间输入框修改 =====
function _onTimeInput(el) {
    const idx = +el.dataset.idx, field = el.dataset.field;
    let val = parseFloat(el.value);
    if(isNaN(val) || val < 0) return;
    const dur = _getEditorDuration() || 9999;
    let changed = false;
    if(field === 'start_time') {
        changed = _syncAdjacentBoundary(idx, 'start', Math.max(0, val));
    } else {
        changed = _syncAdjacentBoundary(idx, 'end', Math.min(dur, val));
    }
    const seg = editorSegments[idx];
    el.value = seg[field].toFixed(1);
    if(changed) {
        const side = field === 'start_time' ? 'start' : 'end';
        _checkSmallGapAfterEdit(idx, side);
        _commitChange();
    }
}

// ===== 微调时间 (←/→) =====
function _nudgeSegTime(dt) {
    if(editorActiveIdx < 0) return;
    const seg = editorSegments[editorActiveIdx];
    const dur = _getEditorDuration() || 9999;
    let ns = seg.start_time + dt, ne = seg.end_time + dt;
    if(ns < 0) { ne -= ns; ns = 0; }
    if(ne > dur) { ns -= (ne-dur); ne = dur; }
    ns = Math.round(ns * 10) / 10;
    ne = Math.round(ne * 10) / 10;
    let changed = _syncAdjacentBoundary(editorActiveIdx, 'start', ns);
    changed = _syncAdjacentBoundary(editorActiveIdx, 'end', ne) || changed;
    if(changed) _commitChange();
}

// ===== 新增唱段 =====
function _addSegAtCursor() {
    if(!editorSong) return;
    const t = _getEditorCurrentTime();
    _addSegAtTime(t);
}
function _addSegAtTime(t) {
    const dur = _getEditorDuration();
    const target = Math.round(t * 10) / 10;
    const idx = editorSegments.findIndex(s => target >= s.start_time && target < s.end_time);
    if(idx >= 0) {
        const seg = editorSegments[idx];
        if(seg.end_time - seg.start_time < SEG_MIN_DUR * 2) { showToast('当前唱段太短，无法在此处插入新段','error'); return; }
        const splitTime = Math.max(seg.start_time + SEG_MIN_DUR, Math.min(seg.end_time - SEG_MIN_DUR, target));
        const newSeg = {
            id: 'new_'+Date.now(),
            index: 0,
            lyrics: '',
            start_time: splitTime,
            end_time: seg.end_time,
            difficulty: 'normal',
            is_chorus: false,
            status: 'unassigned'
        };
        seg.end_time = splitTime;
        editorSegments.splice(idx + 1, 0, newSeg);
        editorSegments.forEach((s,i) => s.index = i+1);
        editorActiveIdx = idx + 1;
        _commitChange();
        showToast('已添加唱段','success');
        return;
    }
    let start = target;
    let end = Math.min(dur, Math.round((target + 5) * 10) / 10);
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
    const startVal = parseFloat(document.getElementById('segStart').value);
    const endVal = parseFloat(document.getElementById('segEnd').value);
    seg.lyrics = document.getElementById('segLyrics').value;
    seg.difficulty = document.getElementById('segDiff').value;
    seg.is_chorus = document.getElementById('segChorus').value === 'true';
    if(!Number.isNaN(startVal)) _syncAdjacentBoundary(idx, 'start', startVal);
    if(!Number.isNaN(endVal)) _syncAdjacentBoundary(idx, 'end', endVal);
    if(seg.end_time - seg.start_time < SEG_MIN_DUR) {
        showToast(`唱段最短${SEG_MIN_DUR}秒`,'error'); return;
    }
    _normalizeSegmentChain();
    closeModal();
    _commitChange();
    showToast('已更新','success');
}

// ===== 右键菜单 =====
function _showCtx(e, idx) {
    if (_editorLocked) { e.preventDefault(); return; }
    e.preventDefault(); e.stopPropagation();
    _selectSeg(idx, false);
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

// ===== 波形空白区域右键菜单 =====
function _onOverlayContextMenu(e) {
    if (_editorLocked) { e.preventDefault(); return; }
    // 如果点击在seg-block上，不处理（由seg-block自己的contextmenu处理）
    if(e.target.closest('.seg-block')) return;
    e.preventDefault();
    e.stopPropagation();
    if(!editorSong || !editorWS) return;
    const dur = _getEditorDuration();
    if(!dur) return;
    const host = document.getElementById('waveHost');
    const waveArea = document.getElementById('waveArea');
    if(!host || !waveArea) return;
    const widthPx = _editorWaveMetrics.width || host.clientWidth || 0;
    if(!widthPx) return;
    // 计算点击位置对应的时间
    const rect = waveArea.getBoundingClientRect();
    const rawX = e.clientX - rect.left + waveArea.scrollLeft;
    const clickTime = Math.max(0, Math.min(dur, (rawX / widthPx) * dur));
    // 检查是否在空白区域
    const inSeg = editorSegments.some(s => clickTime >= s.start_time && clickTime < s.end_time);
    if(inSeg) return;
    // 计算空白区域范围
    let blankStart = 0, blankEnd = dur;
    for(const s of editorSegments) {
        if(s.end_time <= clickTime && s.end_time > blankStart) blankStart = s.end_time;
        if(s.start_time > clickTime && s.start_time < blankEnd) blankEnd = s.start_time;
    }
    const blankDur = blankEnd - blankStart;
    if(blankDur < 3.0) return; // 空白段不足3秒，不显示菜单
    const cm = document.getElementById('ctxMenu');
    const blankDurStr = blankDur.toFixed(1);
    cm.innerHTML = `
        <div class="ctx-menu-item" onclick="_addSegInBlank(${blankStart},${blankEnd},${clickTime});_hideCtx()">➕ 新建唱段切片 (空白 ${blankDurStr}s)</div>`;
    cm.style.display = 'block';
    cm.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
    cm.style.top = Math.min(e.clientY, window.innerHeight - 80) + 'px';
}

function _addSegInBlank(blankStart, blankEnd, clickTime) {
    if(!editorSong) return;
    const dur = _getEditorDuration();
    // 在空白区域创建新唱段，以点击位置为中心，默认5秒
    const defaultLen = 5;
    let start = Math.max(blankStart, clickTime - defaultLen / 2);
    let end = Math.min(blankEnd, start + defaultLen);
    if(end - start < SEG_MIN_DUR) {
        start = blankStart;
        end = Math.min(blankEnd, blankStart + defaultLen);
    }
    if(end - start < SEG_MIN_DUR) {
        showToast('空白区域不足以创建唱段', 'error');
        return;
    }
    start = Math.round(start * 10) / 10;
    end = Math.round(end * 10) / 10;
    const newSeg = {
        id: 'new_' + Date.now(),
        index: 0,
        lyrics: '',
        start_time: start,
        end_time: end,
        difficulty: 'normal',
        is_chorus: false,
        status: 'unassigned'
    };
    editorSegments.push(newSeg);
    editorSegments.sort((a, b) => a.start_time - b.start_time);
    editorSegments.forEach((s, i) => s.index = i + 1);
    editorActiveIdx = editorSegments.indexOf(newSeg);
    _commitChange();
    showToast('已新建唱段切片', 'success');
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
    editorActiveIdx = idx;
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
    if(!editorSong || _editorLocked) return;
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
        const res = await aPut(`/admin/songs/${editorSong.id}/segments/batch`, { segments: editorSegments });
        // 后端检测到有失效录音，需要确认
        if(res.need_confirm) {
            const lines = res.detail.map(d => `#${d.index}「${d.lyrics||'(无歌词)'}」${d.count}条`).join('\n');
            showModal('录音清理确认',
                `<p>本次保存将导致 <b>${res.orphan_count}</b> 条用户录音失效（对应的唱段已被修改或删除）：</p>
                 <pre style="max-height:160px;overflow:auto;background:#f8f9fa;padding:8px;border-radius:6px;font-size:12px;line-height:1.6;">${lines}</pre>
                 <p style="color:#dc2626;margin-top:8px;">确认保存后，这些录音将被永久删除且无法恢复。</p>`,
                `<button class="btn btn-outline" onclick="closeModal()">取消</button>
                 <button class="btn btn-danger" onclick="_confirmSaveWithDelete()">确认保存并删除录音</button>`);
            return;
        }
        _onSaveSuccess(res);
    } catch(e) { showToast(e.message,'error'); }
}

async function _confirmSaveWithDelete() {
    closeModal();
    try {
        const res = await aPut(`/admin/songs/${editorSong.id}/segments/batch`, {
            segments: editorSegments,
            confirm_delete: true
        });
        if(res.deleted_recordings > 0) {
            showToast(`已保存，清理了 ${res.deleted_recordings} 条失效录音`, 'success');
        }
        _onSaveSuccess(res);
    } catch(e) { showToast(e.message,'error'); }
}

async function _onSaveSuccess(res) {
    editorDirty = false;
    document.getElementById('edUnsaved').style.display = 'none';
    if(!res.deleted_recordings) showToast('全部保存成功','success');
    // 刷新数据
    const songRes = await aGet(`/admin/songs/${editorSong.id}`);
    editorSong = songRes.data;
    editorSegments = JSON.parse(JSON.stringify(editorSong.segments||[]));
    _editorSegListVersion = '';
    editorHistory = []; editorHistoryIdx = -1; _pushHistory();
    _renderSegList(); _renderOverlay();
}

// ===== 重置为服务器原始方案 =====
function _resetSegments() {
    if(!editorSong || _editorLocked) return;
    showModal('重置唱段', '<p>是否重置为AI自动切分方案？当前所有未保存的修改将丢失。</p>',
        `<button class="btn btn-outline" onclick="closeModal()">取消</button>
         <button class="btn btn-danger" onclick="_confirmReset()">确认重置</button>`);
}
async function _confirmReset() {
    closeModal();
    try {
        const res = await aGet(`/admin/songs/${editorSong.id}`);
        editorSong = res.data;
        editorSegments = JSON.parse(JSON.stringify(editorSong.segments||[]));
        editorActiveIdx = -1;
        _editorHighlightedIdx = -1;
        _editorPlayingIdx = -1;
        _editorSegListVersion = '';
        _editorOverlayVersion = '';
        editorDirty = false;
        editorHistory = []; editorHistoryIdx = -1;
        _pushHistory();
        document.getElementById('edUnsaved').style.display = 'none';
        _syncToolbarSegButtons();
        _renderSegList();
        _renderOverlay();
        showToast('已重置为AI自动切分方案','success');
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

// ===== 发布/取消任务 =====

function _togglePublishTask() {
    if (!editorSong) return;
    if (editorSong.task_published) {
        _unpublishTask();
    } else {
        _publishTask();
    }
}

function _publishTask() {
    if (!editorSong) return;
    if (editorDirty) {
        showToast('请先保存当前修改', 'warning');
        return;
    }
    if (!editorSegments.length) {
        showToast('歌曲没有唱段数据，请先完成分段编辑', 'warning');
        return;
    }
    showModal('发布任务',
        `<p style="color:#dc2626;font-weight:600;">一旦发布歌曲任务，歌曲分段编辑数据将不能再进行修改，否则将丢失所有的用户录音片段！</p>
         <p style="margin-top:8px;">确定要发布「${editorSong.title}」的拼歌任务吗？</p>`,
        `<button class="btn btn-outline" onclick="closeModal()">取消</button>
         <button class="btn btn-primary" onclick="_confirmPublishTask()">确认发布</button>`);
}

async function _confirmPublishTask() {
    closeModal();
    if (!editorSong) return;
    try {
        await aPost(`/admin/songs/${editorSong.id}/publish-task`, {});
        editorSong.task_published = true;
        showToast('任务已发布', 'success');
        _applyPublishLock();
        _renderEditorShareLink();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function _unpublishTask() {
    if (!editorSong) return;
    showModal('取消任务',
        `<p style="color:#dc2626;font-weight:600;">一旦取消任务将删除当前任务的所有用户录音片段，并恢复歌曲唱段切分的可编辑状态。</p>
         <p style="margin-top:8px;">确定要取消「${editorSong.title}」的拼歌任务吗？</p>`,
        `<button class="btn btn-outline" onclick="closeModal()">取消</button>
         <button class="btn btn-danger" onclick="_confirmUnpublishTask()">确认取消任务</button>`);
}

async function _confirmUnpublishTask() {
    closeModal();
    if (!editorSong) return;
    try {
        const res = await aPost(`/admin/songs/${editorSong.id}/unpublish-task`, {});
        editorSong.task_published = false;
        showToast(`任务已取消，已删除 ${res.deleted_recordings || 0} 条录音`, 'success');
        // 刷新歌曲数据
        const songRes = await aGet(`/admin/songs/${editorSong.id}`);
        editorSong = songRes.data;
        editorSegments = JSON.parse(JSON.stringify(editorSong.segments || []));
        _editorSegListVersion = '';
        editorHistory = []; editorHistoryIdx = -1; _pushHistory();
        _renderSegList(); _renderOverlay();
        _applyPublishLock();
        _renderEditorShareLink();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function _applyPublishLock() {
    const isPublished = !!(editorSong && editorSong.task_published);
    _editorLocked = isPublished;

    const btnPublish = document.getElementById('btnPublishTask');
    if (btnPublish) {
        if (isPublished) {
            btnPublish.textContent = '🚫 取消任务';
            btnPublish.className = 'btn btn-danger btn-sm';
            btnPublish.style.marginLeft = '6px';
        } else {
            btnPublish.textContent = '📢 发布任务';
            btnPublish.className = 'btn btn-primary btn-sm';
            btnPublish.style.marginLeft = '6px';
        }
    }

    // 锁定/解锁编辑控件
    const lockIds = [
        'btnSaveAll', 'btnReset',
        'btnUndo', 'btnRedo',
        'segDetailStart', 'segDetailEnd',
        'sdBtnAdjust', 'sdBtnSplit', 'sdBtnMerge', 'sdBtnDelete'
    ];
    lockIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = isPublished;
    });

    // 波形锁定覆盖层
    const waveArea = document.getElementById('waveArea');
    if (waveArea) {
        let lockOverlay = document.getElementById('editorLockOverlay');
        if (isPublished) {
            if (!lockOverlay) {
                lockOverlay = document.createElement('div');
                lockOverlay.id = 'editorLockOverlay';
                lockOverlay.className = 'editor-lock-overlay';
                lockOverlay.innerHTML = '<div class="lock-badge">🔒 任务已发布 · 编辑已锁定</div>';
                waveArea.parentElement.style.position = 'relative';
                waveArea.parentElement.appendChild(lockOverlay);
            }
            lockOverlay.style.display = '';
        } else {
            if (lockOverlay) lockOverlay.style.display = 'none';
        }
    }

    // 禁止拖拽操作
    const overlayHost = document.getElementById('segOverlay');
    if (overlayHost) {
        overlayHost.style.pointerEvents = isPublished ? 'none' : '';
    }

    _renderEditorShareLink();
}

function _getEditorShareUrl() {
    if (!editorSong) return '';
    const taskTarget = `task.html?song=${encodeURIComponent(editorSong.id)}`;
    const pageUrl = new URL('index.html', window.location.href);
    pageUrl.searchParams.set('target', taskTarget);
    return pageUrl.href;
}

function _renderEditorShareLink() {
    const wrap = document.getElementById('editorShareLink');
    const input = document.getElementById('editorShareUrl');
    if (!wrap || !input) return;
    const isPublished = !!(editorSong && editorSong.task_published);
    wrap.style.display = isPublished ? '' : 'none';
    input.value = isPublished ? _getEditorShareUrl() : '';
}

function _bindEditorShareLink() {
    _renderEditorShareLink();
    const btn = document.getElementById('btnCopyShareLink');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
        const input = document.getElementById('editorShareUrl');
        if (!input || !input.value) return;
        try {
            await navigator.clipboard.writeText(input.value);
            showToast('分享链接已复制', 'success');
        } catch (e) {
            input.select();
            document.execCommand('copy');
            showToast('分享链接已复制', 'success');
        }
    });
}