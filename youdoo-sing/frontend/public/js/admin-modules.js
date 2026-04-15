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
        let songs = res.data;

        // 标准化字段：audio_file_exists 未返回时默认为 true
        songs.forEach(s => {
            if (s.audio_file_exists === undefined) s.audio_file_exists = true;
            if (s.has_accompaniment === undefined) s.has_accompaniment = !!s.accompaniment_url;
        });

        // 检查歌曲文件是否存在，不存在则在卡片上标记警告
        const missing = songs.filter(s => s.audio_file_exists === false);
        if (missing.length > 0) {
            const names = missing.map(s => s.title).join('、');
            showToast(`以下歌曲的音频文件已丢失：${names}，请重新上传或删除`, 'warning');
        }

        container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <span style="color:var(--text-secondary);font-size:13px;">共 ${songs.length} 首歌曲</span>
            <button class="btn btn-primary" onclick="showUploadSongDialog()">+ 上传新歌曲</button>
        </div>
        ${songs.length === 0 ? `
        <div class="empty-state" style="padding:60px 20px;text-align:center;">
            <div class="empty-icon" style="font-size:48px;margin-bottom:16px;">🎵</div>
            <h3 style="margin-bottom:8px;color:var(--text-primary);">歌曲库为空</h3>
            <p style="color:var(--text-secondary);margin-bottom:20px;">点击上方按钮上传第一首歌曲，系统将自动完成唱段切分</p>
            <button class="btn btn-primary" onclick="showUploadSongDialog()">+ 上传新歌曲</button>
        </div>` : `
        <div class="song-grid">${songs.map(s => `
            <div class="song-card${s.audio_file_exists === false ? ' song-card-missing' : ''}" data-id="${s.id}">
                ${s.audio_file_exists === false ? '<div class="song-card-warning">⚠️ 音频文件丢失</div>' : ''}
                <div class="song-card-header">
                    <div class="song-card-icon">🎵</div>
                    <div class="song-card-info">
                        <h4>${s.title}</h4>
                        <p>${s.artist || '未知艺术家'} · ${fmtTime(s.duration)}</p>
                    </div>
                </div>
                <div class="song-card-stats">
                    <span>✂️ ${s.segment_count} 段</span>
                    <span>👥 ${s.participant_count} 人</span>
                    <span>🎤 ${s.recording_count||0} 录音</span>
                </div>
                <div class="song-card-progress"><div class="bar" style="width:${s.completion||0}%"></div></div>
                <div class="song-card-acc">
                    ${s.has_accompaniment
                        ? `<span class="acc-badge">✅ 有伴奏</span><button class="btn btn-outline btn-sm acc-del-btn" onclick="deleteAccForSong('${s.id}','${s.title.replace(/'/g,"\\\\'")}')" title="删除伴奏后可重新上传">🗑 删除伴奏</button>`
                        : `<button class="btn btn-outline btn-sm acc-upload-btn" onclick="uploadAccForSong('${s.id}','${s.title.replace(/'/g,"\\'")}')">🎹 上传伴奏</button>`
                    }
                </div>
                <div class="song-card-actions">
                    <button class="btn btn-outline btn-sm" onclick="editSongInfo('${s.id}')">编辑信息</button>
                    <button class="btn btn-primary btn-sm" onclick="openEditorForSong('${s.id}')">分段编辑</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteSong('${s.id}','${s.title}')">删除</button>
                </div>
            </div>
        `).join('')}</div>`}`;
    } catch (e) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`; }
}

