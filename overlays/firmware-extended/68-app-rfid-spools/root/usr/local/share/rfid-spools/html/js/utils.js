// ─────────────────────────────────────────────────────────────
// DOM helpers, authentication, fetch wrappers, formatters
// ─────────────────────────────────────────────────────────────
import { state } from './state.js';
import { SM_PROXY } from './constants.js';

export const $ = id => document.getElementById(id);

export function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function getJWT() {
    const key = `user-token-${window.location.host.replace(/[^a-zA-Z0-9]/g, '_')}`;
    let t = localStorage.getItem(key);
    if (t) return t;
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('user-token-')) { t = localStorage.getItem(k); if (t) return t; }
    }
    return null;
}

export function authHeaders() { const j = getJWT(); return j ? { Authorization: `Bearer ${j}` } : {}; }

export async function moonFetch(path, opts = {}) {
    opts.headers = { ...authHeaders(), ...opts.headers };
    const r = await fetch(path, opts);
    if (r.status === 401) { $('notice-auth').classList.add('visible'); throw new Error('auth'); }
    $('notice-auth').classList.remove('visible');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
}

export async function smFetch(path, opts = {}) {
    if (!state.spoolmanUrl) throw new Error('no-spoolman-url');
    if (!opts.headers) opts.headers = {};
    opts.headers['X-Spoolman-Target'] = state.spoolmanUrl;
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    const r = await fetch(SM_PROXY + path, opts);
    if (!r.ok) {
        let detail = '';
        try {
            const j = await r.json();
            if (Array.isArray(j.detail)) {
                detail = j.detail.map(e => `${(e.loc||[]).join('.')}: ${e.msg}`).join('; ');
            } else {
                detail = j.message || j.detail || JSON.stringify(j);
            }
        } catch {}
        throw new Error(`Spoolman ${r.status}${detail ? ': ' + detail : ''}`);
    }
    const text = await r.text();
    return text ? JSON.parse(text) : {};
}

export function rgb1ToHex(n) {
    if (!n) return null;
    return '#' + (n >>> 0).toString(16).padStart(6, '0').toUpperCase();
}

export function uidToHex(bytes) {
    if (!Array.isArray(bytes) || !bytes.length) return '';
    return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

export function formatMfDate(s) {
    if (!s) return '';
    const d = s.replace(/-/g, '');
    if (d.length === 8 && /^\d{8}$/.test(d))
        return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
    return s;
}

export function mfDateToISO(s) {
    if (!s) return '';
    const d = s.replace(/-/g, '');
    if (d.length !== 8 || !/^\d{8}$/.test(d) || d === '19700101' || d === '00010101') return '';
    return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
}

export function colorDot(hex, size) {
    size = size || 14;
    return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${escHtml(hex||'#555')};border:1px solid rgba(255,255,255,0.18);flex-shrink:0"></span>`;
}

export function showMsg(id, msg, cls) {
    const el = $(id);
    el.textContent = msg;
    el.className = `status-msg${cls ? ' ' + cls : ''} visible`;
}

export function closeModal(id) { $(id).classList.remove('visible'); }
