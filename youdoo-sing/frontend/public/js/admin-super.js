// ===== 超级管理员模块 =====
function _superEscape(v) {
    return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function _superSettingValue(settings, key, fallback = '') {
    const row = settings?.[key];
    if (!row) return fallback;
    if (row.value_type === 'bool') return row.value === true || row.value === 'true';
    if (row.value_type === 'int') return parseInt(row.value || fallback || 0, 10);
    return row.value ?? fallback;
}

function _superStatusBadge(status) {
    if (status === 'active') return '<span class="badge badge-completed">正常</span>';
    if (status === 'frozen') return '<span class="badge badge-hard">已冻结</span>';
    if (status === 'deleted') return '<span class="badge badge-unassigned">已软删除</span>';
    return `<span class="badge badge-unassigned">${_superEscape(status || '-')}</span>`;
}

function _superBuildUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    const p = path.startsWith('/') ? path : `/${path}`;
    const base = (typeof API === 'string' ? API : '').replace(/\/api\/?$/, '');
    return base ? `${base}${p}` : `${window.location.origin}${p}`;
}

async function _superLoadStats() {
    return (await aGet('/super/stats')).data || {};
}

function _renderStatsCards(stats) {
    const server = stats.server || {};
    return `
    <div class="stats-grid">
        <div class="stat-card"><div class="stat-icon">👥</div><div class="stat-value">${stats.admin_count || 0}</div><div class="stat-label">管理员总数</div></div>
        <div class="stat-card"><div class="stat-icon">✅</div><div class="stat-value">${stats.active_admin_count || 0}</div><div class="stat-label">活跃管理员</div></div>
        <div class="stat-card"><div class="stat-icon">🎶</div><div class="stat-value">${stats.song_count || 0}</div><div class="stat-label">歌曲总数</div></div>
        <div class="stat-card"><div class="stat-icon">🎙️</div><div class="stat-value">${stats.recording_count || 0}</div><div class="stat-label">录音总数</div></div>
        <div class="stat-card"><div class="stat-icon">🎧</div><div class="stat-value">${stats.final_count || 0}</div><div class="stat-label">合成歌曲</div></div>
        <div class="stat-card"><div class="stat-icon">💾</div><div class="stat-value">${server.disk_percent ?? '--'}%</div><div class="stat-label">磁盘使用率</div></div>
    </div>`;
}

