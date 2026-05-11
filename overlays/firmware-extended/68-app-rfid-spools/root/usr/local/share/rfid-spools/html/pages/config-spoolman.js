'use strict';

// ── Spoolman config page ─────────────────────────────────────────────────────
// Markup lives in pages/config-spoolman.html
// (templates "config-spoolman-section" + "config-spoolman-extra-row").

var SpoolmanConfigPage = (function () {

    var EXTRA_FIELDS = [
        { key: 'max_extruder_temp', label: 'Max extruder temp',   hint: 'hotend_max_temp_c', name: 'Max extruder temperature', field_type: 'integer' },
        { key: 'max_bed_temp',      label: 'Max bed temp',         hint: 'bed_temp_max_c',    name: 'Max bed temperature',     field_type: 'integer' },
        { key: 'drying_temp',       label: 'Drying temperature',   hint: 'drying_temp_c',     name: 'Drying temperature',      field_type: 'integer' },
        { key: 'drying_time',       label: 'Drying time (h)',      hint: 'drying_time_hours', name: 'Drying time (hours)',     field_type: 'integer' },
        { key: 'td',                label: 'Transmission distance', hint: 'td',                name: 'Transmission distance',   field_type: 'number'  },
        { key: 'mfg_date',          label: 'Manufacturing date',   hint: 'manufacturing_date',name: 'Manufacturing date',      field_type: 'text'    },
        { key: 'modifiers',         label: 'Modifiers / finish',   hint: 'modifiers',         name: 'Modifiers / finish',      field_type: 'text'    },
    ];

    function mount(container) {
        var config = App.getConfig();
        var page = ConfigShared.buildPageShell('Spoolman');

        var section = Templates.clone('config-spoolman-section');
        var input = Templates.$(section, '[data-id="url-input"]');
        var badge = Templates.$(section, '[data-id="status-badge"]');
        var findBtn = Templates.$(section, '[data-id="find-btn"]');
        var table = Templates.$(section, '[data-id="extra-fields"]');
        var regBtn = Templates.$(section, '[data-id="register-btn"]');
        var regStatus = Templates.$(section, '[data-id="register-status"]');

        input.value = (config && config.spoolman_url) || '';
        input.addEventListener('change', function () {
            var url = input.value.trim();
            if (url) ConfigShared.checkSpoolmanStatus(url, badge);
            else { badge.textContent = ''; badge.className = 'spoolman-status-badge'; }
        });

        findBtn.addEventListener('click', function () {
            ConfigShared.findSpoolman(input, badge);
        });

        var extraFields = (config && config.spoolman_extra_fields) || {};

        function refreshFieldStatus() {
            // Spoolman exposes the registered fields per-entity. We diff
            // EXTRA_FIELDS against the current `spool` field set so rows
            // can flag whether they're ready to be written from sync.
            Spoolman.listExtraFields('spool')
                .then(function (fields) {
                    if (!Array.isArray(fields)) return;
                    var byKey = {};
                    for (var i = 0; i < fields.length; i++) {
                        if (fields[i] && fields[i].key) byKey[fields[i].key] = true;
                    }
                    EXTRA_FIELDS.forEach(function (f) {
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

        EXTRA_FIELDS.forEach(function (f) {
            var row = Templates.clone('config-spoolman-extra-row');
            row.dataset.extraFieldRow = f.key;

            var cb = Templates.$(row, '[data-id="checkbox"]');
            cb.dataset.extraKey = f.key;
            cb.checked = !!(extraFields[f.key]);

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
            Spoolman.listExtraFields('spool')
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
                    var ops = EXTRA_FIELDS.map(function (f) {
                        if (have[f.key]) {
                            alreadyExisted.push(f.key);
                            return Promise.resolve();
                        }
                        var payload = { name: f.name, field_type: f.field_type };
                        return Spoolman.createExtraField('spool', f.key, payload)
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
                    refreshFieldStatus();
                })
                .catch(function (err) {
                    regBtn.disabled = false;
                    regStatus.textContent = err.message;
                    regStatus.className = 'spoolman-status-badge spoolman-status-err';
                });
        });

        page.appendChild(section);

        page.appendChild(ConfigShared.buildSaveFooter(function (saveBtn, statusEl) {
            var extraCbs = page.querySelectorAll('input[data-extra-key]');
            var spoolmanExtraFields = {};
            extraCbs.forEach(function (cb) { spoolmanExtraFields[cb.dataset.extraKey] = cb.checked; });
            ConfigShared.saveConfigPartial(
                { spoolman_url: input.value.trim(), spoolman_extra_fields: spoolmanExtraFields },
                saveBtn, statusEl
            );
        }));

        if (input.value) {
            ConfigShared.checkSpoolmanStatus(input.value.trim(), badge);
            refreshFieldStatus();
        }

        container.appendChild(page);
    }

    function unmount() {}

    return { mount: mount, unmount: unmount };
})();
