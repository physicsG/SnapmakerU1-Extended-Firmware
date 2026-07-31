(function (root, factory) {
    'use strict';

    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.RfidPort = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var PROCESSOR_FORMATS = {
        snapmaker_tag_processor: 'snapmaker',
        openspool_tag_processor: 'openspool',
        bambu_lab_tag_processor: 'bambu',
        creality_tag_processor: 'creality',
        anycubic_tag_processor: 'anycubic',
        elegoo_tag_processor: 'elegoo',
        qidi_tag_processor: 'qidi',
        tigertag_tag_processor: 'tigertag',
        spoolease_tag_processor: 'spoolease',
        spool_ease_tag_processor: 'spoolease'
    };

    var FORMAT_ALIASES = {
        snapmaker: 'snapmaker',
        openspool: 'openspool',
        open_spool: 'openspool',
        bambu: 'bambu',
        bambu_lab: 'bambu',
        creality: 'creality',
        anycubic: 'anycubic',
        elegoo: 'elegoo',
        qidi: 'qidi',
        tigertag: 'tigertag',
        tiger_tag: 'tigertag',
        spoolease: 'spoolease',
        spool_ease: 'spoolease',
        unknown: 'unknown'
    };

    var FORMAT_LABELS = {
        snapmaker: 'Snapmaker',
        openspool: 'OpenSpool',
        bambu: 'Bambu',
        creality: 'Creality',
        anycubic: 'Anycubic',
        elegoo: 'Elegoo',
        qidi: 'Qidi',
        tigertag: 'TigerTag',
        spoolease: 'SpoolEase',
        unknown: 'Unknown'
    };

    var STRUCTURAL_FIELDS = {
        fields: true,
        present_fields: true,
        presentFields: true,
        format_data: true,
        formatData: true,
        authentication: true,
        tagFormat: true,
        sourceProcessor: true
    };

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function isObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function normalizeUid(value) {
        if (value === null || value === undefined) return '';

        if (Array.isArray(value) || (typeof ArrayBuffer !== 'undefined'
                && ArrayBuffer.isView && ArrayBuffer.isView(value))) {
            if (!value.length) return '';
            var parts = [];
            var nonZero = false;
            for (var i = 0; i < value.length; i++) {
                var byte = Number(value[i]);
                if (!isFinite(byte) || Math.floor(byte) !== byte || byte < 0 || byte > 255) {
                    return '';
                }
                if (byte !== 0) nonZero = true;
                parts.push(('0' + byte.toString(16)).slice(-2));
            }
            return nonZero ? parts.join('').toUpperCase() : '';
        }

        if (typeof value !== 'string') return '';
        var text = value.trim();
        if (!text) return '';
        if (/^0x/i.test(text)) text = text.slice(2);
        text = text.replace(/[\s:_-]/g, '');
        if (!text || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) return '';
        if (/^0+$/.test(text)) return '';
        return text.toUpperCase();
    }

    function decodeExtra(value) {
        var decoded = value;
        for (var i = 0; i < 4 && typeof decoded === 'string'; i++) {
            var trimmed = decoded.trim();
            if (!trimmed) return '';
            var next;
            try {
                next = JSON.parse(trimmed);
            } catch (_err) {
                break;
            }
            if (next === decoded) break;
            decoded = next;
        }
        return decoded;
    }

    function normalizeFormatId(value) {
        if (value === null || value === undefined) return '';
        var key = String(value).trim().toLowerCase()
            .replace(/[\s-]+/g, '_')
            .replace(/_tag_processor$/, '');
        return FORMAT_ALIASES[key] || '';
    }

    function formatFromFilament(filament, fallbackTagFormat) {
        filament = filament || {};
        var direct = filament.tag_format;
        if (direct === undefined) direct = filament.tagFormat;
        var normalized = normalizeFormatId(direct);
        if (normalized) return normalized;

        var processor = filament.source_processor || filament.sourceProcessor;
        if (processor && PROCESSOR_FORMATS[String(processor).toLowerCase()]) {
            return PROCESSOR_FORMATS[String(processor).toLowerCase()];
        }

        normalized = normalizeFormatId(fallbackTagFormat);
        return normalized || 'unknown';
    }

    function formatLabel(id) {
        var normalized = normalizeFormatId(id) || 'unknown';
        return FORMAT_LABELS[normalized] || FORMAT_LABELS.unknown;
    }

    function hardwareFrom(tagType, cardType) {
        var values = [tagType, cardType];
        for (var i = 0; i < values.length; i++) {
            if (values[i] === null || values[i] === undefined) continue;
            var value = String(values[i]).trim().toLowerCase().replace(/[\s_-]+/g, '');
            if (!value) continue;
            if (value.indexOf('ultralight') !== -1 || value.indexOf('ntag') !== -1) {
                return 'ultralight';
            }
            if (value.indexOf('mifareclassic') !== -1 || value.indexOf('mifare1k') !== -1
                    || value === 'm1' || value.indexOf('classic') !== -1) {
                return 'mifare_classic';
            }
        }
        return 'unknown';
    }

    function hardwareLabel(hardwareType) {
        if (hardwareType === 'ultralight') return 'Ultralight / NTAG';
        if (hardwareType === 'mifare_classic') return 'MIFARE Classic / M1';
        return 'Unknown';
    }

    function shouldAcceptScan(scan, currentUid, previousScan) {
        if (!scan || typeof scan !== 'object') return false;
        var slot = Number(scan.slot);
        if (!isFinite(slot) || Math.floor(slot) !== slot || slot < 0 || slot >= 4) return false;
        if (scan.event !== 'tag_read' && scan.event !== 'tag_parse_error'
                && scan.event !== 'tag_not_present') return false;

        var previousTs = previousScan && previousScan.ts != null
            ? Number(previousScan.ts) : null;
        var scanTs = scan.ts != null ? Number(scan.ts) : null;
        if (previousTs !== null && isFinite(previousTs)) {
            if (scanTs === null || !isFinite(scanTs) || scanTs < previousTs) return false;
            if (scan.event === 'tag_not_present' && scanTs <= previousTs) return false;
        }

        var normalizedCurrentUid = normalizeUid(currentUid);
        if (scan.event === 'tag_not_present') return normalizedCurrentUid === '';

        var scanUid = normalizeUid(scan.uid);
        return !!scanUid && !!normalizedCurrentUid && scanUid === normalizedCurrentUid;
    }

    function cloneObject(value) {
        if (!isObject(value)) return {};
        var result = {};
        Object.keys(value).forEach(function (key) { result[key] = value[key]; });
        return result;
    }

    function meaningful(value) {
        return value !== null && value !== undefined && value !== '';
    }

    function uniqueStrings(values) {
        var seen = {};
        var result = [];
        (values || []).forEach(function (value) {
            var key = String(value);
            if (!seen[key]) {
                seen[key] = true;
                result.push(key);
            }
        });
        return result;
    }

    function normalizeDecoded(filament, fallbackFormat) {
        if (!filament || typeof filament !== 'object') return null;

        var nestedFields = isObject(filament.fields) ? filament.fields : null;
        var fields = cloneObject(nestedFields || filament);

        // An already-normalized value can still carry additive fields at the
        // top level. Preserve those without replacing values in `fields`.
        if (nestedFields) {
            Object.keys(filament).forEach(function (key) {
                if (!STRUCTURAL_FIELDS[key] && !hasOwn(fields, key)) fields[key] = filament[key];
            });
        }

        var backendPresence = filament.present_fields;
        if (!Array.isArray(backendPresence)) backendPresence = filament.presentFields;
        var presentFields;
        if (Array.isArray(backendPresence)) {
            presentFields = uniqueStrings(backendPresence);
        } else {
            presentFields = Object.keys(fields).filter(function (key) {
                return meaningful(fields[key]);
            });
        }

        var sourceProcessor = filament.source_processor || filament.sourceProcessor
            || fields.source_processor || fields.sourceProcessor || null;
        var formatProbe = {
            tag_format: filament.tag_format || filament.tagFormat || fields.tag_format || fields.tagFormat,
            source_processor: sourceProcessor
        };
        var formatData = cloneObject(filament.format_data || filament.formatData);
        var authentication = filament.authentication === undefined
            ? null : filament.authentication;

        return {
            tagFormat: formatFromFilament(formatProbe, fallbackFormat),
            sourceProcessor: sourceProcessor,
            fields: fields,
            presentFields: presentFields,
            formatData: formatData,
            authentication: authentication
        };
    }

    function normalizeText(value) {
        if (value === null || value === undefined) return '';
        return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function tokenValues(value) {
        value = decodeExtra(value);
        var result = [];

        function add(item) {
            item = decodeExtra(item);
            if (Array.isArray(item)) {
                item.forEach(add);
                return;
            }
            if (item === null || item === undefined) return;
            String(item).split(/[,;|/]+/).forEach(function (part) {
                var normalized = normalizeText(part);
                if (normalized && normalized !== 'none' && normalized !== '-') result.push(normalized);
            });
        }

        add(value);
        return uniqueStrings(result);
    }

    function normalizeColor(value) {
        if (typeof value === 'number' && isFinite(value)) {
            var rgb = (value >>> 0) & 0xFFFFFF;
            return ('000000' + rgb.toString(16)).slice(-6).toUpperCase();
        }
        if (isObject(value) && hasOwn(value, 'r') && hasOwn(value, 'g') && hasOwn(value, 'b')) {
            var r = Number(value.r), g = Number(value.g), b = Number(value.b);
            if ([r, g, b].some(function (part) {
                return !isFinite(part) || part < 0 || part > 255 || Math.floor(part) !== part;
            })) return '';
            return [r, g, b].map(function (part) {
                return ('0' + part.toString(16)).slice(-2);
            }).join('').toUpperCase();
        }
        if (typeof value !== 'string') return '';
        var text = value.trim().replace(/^#/, '');
        if (/^[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
        // GenericFilament's `colors_rgba_hex` is RRGGBBAA. Prefer the RGB
        // prefix for string-form eight-byte colors; numeric ARGB values are
        // handled by the branch above.
        if (/^[0-9a-f]{8}$/i.test(text)) return text.slice(0, 6).toUpperCase();
        return '';
    }

    function colorValues(value) {
        value = decodeExtra(value);
        var values = [];
        if (Array.isArray(value)) {
            values = value;
        } else if (typeof value === 'string' && value.indexOf(',') !== -1) {
            values = value.split(',');
        } else if (value !== null && value !== undefined && value !== '') {
            values = [value];
        }
        var result = [];
        values.forEach(function (item) {
            var color = normalizeColor(item);
            if (color) result.push(color);
        });
        return uniqueStrings(result);
    }

    function firstValue(obj, keys) {
        if (!obj) return undefined;
        for (var i = 0; i < keys.length; i++) {
            if (hasOwn(obj, keys[i]) && obj[keys[i]] !== null && obj[keys[i]] !== undefined) {
                return obj[keys[i]];
            }
        }
        return undefined;
    }

    function buildTagMatchContext(decoded, uid) {
        var fields = decoded && isObject(decoded.fields) ? decoded.fields : (decoded || {});
        var decodedFormatData = decoded && isObject(decoded.formatData)
            ? decoded.formatData : {};
        var materialEntry = decodedFormatData.material;
        var material = normalizeText(firstValue(fields, ['material', 'type']));
        var materialName = normalizeText(
            firstValue(fields, ['material_name'])
            || (isObject(materialEntry) ? materialEntry.label : materialEntry)
        );
        var variantValues = [];
        [
            firstValue(fields, ['variant']),
            firstValue(fields, ['aspects', 'tag_aspects']),
            firstValue(fields, ['aspect_1']),
            firstValue(fields, ['aspect_2']),
            firstValue(fields, ['modifiers'])
        ].forEach(function (value) {
            variantValues = variantValues.concat(tokenValues(value));
        });
        if (materialName && materialName !== material) {
            // The official SDK label carries variants such as PLA Marble or
            // PLA Wood while type remains the printer-facing base material.
            variantValues = variantValues.concat(tokenValues(materialName));
            if (material && materialName.indexOf(material) === 0) {
                var suffix = materialName.slice(material.length).replace(/^[\s_-]+/, '');
                variantValues = variantValues.concat(tokenValues(suffix));
            }
        }

        var colors = colorValues(firstValue(fields, ['colors']));
        if (!colors.length) colors = colorValues(firstValue(fields, ['colors_rgba_hex']));
        if (!colors.length) colors = colorValues(firstValue(fields, ['color', 'color_hex', 'rgb']));

        return {
            uid: normalizeUid(uid),
            vendor: normalizeText(firstValue(fields, ['manufacturer', 'vendor', 'brand'])),
            material: material,
            materialName: materialName,
            variant: uniqueStrings(variantValues),
            message: normalizeText(firstValue(fields, ['message', 'custom_message', 'tag_message'])),
            colors: colors
        };
    }

    function uidValues(value) {
        value = decodeExtra(value);
        var raw = [];
        if (Array.isArray(value)) {
            raw = value;
        } else if (typeof value === 'string') {
            raw = value.split(/[,;]+/);
        } else if (value !== null && value !== undefined) {
            raw = [value];
        }
        var result = [];
        raw.forEach(function (item) {
            var uid = normalizeUid(String(item).trim());
            if (uid) result.push(uid);
        });
        return uniqueStrings(result);
    }

    function spoolIdentity(spool, index) {
        return spool && spool.id !== null && spool.id !== undefined
            ? 'id:' + String(spool.id) : 'index:' + String(index);
    }

    function spoolVariantTokens(spool) {
        var filament = (spool && spool.filament) || {};
        var extra = filament.extra || {};
        var canonical = tokenValues(extra.variant);
        return canonical.length ? canonical : tokenValues(extra.modifiers);
    }

    function spoolColors(spool) {
        var filament = (spool && spool.filament) || {};
        var result = colorValues(filament.multi_color_hexes);
        result = result.concat(colorValues(filament.color_hex));
        return uniqueStrings(result);
    }

    function minimumColorDistance(left, right) {
        if (!left.length || !right.length) return Infinity;
        var minimum = Infinity;
        for (var i = 0; i < left.length; i++) {
            var ar = parseInt(left[i].slice(0, 2), 16);
            var ag = parseInt(left[i].slice(2, 4), 16);
            var ab = parseInt(left[i].slice(4, 6), 16);
            for (var j = 0; j < right.length; j++) {
                var br = parseInt(right[j].slice(0, 2), 16);
                var bg = parseInt(right[j].slice(2, 4), 16);
                var bb = parseInt(right[j].slice(4, 6), 16);
                var dr = ar - br, dg = ag - bg, db = ab - bb;
                var distance = Math.sqrt(dr * dr + dg * dg + db * db);
                if (distance < minimum) minimum = distance;
            }
        }
        return minimum;
    }

    function intersection(left, right) {
        var lookup = {};
        right.forEach(function (value) { lookup[value] = true; });
        return left.some(function (value) { return !!lookup[value]; });
    }

    function scoreSpool(spool, context) {
        var filament = (spool && spool.filament) || {};
        var vendor = normalizeText(filament.vendor && filament.vendor.name);
        var material = normalizeText(filament.material);
        var name = normalizeText(filament.name);
        var score = 0;
        var reasons = [];
        var categories = [];

        if (context.vendor && vendor && context.vendor === vendor) {
            score += 3;
            reasons.push('vendor');
            categories.push('vendor');
        }
        if (context.material && material && context.material === material) {
            score += 2;
            reasons.push('material');
            categories.push('material');
        }

        var distance = minimumColorDistance(context.colors || [], spoolColors(spool));
        if (distance <= 8) {
            score += 3;
            reasons.push('color exact');
            categories.push('color');
        } else if (distance <= 30) {
            score += 2;
            reasons.push('color close');
            categories.push('color');
        } else if (distance <= 60) {
            score += 1;
            reasons.push('color near');
            categories.push('color');
        }

        var tagNames = uniqueStrings([context.message, context.materialName].filter(Boolean));
        if (tagNames.length && name) {
            if (tagNames.indexOf(name) !== -1) {
                score += 3;
                reasons.push('name exact');
                categories.push('name');
            } else if (tagNames.some(function (tagName) {
                return tagName.indexOf(name) !== -1 || name.indexOf(tagName) !== -1;
            })) {
                score += 1;
                reasons.push('name partial');
                categories.push('name');
            }
        }

        if (context.variant && context.variant.length
                && intersection(context.variant, spoolVariantTokens(spool))) {
            score += 1;
            reasons.push('variant');
            categories.push('variant');
        }

        return {
            spool: spool,
            score: score,
            reasons: reasons,
            matchedCategories: uniqueStrings(categories).length,
            colorDistance: distance
        };
    }

    function searchMatches(spool, terms) {
        if (!terms.length) return true;
        var filament = (spool && spool.filament) || {};
        var variant = spoolVariantTokens(spool).join(' ');
        var haystack = [
            filament.vendor && filament.vendor.name,
            filament.material,
            filament.name,
            variant,
            spool && spool.lot_nr,
            filament.external_id,
            spool && spool.id
        ].map(function (value) {
            return normalizeText(value);
        }).filter(Boolean).join(' ');
        return terms.every(function (term) { return haystack.indexOf(term) !== -1; });
    }

    function compareSpoolId(a, b) {
        var left = a && a.id;
        var right = b && b.id;
        var leftNumber = Number(left), rightNumber = Number(right);
        if (isFinite(leftNumber) && isFinite(rightNumber) && leftNumber !== rightNumber) {
            return leftNumber - rightNumber;
        }
        return String(left === undefined ? '' : left)
            .localeCompare(String(right === undefined ? '' : right));
    }

    function groupSpools(spools, context, currentSpoolId, filter) {
        context = context || buildTagMatchContext(null, null);
        var terms = normalizeText(filter).split(/\s+/).filter(Boolean);
        var eligible = [];
        var seen = {};

        (Array.isArray(spools) ? spools : []).forEach(function (spool, index) {
            if (!spool || spool.archived === true) return;
            var identity = spoolIdentity(spool, index);
            if (seen[identity]) return;
            seen[identity] = true;
            if (!searchMatches(spool, terms)) return;
            eligible.push({ spool: spool, identity: identity });
        });

        var linkedRows = [];
        var legacyRows = [];
        eligible.forEach(function (row) {
            var extra = row.spool.extra || {};
            if (context.uid && uidValues(extra.card_uids).indexOf(context.uid) !== -1) {
                linkedRows.push(row);
            }
            if (context.uid && uidValues(extra.rfid_uid).indexOf(context.uid) !== -1) {
                legacyRows.push(row);
            }
        });

        linkedRows.sort(function (a, b) { return compareSpoolId(a.spool, b.spool); });
        legacyRows.sort(function (a, b) { return compareSpoolId(a.spool, b.spool); });

        var used = {};
        linkedRows.forEach(function (row) { used[row.identity] = true; });

        var currentRows = [];
        if (currentSpoolId !== null && currentSpoolId !== undefined && currentSpoolId !== '') {
            var currentKey = String(currentSpoolId);
            eligible.forEach(function (row) {
                if (!used[row.identity] && String(row.spool.id) === currentKey) {
                    currentRows.push(row);
                    used[row.identity] = true;
                }
            });
        }

        var scored = [];
        eligible.forEach(function (row) {
            if (used[row.identity]) return;
            var match = scoreSpool(row.spool, context);
            if (match.score >= 2) {
                match.identity = row.identity;
                scored.push(match);
            }
        });
        scored.sort(function (a, b) {
            if (a.score !== b.score) return b.score - a.score;
            if (a.matchedCategories !== b.matchedCategories) {
                return b.matchedCategories - a.matchedCategories;
            }
            return compareSpoolId(a.spool, b.spool);
        });

        var suggested = scored.slice(0, 5);
        suggested.forEach(function (match) { used[match.identity] = true; });

        var allRows = eligible.filter(function (row) { return !used[row.identity]; });
        allRows.sort(function (a, b) { return compareSpoolId(a.spool, b.spool); });

        var linked = linkedRows.map(function (row) { return row.spool; });
        var conflicts = [];
        if (context.uid && linked.length > 1) {
            conflicts.push({
                type: 'duplicate_uid',
                uid: context.uid,
                spoolIds: linked.map(function (spool) { return spool.id; }),
                spools: linked.slice()
            });
        }

        return {
            linked: linked,
            current: currentRows.map(function (row) { return row.spool; }),
            suggested: suggested.map(function (match) {
                return {
                    spool: match.spool,
                    score: match.score,
                    reasons: match.reasons.slice(),
                    matchedCategories: match.matchedCategories,
                    colorDistance: match.colorDistance
                };
            }),
            all: allRows.map(function (row) { return row.spool; }),
            conflicts: conflicts,
            legacy: legacyRows.map(function (row) { return row.spool; })
        };
    }

    return {
        normalizeUid: normalizeUid,
        decodeExtra: decodeExtra,
        formatFromFilament: formatFromFilament,
        formatLabel: formatLabel,
        hardwareFrom: hardwareFrom,
        hardwareLabel: hardwareLabel,
        shouldAcceptScan: shouldAcceptScan,
        normalizeDecoded: normalizeDecoded,
        buildTagMatchContext: buildTagMatchContext,
        groupSpools: groupSpools
    };
}));