async function renderSuperDashboard(container) {
    try {
        const stats = await _superLoadStats();
        container.innerHTML = `
            ${_renderStatsCards(stats)}
            <div class="card">
                <div class="card-header"><h3>超级管理员工作台</h3></div>
                <div class="card-body super-actions">
                    <button class="btn btn-primary" onclick="switchModule('superAdmins')">管理员管理</button>
                    <button class="btn btn-outline" onclick="switchModule('superRegister')">注册与授权码</button>
                    <button class="btn btn-outline" onclick="switchModule('superSettings')">系统设置</button>
                    <button class="btn btn-outline" onclick="switchModule('superFinals')">全局成曲</button>
                </div>
            </div>`;
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${_superEscape(e.message)}</p></div>`;
    }
}

async function renderSuperAdmins(container) {
    try {
        const admins = (await aGet('/super/admins')).data || [];
        container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3>管理员管理</h3>
                <button class="btn btn-outline" id="superRefreshAdmins">刷新</button>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>账号</th><th>角色/状态</th><th>邮箱</th><th>数据</th><th>歌曲上限</th><th>最后登录</th><th>操作</th></tr></thead>
                    <tbody>${admins.map(a => _renderSuperAdminRow(a)).join('')}</tbody>
                </table>
            </div>
        </div>`;
        document.getElementById('superRefreshAdmins').onclick = () => renderSuperAdmins(container);
        _bindSuperAdminActions(container);
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${_superEscape(e.message)}</p></div>`;
    }
}

function _renderSuperAdminRow(a) {
    const isSuper = a.role === 'super_admin';
    const disabled = isSuper ? 'disabled' : '';
    return `
    <tr data-admin-id="${_superEscape(a.id)}">
        <td><strong>${_superEscape(a.display_name || a.username)}</strong><br><span class="muted">${_superEscape(a.username)}</span></td>
        <td><span class="badge ${isSuper ? 'badge-submitted' : 'badge-normal'}">${isSuper ? '超级管理员' : '普通管理员'}</span> ${_superStatusBadge(a.status)} ${a.freeze_tasks ? '<span class="badge badge-hard">任务冻结</span>' : ''}</td>
        <td>${_superEscape(a.email || '-')}</td>
        <td>歌曲 ${a.song_count || 0}<br>录音 ${a.recording_count || 0}<br>成曲 ${a.final_count || 0}</td>
        <td><input class="super-song-limit" type="number" min="0" value="${a.song_limit ?? 5}" ${disabled}></td>
        <td>${_superEscape(a.last_login_at || '-')}</td>
        <td class="super-table-actions">
            <button class="btn btn-primary btn-xs" data-action="save-limit" ${disabled}>保存上限</button>
            <button class="btn btn-warning btn-xs" data-action="freeze" ${disabled}>冻结登录</button>
            <button class="btn btn-warning btn-xs" data-action="freeze-tasks" ${disabled}>冻结任务</button>
            <button class="btn btn-success btn-xs" data-action="unfreeze" ${disabled}>解冻</button>
            <button class="btn btn-outline btn-xs" data-action="reset" ${disabled}>重置密码</button>
            <button class="btn btn-danger btn-xs" data-action="delete" ${disabled}>软删除</button>
            <button class="btn btn-outline btn-xs" data-action="restore" ${disabled}>恢复</button>
            <button class="btn btn-danger btn-xs" data-action="purge" ${disabled}>清理数据</button>
        </td>
    </tr>`;
}

function _bindSuperAdminActions(container) {
    container.querySelector('tbody')?.addEventListener('click', async e => {
        const btn = e.target.closest('[data-action]');
        if (!btn || btn.disabled) return;
        const tr = btn.closest('tr');
        const id = tr.dataset.adminId;
        const action = btn.dataset.action;
        try {
            if (action === 'save-limit') {
                const songLimit = parseInt(tr.querySelector('.super-song-limit').value || '0', 10);
                await aPut(`/super/admins/${id}`, { song_limit: songLimit });
                showToast('歌曲库上限已保存', 'success');
            } else if (action === 'freeze') {
                if (!confirm('确定冻结该管理员登录？')) return;
                await aPost(`/super/admins/${id}/freeze`, false);
                showToast('已冻结登录', 'success');
            } else if (action === 'freeze-tasks') {
                if (!confirm('确定冻结该管理员登录并冻结其任务？')) return;
                await aPost(`/super/admins/${id}/freeze`, true);
                showToast('已冻结任务', 'success');
            } else if (action === 'unfreeze') {
                await aPost(`/super/admins/${id}/unfreeze`, {});
                showToast('已解冻', 'success');
            } else if (action === 'reset') {
                if (!confirm('确定将密码重置为 123456？')) return;
                await aPost(`/super/admins/${id}/reset-password`, {});
                showToast('密码已重置为123456', 'success');
            } else if (action === 'delete') {
                if (!confirm('确定软删除该管理员？其任务将不可用。')) return;
                await aDel(`/super/admins/${id}`);
                showToast('已软删除', 'success');
            } else if (action === 'restore') {
                await aPost(`/super/admins/${id}/restore`, {});
                showToast('已恢复', 'success');
            } else if (action === 'purge') {
                if (!confirm('确定永久清理该软删除账户及其歌曲、录音、成曲文件？此操作不可恢复。')) return;
                await aDel(`/super/admins/${id}/purge-data`);
                showToast('数据已清理', 'success');
            }
            renderSuperAdmins(container);
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
}

async function renderSuperRegister(container) {
    try {
        const [settingsRes, codesRes] = await Promise.all([aGet('/super/settings'), aGet('/super/invite-codes')]);
        const settings = settingsRes.data || {};
        const codes = codesRes.data || [];
        const enabled = _superSettingValue(settings, 'admin_registration_enabled', false);
        const inviteRequired = _superSettingValue(settings, 'admin_registration_invite_required', true);
        container.innerHTML = `
        <div class="card super-form-card">
            <div class="card-header"><h3>注册控制</h3></div>
            <div class="card-body">
                <div class="field-row">
                    <label class="super-check"><input type="checkbox" id="regEnabled" ${enabled ? 'checked' : ''}> 开放管理员注册</label>
                    <label class="super-check"><input type="checkbox" id="inviteRequired" ${inviteRequired ? 'checked' : ''}> 注册需要授权码</label>
                </div>
                <button class="btn btn-primary" id="saveRegSettings">保存注册设置</button>
                <button class="btn btn-success" id="createInviteCode">生成授权码</button>
            </div>
        </div>
        <div class="card">
            <div class="card-header"><h3>授权码列表</h3><span>${codes.length} 个</span></div>
            <div class="table-wrap"><table>
                <thead><tr><th>授权码</th><th>状态</th><th>使用人</th><th>创建时间</th><th>使用时间</th></tr></thead>
                <tbody>${codes.map(c => `<tr><td><code>${_superEscape(c.code)}</code></td><td>${c.status === 'unused' ? '<span class="badge badge-completed">未使用</span>' : '<span class="badge badge-unassigned">已使用</span>'}</td><td>${_superEscape(c.used_by || '-')}</td><td>${_superEscape(c.created_at || '-')}</td><td>${_superEscape(c.used_at || '-')}</td></tr>`).join('')}</tbody>
            </table></div>
        </div>`;
        document.getElementById('saveRegSettings').onclick = async () => {
            await aPut('/super/settings', {
                admin_registration_enabled: document.getElementById('regEnabled').checked,
                admin_registration_invite_required: document.getElementById('inviteRequired').checked,
            });
            showToast('注册设置已保存', 'success');
            renderSuperRegister(container);
        };
        document.getElementById('createInviteCode').onclick = async () => {
            const res = await aPost('/super/invite-codes', {});
            showToast(`授权码已生成：${res.data.code}`, 'success');
            renderSuperRegister(container);
        };
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${_superEscape(e.message)}</p></div>`;
    }
}

