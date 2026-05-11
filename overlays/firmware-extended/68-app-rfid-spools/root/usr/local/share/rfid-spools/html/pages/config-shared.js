'use strict';

// ── Shared config page constants & helpers ───────────────────────────────────

var ConfigShared = (function () {

    var DEFAULT_NAMES = [
        'Slot 1 (Top-Left)',
        'Slot 2 (Bottom-Left)',
        'Slot 3 (Top-Right)',
        'Slot 4 (Bottom-Right)'
    ];

    function buildSelect(options, selectedValue, className) {
        var sel = document.createElement('select');
        sel.className = 'mapping-select ' + className;
        options.forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (opt.value === selectedValue) o.selected = true;
            sel.appendChild(o);
        });
        return sel;
    }    // Probe the Spoolman the printer is configured against. The deleted
    // backend supported ad-hoc URL pings, but Moonraker only knows about
    // the URL set in moonraker.conf — checking arbitrary URLs from the
    // browser hits CORS. The Save action below already restarts Moonraker's
    // Spoolman client when the URL changes; this badge just reports the
    // status of whatever URL is currently live.
    function checkSpoolmanStatus(url, badge) {
        // `url` is intentionally unused — Moonraker's status reflects the
        // URL it actually has configured. Keeping the parameter for API
        // compatibility with callers that still pass it.
        void url;
        badge.textContent = '\u2026';
        badge.className = 'spoolman-status-badge spoolman-status-checking';
        Spoolman.status()
            .then(function (data) {
                var ok = !!(data && (data.spoolman_connected || data.ok));
                if (ok) {
                    badge.textContent = 'Connected \u2713';
                    badge.className = 'spoolman-status-badge spoolman-status-ok';
                } else {
                    badge.textContent = 'Not reachable';
                    badge.className = 'spoolman-status-badge spoolman-status-err';
                }
            })
            .catch(function () {
                badge.textContent = 'Check failed';
                badge.className = 'spoolman-status-badge spoolman-status-err';
            });
    }

    // Spoolman auto-discovery is no longer offered: it relied on a
    // backend-side network sweep that has no client-side equivalent.
    // Surface a helpful message instead so the button still hints at
    // what the user should do.
    function findSpoolman(input, badge) {
        void input;
        badge.textContent = 'Auto-discover not available \u2014 paste the Spoolman URL';
        badge.className = 'spoolman-status-badge spoolman-status-err';
    }

    function saveConfigPartial(payload, saveBtn, statusEl) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving\u2026';
        App.saveConfig(payload)
            .then(function () {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
                if (statusEl) {
                    statusEl.textContent = 'Saved';
                    statusEl.className = 'config-save-status config-save-ok';
                    setTimeout(function () {
                        statusEl.textContent = '';
                        statusEl.className = 'config-save-status';
                    }, 2000);
                }
            })
            .catch(function (err) {
                console.error('Config save failed:', err);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
                if (statusEl) {
                    statusEl.textContent = 'Save failed';
                    statusEl.className = 'config-save-status config-save-err';
                }
            });
    }

    function buildPageShell(title) {
        var page = Templates.clone('config-page-shell');
        Templates.setText(page, '[data-id="heading"]', title);
        return page;
    }

    function buildSaveFooter(onSave) {
        var footer = Templates.clone('config-save-footer');
        var saveBtn = Templates.$(footer, '[data-id="save-btn"]');
        var statusEl = Templates.$(footer, '[data-id="status"]');
        saveBtn.addEventListener('click', function () { onSave(saveBtn, statusEl); });
        return footer;
    }

    return {
        DEFAULT_NAMES: DEFAULT_NAMES,
        buildSelect: buildSelect,
        checkSpoolmanStatus: checkSpoolmanStatus,
        findSpoolman: findSpoolman,
        saveConfigPartial: saveConfigPartial,
        buildPageShell: buildPageShell,
        buildSaveFooter: buildSaveFooter,
    };
})();
