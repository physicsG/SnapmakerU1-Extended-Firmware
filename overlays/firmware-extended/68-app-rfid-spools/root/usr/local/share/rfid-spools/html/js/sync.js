// ─────────────────────────────────────────────────────────────
// Spoolman sync, unlink, set active
// ─────────────────────────────────────────────────────────────
import { state } from './state.js';
import { SM_API } from './constants.js';
import { $, smFetch, moonFetch, formatMfDate } from './utils.js';
import { loadSpools, matchChannel } from './data.js';
import { renderGrid } from './render.js';

export async function setActive(spoolId, ch) {
    try {
        await moonFetch('/server/spoolman/spool_id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spool_id: spoolId }),
        });
        state.activeSpoolId = spoolId;
        renderGrid();
    } catch (e) {
        alert(`Could not set active spool: ${e.message}`);
    }
}

export async function syncChannelToSpoolman(chIdx) {
    const ch = state.channels.find(c => c.ch === chIdx);
    if (!ch || !ch.material) return 'skip';
    const match = matchChannel(ch, state.spools);
    const result = { filament: null, spool: null };

    try {
        if (match.type === 'none') {
            // ── Create path: vendor → filament → spool ──
            let vendorId = null;
            if (ch.vendor) {
                const vlist = await smFetch(SM_API + '/vendor');
                const ev = vlist.find(v => v.name.toLowerCase() === ch.vendor.toLowerCase());
                if (ev) { vendorId = ev.id; }
                else {
                    const nv = await smFetch(SM_API + '/vendor', { method:'POST', body: JSON.stringify({ name: ch.vendor }) });
                    vendorId = nv.id;
                }
            }
            const colorHex = ch.colorHex ? ch.colorHex.replace('#','').toUpperCase() : null;
            const flist = await smFetch(SM_API + '/filament');
            let filament = flist.find(f => {
                const matOk = (f.material||'').toUpperCase() === ch.material.toUpperCase();
                const venOk = (f.vendor ? f.vendor.id : null) === vendorId;
                const colOk = !colorHex || !f.color_hex || f.color_hex.toUpperCase() === colorHex;
                return matOk && venOk && colOk;
            });
            if (!filament) {
                const fd = { name: [ch.vendor, ch.material, ch.subtype].filter(Boolean).join(' '), material: ch.material };
                if (vendorId != null) fd.vendor_id = vendorId;
                if (colorHex) fd.color_hex = colorHex;
                fd.diameter = ch.diameter ? ch.diameter / 100 : 1.75;
                fd.density = 1.24;
                if (ch.weight) fd.weight = ch.weight;
                const settings = {};
                if (ch.hotendMax) settings.extruder_temp = ch.hotendMax;
                if (ch.bedTemp) settings.bed_temp = ch.bedTemp;
                if (Object.keys(settings).length) fd.settings = settings;
                try {
                    const extra = {};
                    if (ch.subtype) extra.subtype = JSON.stringify(ch.subtype);
                    if (ch.dryingTemp) extra.drying_temp = String(ch.dryingTemp);
                    if (ch.dryingTime) extra.drying_time = String(ch.dryingTime);
                    if (ch.td) extra.td = String(ch.td);
                    if (ch.mfDate && ch.mfDate !== '19700101') extra.mfg_date = JSON.stringify(formatMfDate(ch.mfDate));
                    if (Object.keys(extra).length) fd.extra = extra;
                    filament = await smFetch(SM_API + '/filament', { method:'POST', body: JSON.stringify(fd) });
                } catch {
                    delete fd.extra;
                    filament = await smFetch(SM_API + '/filament', { method:'POST', body: JSON.stringify(fd) });
                }
                result.filament = 'created';
            } else {
                result.filament = 'found';
            }
            // Create spool (always, even if extra fields fail)
            const sd = { filament_id: filament.id };
            if (ch.cardUid) sd.comment = `rfid:${ch.cardUid}`;
            if (ch.weight) sd.initial_weight = ch.weight;
            try {
                if (ch.cardUid) sd.extra = { rfid_uid: JSON.stringify(ch.cardUid) };
                await smFetch(SM_API + '/spool', { method:'POST', body: JSON.stringify(sd) });
            } catch {
                delete sd.extra;
                await smFetch(SM_API + '/spool', { method:'POST', body: JSON.stringify(sd) });
            }
            result.spool = 'created';
        } else {
            // ── Update path: patch filament + spool ──
            const spool = match.spool;
            const f = spool.filament || {};
            const fd = {};
            if (ch.material && ch.material.toUpperCase() !== (f.material||'').toUpperCase()) fd.material = ch.material;
            if (ch.colorHex) {
                const tagColor = ch.colorHex.replace('#','').toUpperCase();
                if (!f.color_hex || f.color_hex.toUpperCase() !== tagColor) fd.color_hex = tagColor;
            }
            if (ch.diameter) fd.diameter = ch.diameter / 100;
            if (ch.weight && ch.weight !== f.weight) fd.weight = ch.weight;
            const settings = { ...(f.settings || {}) };
            if (ch.hotendMax) settings.extruder_temp = ch.hotendMax;
            if (ch.bedTemp) settings.bed_temp = ch.bedTemp;
            fd.settings = settings;
            try {
                const extra = { ...(f.extra || {}) };
                if (ch.subtype) extra.subtype = JSON.stringify(ch.subtype);
                if (ch.dryingTemp) extra.drying_temp = String(ch.dryingTemp);
                if (ch.dryingTime) extra.drying_time = String(ch.dryingTime);
                if (ch.td) extra.td = String(ch.td);
                if (ch.mfDate && ch.mfDate !== '19700101') extra.mfg_date = JSON.stringify(formatMfDate(ch.mfDate));
                fd.extra = extra;
                await smFetch(SM_API + `/filament/${f.id}`, { method:'PATCH', body: JSON.stringify(fd) });
            } catch {
                delete fd.extra;
                await smFetch(SM_API + `/filament/${f.id}`, { method:'PATCH', body: JSON.stringify(fd) });
            }
            result.filament = 'updated';
            const sd = {};
            if (ch.weight && ch.weight !== spool.initial_weight) sd.initial_weight = ch.weight;
            if (Object.keys(sd).length) {
                await smFetch(SM_API + `/spool/${spool.id}`, { method:'PATCH', body: JSON.stringify(sd) });
                result.spool = 'updated';
            }
            if (ch.cardUid) {
                const tag = `rfid:${ch.cardUid}`;
                if (!(spool.comment || '').includes(tag)) {
                    await smFetch(SM_API + `/spool/${spool.id}`, {
                        method:'PATCH',
                        body: JSON.stringify({ comment: (spool.comment ? spool.comment + ' ' : '') + tag }),
                    });
                }
            }
        }
        state.spools = await loadSpools();
        renderGrid();
        return result;
    } catch (e) {
        throw new Error(`Channel ${chIdx} (${ch.material}): ${e.message}`);
    }
}

