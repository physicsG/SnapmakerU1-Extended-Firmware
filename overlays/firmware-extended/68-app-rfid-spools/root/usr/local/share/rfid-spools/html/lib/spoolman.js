'use strict';

// ── Spoolman REST client (via Moonraker proxy) ─────────────────────────────
// All Spoolman traffic goes through Moonraker's `/server/spoolman/proxy`
// endpoint (POST {request_method, path, body?}). This is the same path
// Mainsail and Fluidd use, which avoids CORS and reuses the configured
// Spoolman base URL on the printer.

var Spoolman = (function () {

    var PROXY_PATH = '/server/spoolman/proxy';
    var STATUS_PATH = '/server/spoolman/status';

    function _proxy(method, path, body) {
        var payload = { request_method: method, path: path };
        if (body !== undefined) payload.body = body;
        return fetch(PROXY_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (resp) {
            if (!resp.ok) {
                return resp.text().then(function (t) {
                    var err = new Error('Spoolman proxy ' + method + ' ' + path
                        + ' failed: ' + resp.status + (t ? ' ' + t : ''));
                    err.status = resp.status;
                    throw err;
                });
            }
            return resp.json();
        }).then(function (data) {
            // Moonraker wraps the upstream JSON in {result, ...}; unwrap.
            if (data && typeof data === 'object' && 'result' in data) {
                return data.result;
            }
            return data;
        });
    }

    function _qs(params) {
        if (!params) return '';
        var parts = [];
        Object.keys(params).forEach(function (k) {
            var v = params[k];
            if (v === undefined || v === null || v === '') return;
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        });
        return parts.length ? '?' + parts.join('&') : '';
    }

    return {
        // Connection status — direct GET (Moonraker handles it).
        status: function () {
            return fetch(STATUS_PATH).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }).then(function (d) {
                // Moonraker returns {result: {...}}; unwrap to match proxy.
                return (d && typeof d === 'object' && 'result' in d) ? d.result : d;
            });
        },

        // NOTE: Moonraker's spoolman proxy expects paths *without* the
        // `/api` prefix — it prepends `/api` itself before forwarding to
        // Spoolman. So we send `/v1/spool` here, not `/api/v1/spool`.
        // Sending `/api/v1/...` makes Moonraker reject the request with
        // 400 "Invalid path, must start with the API version".
        info: function () { return _proxy('GET', '/v1/info'); },

        listSpools: function (params) {
            return _proxy('GET', '/v1/spool' + _qs(params));
        },
        getSpool: function (id) {
            return _proxy('GET', '/v1/spool/' + encodeURIComponent(id));
        },
        upsertSpool: function (payload) {
            return _proxy('POST', '/v1/spool', payload);
        },
        updateSpool: function (id, payload) {
            return _proxy('PATCH', '/v1/spool/' + encodeURIComponent(id), payload);
        },

        listFilaments: function (params) {
            return _proxy('GET', '/v1/filament' + _qs(params));
        },
        getFilament: function (id) {
            return _proxy('GET', '/v1/filament/' + encodeURIComponent(id));
        },
        createFilament: function (payload) {
            return _proxy('POST', '/v1/filament', payload);
        },
        updateFilament: function (id, payload) {
            return _proxy('PATCH', '/v1/filament/' + encodeURIComponent(id), payload);
        },

        listVendors: function () { return _proxy('GET', '/v1/vendor'); },
        createVendor: function (payload) {
            return _proxy('POST', '/v1/vendor', payload);
        },

        // Extra-fields management. Spoolman exposes `/v1/field/<entity>`
        // (entity in {spool, filament, vendor}) for listing & creating
        // user-defined fields. We pin to `spool` since that's where the SPA
        // stores its TigerTag-derived attributes.
        listExtraFields: function (entity) {
            entity = entity || 'spool';
            return _proxy('GET', '/v1/field/' + encodeURIComponent(entity));
        },
        createExtraField: function (entity, key, payload) {
            entity = entity || 'spool';
            return _proxy('POST',
                '/v1/field/' + encodeURIComponent(entity)
                    + '/' + encodeURIComponent(key),
                payload);
        },

        // Writes /oem/printer_data/config/extended/moonraker/05_spoolman.cfg
        // via Moonraker's standard file API (root=config) and triggers a
        // Moonraker self-restart so the [spoolman] section is picked up.
        // Returns a Promise that resolves once the restart was *requested*
        // (Moonraker disconnects mid-call; the caller should poll
        // Spoolman.status() afterwards).
        // Refs:
        //   https://moonraker.readthedocs.io/en/latest/external_api/file_manager/#file-upload
        //   https://moonraker.readthedocs.io/en/latest/external_api/server/#restart-server
        writeServerConfig: function (url, syncRate) {
            var rate = (syncRate === undefined || syncRate === null) ? 5 : syncRate;
            var body = '[spoolman]\nserver: ' + url + '\nsync_rate: ' + rate + '\n';
            var fd = new FormData();
            fd.append('root', 'config');
            fd.append('file', new Blob([body], { type: 'text/plain' }),
                      'extended/moonraker/05_spoolman.cfg');
            return fetch('/server/files/upload', { method: 'POST', body: fd })
                .then(function (resp) {
                    if (!resp.ok) {
                        return resp.text().then(function (t) {
                            throw new Error('upload failed: ' + resp.status
                                + (t ? ' ' + t : ''));
                        });
                    }
                    return fetch('/server/restart', { method: 'POST' });
                })
                .then(function (resp) {
                    // 200 ok, but Moonraker also closes connections
                    // immediately on restart — a network error here is
                    // expected and benign.
                    if (resp && !resp.ok) {
                        return resp.text().then(function (t) {
                            throw new Error('restart failed: ' + resp.status
                                + (t ? ' ' + t : ''));
                        });
                    }
                });
        }
    };
})();
