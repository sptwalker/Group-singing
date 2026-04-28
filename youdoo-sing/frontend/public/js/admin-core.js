// ===== 管理后台核心框架 =====
const DEFAULT_API_BASE = window.location.port === '3000' ? 'http://localhost:8000/api' : '/api';
const API = (window.YOUDOO_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '');
let adminToken = localStorage.getItem('admin_token') || '';
let currentAdmin = null;

async function parseApiResponse(res) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return res.json();
    const text = await res.text();
    throw new Error(text.trim().startsWith('<') ? 'API服务地址错误或后端未启动' : (text || `请求失败(${res.status})`));
}

// ===== API 工具 =====
async function adminFetch(path, opts = {}) {
    const headers = { 'Authorization': `Bearer ${adminToken}`, ...(opts.headers || {}) };
    if (opts.body !== undefined && opts.body !== null && !(opts.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (res.status === 401) { doLogout(); throw new Error('登录已过期'); }
    if (!res.ok) {
        const err = await parseApiResponse(res).catch(error => ({ detail: error.message }));
        throw new Error(err.detail || `请求失败(${res.status})`);
    }
    return parseApiResponse(res);
}
const aGet = (p) => adminFetch(p);
const aPut = (p, b) => adminFetch(p, { method: 'PUT', body: b });
const aPost = (p, b) => adminFetch(p, { method: 'POST', body: b });
const aDel = (p) => adminFetch(p, { method: 'DELETE' });

// ===== Toast =====
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (type ? ` toast-${type}` : '');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.className = 'toast', 2500);
}

function fmtTime(s) {
    if (s == null) return '--:--';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}
function fmtTimePrecise(s) {
    if (s == null) return '--:--.--';
    const m = Math.floor(s / 60), sec = (s % 60).toFixed(1);
    return `${m}:${sec.padStart(4, '0')}`;
}

// ===== 模态框 =====
function showModal(title, bodyHtml, footerHtml) {
    const c = document.getElementById('modalContainer');
    c.innerHTML = `<div class="modal-overlay" id="modalOverlay">
        <div class="modal-box">
            <div class="modal-header"><h3>${title}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
            <div class="modal-body">${bodyHtml}</div>
            ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
        </div></div>`;
    const overlay = document.getElementById('modalOverlay');
    let _modalMouseDownTarget = null;
    overlay.addEventListener('mousedown', e => { _modalMouseDownTarget = e.target; });
    overlay.addEventListener('click', e => {
        if (e.target === e.currentTarget && _modalMouseDownTarget === e.currentTarget) closeModal();
        _modalMouseDownTarget = null;
    });
}
function closeModal() { document.getElementById('modalContainer').innerHTML = ''; }

// ===== 登录/登出 =====
function doLogout() {
    adminToken = '';
    currentAdmin = null;
    currentModule = '';
    localStorage.removeItem('admin_token');
    document.getElementById('loginOverlay').style.display = 'flex';
    document.getElementById('appMain').style.display = 'none';
}

function isSuperAdmin() {
    return currentAdmin && currentAdmin.role === 'super_admin';
}

function getDefaultModule() {
    return isSuperAdmin() ? 'superDashboard' : 'dashboard';
}

function setAdminSession(data) {
    currentAdmin = data || null;
    document.getElementById('adminName').textContent = currentAdmin?.display_name || currentAdmin?.username || 'admin';
    renderAdminMenu();
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('appMain').style.display = 'flex';
    switchModule(getDefaultModule(), true);
}