export async function syncAllToSpoolman() {
    const btn = $('btn-sync-all');
    if (!btn || !state.spoolmanUrl) return;
    btn.disabled = true;
    btn.textContent = '\u23f3 Syncing\u2026';
    const results = [];
    const errors = [];
    for (const ch of state.channels) {
        if (!ch.material) continue;
        try {
            const r = await syncChannelToSpoolman(ch.ch);
            if (r !== 'skip') results.push({ ch: ch.ch, ...r });
        } catch (e) {
            errors.push(e.message);
        }
    }
    btn.disabled = false;
    btn.textContent = '\u{1f504} Sync All';
    const created = results.filter(r => r.spool === 'created').length;
    const updated = results.filter(r => r.filament === 'updated').length;
    const found   = results.filter(r => r.filament === 'found').length;
    const parts = [];
    if (created) parts.push(`${created} spool${created>1?'s':''} created`);
    if (found)   parts.push(`${found} filament${found>1?'s':''} reused`);
    if (updated) parts.push(`${updated} updated`);
    if (errors.length) parts.push(`${errors.length} failed`);
    const summary = parts.length ? parts.join(', ') : 'Nothing to sync';
    if (errors.length) {
        alert(`${summary}\n\nErrors:\n${errors.join('\n')}`);
    } else {
        alert(summary);
    }
}

export async function pushToSpoolman(chIdx) {
    const ch = state.channels.find(c => c.ch === chIdx);
    if (!ch || !ch.material) return;
    const match = matchChannel(ch, state.spools);
    const diffs = match.spool ? (await import('./data.js')).diffChannelVsSpool(ch, match.spool) : [];
    const isForce = match.type !== 'none' && diffs.length > 0;
    const action = match.type === 'none' ? 'create a new spool' : `force-update ${diffs.length} field${diffs.length>1?'s':''} in Spoolman`;
    if (isForce && !confirm(`This will ${action}:\n${diffs.map(d => `  ${d.field}: "${d.spool}" → "${d.tag}"`).join('\n')}\n\nContinue?`)) return;
    try {
        const r = await syncChannelToSpoolman(chIdx);
        if (r !== 'skip') {
            const msg = r.spool === 'created' ? `Created spool in Spoolman` : `Synced to Spoolman`;
            alert(msg);
        }
    } catch (e) {
        alert(`Push failed: ${e.message}`);
    }
}

export async function doUnlink(chIdx, spoolId) {
    const ch = state.channels.find(c => c.ch === chIdx);
    if (!ch) return;
    try {
        const spool = state.spools.find(s => s.id === spoolId);
        if (spool && ch.cardUid) {
            const tag = `rfid:${ch.cardUid}`;
            const comment = (spool.comment || '').replace(tag, '').replace(/  +/g, ' ').trim();
            await smFetch(SM_API + `/spool/${spool.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ comment }),
            });
        }
        if (state.activeSpoolId === spoolId) {
            try {
                await moonFetch('/server/spoolman/spool_id', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ spool_id: 0 }),
                });
                state.activeSpoolId = null;
            } catch {}
        }
        state.spools = await loadSpools();
        renderGrid();
    } catch (e) {
        alert(`Unlink failed: ${e.message}`);
    }
}
