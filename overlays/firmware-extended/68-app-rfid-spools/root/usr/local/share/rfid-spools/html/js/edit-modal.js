// ─────────────────────────────────────────────────────────────
// Edit TigerTag modal — mapper, form population, write
// ─────────────────────────────────────────────────────────────
import { state, editTagCtx, editTagRaw, setEditTagCtx, setEditTagRaw } from './state.js';
import { TT_TAG_ID_MAKER, TT_EPOCH, TT_MATERIALS, TT_BRANDS, TT_ASPECTS, TT_DIAMETERS, TT_MESSAGE_SIZE, SM_API } from './constants.js';
import { $, escHtml, showMsg, closeModal, mfDateToISO, moonFetch, smFetch } from './utils.js';
import { encodeTigerTag, decodeTigerTag } from './tigertag.js';
import { matchChannel } from './data.js';

// ── Field limit initialization ──
const etMessageInput = $('et-message');
const etMessageLimit = $('et-message-limit');
if (etMessageInput) {
    etMessageInput.maxLength = TT_MESSAGE_SIZE;
}
if (etMessageLimit) {
    etMessageLimit.textContent = `(max ${TT_MESSAGE_SIZE} characters — filament name)`;
}

// ── Dropdown population ──
function populateSelect(id, items, valueFn, labelFn, selectedValue) {
    const sel = $(id);
    sel.innerHTML = items.map(it =>
        `<option value="${valueFn(it)}"${valueFn(it) == selectedValue ? ' selected' : ''}>${escHtml(labelFn(it))}</option>`
    ).join('');
}

// ── Color sync helpers ──
export function syncEtColorText() {
    const hex = $('et-color-picker').value.replace('#','').toUpperCase();
    const cur = $('et-color').value.trim();
    const alpha = cur.length === 8 ? cur.slice(6) : 'FF';
    $('et-color').value = hex + alpha;
}
export function syncEtColorPicker() {
    const v = $('et-color').value.trim();
    if (v.length >= 6 && /^[0-9A-Fa-f]+$/.test(v))
        $('et-color-picker').value = '#' + v.slice(0,6);
}

// ── Best-effort channel→TigerTag converter ──
function mapChannelToTigerTag(ch) {
    const _fuzzy = new Set(), _unmapped = new Set();
    const matType = (ch.material || '').trim();
    const subtype = (ch.subtype || '').trim();
    const matUpper = matType.toUpperCase();

    // --- Material ---
    let mat = subtype
        ? TT_MATERIALS.find(m => m.l.toUpperCase() === `${matUpper} ${subtype.toUpperCase()}`)
          || TT_MATERIALS.find(m => m.l.toUpperCase() === `${matUpper}-${subtype.toUpperCase()}`)
        : null;
    if (!mat) mat = TT_MATERIALS.find(m => m.t.toUpperCase() === matUpper && m.l === m.t);
    if (!mat) mat = TT_MATERIALS.find(m => m.t.toUpperCase() === matUpper);
    if (!mat && matUpper.length >= 2) {
        mat = TT_MATERIALS.find(m => m.l.toUpperCase().includes(matUpper));
        if (mat) _fuzzy.add('material');
    }
    if (!mat && matType && matUpper !== 'NONE') _unmapped.add('material');

    // --- Brand ---
    const vendor = (ch.vendor || '').trim();
    let brand = vendor ? TT_BRANDS.find(b => b.n.toLowerCase() === vendor.toLowerCase()) : null;
    if (!brand && vendor) {
        brand = TT_BRANDS.find(b =>
            b.n.toLowerCase().includes(vendor.toLowerCase()) ||
            vendor.toLowerCase().includes(b.n.toLowerCase()));
        if (brand) _fuzzy.add('brand');
    }
    if (!brand && vendor) _unmapped.add('brand');

    // --- Aspect 1 (from subtype) ---
    let asp1 = null;
    if (subtype) {
        asp1 = TT_ASPECTS.find(a => a.l.toLowerCase() === subtype.toLowerCase());
        if (!asp1) {
            asp1 = TT_ASPECTS.find(a => a.i !== 255 && (
                a.l.toLowerCase().includes(subtype.toLowerCase()) ||
                subtype.toLowerCase().includes(a.l.toLowerCase())));
            if (asp1) _fuzzy.add('aspect1');
        }
        if (!asp1 && mat && !mat.l.toUpperCase().includes(subtype.toUpperCase()))
            _unmapped.add('aspect1');
    }

    // --- Diameter ---
    const diam = ch.diameter
        ? TT_DIAMETERS.find(d => Math.abs(parseFloat(d.l) * 100 - ch.diameter) < 5) : null;

    // --- Color ---
    const rgb = ch.colorHex ? ch.colorHex.replace('#', '') : '';
    const a = (ch.alpha != null ? ch.alpha : 255).toString(16).padStart(2, '0').toUpperCase();

    return {
        materialId: mat ? mat.i : 65535,
        brandId:    brand ? brand.i : 65535,
        aspect1Id:  asp1 ? asp1.i : 255,
        aspect2Id:  255,
        diameterId: diam ? diam.i : 56,
        weight:     ch.weight || '',
        hotendMin:  ch.hotendMin || '',
        hotendMax:  ch.hotendMax || '',
        bedTempMin: '',
        bedTempMax: ch.bedTemp || '',
        dryingTemp: ch.dryingTemp || '',
        dryingTime: ch.dryingTime || '',
        td:         ch.td || '',
        colorHex:   (rgb + a).toUpperCase(),
        colorRgb:   rgb,
        mfDate:     mfDateToISO(ch.mfDate),
        _fuzzy, _unmapped,
    };
}