function openAccountSettings() {
    if (!currentAdmin) return;
    showModal('账号设置', `
        <div class="form-group">
            <label>用户名</label>
            <input type="text" value="${currentAdmin.username || ''}" disabled>
        </div>
        <div class="form-group">
            <label>当前邮箱</label>
            <input type="email" id="accountEmail" value="${currentAdmin.email || ''}" placeholder="name@example.com">
        </div>
        ${currentAdmin.pending_email ? `<p class="muted" style="margin:-8px 0 14px;">待确认邮箱：${currentAdmin.pending_email}</p>` : ''}
        <div class="form-group">
            <label>当前密码（修改邮箱时必填）</label>
            <input type="password" id="accountCurrentPass" placeholder="请输入当前密码">
        </div>
        <div class="form-group">
            <label>新密码（不修改可留空）</label>
            <input type="password" id="accountNewPass" placeholder="长于6位，包含数字和字母">
        </div>
        <div class="form-group">
            <label>确认新密码</label>
            <input type="password" id="accountNewPassConfirm" placeholder="请再次输入新密码">
        </div>
    `, `<button class="btn-secondary" onclick="closeModal()">取消</button><button class="btn-primary" onclick="submitAccountSettings()">保存设置</button>`);
}

async function submitAccountSettings() {
    const newEmail = document.getElementById('accountEmail').value.trim();
    const currentPassword = document.getElementById('accountCurrentPass').value;
    const newPassword = document.getElementById('accountNewPass').value;
    const newPasswordConfirm = document.getElementById('accountNewPassConfirm').value;
    if (newPassword) {
        if (newPassword.length <= 6 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
            showToast('新密码需要长于6位，且包含数字和字母', 'error');
            return;
        }
        if (newPassword !== newPasswordConfirm) {
            showToast('两次输入的新密码不一致', 'error');
            return;
        }
    }
    if (newEmail !== (currentAdmin.email || '') && !currentPassword) {
        showToast('修改邮箱需要先输入当前密码', 'error');
        return;
    }
    try {
        const res = await aPut('/admin/account', {
            current_password: currentPassword,
            new_password: newPassword,
            new_email: newEmail,
        });
        currentAdmin = { ...currentAdmin, ...res.data };
        document.getElementById('adminName').textContent = currentAdmin.display_name || currentAdmin.username || 'admin';
        closeModal();
        showToast(res.message || '账号设置已更新', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

const NORMAL_MENU = [
    ['dashboard', '📊', '仪表盘'],
    ['songs', '🎶', '歌曲库'],
    ['editor', '✂️', '分段编辑器'],
    ['tasks', '📋', '任务管理'],
    ['export', '📦', '合成导出'],
    ['finals', '🎵', '最终成曲'],
];

const SUPER_MENU = [
    ['superDashboard', '🛡️', '超级首页'],
    ['superAdmins', '👥', '管理员管理'],
    ['superRegister', '🔐', '注册与授权码'],
    ['superStats', '📈', '服务器统计'],
    ['superFinals', '🎧', '全局成曲'],
    ['superSettings', '⚙️', '系统设置'],
];

function renderAdminMenu() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    const items = isSuperAdmin() ? SUPER_MENU : NORMAL_MENU;
    nav.innerHTML = items.map(([module, icon, text]) => `
        <a class="nav-item" data-module="${module}">
            <span class="nav-icon">${icon}</span>
            <span>${text}</span>
        </a>`).join('');
    nav.querySelectorAll('.nav-item').forEach(n => n.addEventListener('click', () => switchModule(n.dataset.module)));
}

function initAuth() {
    const form = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const btnShowRegister = document.getElementById('btnShowRegister');
    const btnBackLogin = document.getElementById('btnBackLogin');

    async function showRegisterForm() {
        try {
            const res = await fetch(`${API}/admin/register-status`);
            const data = await parseApiResponse(res);
            if (!data.data?.enabled) {
                showToast('管理员注册暂未开放', 'error');
                return;
            }
            document.getElementById('regInviteGroup').style.display = data.data.invite_required ? '' : 'none';
            document.getElementById('regInvite').required = !!data.data.invite_required;
            form.style.display = 'none';
            registerForm.style.display = '';
            document.querySelector('.login-subtitle').textContent = '注册管理员账户';
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    function showLoginForm() {
        registerForm.style.display = 'none';
        form.style.display = '';
        document.querySelector('.login-subtitle').textContent = '管理后台';
    }

    btnShowRegister?.addEventListener('click', showRegisterForm);
    btnBackLogin?.addEventListener('click', showLoginForm);

    registerForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btnRegister');
        const password = document.getElementById('regPass').value;
        const passwordConfirm = document.getElementById('regPassConfirm').value;
        if (password.length <= 6 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
            showToast('密码需要长于6位，且包含数字和字母', 'error');
            return;
        }
        if (password !== passwordConfirm) {
            showToast('两次输入的密码不一致', 'error');
            return;
        }
        btn.disabled = true; btn.textContent = '注册中...';
        try {
            const res = await fetch(`${API}/admin/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('regUser').value.trim(),
                    email: document.getElementById('regEmail').value.trim(),
                    password,
                    invite_code: document.getElementById('regInvite').value.trim(),
                })
            });
            const data = await parseApiResponse(res);
            if (!res.ok) throw new Error(data.detail || '注册失败');
            showToast(data.message || '注册成功，请使用新账号登录', 'success');
            showLoginForm();
            document.getElementById('loginUser').value = document.getElementById('regUser').value.trim();
            registerForm.reset();
        } catch (err) { showToast(err.message, 'error'); }
        btn.disabled = false; btn.textContent = '注 册';
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btnLogin');
        btn.disabled = true; btn.textContent = '登录中...';
        try {
            const res = await fetch(`${API}/admin/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: document.getElementById('loginUser').value, password: document.getElementById('loginPass').value })
            });
            const data = await parseApiResponse(res);
            if (!res.ok) throw new Error(data.detail || '登录失败');
            adminToken = data.data.token;
            localStorage.setItem('admin_token', adminToken);
            setAdminSession(data.data);
            showToast('登录成功', 'success');
        } catch (err) { showToast(err.message, 'error'); }
        btn.disabled = false; btn.textContent = '登 录';
    });

    document.getElementById('btnLogout').addEventListener('click', doLogout);
    document.getElementById('btnAccountSettings')?.addEventListener('click', openAccountSettings);
    document.getElementById('btnMenuToggle').addEventListener('click', () => {
        document.querySelector('.sidebar').classList.toggle('open');
    });

    // 检查已有 token
    if (adminToken) {
        aGet('/admin/check').then(res => {
            setAdminSession(res.data);
        }).catch(() => doLogout());
    }
}

