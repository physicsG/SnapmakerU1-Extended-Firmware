// ─────────────────────────────────────────────────────────────
// Debug log panel
// ─────────────────────────────────────────────────────────────
import { $, escHtml, moonFetch, authHeaders } from './utils.js';

let logAutoPollTimer = null;

export function toggleLog() {
    const body = $('log-body');
    const title = $('log-card').querySelector('.log-title');
    const isOpen = body.classList.toggle('open');
    title.textContent = (isOpen ? '\u25bc' : '\u25b6') + ' Debug Log';
}

export function logAppend(cls, text) {
    const out = $('log-output');
    const ts = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.innerHTML = `<span class="log-ts">[${ts}]</span> <span class="${cls}">${text}</span>`;
    out.appendChild(line);
    while (out.children.length > 500) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
}

function logJson(label, obj) {
    const json = JSON.stringify(obj, null, 2);
    const colored = escHtml(json)
        .replace(/"([^"]+)"\s*:/g, '<span class="log-key">"$1"</span>:')
        .replace(/: ("[^"]*")/g, ': <span class="log-val">$1</span>')
        .replace(/: (\d+\.?\d*)/g, ': <span class="log-val">$1</span>')
        .replace(/: (true|false|null)/g, ': <span class="log-val">$1</span>');
    logAppend('log-info', escHtml(label));
    const out = $('log-output');
    const pre = document.createElement('div');
    pre.style.cssText = 'margin:0 0 4px 16px;';
    pre.innerHTML = colored;
    out.appendChild(pre);
    out.scrollTop = out.scrollHeight;
}

export function clearLog() { $('log-output').innerHTML = ''; }

export function copyLog() {
    const out = $('log-output');
    const text = out.innerText;
    navigator.clipboard.writeText(text).then(
        () => logAppend('log-info', 'Copied to clipboard (' + text.length + ' chars)'),
        () => {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
            logAppend('log-info', 'Copied to clipboard (fallback)');
        }
    );
}

export async function fetchOpenRfidLog() {
    logAppend('log-info', 'Fetching OpenRFID syslog ...');
    try {
        const resp = await fetch('/firmware-config/api/action/openrfid-log', {
            method: 'POST',
            headers: authHeaders(),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const text = await resp.text();
        const lines = text.split('\n').filter(l =>
            l && !l.startsWith('===') && !l.startsWith('SUCCESS:') && !l.startsWith('ERROR:') && l !== 'Fetching OpenRFID log entries...'
        );
        if (lines.length) {
            logAppend('log-info', '\u2500\u2500 OpenRFID syslog (last lines) \u2500\u2500');
            lines.forEach(line => {
                const cls = /error|fail|exception/i.test(line) ? 'log-err'
                    : /warn/i.test(line) ? 'log-warn' : 'log-info';
                logAppend(cls, escHtml(line));
            });
        } else {
            logAppend('log-warn', 'No OpenRFID entries in syslog.');
        }
    } catch (e) {
        logAppend('log-err', 'Could not fetch syslog: ' + escHtml(e.message));
        logAppend('log-warn', 'Tip: SSH into the printer and run:');
        logAppend('log-warn', '  logread | grep -i openrfid | tail -50');
        logAppend('log-warn', '  # or for live following:');
        logAppend('log-warn', '  logread -f | grep -i openrfid');
    }
}

export async function fetchKlipperLog() {
    logAppend('log-info', 'Fetching klippy.log tail (filament_detect lines) ...');
    try {
        const resp = await fetch('/server/files/klippy.log', { headers: authHeaders() });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const text = await resp.text();
        const lines = text.split('\n');
        const tail = lines.slice(-500);
        const filtered = tail.filter(l =>
            /filament_detect|filament_info|RFID|rfid|openrfid|tag_read|nfc/i.test(l)
        );
        if (filtered.length) {
            logAppend('log-info', `\u2500\u2500 klippy.log (${filtered.length} matching lines) \u2500\u2500`);
            filtered.slice(-80).forEach(line => {
                const cls = /error|fail|exception/i.test(line) ? 'log-err'
                    : /warn/i.test(line) ? 'log-warn' : 'log-info';
                logAppend(cls, escHtml(line));
            });
        } else {
            logAppend('log-warn', 'No filament_detect/RFID entries in recent klippy.log');
            logAppend('log-info', '\u2500\u2500 klippy.log (last 20 lines) \u2500\u2500');
            lines.slice(-20).forEach(l => logAppend('log-info', escHtml(l)));
        }
    } catch (e) {
        logAppend('log-err', 'Could not fetch klippy.log: ' + escHtml(e.message));
    }
}

export async function pollOnce() {
    logAppend('log-info', 'Polling filament_detect + print_task_config ...');
    try {
        const data = await moonFetch('/printer/objects/query?filament_detect&print_task_config');
        const status = (data.result || {}).status || {};
        const fd  = status.filament_detect   || {};
        const ptc = status.print_task_config || {};

        const fdInfo = fd.info || [];
        for (let i = 0; i < fdInfo.length; i++) {
            const f = fdInfo[i];
            const keys = Object.keys(f).filter(k => {
                const v = f[k];
                if (v === 0 || v === '' || v === 'NONE') return false;
                if (Array.isArray(v) && v.every(x => x === 0)) return false;
                return true;
            });
            if (keys.length === 0) {
                logAppend('log-warn', `CH${i}: empty / no tag`);
            } else {
                logJson(`CH${i} filament_detect.info[${i}]`, f);
            }
        }

        const ptcSummary = {};
        for (const k of Object.keys(ptc)) {
            const v = ptc[k];
            if (Array.isArray(v) && v.some(x => x && x !== 'NONE' && x !== '00000000')) ptcSummary[k] = v;
        }
        if (Object.keys(ptcSummary).length) {
            logJson('print_task_config (non-empty)', ptcSummary);
        }

        logAppend('log-info', `Poll complete — ${fdInfo.length} channel(s)`);
    } catch (e) {
        logAppend('log-err', 'Poll error: ' + escHtml(e.message));
    }
}

export function toggleAutoPoll() {
    if ($('log-autopoll').checked) {
        if (!$('log-body').classList.contains('open')) toggleLog();
        pollOnce();
        logAutoPollTimer = setInterval(pollOnce, 3000);
    } else {
        clearInterval(logAutoPollTimer);
        logAutoPollTimer = null;
    }
}
