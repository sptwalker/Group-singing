// ===== 仪表盘模块 =====
async function renderDashboard(container) {
    try {
        const [statsRes, songsRes] = await Promise.all([aGet('/admin/stats'), aGet('/admin/songs')]);
        const st = statsRes.data, songs = songsRes.data;
        container.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-icon">🎶</div><div class="stat-value">${st.total_songs}</div><div class="stat-label">歌曲总数</div></div>
            <div class="stat-card"><div class="stat-icon">✂️</div><div class="stat-value">${st.total_segments}</div><div class="stat-label">唱段总数</div></div>
            <div class="stat-card"><div class="stat-icon">🎤</div><div class="stat-value">${st.total_recordings}</div><div class="stat-label">录音数</div></div>
            <div class="stat-card"><div class="stat-icon">👥</div><div class="stat-value">${st.total_users}</div><div class="stat-label">参与用户</div></div>
            <div class="stat-card"><div class="stat-icon">✅</div><div class="stat-value">${st.completed_segments}</div><div class="stat-label">已完成唱段</div></div>
            <div class="stat-card"><div class="stat-icon">📤</div><div class="stat-value">${st.submitted_recordings}</div><div class="stat-label">已提交录音</div></div>
        </div>
        <div class="card"><div class="card-header"><h3>歌曲概览</h3></div>
        <div class="card-body"><div class="table-wrap"><table>
            <thead><tr><th>歌曲</th><th>艺术家</th><th>时长</th><th>唱段</th><th>已认领</th><th>已完成</th><th>录音</th><th>完成度</th></tr></thead>
            <tbody>${songs.map(s => `<tr>
                <td><strong>${s.title}</strong></td><td>${s.artist}</td><td>${fmtTime(s.duration)}</td>
                <td>${s.segment_count}</td><td>${s.claimed_count||0}</td><td>${s.completed_count||0}</td><td>${s.recording_count||0}</td>
                <td><div style="display:flex;align-items:center;gap:8px;"><div style="flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;min-width:60px;"><div style="height:100%;background:var(--primary);width:${s.completion||0}%;border-radius:3px;"></div></div><span style="font-size:12px;color:var(--text-secondary);">${s.completion||0}%</span></div></td>
            </tr>`).join('')}</tbody>
        </table></div></div></div>`;
    } catch (e) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`; }
}

// ===== 歌曲库模块 =====
async function renderSongs(container) {
    try {
        const res = await aGet('/admin/songs');
        const songs = res.data;
        container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <span style="color:var(--text-secondary);font-size:13px;">共 ${songs.length} 首歌曲</span>
        </div>
        <div class="song-grid">${songs.map(s => `
            <div class="song-card" data-id="${s.id}">
                <div class="song-card-header">
                    <div class="song-card-icon">🎵</div>
                    <div class="song-card-info">
                        <h4>${s.title}</h4>
                        <p>${s.artist} · ${fmtTime(s.duration)}</p>
                    </div>
                </div>
                <div class="song-card-stats">
                    <span>✂️ ${s.segment_count} 段</span>
                    <span>👥 ${s.participant_count} 人</span>
                    <span>🎤 ${s.recording_count||0} 录音</span>
                </div>
                <div class="song-card-progress"><div class="bar" style="width:${s.completion||0}%"></div></div>
                <div class="song-card-actions">
                    <button class="btn btn-outline btn-sm" onclick="editSongInfo('${s.id}')">编辑信息</button>
                    <button class="btn btn-primary btn-sm" onclick="openEditorForSong('${s.id}')">分段编辑</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteSong('${s.id}','${s.title}')">删除</button>
                </div>
            </div>
        `).join('')}</div>`;
    } catch (e) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`; }
}

async function editSongInfo(songId) {
    try {
        const res = await aGet(`/admin/songs/${songId}`);
        const s = res.data;
        showModal('编辑歌曲信息', `
            <div class="field"><label>歌曲名</label><input id="editTitle" value="${s.title}"></div>
            <div class="field"><label>艺术家</label><input id="editArtist" value="${s.artist}"></div>
            <div class="field"><label>时长(秒)</label><input id="editDuration" type="number" step="0.1" value="${s.duration}"></div>
        `, `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="saveSongInfo('${songId}')">保存</button>`);
    } catch (e) { showToast(e.message, 'error'); }
}

async function saveSongInfo(songId) {
    try {
        await aPut(`/admin/songs/${songId}`, {
            title: document.getElementById('editTitle').value,
            artist: document.getElementById('editArtist').value,
            duration: parseFloat(document.getElementById('editDuration').value)
        });
        closeModal();
        showToast('保存成功', 'success');
        renderSongs(document.getElementById('moduleContainer'));
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteSong(songId, title) {
    showModal('确认删除', `<p>确定要删除歌曲 <strong>${title}</strong> 吗？此操作不可恢复。</p>`,
        `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="confirmDeleteSong('${songId}')">确认删除</button>`);
}
async function confirmDeleteSong(songId) {
    try {
        await aDel(`/admin/songs/${songId}`);
        closeModal(); showToast('已删除', 'success');
        renderSongs(document.getElementById('moduleContainer'));
    } catch (e) { showToast(e.message, 'error'); }
}

// openEditorForSong 已移至 admin-editor2.js