// ===== 模块路由 =====
const MODULE_TITLES = {
    dashboard: '仪表盘',
    songs: '歌曲库',
    editor: '分段编辑器',
    tasks: '任务管理',
    export: '合成导出',
    finals: '最终成曲',
    superDashboard: '超级首页',
    superAdmins: '管理员管理',
    superRegister: '注册与授权码',
    superSettings: '系统设置',
    superStats: '服务器统计',
    superFinals: '全局成曲'
};
let currentModule = '';

function switchModule(name, force = false) {
    if (!force && currentModule === name) return;
    currentModule = name;
    document.getElementById('pageTitle').textContent = MODULE_TITLES[name] || name;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.module === name));
    document.querySelector('.sidebar').classList.remove('open');
    const container = document.getElementById('moduleContainer');
    container.innerHTML = '<div class="loading">加载中</div>';
    const loaders = {
        dashboard: renderDashboard,
        songs: renderSongs,
        editor: renderEditor,
        tasks: renderTasks,
        export: renderExport,
        finals: renderFinals,
        superDashboard: window.renderSuperDashboard,
        superAdmins: window.renderSuperAdmins,
        superRegister: window.renderSuperRegister,
        superSettings: window.renderSuperSettings,
        superStats: window.renderSuperStats,
        superFinals: window.renderSuperFinals,
    };
    if (loaders[name]) loaders[name](container);
    else container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>模块尚未加载</p></div>';
}

document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    renderAdminMenu();
});