// ── Field hint helpers ──
function clearFieldHints() {
    document.querySelectorAll('.field-group.fuzzy, .field-group.unmapped').forEach(el =>
        el.classList.remove('fuzzy', 'unmapped'));
}
function setFieldHint(inputId, status) {
    const el = $(inputId);
    if (!el) return;
    const g = el.closest('.field-group');
    if (g) { g.classList.remove('fuzzy', 'unmapped'); g.classList.add(status); }
}

// ── Populate edit-tag form ──
function populateEditFields(ch, decoded) {
    clearFieldHints();
    const banner = $('et-mapping-banner');

    if (decoded) {
        banner.style.display = 'none';

        populateSelect('et-material', TT_MATERIALS, m => m.i, m => m.l, decoded.materialId);
        populateSelect('et-brand', TT_BRANDS, b => b.i, b => b.n, decoded.brandId);
        populateSelect('et-aspect1', TT_ASPECTS, a => a.i, a => a.l, decoded.aspect1Id);
        populateSelect('et-aspect2', TT_ASPECTS, a => a.i, a => a.l, decoded.aspect2Id);
        populateSelect('et-diameter', TT_DIAMETERS, d => d.i, d => d.l + ' mm', decoded.diameterId);

        $('et-weight').value     = decoded.weight;
        $('et-hotend-min').value = decoded.hotendMin;
        $('et-hotend-max').value = decoded.hotendMax;
        $('et-bed-min').value    = decoded.bedTempMin;
        $('et-bed-max').value    = decoded.bedTempMax;
        $('et-dry-temp').value   = decoded.dryingTemp;
        $('et-dry-time').value   = decoded.dryingTime;
        $('et-td').value         = (decoded.tdRaw / 10).toFixed(1);

        const hex = [decoded.colorR, decoded.colorG, decoded.colorB, decoded.colorA]
            .map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
        $('et-color').value = hex;
        $('et-color-picker').value = '#' + hex.slice(0, 6);

        $('et-message').value = decoded.message || '';

        if (decoded.timestamp) {
            const d = new Date((decoded.timestamp + TT_EPOCH) * 1000);
            const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
            $('et-mfg-date').value = `${y}-${m}-${dd}`;
        } else {
            $('et-mfg-date').value = '';
        }
        return;
    }

    // Non-TigerTag: best-effort conversion from channel data
    const mapped = mapChannelToTigerTag(ch);

    populateSelect('et-material', TT_MATERIALS, m => m.i, m => m.l, mapped.materialId);
    populateSelect('et-brand', TT_BRANDS, b => b.i, b => b.n, mapped.brandId);
    populateSelect('et-aspect1', TT_ASPECTS, a => a.i, a => a.l, mapped.aspect1Id);
    populateSelect('et-aspect2', TT_ASPECTS, a => a.i, a => a.l, mapped.aspect2Id);
    populateSelect('et-diameter', TT_DIAMETERS, d => d.i, d => d.l + ' mm', mapped.diameterId);

    $('et-weight').value     = mapped.weight;
    $('et-hotend-min').value = mapped.hotendMin;
    $('et-hotend-max').value = mapped.hotendMax;
    $('et-bed-min').value    = mapped.bedTempMin;
    $('et-bed-max').value    = mapped.bedTempMax;
    $('et-dry-temp').value   = mapped.dryingTemp;
    $('et-dry-time').value   = mapped.dryingTime;
    $('et-td').value         = mapped.td;

    $('et-color').value = mapped.colorHex;
    if (mapped.colorRgb.length === 6) $('et-color-picker').value = '#' + mapped.colorRgb;
    $('et-mfg-date').value = mapped.mfDate;
    $('et-message').value = [ch.vendor, ch.material, ch.subtype].filter(Boolean).join(' ');

    for (const f of mapped._fuzzy)    setFieldHint('et-' + f, 'fuzzy');
    for (const f of mapped._unmapped) setFieldHint('et-' + f, 'unmapped');

    const hasSource = !!(ch.material || ch.vendor);
    if (!hasSource) {
        banner.textContent = '\uD83C\uDFF7 Blank tag \u2014 fill in fields and write to format as TigerTag';
        banner.className = 'mapping-banner warn';
        banner.style.display = '';
    } else if (mapped._unmapped.size > 0) {
        banner.textContent = '\u26a0 Some fields could not be mapped \u2014 please review highlighted fields';
        banner.className = 'mapping-banner warn';
        banner.style.display = '';
    } else if (mapped._fuzzy.size > 0) {
        banner.textContent = '\u2139 Some fields were fuzzy-matched \u2014 please verify highlighted fields';
        banner.className = 'mapping-banner warn';
        banner.style.display = '';
    } else {
        banner.textContent = '\u2713 All fields mapped successfully';
        banner.className = 'mapping-banner ok';
        banner.style.display = '';
    }
}

