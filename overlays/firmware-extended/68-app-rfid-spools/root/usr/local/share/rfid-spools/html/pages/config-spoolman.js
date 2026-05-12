'use strict';

// ── Spoolman config page ─────────────────────────────────────────────────────
// Markup lives in pages/config-spoolman.html
// (templates "config-spoolman-section" + "config-spoolman-extras-section"
//  + "config-spoolman-extra-row").

var SpoolmanConfigPage = (function () {

    // Filament extras: the seven physical/material attributes we surface
    // from RFID tags (TigerTag, OpenSpool, …). Spoolman models these on
    // the *filament* entity because they describe the spool's contents,
    // not the physical plastic reel.
    var FILAMENT_EXTRA_FIELDS = [
        { key: 'max_extruder_temp', label: 'Max extruder temp',   hint: 'hotend_max_temp_c', name: 'Max extruder temperature', field_type: 'integer' },
        { key: 'max_bed_temp',      label: 'Max bed temp',         hint: 'bed_temp_max_c',    name: 'Max bed temperature',     field_type: 'integer' },
        { key: 'drying_temp',       label: 'Drying temperature',   hint: 'drying_temp_c',     name: 'Drying temperature',      field_type: 'integer' },
        { key: 'drying_time',       label: 'Drying time (h)',      hint: 'drying_time_hours', name: 'Drying time (hours)',     field_type: 'integer' },
        { key: 'td',                label: 'Transmission distance', hint: 'td',                name: 'Transmission distance',   field_type: 'number'  },
        { key: 'mfg_date',          label: 'Manufacturing date',   hint: 'manufacturing_date',name: 'Manufacturing date',      field_type: 'text'    },
        { key: 'modifiers',         label: 'Modifiers / finish',   hint: 'modifiers',         name: 'Modifiers / finish',      field_type: 'text'    },
    ];

    // Spool extras: identifiers that belong to the physical reel rather
    // than the material on it. Currently just the RFID UID, kept as a
    // JSON-encoded array so a single spool can be tagged from both sides
    // (see spools.js syncToSpoolman). `color_hex` is *not* duplicated as
    // a spool extra — it lives on the filament's first-class column.
    var SPOOL_EXTRA_FIELDS = [
        { key: 'rfid_uid', label: 'RFID Tag UID(s)', name: 'RFID Tag UID', field_type: 'text' }
    ];

    // Build a "register extras for entity X" sub-section. Keeps the
    // per-entity registration logic in one place so the filament and
    // spool sections stay in lockstep.
    function buildExtrasSection(entity, fields, titleText, savedToggles) {
        var section = Templates.clone('config-spoolman-extras-section');
        Templates.setText(section, '[data-id="title"]', titleText);
        var table = Templates.$(section, '[data-id="extra-fields"]');
        var regBtn = Templates.$(section, '[data-id="register-btn"]');
        var regStatus = Templates.$(section, '[data-id="register-status"]');

        function refreshStatus() {
            Spoolman.listExtraFields(entity)
                .then(function (existing) {
                    if (!Array.isArray(existing)) return;
                    var byKey = {};
                    for (var i = 0; i < existing.length; i++) {
                        if (existing[i] && existing[i].key) byKey[existing[i].key] = true;
                    }
                    fields.forEach(function (f) {
                        var row = table.querySelector('[data-extra-field-row="' + f.key + '"]');
                        if (!row) return;
                        var sb = Templates.$(row, '[data-id="status"]');
                        if (!sb) return;
                        if (byKey[f.key]) {
                            sb.textContent = '\u2713';
                            sb.className = 'config-extra-field-status config-extra-field-status-ok';
                        } else {
                            sb.textContent = '\u2717';
                            sb.className = 'config-extra-field-status config-extra-field-status-missing';
                        }
                    });
                })
                .catch(function () {});
        }

        fields.forEach(function (f) {
            var row = Templates.clone('config-spoolman-extra-row');
            row.dataset.extraFieldRow = f.key;

            var cb = Templates.$(row, '[data-id="checkbox"]');
            cb.dataset.extraKey = f.key;
            cb.dataset.extraEntity = entity;
            cb.checked = !!(savedToggles && savedToggles[f.key]);

            Templates.setText(row, '[data-id="label"]', f.label);
            Templates.setText(row, '[data-id="key"]', f.key);

            table.appendChild(row);
        });

        regBtn.addEventListener('click', function () {
            regBtn.disabled = true;
            regStatus.textContent = 'Registering\u2026';
            regStatus.className = 'spoolman-status-badge spoolman-status-checking';

            // Two-step: list current fields, then create only the ones
            // that are still missing. The Spoolman API rejects duplicate
            // keys with a 4xx, so this avoids spamming benign errors.
            Spoolman.listExtraFields(entity)
                .then(function (existing) {
                    var have = {};
                    if (Array.isArray(existing)) {
                        for (var i = 0; i < existing.length; i++) {
                            if (existing[i] && existing[i].key) have[existing[i].key] = true;
                        }
                    }
                    var registered = [];
                    var alreadyExisted = [];
                    var errors = {};
                    var ops = fields.map(function (f) {
                        if (have[f.key]) {
                            alreadyExisted.push(f.key);
                            return Promise.resolve();
                        }
                        var payload = { name: f.name, field_type: f.field_type };
                        return Spoolman.createExtraField(entity, f.key, payload)
                            .then(function () { registered.push(f.key); })
                            .catch(function (err) {
                                errors[f.key] = (err && err.message) || 'unknown error';
                            });
                    });
                    return Promise.all(ops).then(function () {
                        return { registered: registered, already_existed: alreadyExisted, errors: errors };
                    });
                })
                .then(function (data) {
                    regBtn.disabled = false;
                    var newCount = (data.registered || []).length;
                    var existCount = (data.already_existed || []).length;
                    var errKeys = Object.keys(data.errors || {});
                    var okTotal = newCount + existCount;
                    if (errKeys.length > 0) {
                        var errDetails = errKeys.map(function (k) {
                            return k + ': ' + (data.errors[k] || '?');
                        }).join('; ');
                        regStatus.textContent = okTotal + ' ok, ' + errKeys.length + ' failed \u2014 ' + errDetails;
                        regStatus.className = 'spoolman-status-badge spoolman-status-err';
                    } else {
                        regStatus.textContent = okTotal + ' field(s) ready \u2713';
                        regStatus.className = 'spoolman-status-badge spoolman-status-ok';
                    }
                    refreshStatus();
                })
                .catch(function (err) {
                    regBtn.disabled = false;
                    regStatus.textContent = err.message;
                    regStatus.className = 'spoolman-status-badge spoolman-status-err';
                });
        });

        return { section: section, refreshStatus: refreshStatus };
    }

    function mount(container) {
        var config = App.getConfig();
        var page = ConfigShared.buildPageShell('Spoolman');

        // ── URL section ────────────────────────────────────────────────
        var urlSection = Templates.clone('config-spoolman-section');
        var input = Templates.$(urlSection, '[data-id="url-input"]');
        var badge = Templates.$(urlSection, '[data-id="status-badge"]');
        var findBtn = Templates.$(urlSection, '[data-id="find-btn"]');

        input.value = (config && config.spoolman_url) || '';
        input.addEventListener('change', function () {
            var url = input.value.trim();
            if (url) ConfigShared.checkSpoolmanStatus(url, badge);
            else { badge.textContent = ''; badge.className = 'spoolman-status-badge'; }
        });
        findBtn.addEventListener('click', function () {
            ConfigShared.findSpoolman(input, badge);
        });

        page.appendChild(urlSection);

        // ── Filament extras (the seven material/physical attributes) ───
        var savedToggles = (config && config.spoolman_extra_fields) || {};
        var filamentExtras = buildExtrasSection(
            'filament', FILAMENT_EXTRA_FIELDS,
            'Filament extras to sync (registered on Spoolman filaments)',
            savedToggles
        );
        page.appendChild(filamentExtras.section);

        // ── Spool extras (only RFID UID at the moment) ─────────────────
        var spoolExtras = buildExtrasSection(
            'spool', SPOOL_EXTRA_FIELDS,
            'Spool extras (registered on Spoolman spools)',
            savedToggles
        );
        page.appendChild(spoolExtras.section);

        // ── Save footer ────────────────────────────────────────────────
        page.appendChild(ConfigShared.buildSaveFooter(function (saveBtn, statusEl) {
            var extraCbs = page.querySelectorAll('input[data-extra-key]');
            var spoolmanExtraFields = {};
            extraCbs.forEach(function (cb) { spoolmanExtraFields[cb.dataset.extraKey] = cb.checked; });
            var url = input.value.trim();

            // Two-pronged save:
            //   1. Persist UI hint copy (spoolman_url + extra_fields) into
            //      Moonraker DB so spools.js can gate Spoolman UI without
            //      a round-trip on every page load.
            //   2. Write the canonical [spoolman] section to
            //      extended/moonraker/05_spoolman.cfg via Moonraker's
            //      file API and trigger /server/restart so the new URL
            //      takes effect immediately. No firmware-config toggle —
            //      having the Spools page implies Spoolman wiring belongs
            //      to the SPA.
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving\u2026';
            if (statusEl) {
                statusEl.textContent = 'Writing config\u2026';
                statusEl.className = 'config-save-status';
            }

            var dbSave = App.saveConfig({
                spoolman_url: url,
                spoolman_extra_fields: spoolmanExtraFields
            });

            var cfgWrite = url
                ? Spoolman.writeServerConfig(url)
                : Promise.resolve();

            Promise.all([dbSave, cfgWrite])
                .then(function () {
                    if (statusEl) {
                        statusEl.textContent = url
                            ? 'Restarting Moonraker\u2026'
                            : 'Saved';
                        statusEl.className = 'config-save-status';
                    }
                    badge.textContent = '\u2026';
                    badge.className = 'spoolman-status-badge spoolman-status-checking';

                    if (!url) {
                        saveBtn.disabled = false;
                        saveBtn.textContent = 'Save';
                        return;
                    }

                    // Moonraker takes a few seconds to come back up. Poll
                    // /server/spoolman/status until it succeeds (or give
                    // up after ~20 s).
                    var deadline = Date.now() + 20000;
                    function poll() {
                        Spoolman.status()
                            .then(function (data) {
                                saveBtn.disabled = false;
                                saveBtn.textContent = 'Save';
                                var ok = !!(data && (data.spoolman_connected || data.ok));
                                if (ok) {
                                    badge.textContent = 'Connected \u2713';
                                    badge.className = 'spoolman-status-badge spoolman-status-ok';
                                } else {
                                    badge.textContent = 'Not reachable';
                                    badge.className = 'spoolman-status-badge spoolman-status-err';
                                }
                                if (statusEl) {
                                    statusEl.textContent = 'Saved';
                                    statusEl.className = 'config-save-status config-save-ok';
                                    setTimeout(function () {
                                        statusEl.textContent = '';
                                        statusEl.className = 'config-save-status';
                                    }, 2000);
                                }
                                filamentExtras.refreshStatus();
                                spoolExtras.refreshStatus();
                            })
                            .catch(function () {
                                if (Date.now() < deadline) {
                                    setTimeout(poll, 1000);
                                } else {
                                    saveBtn.disabled = false;
                                    saveBtn.textContent = 'Save';
                                    badge.textContent = 'Check failed';
                                    badge.className = 'spoolman-status-badge spoolman-status-err';
                                    if (statusEl) {
                                        statusEl.textContent = 'Saved (Moonraker restart timed out)';
                                        statusEl.className = 'config-save-status config-save-err';
                                    }
                                }
                            });
                    }
                    // First poll after a short delay to give Moonraker
                    // a head start on shutting down + relaunching.
                    setTimeout(poll, 4000);
                })
                .catch(function (err) {
                    console.error('Spoolman save failed:', err);
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save';
                    if (statusEl) {
                        statusEl.textContent = 'Save failed: ' + (err && err.message || err);
                        statusEl.className = 'config-save-status config-save-err';
                    }
                });
        }));

        if (input.value) {
            ConfigShared.checkSpoolmanStatus(input.value.trim(), badge);
            filamentExtras.refreshStatus();
            spoolExtras.refreshStatus();
        }

        container.appendChild(page);
    }

    function unmount() {}

    return { mount: mount, unmount: unmount };
})();
