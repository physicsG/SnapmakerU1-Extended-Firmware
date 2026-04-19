// ─────────────────────────────────────────────────────────────
// Shared application state
// ─────────────────────────────────────────────────────────────
export const state = {
    spoolmanUrl: localStorage.getItem('rfid-spoolman-url') || '',
    channels: [],
    spools: [],
    activeSpoolId: null,
};

// Modal context variables
export let importCtx = null;
export let linkCtx = null;
export let linkSelectedId = null;
export let allSpoolsForLink = [];
export let editTagCtx = null;
export let editTagRaw = null;

export function setImportCtx(v)      { importCtx = v; }
export function setLinkCtx(v)        { linkCtx = v; }
export function setLinkSelectedId(v) { linkSelectedId = v; }
export function setAllSpoolsForLink(v) { allSpoolsForLink = v; }
export function setEditTagCtx(v)     { editTagCtx = v; }
export function setEditTagRaw(v)     { editTagRaw = v; }