// ===== 上传歌曲对话框 =====
function showUploadSongDialog() {
    showModal('上传新歌曲', `
        <div class="field" style="margin-bottom:16px;">
            <label style="display:block;font-weight:600;margin-bottom:6px;">音频文件 <span style="color:#ef4444;">*</span></label>
            <div id="uploadDropZone" style="border:2px dashed var(--border);border-radius:8px;padding:32px 20px;text-align:center;cursor:pointer;transition:all .2s;background:var(--bg-secondary);">
                <div style="font-size:32px;margin-bottom:8px;">📁</div>
                <p style="color:var(--text-secondary);margin-bottom:8px;">点击选择或拖拽音频文件到此处</p>
                <p style="font-size:12px;color:var(--text-light);">支持 MP3、WAV、FLAC、OGG、M4A 格式，最大 100MB</p>
                <input type="file" id="uploadAudioFile" accept=".mp3,.wav,.flac,.ogg,.m4a,.aac,.wma" style="display:none;">
            </div>
            <div id="uploadFileInfo" style="display:none;margin-top:8px;padding:10px 14px;background:var(--bg-secondary);border-radius:6px;font-size:13px;">
                <span id="uploadFileName" style="color:var(--text-primary);font-weight:500;"></span>
                <span id="uploadFileSize" style="color:var(--text-secondary);margin-left:8px;"></span>
                <button onclick="clearUploadFile()" style="float:right;background:none;border:none;color:var(--text-light);cursor:pointer;font-size:16px;">×</button>
            </div>
        </div>
        <div class="field" style="margin-bottom:16px;">
            <label style="display:block;font-weight:600;margin-bottom:6px;">歌曲名称 <span style="color:#ef4444;">*</span></label>
            <input id="uploadTitle" placeholder="输入歌曲名称" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:6px;font-size:14px;">
        </div>
        <div class="field" style="margin-bottom:16px;">
            <label style="display:block;font-weight:600;margin-bottom:6px;">艺术家</label>
            <input id="uploadArtist" placeholder="输入艺术家名称（可选）" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:6px;font-size:14px;">
        </div>
        <div id="uploadProgress" style="display:none;margin-top:12px;">
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;">
                    <div id="uploadProgressBar" style="height:100%;background:var(--primary);width:0%;border-radius:3px;transition:width .3s;"></div>
                </div>
                <span id="uploadProgressText" style="font-size:12px;color:var(--text-secondary);min-width:40px;">0%</span>
            </div>
            <p id="uploadStatusText" style="font-size:12px;color:var(--text-secondary);margin-top:6px;">上传中...</p>
        </div>
    `, `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" id="btnDoUpload" onclick="doUploadSong()">上传并AI识别切分</button>`);

    // 绑定事件
    const dropZone = document.getElementById('uploadDropZone');
    const fileInput = document.getElementById('uploadAudioFile');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; dropZone.style.background = 'rgba(79,70,229,0.05)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border)'; dropZone.style.background = 'var(--bg-secondary)'; });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--border)'; dropZone.style.background = 'var(--bg-secondary)';
        if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; handleUploadFileSelect(); }
    });
    fileInput.addEventListener('change', handleUploadFileSelect);
}

function handleUploadFileSelect() {
    const fileInput = document.getElementById('uploadAudioFile');
    const file = fileInput.files[0];
    if (!file) return;

    document.getElementById('uploadDropZone').style.display = 'none';
    document.getElementById('uploadFileInfo').style.display = 'block';
    document.getElementById('uploadFileName').textContent = file.name;
    document.getElementById('uploadFileSize').textContent = (file.size / 1024 / 1024).toFixed(1) + ' MB';

    // 自动填充歌曲名
    const titleInput = document.getElementById('uploadTitle');
    if (!titleInput.value) {
        let name = file.name.replace(/\.[^.]+$/, '');
        // 尝试解析 "艺术家 - 歌曲名" 格式
        const match = name.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (match) {
            const artistInput = document.getElementById('uploadArtist');
            if (!artistInput.value) artistInput.value = match[1].trim();
            titleInput.value = match[2].trim();
        } else {
            titleInput.value = name;
        }
    }
}

function clearUploadFile() {
    document.getElementById('uploadAudioFile').value = '';
    document.getElementById('uploadDropZone').style.display = '';
    document.getElementById('uploadFileInfo').style.display = 'none';
}

