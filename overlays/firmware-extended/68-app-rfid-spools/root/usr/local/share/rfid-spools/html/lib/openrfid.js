'use strict';

// ── OpenRFID JSON-RPC + agent-event helpers ────────────────────────────────
// Wraps the `openrfid/*` methods registered by the OpenRFID Moonraker
// agent (see OpenRFID src/controllers/openrfid_api.py and the
// openrfid_api.cfg installed by 68-app-rfid-spools).

var OpenRfid = (function () {

    var REMOTE_METHODS = {
        LIST_CHANNELS:    'openrfid/list_channels',
        SCAN_SLOT:        'openrfid/scan_slot',
        WRITE_TAG:        'openrfid/write_tag',
        CLEAR_TAG:        'openrfid/clear_tag',
        TIGERTAG_ENCODE:  'openrfid/tigertag_encode'
    };

    var AGENT_NAME = 'openrfid';
    var AGENT_EVENT_SCAN = 'openrfid/scan';
    var EXTENSION_REQUEST_METHOD = 'server.extensions.request';

    function OpenRfidClient(moonraker) {
        this.moonraker = moonraker;
    }

    // Moonraker exposes agent-registered methods to other websocket
    // clients only via `server.extensions.request` — calling the method
    // by name returns -32601 because `connection.register_remote_method`
    // wires methods up for Klipper macros, not for cross-client RPC.
    // See https://moonraker.readthedocs.io/en/latest/external_api/extensions/
    OpenRfidClient.prototype._invoke = function (method, args) {
        return this.moonraker.call(EXTENSION_REQUEST_METHOD, {
            agent: AGENT_NAME,
            method: method,
            arguments: args || {}
        });
    };

    OpenRfidClient.prototype.listChannels = function () {
        return this._invoke(REMOTE_METHODS.LIST_CHANNELS, {});
    };

    OpenRfidClient.prototype.scanSlot = function (slot) {
        return this._invoke(REMOTE_METHODS.SCAN_SLOT, { slot: slot });
    };

    OpenRfidClient.prototype.writeTag = function (slot, dataHex, opts) {
        opts = opts || {};
        var params = { slot: slot, data_hex: dataHex };
        if (opts.startPage !== undefined) params.start_page = opts.startPage;
        if (opts.timeout !== undefined) params.timeout = opts.timeout;
        return this._invoke(REMOTE_METHODS.WRITE_TAG, params);
    };

    OpenRfidClient.prototype.clearTag = function (slot, opts) {
        opts = opts || {};
        var params = { slot: slot };
        if (opts.pages !== undefined) params.pages = opts.pages;
        if (opts.startPage !== undefined) params.start_page = opts.startPage;
        return this._invoke(REMOTE_METHODS.CLEAR_TAG, params);
    };

    OpenRfidClient.prototype.tigertagEncode = function (spec) {
        return this._invoke(REMOTE_METHODS.TIGERTAG_ENCODE, { spec: spec });
    };

    // Subscribe to live scan events. Returns an unsubscribe callback.
    // The callback receives the `data` portion of the agent event:
    //   { event, ts, slot, reader, uid, tag_type, filament }
    OpenRfidClient.prototype.onScan = function (callback) {
        return this.moonraker.on('notify_agent_event', function (params) {
            var evt = Array.isArray(params) ? params[0] : params;
            if (!evt || evt.agent !== AGENT_NAME) return;
            if (evt.event !== AGENT_EVENT_SCAN) return;
            try { callback(evt.data || {}); }
            catch (e) { /* swallow listener errors */ }
        });
    };

    return {
        Client: OpenRfidClient,
        REMOTE_METHODS: REMOTE_METHODS,
        AGENT_NAME: AGENT_NAME,
        AGENT_EVENT_SCAN: AGENT_EVENT_SCAN
    };
})();
