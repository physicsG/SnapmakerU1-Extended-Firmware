// ─────────────────────────────────────────────────────────────
// Data loading, matching, and diff
// ─────────────────────────────────────────────────────────────
import { state } from './state.js';
import { SM_API, TT_BRANDS } from './constants.js';
import { moonFetch, smFetch, rgb1ToHex, uidToHex } from './utils.js';

export function isNtag(ch) { return ch.cardUid && ch.cardUid.length === 14; }

export function canEditTag(ch) {
    if (isNtag(ch)) return true;
    if (!ch.hasRfid || !ch.material) return false;
    if (ch.cardUid && ch.cardUid.length > 0 && ch.cardUid.length !== 14) return false;
    return true;
}

// Compare channel tag data against a matched Spoolman spool/filament.
export function diffChannelVsSpool(ch, spool) {
    if (!spool || !spool.filament) return [];
    const f = spool.filament;
    const diffs = [];
    const cmp = (field, tagVal, smVal) => {
        if (tagVal != null && smVal != null && String(tagVal).toLowerCase() !== String(smVal).toLowerCase())
            diffs.push({ field, tag: tagVal, spool: smVal });
    };
    // Strip JSON encoding from Spoolman extra text values (legacy double-quoted data)
    const smText = v => { try { const p = JSON.parse(v); return typeof p === 'string' ? p : v; } catch { return v; } };
    cmp('Vendor',   ch.vendor, (f.vendor||{}).name || 'Generic');
    cmp('Material', ch.material, f.material);
    if (ch.colorHex && f.color_hex)
        cmp('Color', ch.colorHex.replace('#','').toUpperCase(), f.color_hex.toUpperCase());
    if (ch.diameter && f.diameter)
        cmp('Diameter', (ch.diameter/100).toFixed(2), f.diameter.toFixed(2));
    const fe = f.extra || {};
    if (ch.subtype && fe.subtype)
        cmp('Subtype', ch.subtype, smText(fe.subtype));
    if (ch.dryingTemp && fe.drying_temp)
        cmp('Drying temp', ch.dryingTemp, fe.drying_temp);
    if (ch.dryingTime && fe.drying_time)
        cmp('Drying time', ch.dryingTime, fe.drying_time);
    const st = f.settings || {};
    if (ch.hotendMax && st.extruder_temp)
        cmp('Hotend temp', ch.hotendMax, st.extruder_temp);
    if (ch.bedTemp && st.bed_temp)
        cmp('Bed temp', ch.bedTemp, st.bed_temp);
    if (ch.weight && spool.initial_weight)
        cmp('Weight', ch.weight, spool.initial_weight);
    return diffs;
}

export async function loadChannels() {
    const data = await moonFetch('/printer/objects/query?filament_detect&print_task_config');
    const status = (data.result || {}).status || {};
    const fd  = status.filament_detect    || {};
    const ptc = status.print_task_config  || {};

    const fdInfo     = fd.info                     || [];
    const ptcVendor  = ptc.filament_vendor         || [];
    const ptcType    = ptc.filament_type           || [];
    const ptcSub     = ptc.filament_sub_type       || [];
    const ptcColor   = ptc.filament_color_rgba     || [];
    const ptcExist   = ptc.filament_exist          || [];

    const n = Math.max(fdInfo.length, ptcVendor.length, 4);
    const channels = [];

    for (let ch = 0; ch < n; ch++) {
        const f = fdInfo[ch] || {};

        let vendor   = (f.VENDOR   && f.VENDOR   !== 'NONE') ? f.VENDOR   : '';
        let material = (f.MAIN_TYPE && f.MAIN_TYPE !== 'NONE') ? f.MAIN_TYPE : '';
        let subtype  = (f.SUB_TYPE && f.SUB_TYPE  !== 'NONE') ? f.SUB_TYPE  : '';

        let rgb1 = f.RGB_1 || 0;
        let alpha = (f.ALPHA != null) ? f.ALPHA : 255;
        const extraRgb = [f.RGB_2, f.RGB_3, f.RGB_4, f.RGB_5].filter(Boolean);

        let hotendMin  = f.HOTEND_MIN_TEMP || 0;
        let hotendMax  = f.HOTEND_MAX_TEMP || 0;
        let bedTemp    = f.BED_TEMP        || 0;
        let weight     = f.WEIGHT          || 0;
        let diameter   = f.DIAMETER        || 0;
        let dryingTemp = f.DRYING_TEMP     || 0;
        let dryingTime = f.DRYING_TIME     || 0;
        let td         = f.TD              || null;
        let mfDate     = f.MF_DATE         || '';

        const cardUid = uidToHex(f.CARD_UID);
        const official = !!f.OFFICIAL;
        const hasRfid = !!f.MAIN_TYPE;

        if (!material) {
            vendor   = ptcVendor[ch] || '';
            material = ptcType[ch]   || '';
            subtype  = ptcSub[ch]    || '';
            const rgba = ptcColor[ch] || '';
            if (rgba.length >= 6) {
                rgb1 = parseInt(rgba.slice(0, 6), 16) || 0;
                if (rgba.length >= 8) alpha = parseInt(rgba.slice(6, 8), 16);
            }
        }

        const colorHex    = rgb1ToHex(rgb1);
        const extraColors = extraRgb.map(rgb1ToHex).filter(Boolean);
        const exist = ptcExist[ch] != null ? ptcExist[ch] : !!material;

        // Resolve "Unknown(NNN)" vendors from our TigerTag brand table
        const unknownMatch = vendor.match(/^Unknown\((\d+)\)$/i);
        if (unknownMatch) {
            const brandId = parseInt(unknownMatch[1]);
            const brand = TT_BRANDS.find(b => b.i === brandId);
            if (brand && brand.i !== 65535) vendor = brand.n;
        }

        channels.push({ ch, vendor, material, subtype, colorHex, alpha, extraColors,
            cardUid, official, hasRfid, hotendMin, hotendMax, bedTemp, weight, diameter,
            dryingTemp, dryingTime, td, mfDate, exist });
    }
    return channels;
}

export async function loadSpools() {
    const spools = await smFetch(SM_API + '/spool');
    return Array.isArray(spools) ? spools.filter(s => !s.archived) : [];
}

export async function loadActiveSpool() {
    try {
        const d = await moonFetch('/server/spoolman/status');
        return (d.result || {}).spool_id || null;
    } catch { return null; }
}

export function matchChannel(ch, spools) {
    if (!ch.material) return { type: 'empty', spool: null };

    if (ch.cardUid) {
        const tag = `rfid:${ch.cardUid}`;
        const s = spools.find(sp => (sp.comment || '').includes(tag));
        if (s) return { type: 'uid', spool: s };
    }

    const mat = ch.material.toUpperCase();
    const col = ch.colorHex ? ch.colorHex.replace('#', '').toUpperCase() : null;
    const ven = (ch.vendor || '').toLowerCase();

    const s = spools.find(sp => {
        const f = sp.filament; if (!f) return false;
        const matOk = (f.material || '').toUpperCase() === mat;
        const venOk = !ven
            || (f.vendor && f.vendor.name.toLowerCase() === ven)
            || (!f.vendor && ven === 'generic');
        const colOk = !col || !f.color_hex
            || f.color_hex.toUpperCase() === col;
        return matOk && venOk && colOk;
    });
    if (s) return { type: 'prop', spool: s };

    return { type: 'none', spool: null };
}
