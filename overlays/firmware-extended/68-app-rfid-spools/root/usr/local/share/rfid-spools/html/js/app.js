// ─────────────────────────────────────────────────────────────
// App entry point — wires modules together and bootstraps
// ─────────────────────────────────────────────────────────────
import { state }                   from './state.js';
import { $, escHtml, authHeaders, closeModal } from './utils.js';
import { loadChannels, loadSpools, loadActiveSpool } from './data.js';
import { initConfig, toggleConfig, validateUrl, saveUrl, testProxy, setupSpoolmanFields } from './config.js';
import { renderGrid, badge }       from './render.js';
import { setActive, syncChannelToSpoolman, syncAllToSpoolman, doUnlink } from './sync.js';
import { openImport, syncColorText, syncColorPicker, doImport } from './import-modal.js';
import { openLink, filterSpools, selectSpool, doLink } from './link-modal.js';
import { syncEtColorText, syncEtColorPicker, openEditTag, doWriteTag } from './edit-modal.js';
import { toggleLog, pollOnce, fetchOpenRfidLog, fetchKlipperLog, copyLog, clearLog, toggleAutoPoll } from './debug.js';

// ─────────────────────────────────────────────────────────────
// Main refresh
// ─────────────────────────────────────────────────────────────
async function refreshAll() {
    $('channels-grid').innerHTML = '<div class="loading"><span class="spinner"></span> Loading RFID data\u2026</div>';
    badge('badge-moonraker', null, 'Moonraker');
    badge('badge-spoolman',  null, 'Spoolman');

    try {
        [state.channels, state.activeSpoolId] = await Promise.all([loadChannels(), loadActiveSpool()]);
        badge('badge-moonraker', true, 'Moonraker');
    } catch (e) {
        badge('badge-moonraker', false, 'Moonraker');
        $('channels-grid').innerHTML = e.message !== 'auth'
            ? `<div class="loading" style="color:var(--error)">Moonraker error: ${escHtml(e.message)}</div>`
            : '<div class="loading" style="color:var(--error)">Authentication required.</div>';
        return;
    }

    if (state.spoolmanUrl) {
        try {
            state.spools = await loadSpools();
            badge('badge-spoolman', true, 'Spoolman');
        } catch (e) {
            badge('badge-spoolman', false, 'Spoolman');
            state.spools = [];
        }
    } else {
        state.spools = [];
        badge('badge-spoolman', null, 'Spoolman');
    }

    renderGrid();
}

// ─────────────────────────────────────────────────────────────
// Re-read RFID tags
// ─────────────────────────────────────────────────────────────
async function rereadTags() {
    const btn = $('btn-reread');
    btn.disabled = true;
    btn.textContent = '\u23f3 Reading\u2026';
    try {
        const resp = await fetch('/firmware-config/api/action/restart-openrfid', {
            method: 'POST',
            headers: authHeaders(),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const text = await resp.text();
        if (text.includes('ERROR')) throw new Error(text.split('\n').filter(l => l.includes('ERROR')).join('; '));
        await new Promise(ok => setTimeout(ok, 8000));
        await refreshAll();
    } catch (e) {
        alert('Re-read failed: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '\ud83d\udce1 Re-read Tags';
    }
}

// ─────────────────────────────────────────────────────────────
// Window bindings (for inline onclick handlers in HTML)
// ─────────────────────────────────────────────────────────────
Object.assign(window, {
    refreshAll, rereadTags, closeModal,
    // config
    toggleConfig, validateUrl, saveUrl, testProxy, setupSpoolmanFields,
    // sync
    setActive, syncChannelToSpoolman, syncAllToSpoolman, doUnlink,
    // import modal
    openImport, syncColorText, syncColorPicker, doImport,
    // link modal
    openLink, filterSpools, selectSpool, doLink,
    // edit modal
    openEditTag, syncEtColorText, syncEtColorPicker, doWriteTag,
    // debug
    toggleLog, pollOnce, fetchOpenRfidLog, fetchKlipperLog, copyLog, clearLog, toggleAutoPoll,
});

// ─────────────────────────────────────────────────────────────
// Modal click-outside-to-close
// ─────────────────────────────────────────────────────────────
document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); });
});

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────
initConfig();
refreshAll();
