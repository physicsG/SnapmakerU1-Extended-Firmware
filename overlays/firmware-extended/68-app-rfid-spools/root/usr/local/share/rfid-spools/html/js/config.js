// ─────────────────────────────────────────────────────────────
// Config panel
// ─────────────────────────────────────────────────────────────
import { state } from './state.js';
import { SM_API, SM_PROXY } from './constants.js';
import { $, showMsg } from './utils.js';

export function initConfig() {
    $('spoolman-url-input').value = state.spoolmanUrl;
    validateUrl();
    if (!state.spoolmanUrl) $('notice-no-url').classList.add('visible');
}

export function toggleConfig() {
    const b = $('config-body'); const btn = $('config-card').querySelector('button');
    const hidden = b.style.display === 'none';
    b.style.display = hidden ? '' : 'none';
    btn.textContent = hidden ? 'Hide' : 'Show';
}

export function validateUrl() {
    const v = $('spoolman-url-input').value.trim();
    let validUrl = false;
    try { validUrl = v && ['http:', 'https:'].includes(new URL(v).protocol); } catch {}
    $('btn-save-url').disabled = false;
    $('btn-test-url').disabled = !validUrl;
    $('btn-setup-fields').disabled = !validUrl;
}

export function saveUrl() {
    const v = $('spoolman-url-input').value.trim().replace(/\/$/, '');
    state.spoolmanUrl = v;
    if (v) {
        localStorage.setItem('rfid-spoolman-url', v);
        $('notice-no-url').classList.remove('visible');
        showMsg('url-status', '\u2713 Saved', 'ok');
    } else {
        localStorage.removeItem('rfid-spoolman-url');
        $('notice-no-url').classList.add('visible');
        showMsg('url-status', 'Spoolman disabled', 'info');
    }
    window.refreshAll();
}

export async function testProxy() {
    const v = $('spoolman-url-input').value.trim().replace(/\/$/, '');
    if (!v) return;
    showMsg('url-status', '\u23f3 Testing\u2026', 'info');
    try {
        let ver = '?';
        try {
            const r = await fetch(SM_PROXY + SM_API + '/health', {
                headers: { 'X-Spoolman-Target': v },
                signal: AbortSignal.timeout(5000),
            });
            if (r.ok) { const d = await r.json(); ver = d.version || '?'; }
            else throw new Error();
        } catch {
            const r = await fetch(SM_PROXY + SM_API + '/vendor', {
                headers: { 'X-Spoolman-Target': v },
                signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
        }
        showMsg('url-status', `\u2713 Spoolman reachable${ver !== '?' ? ' (v' + ver + ')' : ''}`, 'ok');
    } catch (e) {
        showMsg('url-status', `\u2717 Cannot reach Spoolman \u2014 ${e.message}`, 'err');
    }
}

export async function setupSpoolmanFields() {
    const v = $('spoolman-url-input').value.trim().replace(/\/$/, '') || state.spoolmanUrl;
    if (!v) { showMsg('url-status', 'Set Spoolman URL first', 'err'); return; }
    showMsg('url-status', '\u23f3 Creating custom fields\u2026', 'info');
    const fields = [
        ['filament', 'td',             { name: 'Transmission Distance', field_type: 'float', unit: 'mm' }],
        ['filament', 'subtype',         { name: 'Subtype',              field_type: 'text' }],
        ['filament', 'hotend_min_temp', { name: 'Min Hotend Temp',      field_type: 'integer', unit: '\u00b0C' }],
        ['filament', 'drying_temp',     { name: 'Drying Temperature',   field_type: 'integer', unit: '\u00b0C' }],
        ['filament', 'drying_time',     { name: 'Drying Time',          field_type: 'integer', unit: 'h' }],
        ['filament', 'mfg_date',        { name: 'Manufacturing Date',   field_type: 'text' }],
        ['spool',    'rfid_uid',        { name: 'RFID Tag UID',         field_type: 'text' }],
        ['spool',    'tigertag_product_id', { name: 'TigerTag Product ID', field_type: 'text' }],
    ];
    let ok = 0, skip = 0, fail = 0;
    for (const [entity, key, body] of fields) {
        try {
            const r = await fetch(SM_PROXY + SM_API + '/field/' + entity + '/' + key, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Spoolman-Target': v },
                body: JSON.stringify(body),
            });
            if (r.ok) ok++;
            else if (r.status === 409) skip++;
            else fail++;
        } catch { fail++; }
    }
    const msg = `Fields: ${ok} created, ${skip} already exist, ${fail} failed`;
    showMsg('url-status', (fail ? '\u26a0 ' : '\u2713 ') + msg, fail ? 'err' : 'ok');
}