async function doUploadSong() {
    const fileInput = document.getElementById('uploadAudioFile');
    const file = fileInput.files[0];
    const title = document.getElementById('uploadTitle').value.trim();

    if (!file) { showToast('请选择音频文件', 'error'); return; }
    if (!title) { showToast('请输入歌曲名称', 'error'); return; }
    if (file.size > 100 * 1024 * 1024) { showToast('文件大小不能超过 100MB', 'error'); return; }

    const btn = document.getElementById('btnDoUpload');
    btn.disabled = true; btn.textContent = '上传中...';
    document.getElementById('uploadProgress').style.display = 'block';

    const formData = new FormData();
    formData.append('title', title);
    formData.append('artist', document.getElementById('uploadArtist').value.trim());
    formData.append('audio', file);

    try {
        const xhr = new XMLHttpRequest();
        const result = await new Promise((resolve, reject) => {
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round(e.loaded / e.total * 100);
                    document.getElementById('uploadProgressBar').style.width = pct + '%';
                    document.getElementById('uploadProgressText').textContent = pct + '%';
                    document.getElementById('uploadStatusText').textContent = pct < 100 ? '上传中...' : '正在AI识别歌词并切分唱段，请稍候...';
                }
            });
            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    try { reject(new Error(JSON.parse(xhr.responseText).detail)); }
                    catch { reject(new Error(`上传失败(${xhr.status})`)); }
                }
            });
            xhr.addEventListener('error', () => reject(new Error('网络错误')));
            xhr.open('POST', `${API}/admin/songs/upload`);
            xhr.setRequestHeader('Authorization', `Bearer ${adminToken}`);
            xhr.send(formData);
        });

        closeModal();
        if (result.data.ai_split === false) {
            showToast(`歌曲 "${title}" 上传成功，已自动切分为 ${result.data.segment_count || '若干'} 个唱段（基于静音检测，歌词需手动填写）`, 'warning');
        } else {
            showToast(`歌曲 "${title}" 上传成功，AI已识别歌词并智能切分为 ${result.data.segment_count} 个唱段（含副歌/难度标注）`, 'success');
        }

        // 跳转到分段编辑器
        if (typeof openEditorForSong === 'function') {
            switchModule('editor');
            setTimeout(() => openEditorForSong(result.data.id), 300);
        } else {
            renderSongs(document.getElementById('moduleContainer'));
        }
    } catch (e) {
        showToast(e.message, 'error');
        btn.disabled = false; btn.textContent = '上传并AI识别切分';
        document.getElementById('uploadProgress').style.display = 'none';
    }
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

// ===== 删除伴奏 =====
function deleteAccForSong(songId, songTitle) {
    showModal('确认删除伴奏', `<p>确定要删除歌曲 <strong>${songTitle}</strong> 的伴奏吗？删除后可重新上传。</p>`,
        `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="confirmDeleteAcc('${songId}')">确认删除</button>`);
}
async function confirmDeleteAcc(songId) {
    try {
        await aDel(`/admin/songs/${songId}/accompaniment`);
        closeModal();
        showToast('伴奏已删除', 'success');
        renderSongs(document.getElementById('moduleContainer'));
    } catch (e) { showToast(e.message, 'error'); }
}

