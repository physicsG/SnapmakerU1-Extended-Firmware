// ─────────────────────────────────────────────────────────────
// Import to Spoolman modal
// ─────────────────────────────────────────────────────────────
import { state, setImportCtx, importCtx } from './state.js';
import { SM_API } from './constants.js';
import { $, smFetch, moonFetch, showMsg, closeModal, mfDateToISO } from './utils.js';
import { loadSpools } from './data.js';
import { renderGrid } from './render.js';

export function openImport(chIdx) {
    const ch = state.channels.find(c => c.ch === chIdx);
    if (!ch) return;
    setImportCtx(ch);
    $('import-title').textContent = `Import Channel ${chIdx} to Spoolman`;
    $('imp-vendor').value   = ch.vendor   || '';
    $('imp-material').value = ch.material || '';
    $('imp-subtype').value  = ch.subtype  || '';
    const hex = ch.colorHex ? ch.colorHex.replace('#','') : '';
    $('imp-color').value = hex;
    if (hex.length === 6) $('imp-color-picker').value = ch.colorHex;
    $('imp-hotend').value = ch.hotendMax || ch.hotendMin || '';
    $('imp-bed').value    = ch.bedTemp || '';
    $('imp-weight').value = ch.weight || '';
    $('imp-diam').value   = ch.diameter ? (ch.diameter / 100).toFixed(2) : '';
    $('imp-drying-temp').value = ch.dryingTemp || '';
    $('imp-drying-time').value = ch.dryingTime || '';
    $('imp-td').value          = ch.td || '';
    $('imp-mfg-date').value    = mfDateToISO(ch.mfDate);
    $('imp-status').className = 'status-msg';
    $('imp-confirm').disabled = false;
    $('import-modal').classList.add('visible');
}

export function syncColorText() {
    $('imp-color').value = $('imp-color-picker').value.replace('#','').toUpperCase();
}

export function syncColorPicker() {
    const v = $('imp-color').value.trim();
    if (/^[0-9A-Fa-f]{6}$/.test(v)) $('imp-color-picker').value = '#' + v;
}

export async function doImport() {
    const ch = importCtx;
    const vendor   = $('imp-vendor').value.trim();
    const material = $('imp-material').value.trim();
    const subtype  = $('imp-subtype').value.trim();
    const colorRaw = $('imp-color').value.trim().replace('#','');
    const hotend   = parseInt($('imp-hotend').value) || null;
    const bed      = parseInt($('imp-bed').value) || null;
    const weight   = parseFloat($('imp-weight').value) || null;
    const diam     = parseFloat($('imp-diam').value) || null;
    const dryingTemp = parseInt($('imp-drying-temp').value) || null;
    const dryingTime = parseInt($('imp-drying-time').value) || null;
    const td         = parseFloat($('imp-td').value) || null;
    const mfgDate    = $('imp-mfg-date').value.trim();

    if (!material) { showMsg('imp-status', 'Material is required', 'err'); return; }

    $('imp-confirm').disabled = true;
    showMsg('imp-status', '\u23f3 Importing\u2026', 'info');

    try {
        let vendorId = null;
        if (vendor) {
            const vlist = await smFetch(SM_API + '/vendor');
            const ev = vlist.find(v => v.name.toLowerCase() === vendor.toLowerCase());
            if (ev) {
                vendorId = ev.id;
            } else {
                const nv = await smFetch(SM_API + '/vendor', { method:'POST', body: JSON.stringify({ name: vendor }) });
                vendorId = nv.id;
            }
        }

        const colorHex = /^[0-9A-Fa-f]{6}$/.test(colorRaw) ? colorRaw.toUpperCase() : null;
        const flist = await smFetch(SM_API + '/filament');
        let filament = flist.find(f => {
            const matOk = (f.material||'').toUpperCase() === material.toUpperCase();
            const venOk = (f.vendor ? f.vendor.id : null) === vendorId;
            const colOk = !colorHex || !f.color_hex || f.color_hex.toUpperCase() === colorHex;
            return matOk && venOk && colOk;
        });
        if (!filament) {
            const nameParts = [vendor, material, subtype].filter(Boolean);
            const fd = { name: nameParts.join(' '), material };
            if (vendorId != null) fd.vendor_id = vendorId;
            if (colorHex)        fd.color_hex = colorHex;
            fd.diameter = diam || 1.75;
            fd.density = 1.24;
            const settings = {};
            if (hotend) settings.extruder_temp = hotend;
            if (bed)    settings.bed_temp = bed;
            if (Object.keys(settings).length) fd.settings = settings;

            const extra = {};
            if (subtype)    extra.subtype = JSON.stringify(subtype);
            if (dryingTemp) extra.drying_temp = String(dryingTemp);
            if (dryingTime) extra.drying_time = String(dryingTime);
            if (td)         extra.td = String(td);
            if (mfgDate)    extra.mfg_date = JSON.stringify(mfgDate);
            if (Object.keys(extra).length) fd.extra = extra;

            filament = await smFetch(SM_API + '/filament', { method:'POST', body: JSON.stringify(fd) });
        }

        const sd = { filament_id: filament.id };
        if (ch.cardUid) sd.comment = `rfid:${ch.cardUid}`;
        if (weight)     sd.initial_weight = weight;
        if (ch.cardUid) sd.extra = { rfid_uid: JSON.stringify(ch.cardUid) };
        const spool = await smFetch(SM_API + '/spool', { method:'POST', body: JSON.stringify(sd) });

        try {
            await moonFetch('/server/spoolman/spool_id', {
                method:'POST',
                headers: { 'Content-Type':'application/json' },
                body: JSON.stringify({ spool_id: spool.id }),
            });
            state.activeSpoolId = spool.id;
        } catch {}

        showMsg('imp-status', `\u2713 Created spool #${spool.id} and set as active`, 'ok');
        state.spools = await loadSpools();
        renderGrid();
        setTimeout(() => closeModal('import-modal'), 1500);
    } catch (e) {
        showMsg('imp-status', `\u2717 ${e.message}`, 'err');
        $('imp-confirm').disabled = false;
    }
}
