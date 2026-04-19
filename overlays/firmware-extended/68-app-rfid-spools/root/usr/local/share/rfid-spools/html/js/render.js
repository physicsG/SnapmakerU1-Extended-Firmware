// ─────────────────────────────────────────────────────────────
// Channel grid and card rendering
// ─────────────────────────────────────────────────────────────
import { state } from './state.js';
import { $, escHtml, colorDot, formatMfDate } from './utils.js';
import { matchChannel, diffChannelVsSpool, isNtag, canEditTag } from './data.js';

export function renderGrid() {
    const grid = $('channels-grid');
    if (!state.channels.length) {
        grid.innerHTML = '<div class="loading">No channel data.</div>';
        return;
    }
    grid.innerHTML = state.channels
        .map(ch => renderCard(ch, matchChannel(ch, state.spools), state.activeSpoolId))
        .join('');
}

export function badge(id, ok, label) {
    const el = $(id);
    if (ok === null) { el.className = 'badge badge-muted'; el.textContent = `\u2299 ${label}`; }
    else if (ok)     { el.className = 'badge badge-ok';    el.textContent = `\u2b24 ${label}`; }
    else             { el.className = 'badge badge-error'; el.textContent = `\u2298 ${label}`; }
}

function renderCard(ch, match, activeId) {
    const isBlankTag = !ch.material && isNtag(ch);
    const isEmpty   = !ch.material && !isBlankTag;
    const isActive  = !!(match.spool && match.spool.id === activeId);
    const allColors = [ch.colorHex, ...ch.extraColors].filter(Boolean);

    const barBg = allColors.length > 1
        ? `linear-gradient(90deg,${allColors.map((c,i,a)=>`${c} ${100*i/a.length}%,${c} ${100*(i+1)/a.length}%`).join(',')})`
        : (allColors[0] || '#3a3a3a');

    const swatchBg = allColors.length > 1
        ? `conic-gradient(${allColors.map((c,i,a)=>`${c} ${360*i/a.length}deg ${360*(i+1)/a.length}deg`).join(',')})`
        : (allColors[0] || '#555');

    let badgeHtml = '';
    if (isEmpty)           badgeHtml = `<span class="badge badge-muted">Empty</span>`;
    else if (isBlankTag)   badgeHtml = `<span class="badge badge-info">\uD83C\uDFF7 Blank Tag</span>`;
    else if (isActive)     badgeHtml = `<span class="badge badge-ok">\u2b24 Active</span>`;
    else if (match.type === 'uid')  badgeHtml = `<span class="badge badge-ok">\u2b24 In Spoolman</span>`;
    else if (match.type === 'prop') badgeHtml = `<span class="badge badge-info">\u2248 Matched</span>`;
    else                   badgeHtml = `<span class="badge badge-warn">\uff0b Not in Spoolman</span>`;

    // ── Detail rows ──
    const dim = '\u2014';
    const rows = [];
    rows.push(['RFID UID', `<span class="detail-val dim">${ch.cardUid ? escHtml(ch.cardUid) : dim}</span>`]);
    rows.push(['Official', `<span class="detail-val">${ch.official ? '<span class="badge badge-ok" style="font-size:10px">Yes</span>' : '<span class="badge badge-muted" style="font-size:10px">No</span>'}</span>`]);
    rows.push(['Color', `<span class="detail-val">${ch.colorHex ? colorDot(ch.colorHex) + ' ' + escHtml(ch.colorHex) : dim}${ch.alpha != null && ch.alpha !== 255 ? ' \u03b1' + ch.alpha : ''}</span>`]);
    if (ch.extraColors.length)
        rows.push(['Extra colors', `<span class="detail-val">${ch.extraColors.map(c => colorDot(c) + ' ' + escHtml(c)).join('&ensp;')}</span>`]);
    rows.push(['Hotend temp', `<span class="detail-val">${ch.hotendMin || ch.hotendMax ? (ch.hotendMin && ch.hotendMax ? `${ch.hotendMin} \u2013 ${ch.hotendMax}` : `${ch.hotendMin || ch.hotendMax}`) + ' \u00b0C' : dim}</span>`]);
    rows.push(['Bed temp', `<span class="detail-val">${ch.bedTemp ? ch.bedTemp + ' \u00b0C' : dim}</span>`]);
    rows.push(['Diameter', `<span class="detail-val">${ch.diameter ? (ch.diameter / 100).toFixed(2) + ' mm' : dim}</span>`]);
    rows.push(['Weight', `<span class="detail-val">${ch.weight ? ch.weight + ' g' : dim}</span>`]);
    rows.push(['Drying temp', `<span class="detail-val">${ch.dryingTemp ? ch.dryingTemp + ' \u00b0C' : dim}</span>`]);
    rows.push(['Drying time', `<span class="detail-val">${ch.dryingTime ? ch.dryingTime + ' h' : dim}</span>`]);
    rows.push(['TD', `<span class="detail-val">${ch.td != null ? ch.td + ' mm' : dim}</span>`]);
    rows.push(['Mfg date', `<span class="detail-val">${ch.mfDate && ch.mfDate !== '19700101' ? escHtml(formatMfDate(ch.mfDate)) : dim}</span>`]);
    if (!ch.hasRfid && ch.material)
        rows.push(['Source', `<span class="badge badge-muted" style="font-size:10px">Manual / no RFID</span>`]);

    const detailsHtml = rows.length ? `
        <div class="detail-rows">
            ${rows.map(([k,v]) => `
            <div class="detail-row">
                <span class="detail-key">${escHtml(k)}</span>
                ${v}
            </div>`).join('')}
        </div>` : '';

    // ── Tag actions (NTAG write) ──
    let tagActionsHtml = '';
    if (canEditTag(ch)) {
        tagActionsHtml = `<div class="tag-actions">
            <button class="btn btn-warning btn-sm" onclick="openEditTag(${ch.ch})">${isBlankTag ? '&#9998; Format Tag' : '&#9998; Edit Tag'}</button>
        </div>`;
    }

    // ── Spoolman section ──
    let smHtml = '';
    if (ch.material) {
        const hasUrl = !!state.spoolmanUrl;
        if (!hasUrl) {
            smHtml = `<div class="sm-section"><span style="font-size:12px;color:var(--muted)">Configure Spoolman URL above</span></div>`;
        } else if (match.type === 'none') {
            smHtml = `<div class="sm-section">
                <div class="sm-row">
                    <span class="sm-info">Not found in Spoolman</span>
                    <div class="sm-buttons">
                        <button class="btn btn-warning btn-sm" onclick="openImport(${ch.ch})">Import</button>
                        <button class="btn btn-secondary btn-sm" onclick="openLink(${ch.ch})">Link</button>
                    </div>
                </div>
            </div>`;
        } else {
            const s = match.spool;
            const f = s.filament || {};
            const fName = f.name || [(f.vendor||{}).name, f.material].filter(Boolean).join(' ') || 'Spool';
            const remaining = s.remaining_weight != null ? `${Math.round(s.remaining_weight)} g remaining` : '';
            const matchNote = match.type === 'prop' ? '<div class="sm-sub" style="color:var(--warning)">\u26a0 matched by properties</div>' : '';
            const diffs = diffChannelVsSpool(ch, s);
            const diffHtml = diffs.length ? `<div class="sm-sub" style="color:var(--warning)">\u26a0 ${diffs.length} field${diffs.length>1?'s':''} differ: ${escHtml(diffs.map(d=>d.field).join(', '))}</div>` : '';
            const setBtnHtml = isActive
                ? `<span class="badge badge-ok" style="align-self:center">Active</span>`
                : `<button class="btn btn-primary btn-sm" onclick="setActive(${s.id},${ch.ch})">Set active</button>`;
            const syncBtnHtml = diffs.length
                ? `<button class="btn btn-warning btn-sm" onclick="syncChannelToSpoolman(${ch.ch})">Sync</button>`
                : '';
            smHtml = `<div class="sm-section">
                <div class="sm-row">
                    <div class="sm-info">
                        <div class="sm-name">${escHtml(fName)} <span style="color:var(--muted);font-size:11px">#${s.id}</span></div>
                        ${remaining ? `<div class="sm-sub">${escHtml(remaining)}</div>` : ''}
                        ${matchNote}
                        ${diffHtml}
                    </div>
                    <div class="sm-buttons">
                        ${setBtnHtml}
                        ${syncBtnHtml}
                        <button class="btn btn-secondary btn-sm" onclick="openLink(${ch.ch})">Re-link</button>
                        <button class="btn btn-secondary btn-sm" onclick="doUnlink(${ch.ch},${s.id})">Unlink</button>
                    </div>
                </div>
            </div>`;
        }
    }

    const laneNames = ['E0','E1','E2','E3'];
    const lane = laneNames[ch.ch] || `E${ch.ch}`;
    const cardClass = `channel-card${isEmpty?' empty':''}${isActive?' active-spool':''}`;

    return `<div class="${cardClass}" id="card-${ch.ch}">
        <div class="color-bar" style="background:${barBg}"></div>
        <div class="ch-header">
            <span class="ch-label">Channel ${ch.ch} / ${lane}</span>
            ${badgeHtml}
        </div>
        ${isEmpty ? `<div class="empty-slot">No filament detected</div>` : `
        <div class="fil-summary">
            <div class="color-swatch" style="background:${swatchBg}"></div>
            <div class="fil-text">
                ${ch.vendor ? `<div class="fil-vendor">${escHtml(ch.vendor)}</div>` : ''}
                <div class="fil-material">${ch.material ? escHtml(ch.material) : '<span style="color:var(--muted);font-style:italic">Blank Tag</span>'}${ch.subtype ? `<span style="font-size:12px;font-weight:400;color:var(--muted);margin-left:5px">${escHtml(ch.subtype)}</span>` : ''}</div>
            </div>
        </div>
        ${detailsHtml}`}
        ${tagActionsHtml}
        ${smHtml}
    </div>`;
}
