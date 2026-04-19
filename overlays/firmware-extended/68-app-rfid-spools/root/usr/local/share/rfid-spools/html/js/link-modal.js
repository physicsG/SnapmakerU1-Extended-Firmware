// ─────────────────────────────────────────────────────────────
// Link to existing spool modal
// ─────────────────────────────────────────────────────────────
import { state, linkCtx, linkSelectedId, allSpoolsForLink,
         setLinkCtx, setLinkSelectedId, setAllSpoolsForLink } from './state.js';
import { SM_API } from './constants.js';
import { $, escHtml, smFetch, moonFetch, showMsg, closeModal } from './utils.js';
import { loadSpools } from './data.js';
import { renderGrid } from './render.js';

export function openLink(chIdx) {
    const ch = state.channels.find(c => c.ch === chIdx);
    if (!ch) return;
    setLinkCtx(ch);
    setLinkSelectedId(null);
    $('link-confirm').disabled = true;
    $('link-status').className = 'status-msg';
    $('spool-search').value = '';
    setAllSpoolsForLink(state.spools);
    renderSpoolList(state.spools);
    $('link-modal').classList.add('visible');
}

export function filterSpools() {
    const q = $('spool-search').value.trim().toLowerCase();
    renderSpoolList(q
        ? allSpoolsForLink.filter(s => {
            const f = s.filament || {};
            return (f.name||'').toLowerCase().includes(q)
                || (f.material||'').toLowerCase().includes(q)
                || ((f.vendor||{}).name||'').toLowerCase().includes(q)
                || (s.comment||'').toLowerCase().includes(q);
        })
        : allSpoolsForLink);
}

function renderSpoolList(spools) {
    const list = $('spool-list');
    if (!spools.length) {
        list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:13px">No spools found</div>';
        return;
    }
    list.innerHTML = spools.map(s => {
        const f = s.filament || {};
        const col = f.color_hex ? `#${f.color_hex}` : '#555';
        const name = f.name || [(f.vendor||{}).name, f.material].filter(Boolean).join(' ') || 'Spool';
        const meta = [f.material, (f.vendor||{}).name, s.remaining_weight != null ? `${Math.round(s.remaining_weight)}g` : null].filter(Boolean).join(' \u00b7 ');
        const sel = linkSelectedId === s.id ? ' selected' : '';
        return `<div class="spool-item${sel}" onclick="selectSpool(${s.id},this)">
            <span class="spool-dot" style="background:${escHtml(col)}"></span>
            <div class="spool-text">
                <div class="spool-name">${escHtml(name)} <span style="color:var(--muted);font-size:11px">#${s.id}</span></div>
                <div class="spool-meta">${escHtml(meta)}</div>
            </div>
        </div>`;
    }).join('');
}

export function selectSpool(id, el) {
    $('spool-list').querySelectorAll('.spool-item').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    setLinkSelectedId(id);
    $('link-confirm').disabled = false;
}

export async function doLink() {
    if (!linkCtx || !linkSelectedId) return;
    const ch = linkCtx;
    const spool = state.spools.find(s => s.id === linkSelectedId);
    if (!spool) return;
    $('link-confirm').disabled = true;
    showMsg('link-status', '\u23f3 Linking\u2026', 'info');
    try {
        if (ch.cardUid) {
            const tag = `rfid:${ch.cardUid}`;
            const existing = spool.comment || '';
            if (!existing.includes(tag)) {
                await smFetch(SM_API + `/spool/${spool.id}`, {
                    method:'PATCH',
                    body: JSON.stringify({ comment: existing ? `${existing} ${tag}` : tag }),
                });
            }
        }
        await moonFetch('/server/spoolman/spool_id', {
            method:'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({ spool_id: spool.id }),
        });
        state.activeSpoolId = spool.id;
        showMsg('link-status', `\u2713 Linked to spool #${spool.id} and set as active`, 'ok');
        state.spools = await loadSpools();
        renderGrid();
        setTimeout(() => closeModal('link-modal'), 1500);
    } catch (e) {
        showMsg('link-status', `\u2717 ${e.message}`, 'err');
        $('link-confirm').disabled = false;
    }
}