// ── Initialize edit-text field limits from constants ──
const etMessageField = $('et-message');
if (etMessageField) {
    etMessageField.maxLength = TT_MESSAGE_SIZE;
}

// ── Open edit tag modal ──
export async function openEditTag(chIdx) {
    const ch = state.channels.find(c => c.ch === chIdx);
    if (!ch) return;
    setEditTagCtx(ch);
    setEditTagRaw(null);

    $('edit-tag-title').textContent = `Edit Tag \u2014 Channel ${chIdx}`;
    $('et-status').className = 'status-msg';
    $('et-confirm').disabled = false;
    $('et-confirm').textContent = '\u270e Write TigerTag';

    populateEditFields(ch, null);
    $('edit-tag-modal').classList.add('visible');

    try {
        showMsg('et-status', '\u23f3 Reading tag\u2026', 'info');
        const rr = await fetch('/rfid-spools/api/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: chIdx }),
        });
        const rj = await rr.json();
        if (rj.ok && rj.hex) {
            const bytes = new Uint8Array(rj.hex.match(/.{2}/g).map(h => parseInt(h, 16)));
            const decoded = decodeTigerTag(bytes);
            if (decoded.tagId === TT_TAG_ID_MAKER) {
                setEditTagRaw(bytes);
                populateEditFields(ch, decoded);
                $('edit-tag-title').textContent = `Edit TigerTag \u2014 Channel ${chIdx}`;
                showMsg('et-status', '\u2713 TigerTag data loaded', 'ok');
            } else {
                $('edit-tag-title').textContent = `Format as TigerTag \u2014 Channel ${chIdx}`;
                showMsg('et-status', '\u2139 Non-TigerTag \u2014 writing will format as TigerTag', 'info');
            }
            setTimeout(() => { $('et-status').className = 'status-msg'; }, 2500);
        } else {
            $('et-status').className = 'status-msg';
        }
    } catch {
        $('et-status').className = 'status-msg';
    }
}