async function renderSuperSettings(container) {
    try {
        const settings = (await aGet('/super/settings')).data || {};
        container.innerHTML = `
        <div class="card super-form-card">
            <div class="card-header"><h3>系统参数</h3></div>
            <div class="card-body">
                <div class="field-row">
                    <div class="field"><label>默认歌曲库上限</label><input type="number" id="defaultSongLimit" min="0" value="${_superSettingValue(settings, 'default_song_limit', 5)}"></div>
                    <div class="field"><label>最终合成功能</label><select id="finalMixEnabled"><option value="true">开启</option><option value="false">关闭</option></select></div>
                </div>
                <button class="btn btn-primary" id="saveSystemSettings">保存系统参数</button>
            </div>
        </div>`;
        document.getElementById('finalMixEnabled').value = String(_superSettingValue(settings, 'final_mix_enabled', true));
        document.getElementById('saveSystemSettings').onclick = async () => {
            await aPut('/super/settings', {
                default_song_limit: parseInt(document.getElementById('defaultSongLimit').value || '5', 10),
                final_mix_enabled: document.getElementById('finalMixEnabled').value === 'true',
            });
            showToast('系统参数已保存', 'success');
            renderSuperSettings(container);
        };
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${_superEscape(e.message)}</p></div>`;
    }
}

async function renderSuperStats(container) {
    try {
        const stats = await _superLoadStats();
        const server = stats.server || {};
        container.innerHTML = `
            ${_renderStatsCards(stats)}
            <div class="card">
                <div class="card-header"><h3>服务器运行指标</h3><button class="btn btn-outline" id="refreshSuperStats">刷新</button></div>
                <div class="card-body">
                    <div class="super-metric-row"><span>CPU 使用率</span><strong>${server.cpu_percent ?? '--'}%</strong></div>
                    <div class="super-metric-row"><span>内存使用率</span><strong>${server.memory_percent ?? '--'}%</strong></div>
                    <div class="super-metric-row"><span>磁盘使用率</span><strong>${server.disk_percent ?? '--'}%</strong></div>
                    ${server.error ? `<p class="muted">psutil 不可用：${_superEscape(server.error)}</p>` : ''}
                </div>
            </div>`;
        document.getElementById('refreshSuperStats').onclick = () => renderSuperStats(container);
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${_superEscape(e.message)}</p></div>`;
    }
}

