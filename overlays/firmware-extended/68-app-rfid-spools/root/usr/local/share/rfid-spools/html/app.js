'use strict';

// ── App entry point ──────────────────────────────────────────────────────────
// Owns the singleton clients (Moonraker WS, OpenRFID, Spoolman) and the
// shared configuration cache that persists in the Moonraker DB
// (namespace `rfid_spools`).

var App = (function () {

    var _config = {};
    var _moonraker = null;
    var _openrfid = null;
    var _ready = null;        // Promise resolved once WS opens for the first time
    var _readyResolve = null;

    var DB_NAMESPACE = 'rfid_spools';
    var DB_KEY = 'settings';

    // Default shape: kept tiny so an empty DB looks fine on first launch.
    var DEFAULT_CONFIG = {
        slot_names: {},
        slot_notes: {},
        spoolman_url: '',
        spoolman_extra_fields: {}
    };

    function getConfig() { return _config; }
    function setConfig(cfg) { _config = cfg || {}; }
    function moonraker() { return _moonraker; }
    function openrfid() { return _openrfid; }

    function setConnectionStatus(connected) {
        var dot = document.getElementById('connection-status');
        var text = document.getElementById('connection-text');
        if (dot) dot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
        if (text) text.textContent = connected ? 'RFID: Connected' : 'RFID: Disconnected';
    }

    // ── Persistent config (Moonraker DB) ────────────────────────────────────
    // Mainsail and Fluidd use the same namespace pattern. Survives
    // restarts via /var/lib/moonraker.
    function loadConfig() {
        if (!_moonraker || !_moonraker.isConnected()) {
            _config = Object.assign({}, DEFAULT_CONFIG);
            return Promise.resolve(_config);
        }
        return _moonraker.call('server.database.get_item', {
            namespace: DB_NAMESPACE,
            key: DB_KEY
        }).then(function (res) {
            // Moonraker returns {namespace, key, value}; value may be null.
            var val = (res && res.value) ? res.value : {};
            _config = Object.assign({}, DEFAULT_CONFIG, val);
            return _config;
        }).catch(function (err) {
            // Most common: namespace/key not yet created. Quietly fall back.
            if (err && err.code === -32601) {
                console.warn('Moonraker DB not available; using defaults');
            }
            _config = Object.assign({}, DEFAULT_CONFIG);
            return _config;
        });
    }

    function saveConfig(partial) {
        _config = Object.assign({}, _config, partial || {});
        if (!_moonraker || !_moonraker.isConnected()) {
            return Promise.reject(new Error('Moonraker not connected'));
        }
        return _moonraker.call('server.database.post_item', {
            namespace: DB_NAMESPACE,
            key: DB_KEY,
            value: _config
        }).then(function () { return _config; });
    }

    // ── Bootstrap ───────────────────────────────────────────────────────────
    function ready() { return _ready; }

    function init() {
        _moonraker = new Moonraker.Client();
        _openrfid = new OpenRfid.Client(_moonraker);

        _ready = new Promise(function (resolve) { _readyResolve = resolve; });

        _moonraker.onConnectionChange(function (connected) {
            setConnectionStatus(connected);
            if (connected && _readyResolve) {
                // First open: load config from DB, then bring up router.
                loadConfig().then(function () {
                    if (_readyResolve) {
                        var r = _readyResolve;
                        _readyResolve = null;
                        r();
                    }
                });
            }
        });

        _moonraker.connect();

        // Templates can be fetched in parallel with the WS handshake; we
        // gate the router on both completing.
        var tplLoad = Templates.loadAll([
            'pages/config-shared.html',
            'pages/config-slots.html',
            'pages/config-spoolman.html',
            'pages/spools.html'
        ]);

        Promise.all([_ready, tplLoad]).then(function () {
            Router.init();
        }).catch(function (err) {
            console.error('App init failed:', err);
        });
    }

    return {
        init: init,
        ready: ready,
        getConfig: getConfig,
        setConfig: setConfig,
        saveConfig: saveConfig,
        loadConfig: loadConfig,
        moonraker: moonraker,
        openrfid: openrfid,
        setConnectionStatus: setConnectionStatus,
        navigate: function (page) { Router.navigate(page); }
    };
})();

document.addEventListener('DOMContentLoaded', function () {
    App.init();
});