// ── Write TigerTag to physical NTAG ──
export async function doWriteTag() {
    const ch = editTagCtx;
    if (!ch) return;

    const matId = +$('et-material').value;
    if (!matId || matId === 65535) {
        showMsg('et-status', '\u26a0 Material is required', 'error');
        return;
    }

    $('et-confirm').disabled = true;
    showMsg('et-status', '\u23f3 Encoding and writing\u2026', 'info');

    try {
        const colHex = $('et-color').value.trim();
        let cR = 0, cG = 0, cB = 0, cA = 255;
        if (colHex.length >= 6 && /^[0-9A-Fa-f]+$/.test(colHex)) {
            cR = parseInt(colHex.slice(0,2), 16);
            cG = parseInt(colHex.slice(2,4), 16);
            cB = parseInt(colHex.slice(4,6), 16);
            if (colHex.length >= 8) cA = parseInt(colHex.slice(6,8), 16);
        }

        let ts = 0;
        const mfg = $('et-mfg-date').value.trim().replace(/-/g, '');
        if (/^\d{8}$/.test(mfg)) {
            const d = new Date(+mfg.slice(0,4), +mfg.slice(4,6)-1, +mfg.slice(6,8));
            ts = Math.max(0, Math.floor(d.getTime() / 1000) - TT_EPOCH);
        }

        const rawUd = editTagRaw && editTagRaw.length > 96
            ? editTagRaw.slice(16, 16+96) : (editTagRaw || null);

        const payload = encodeTigerTag({
            tagId:      TT_TAG_ID_MAKER,
            productId:  rawUd ? new DataView(rawUd.buffer, rawUd.byteOffset, rawUd.byteLength).getUint32(4) : 0,
            materialId: +$('et-material').value,
            aspect1Id:  +$('et-aspect1').value,
            aspect2Id:  +$('et-aspect2').value,
            typeId:     142,
            diameterId: +$('et-diameter').value,
            brandId:    +$('et-brand').value,
            colorR: cR, colorG: cG, colorB: cB, colorA: cA,
            weight:     parseInt($('et-weight').value) || 0,
            unitId:     21,
            hotendMin:  parseInt($('et-hotend-min').value) || 0,
            hotendMax:  parseInt($('et-hotend-max').value) || 0,
            dryingTemp: parseInt($('et-dry-temp').value) || 0,
            dryingTime: parseInt($('et-dry-time').value) || 0,
            bedTempMin: parseInt($('et-bed-min').value) || 0,
            bedTempMax: parseInt($('et-bed-max').value) || 0,
            timestamp:  ts,
            tdRaw:      Math.round((parseFloat($('et-td').value) || 0) * 10),
            message:    $('et-message').value.trim(),
            _raw:       rawUd ? new Uint8Array(rawUd) : null,
        });

        const hex = Array.from(payload).map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();

        showMsg('et-status', '\u23f3 Writing to tag\u2026', 'info');
        const wr = await fetch('/rfid-spools/api/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: ch.ch, data: hex }),
        });
        const wj = await wr.json();
        if (!wj.ok) throw new Error(wj.error || `HTTP ${wr.status}`);

        showMsg('et-status', '\u2713 Tag written! Updating\u2026', 'ok');

        const uidHex = wj.uid || '';
        const uidBytes = [];
        for (let i = 0; i < uidHex.length; i += 2)
            uidBytes.push(parseInt(uidHex.slice(i, i+2), 16));

        const brandId    = +$('et-brand').value;
        const materialId = +$('et-material').value;
        const aspect1Id  = +$('et-aspect1').value;
        const diameterId = +$('et-diameter').value;

        const brandName = (TT_BRANDS.find(b => b.i === brandId) || {}).n || 'Generic';
        const matEntry  = TT_MATERIALS.find(m => m.i === materialId) || {};
        const mainType  = matEntry.t || matEntry.l || 'None';
        const subType   = (TT_ASPECTS.find(a => a.i === aspect1Id) || {}).l || '';
        const diaVal    = (TT_DIAMETERS.find(d => d.i === diameterId) || {}).l || '1.75';

        const fdPayload = {
            channel: ch.ch,
            info: {
                VENDOR:         brandName,
                MAIN_TYPE:      mainType,
                SUB_TYPE:       subType === 'None' || subType === '-' ? '' : subType,
                HOTEND_MIN_TEMP: parseInt($('et-hotend-min').value) || 0,
                HOTEND_MAX_TEMP: parseInt($('et-hotend-max').value) || 0,
                BED_TEMP:        Math.max(parseInt($('et-bed-min').value) || 0,
                                          parseInt($('et-bed-max').value) || 0),
                ALPHA:          cA,
                RGB_1:          (cR << 16) | (cG << 8) | cB,
                CARD_UID:       uidBytes,
                DIAMETER:       Math.round(parseFloat(diaVal) * 100),
                WEIGHT:         parseInt($('et-weight').value) || 0,
                DRYING_TEMP:    parseInt($('et-dry-temp').value) || 0,
                DRYING_TIME:    parseInt($('et-dry-time').value) || 0,
                MF_DATE:        $('et-mfg-date').value.trim(),
                TD:             parseFloat($('et-td').value) || 0,
            }
        };
        await moonFetch('/printer/filament_detect/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fdPayload),
        });

        // Update Spoolman filament name with brand + material + message
        const msg = $('et-message').value.trim();
        if (state.spoolmanUrl) {
            const match = matchChannel(ch, state.spools);
            if (match.spool && match.spool.filament) {
                const fil = match.spool.filament;
                const smName = [brandName, mainType, msg].filter(Boolean).join(' ');
                if (smName && fil.name !== smName) {
                    try {
                        await smFetch(SM_API + `/filament/${fil.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ name: smName }),
                        });
                    } catch {}
                }
            }
        }

        await window.refreshAll();
        closeModal('edit-tag-modal');

    } catch (e) {
        showMsg('et-status', '\u2717 Write failed: ' + escHtml(e.message), 'err');
        $('et-confirm').disabled = false;
    }
}