async function renderSuperFinals(container) {
    if (typeof _stopFinalsPlayback === 'function') _stopFinalsPlayback();
    try {
        const finals = (await aGet('/super/finals')).data || [];
        container.innerHTML = `
        <div class="finals-header">
            <h3>全局合成歌曲</h3>
            <span class="finals-count">${finals.length} 首成曲</span>
        </div>
        <div class="finals-list" id="superFinalsList">
            ${finals.length ? finals.map(f => _renderSuperFinalCard(f)).join('') : '<div class="empty-state"><div class="empty-icon">🎧</div><p>暂无合成歌曲</p></div>'}
        </div>`;
        _bindSuperFinalActions(container);
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${_superEscape(e.message)}</p></div>`;
    }
}

function _renderSuperFinalCard(f) {
    const statusBadge = f.published ? '<span class="badge badge-completed">已发布</span>' : '<span class="badge badge-unassigned">未发布</span>';
    return `
    <div class="final-card" data-final-id="${_superEscape(f.id)}">
        <div class="final-card-body">
            <div class="final-card-top">
                <button class="final-play-btn" data-action="play" data-id="${_superEscape(f.id)}" data-url="${_superEscape(f.audio_url)}" data-dur="${f.duration || 0}" title="播放">▶</button>
                <div class="final-info">
                    <div class="final-title">${_superEscape(f.song_title || '未命名')} <span class="final-artist">${_superEscape(f.song_artist || '')}</span></div>
                    <div class="final-meta">
                        ${statusBadge}
                        <span>管理员：${_superEscape(f.owner_admin_id || '系统')}</span>
                        <span>${f.segment_count || 0} 唱段</span>
                        <span>${f.track_count || 0} 轨</span>
                        <span>${fmtTime(f.duration || 0)}</span>
                        <span>${_superEscape(f.created_at || '')}</span>
                    </div>
                </div>
                <div class="final-card-right">
                    <button class="btn btn-warning btn-sm" data-action="resynth" data-id="${_superEscape(f.id)}" data-song-id="${_superEscape(f.song_id)}">重新合成</button>
                    <button class="btn btn-danger btn-sm" data-action="delete" data-id="${_superEscape(f.id)}">删除</button>
                </div>
            </div>
            <div class="final-player-row" id="finalPlayer_${_superEscape(f.id)}" style="display:none;">
                <canvas class="final-wave-canvas" id="finalWave_${_superEscape(f.id)}" width="800" height="40"></canvas>
                <div class="final-time-bar">
                    <div class="final-progress-track" id="finalTrack_${_superEscape(f.id)}"><div class="final-progress-fill" id="finalFill_${_superEscape(f.id)}"></div></div>
                    <span class="final-time-label" id="finalTime_${_superEscape(f.id)}">0:00 / ${fmtTime(f.duration || 0)}</span>
                </div>
            </div>
        </div>
    </div>`;
}

function _bindSuperFinalActions(container) {
    const list = document.getElementById('superFinalsList');
    if (!list) return;
    list.addEventListener('click', async e => {
        const track = e.target.closest('.final-progress-track');
        if (track && typeof _finalsPlayingAudio !== 'undefined' && _finalsPlayingAudio) {
            const rect = track.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            _finalsPlayingAudio.currentTime = ratio * (_finalsPlayingAudio.duration || 0);
            return;
        }
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        try {
            if (action === 'play') {
                if (typeof _toggleFinalPlay === 'function') _toggleFinalPlay(btn, btn.dataset.id, btn.dataset.url, parseFloat(btn.dataset.dur) || 0);
                else window.open(_superBuildUrl(btn.dataset.url), '_blank');
            } else if (action === 'delete') {
                if (!confirm('确定删除该成曲？此操作不可恢复。')) return;
                await aDel(`/admin/finals/${btn.dataset.id}`);
                showToast('成曲已删除', 'success');
                renderSuperFinals(container);
            } else if (action === 'resynth') {
                if (!confirm('确定用当前已选录音替该管理员重新发起合成？')) return;
                await aPost(`/admin/songs/${btn.dataset.songId}/synthesize`, {});
                showToast('重新合成任务已启动', 'success');
            }
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
}

window.renderSuperDashboard = renderSuperDashboard;
window.renderSuperAdmins = renderSuperAdmins;
window.renderSuperRegister = renderSuperRegister;
window.renderSuperSettings = renderSuperSettings;
window.renderSuperStats = renderSuperStats;
window.renderSuperFinals = renderSuperFinals;
