'use strict';

// ── Browser-side TigerTag helpers ──────────────────────────────────────────
// The 96-byte payload is encoded server-side via OpenRfid.tigertagEncode
// (which calls openrfid/tigertag_encode, ultimately the Python
// TigerTagEncoder in upstream OpenRFID). This module hosts helpers that
// only make sense in the browser:
//
//   • TigerTag.loadRegistry(): fetches the 7 TigerTag DB JSON files from
//     the static nginx alias `/spools/static/openrfid/database/` and
//     returns a merged {materials, brands, types, aspects, diameters,
//     units, versions} object. The result is cached for the lifetime of
//     the page load.
//
//   • TigerTag.spoolToSpec(spool, filament, vendor): translates a Spoolman
//     spool record (with its embedded filament + vendor) into the spec
//     payload that TigerTag.encode (server side) expects. Ported from the
//     deleted backend's spool_to_tigertag_spec().

var TigerTag = (function () {

    var REGISTRY_BASE = '/spools/static/openrfid/database/';
    var REGISTRY_FILES = {
        materials: 'id_material.json',
        brands:    'id_brand.json',
        types:     'id_type.json',
        aspects:   'id_aspect.json',
        diameters: 'id_diameter.json',
        units:     'id_measure_unit.json',
        versions:  'id_version.json'
    };

    var _registryPromise = null;

    function loadRegistry() {
        if (_registryPromise) return _registryPromise;
        var keys = Object.keys(REGISTRY_FILES);
        var fetches = keys.map(function (key) {
            return fetch(REGISTRY_BASE + REGISTRY_FILES[key], { cache: 'no-cache' })
                .then(function (r) {
                    if (!r.ok) throw new Error(REGISTRY_FILES[key] + ': HTTP ' + r.status);
                    return r.json();
                });
        });
        _registryPromise = Promise.all(fetches).then(function (results) {
            var merged = {};
            for (var i = 0; i < keys.length; i++) {
                merged[keys[i]] = results[i] || [];
            }
            return merged;
        }).catch(function (err) {
            // Allow a retry on next call after a transient failure.
            _registryPromise = null;
            throw err;
        });
        return _registryPromise;
    }

    // Translate Spoolman spool record → TigerTag spec accepted by
    // openrfid/tigertag_encode. Only fills the fields we can derive cleanly
    // from Spoolman; anything missing is left out so the encoder's own
    // defaults apply. Mirrors the backend `spool_to_tigertag_spec` logic.
    function spoolToSpec(spool, filament, vendor) {
        var spec = {};
        // Spoolman wraps embedded relations on the spool when expanded.
        var fil = filament || (spool && spool.filament) || {};
        var ven = vendor || (fil && fil.vendor) || (spool && spool.vendor) || {};

        if (ven && ven.name) spec.brand = ven.name;
        if (fil.material) spec.material = fil.material;
        if (fil.diameter) spec.diameter = String(fil.diameter);

        // Color — Spoolman uses lowercase hex without the '#'.
        var color = fil.color_hex || (spool && spool.color_hex) || null;
        if (color) {
            spec.color = (color.charAt(0) === '#') ? color : '#' + color;
        }

        // Weight — prefer initial spool weight, fall back to filament weight.
        var weight = (spool && (spool.initial_weight || spool.weight))
            || fil.weight
            || null;
        if (weight && weight > 0) spec.weight_g = Math.round(weight);

        // Temperatures.
        if (fil.settings_extruder_temp) spec.temp_max_c = fil.settings_extruder_temp;
        if (fil.settings_bed_temp) spec.bed_temp_max_c = fil.settings_bed_temp;

        // Spool/filament extras pushed through Spoolman's user-defined fields.
        var spoolExtra = (spool && spool.extra) || {};
        var filExtra = fil.extra || {};
        function _ex(key) {
            // Spool-level overrides win, then filament-level.
            if (spoolExtra && spoolExtra[key] !== undefined) return spoolExtra[key];
            if (filExtra && filExtra[key] !== undefined) return filExtra[key];
            return undefined;
        }
        // Spoolman serializes extras as JSON strings — try to parse numbers.
        function _num(v) {
            if (typeof v === 'number') return v;
            if (typeof v === 'string') {
                var n = parseFloat(v.replace(/^"|"$/g, ''));
                return isNaN(n) ? undefined : n;
            }
            return undefined;
        }
        function _str(v) {
            if (typeof v === 'string') return v.replace(/^"|"$/g, '');
            if (v !== undefined && v !== null) return String(v);
            return undefined;
        }

        var maxExt = _num(_ex('max_extruder_temp'));
        if (maxExt) spec.temp_max_c = maxExt;
        var maxBed = _num(_ex('max_bed_temp'));
        if (maxBed) spec.bed_temp_max_c = maxBed;
        var dryT = _num(_ex('drying_temp'));
        if (dryT) spec.dry_temp_c = dryT;
        var dryH = _num(_ex('drying_time'));
        if (dryH) spec.dry_time_h = dryH;
        var td = _num(_ex('td'));
        if (td) spec.td_mm = td;
        var mfg = _str(_ex('mfg_date'));
        if (mfg) spec.manufacturing_date = mfg;
        var mods = _str(_ex('modifiers'));
        if (mods) {
            // Comma-split into up to two aspect entries.
            var parts = mods.split(/\s*,\s*/).filter(Boolean);
            if (parts.length > 0) spec.aspect_1 = parts[0];
            if (parts.length > 1) spec.aspect_2 = parts[1];
        }

        return spec;
    }

    return {
        REGISTRY_BASE: REGISTRY_BASE,
        REGISTRY_FILES: REGISTRY_FILES,
        loadRegistry: loadRegistry,
        spoolToSpec: spoolToSpec
    };
})();
