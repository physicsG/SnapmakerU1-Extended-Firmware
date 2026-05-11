'use strict';

// ── Moonraker WebSocket client ──────────────────────────────────────────────
// Minimal JSON-RPC 2.0 client over Moonraker's `/websocket`.
//
// Features:
//   • Auto-connect with 5 s reconnect backoff
//   • Promise-based call(method, params)
//   • on(method, cb) for notify_* server-pushed messages
//   • onConnectionChange(cb) for status-bar wiring
//
// No oneshot-token dance: the SPA is served by the same nginx that
// already auths the printer UI, so the WS upgrade inherits the cookie.

var Moonraker = (function () {

    function buildUrl() {
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return proto + '//' + location.host + '/websocket';
    }

    function MoonrakerClient(url) {
        this.url = url || buildUrl();
        this._ws = null;
        this._nextId = 1;
        this._pending = {};            // id -> {resolve, reject}
        this._listeners = {};          // method -> [cb, ...]
        this._statusListeners = [];    // [cb, ...]
        this._reconnectTimer = null;
        this._connected = false;
        this._reconnectDelayMs = 5000;
        this._closeRequested = false;
    }

    MoonrakerClient.prototype.connect = function () {
        if (this._ws || this._closeRequested) return;
        var self = this;
        try {
            this._ws = new WebSocket(this.url);
        } catch (err) {
            this._scheduleReconnect();
            return;
        }
        this._ws.addEventListener('open', function () {
            self._connected = true;
            self._notifyStatus(true);
        });
        this._ws.addEventListener('message', function (ev) {
            self._handleMessage(ev.data);
        });
        this._ws.addEventListener('close', function () { self._handleClose(); });
        this._ws.addEventListener('error', function () {
            // Some browsers fire 'error' without a follow-up 'close'.
            try { self._ws && self._ws.close(); } catch (e) {}
        });
    };

    MoonrakerClient.prototype._handleClose = function () {
        var wasConnected = this._connected;
        this._connected = false;
        this._ws = null;
        // Reject all in-flight calls so callers can react instead of
        // hanging forever on a response that will never come.
        var pending = this._pending;
        this._pending = {};
        Object.keys(pending).forEach(function (id) {
            try { pending[id].reject(new Error('Moonraker connection lost')); }
            catch (e) {}
        });
        if (wasConnected) this._notifyStatus(false);
        if (!this._closeRequested) this._scheduleReconnect();
    };

    MoonrakerClient.prototype._scheduleReconnect = function () {
        if (this._reconnectTimer || this._closeRequested) return;
        var self = this;
        this._reconnectTimer = setTimeout(function () {
            self._reconnectTimer = null;
            self.connect();
        }, this._reconnectDelayMs);
    };

    MoonrakerClient.prototype.disconnect = function () {
        this._closeRequested = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            try { this._ws.close(); } catch (e) {}
            this._ws = null;
        }
    };

    MoonrakerClient.prototype.isConnected = function () {
        return this._connected;
    };

    // ── JSON-RPC ──────────────────────────────────────────────────────────
    MoonrakerClient.prototype.call = function (method, params) {
        var self = this;
        return new Promise(function (resolve, reject) {
            if (!self._ws || self._ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Moonraker WebSocket not connected'));
                return;
            }
            var id = self._nextId++;
            self._pending[id] = { resolve: resolve, reject: reject };
            var req = { jsonrpc: '2.0', method: method, id: id };
            if (params !== undefined) req.params = params;
            try {
                self._ws.send(JSON.stringify(req));
            } catch (err) {
                delete self._pending[id];
                reject(err);
            }
        });
    };

    MoonrakerClient.prototype._handleMessage = function (raw) {
        var msg;
        try { msg = JSON.parse(raw); }
        catch (err) { return; }
        if (Array.isArray(msg)) {
            for (var i = 0; i < msg.length; i++) this._dispatchOne(msg[i]);
        } else {
            this._dispatchOne(msg);
        }
    };

    MoonrakerClient.prototype._dispatchOne = function (msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.id !== undefined && msg.id !== null) {
            var p = this._pending[msg.id];
            if (!p) return;
            delete this._pending[msg.id];
            if (msg.error) {
                var err = new Error(msg.error.message || 'JSON-RPC error');
                err.code = msg.error.code;
                err.data = msg.error.data;
                p.reject(err);
            } else {
                p.resolve(msg.result);
            }
            return;
        }
        if (typeof msg.method === 'string') {
            var cbs = this._listeners[msg.method];
            if (!cbs) return;
            for (var j = 0; j < cbs.length; j++) {
                try { cbs[j](msg.params); }
                catch (e) { /* swallow listener errors */ }
            }
        }
    };

    // ── Subscriptions ─────────────────────────────────────────────────────
    MoonrakerClient.prototype.on = function (method, cb) {
        var arr = this._listeners[method];
        if (!arr) {
            arr = [];
            this._listeners[method] = arr;
        }
        arr.push(cb);
        return function unsub() {
            var idx = arr.indexOf(cb);
            if (idx !== -1) arr.splice(idx, 1);
        };
    };

    MoonrakerClient.prototype.onConnectionChange = function (cb) {
        this._statusListeners.push(cb);
        // Fire current state immediately so callers don't miss the first event.
        try { cb(this._connected); } catch (e) {}
    };

    MoonrakerClient.prototype._notifyStatus = function (connected) {
        for (var i = 0; i < this._statusListeners.length; i++) {
            try { this._statusListeners[i](connected); }
            catch (e) {}
        }
    };

    return { Client: MoonrakerClient, buildUrl: buildUrl };
})();