// ===== 上传伴奏 =====
function uploadAccForSong(songId, songTitle) {
    showModal('上传伴奏 - ' + songTitle, `
        <div class="field" style="margin-bottom:16px;">
            <label style="display:block;font-weight:600;margin-bottom:6px;">伴奏音频文件 <span style="color:#ef4444;">*</span></label>
            <div id="accDropZone" style="border:2px dashed var(--border);border-radius:8px;padding:32px 20px;text-align:center;cursor:pointer;transition:all .2s;background:var(--bg-secondary);">
                <div style="font-size:32px;margin-bottom:8px;">🎹</div>
                <p style="color:var(--text-secondary);margin-bottom:8px;">点击选择或拖拽伴奏文件到此处</p>
                <p style="font-size:12px;color:var(--text-light);">支持 MP3、WAV、FLAC、OGG、M4A 格式，时长需与原曲基本一致</p>
                <input type="file" id="accAudioFile" accept=".mp3,.wav,.flac,.ogg,.m4a,.aac,.wma" style="display:none;">
            </div>
            <div id="accFileInfo" style="display:none;margin-top:8px;padding:10px 14px;background:var(--bg-secondary);border-radius:6px;font-size:13px;">
                <span id="accFileName" style="color:var(--text-primary);font-weight:500;"></span>
                <span id="accFileSize" style="color:var(--text-secondary);margin-left:8px;"></span>
                <button onclick="document.getElementById('accAudioFile').value='';document.getElementById('accDropZone').style.display='';document.getElementById('accFileInfo').style.display='none';" style="float:right;background:none;border:none;color:var(--text-light);cursor:pointer;font-size:16px;">×</button>
            </div>
        </div>
        <div id="accUploadProgress" style="display:none;margin-top:12px;">
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;">
                    <div id="accProgressBar" style="height:100%;background:var(--primary);width:0%;border-radius:3px;transition:width .3s;"></div>
                </div>
                <span id="accProgressText" style="font-size:12px;color:var(--text-secondary);min-width:40px;">0%</span>
            </div>
            <p id="accStatusText" style="font-size:12px;color:var(--text-secondary);margin-top:6px;">上传中...</p>
        </div>
    `, `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" id="btnDoAccUpload" onclick="doUploadAcc('${songId}')">上传伴奏</button>`);

    const dropZone = document.getElementById('accDropZone');
    const fileInput = document.getElementById('accAudioFile');
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; dropZone.style.background = 'rgba(79,70,229,0.05)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border)'; dropZone.style.background = 'var(--bg-secondary)'; });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--border)'; dropZone.style.background = 'var(--bg-secondary)';
        if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; _showAccFileInfo(); }
    });
    fileInput.addEventListener('change', _showAccFileInfo);
}

function _showAccFileInfo() {
    const file = document.getElementById('accAudioFile').files[0];
    if (!file) return;
    document.getElementById('accDropZone').style.display = 'none';
    document.getElementById('accFileInfo').style.display = 'block';
    document.getElementById('accFileName').textContent = file.name;
    document.getElementById('accFileSize').textContent = (file.size / 1024 / 1024).toFixed(1) + ' MB';
}

async function doUploadAcc(songId) {
    const file = document.getElementById('accAudioFile').files[0];
    if (!file) { showToast('请选择伴奏文件', 'error'); return; }
    if (file.size > 100 * 1024 * 1024) { showToast('文件大小不能超过 100MB', 'error'); return; }

    const btn = document.getElementById('btnDoAccUpload');
    btn.disabled = true; btn.textContent = '上传中...';
    document.getElementById('accUploadProgress').style.display = 'block';

    const formData = new FormData();
    formData.append('audio', file);

    try {
        const xhr = new XMLHttpRequest();
        const result = await new Promise((resolve, reject) => {
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round(e.loaded / e.total * 100);
                    document.getElementById('accProgressBar').style.width = pct + '%';
                    document.getElementById('accProgressText').textContent = pct + '%';
                    document.getElementById('accStatusText').textContent = pct < 100 ? '上传中...' : '正在校验伴奏时长...';
                }
            });
            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    try { reject(new Error(JSON.parse(xhr.responseText).detail)); }
                    catch { reject(new Error(`上传失败(${xhr.status})`)); }
                }
            });
            xhr.addEventListener('error', () => reject(new Error('网络错误')));
            xhr.open('POST', `${API}/admin/songs/${songId}/accompaniment`);
            xhr.setRequestHeader('Authorization', `Bearer ${adminToken}`);
            xhr.send(formData);
        });

        closeModal();
        showToast('伴奏上传成功', 'success');
        renderSongs(document.getElementById('moduleContainer'));
    } catch (e) {
        showToast(e.message, 'error');
        btn.disabled = false; btn.textContent = '上传伴奏';
        document.getElementById('accUploadProgress').style.display = 'none';
    }
}

// openEditorForSong 已移至 admin-editor2.js
