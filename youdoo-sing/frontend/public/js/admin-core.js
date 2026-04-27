// ===== 管理后台核心框架 =====
const DEFAULT_API_BASE = window.location.port === '3000' ? 'http://localhost:8000/api' : '/api';
const API = (window.YOUDOO_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '');
let adminToken = localStorage.getItem('admin_token') || '';

async function parseApiResponse(res) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return res.json();
    const text = await res.text();
    throw new Error(text.trim().startsWith('<') ? 'API服务地址错误或后端未启动' : (text || `请求失败(${res.status})`));
}

// ===== API 工具 =====
async function adminFetch(path, opts = {}) {
    const headers = { 'Authorization': `Bearer ${adminToken}`, ...(opts.headers || {}) };
    if (opts.body && !(opts.body instanceof FormData)) {
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
    localStorage.removeItem('admin_token');
    document.getElementById('loginOverlay').style.display = 'flex';
    document.getElementById('appMain').style.display = 'none';
}

function initAuth() {
    const form = document.getElementById('loginForm');
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
            document.getElementById('adminName').textContent = data.data.username;
            document.getElementById('loginOverlay').style.display = 'none';
            document.getElementById('appMain').style.display = 'flex';
            switchModule('dashboard');
            showToast('登录成功', 'success');
        } catch (err) { showToast(err.message, 'error'); }
        btn.disabled = false; btn.textContent = '登 录';
    });

    document.getElementById('btnLogout').addEventListener('click', doLogout);
    document.getElementById('btnMenuToggle').addEventListener('click', () => {
        document.querySelector('.sidebar').classList.toggle('open');
    });

    // 检查已有 token
    if (adminToken) {
        aGet('/admin/check').then(() => {
            document.getElementById('loginOverlay').style.display = 'none';
            document.getElementById('appMain').style.display = 'flex';
            switchModule('dashboard');
        }).catch(() => doLogout());
    }
}

// ===== 模块路由 =====
const MODULE_TITLES = { dashboard: '仪表盘', songs: '歌曲库', editor: '分段编辑器', tasks: '任务管理', export: '合成导出', finals: '最终成曲' };
let currentModule = '';

function switchModule(name) {
    if (currentModule === name) return;
    currentModule = name;
    document.getElementById('pageTitle').textContent = MODULE_TITLES[name] || name;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.module === name));
    document.querySelector('.sidebar').classList.remove('open');
    const container = document.getElementById('moduleContainer');
    container.innerHTML = '<div class="loading">加载中</div>';
    const loaders = { dashboard: renderDashboard, songs: renderSongs, editor: renderEditor, tasks: renderTasks, export: renderExport, finals: renderFinals };
    if (loaders[name]) loaders[name](container);
}

document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    document.querySelectorAll('.nav-item').forEach(n => n.addEventListener('click', () => switchModule(n.dataset.module)));
});
