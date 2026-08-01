(function (root, factory) {
    'use strict';

    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TigerTagAuthoring = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var GROUPS = Object.freeze({
        material: 'materials',
        brand: 'brands',
        aspect1: 'aspects',
        aspect2: 'aspects',
        productType: 'types',
        diameter: 'diameters',
        unit: 'units'
    });

    var TIGERTAG_MAKER_ID = 0x5BF59264;
    var TIGERTAG_PLUS_ID = 0xBC0FCB97;
    var TIGERTAG_INIT_ID = 0x6C41A2E1;
    var TIGERTAG_MAKER_PRODUCT_ID = 0xFFFFFFFF;
    var TIGERTAG_EPOCH_MS = Date.UTC(2000, 0, 1);
    var LEGACY_VARIANTS = Object.freeze(['legacy_openrfid_v1']);

    function own(value, key) {
        return Object.prototype.hasOwnProperty.call(value || {}, key);
    }

    function object(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function decodeExtra(value) {
        var decoded = value;
        for (var attempt = 0; attempt < 4 && typeof decoded === 'string'; attempt += 1) {
            var text = decoded.trim();
            if (!text) return '';
            try {
                var next = JSON.parse(text);
                if (next === decoded) break;
                decoded = next;
            } catch (_error) {
                break;
            }
        }
        return decoded;
    }

    function utf8ByteLength(value) {
        var text = String(value == null ? '' : value);
        var length = 0;
        for (var index = 0; index < text.length; index += 1) {
            var code = text.charCodeAt(index);
            if (code < 0x80) length += 1;
            else if (code < 0x800) length += 2;
            else if (code >= 0xD800 && code <= 0xDBFF
                    && index + 1 < text.length
                    && text.charCodeAt(index + 1) >= 0xDC00
                    && text.charCodeAt(index + 1) <= 0xDFFF) {
                length += 4;
                index += 1;
            } else length += 3;
        }
        return length;
    }

    function normalizeUid(value) {
        if (typeof value !== 'string') return '';
        var text = value.trim();
        if (/^0x/i.test(text)) text = text.slice(2);
        text = text.replace(/[\s:_-]/g, '');
        return /^[0-9a-f]{14}$/i.test(text) ? text.toUpperCase() : '';
    }

    function normalizeColor(value, encoding) {
        if (typeof value === 'number' && isFinite(value)) {
            var number = value >>> 0;
            if (encoding === 'argb') return ('000000' + (number & 0xFFFFFF).toString(16)).slice(-6).toUpperCase();
            if (encoding === 'rgba') return ('000000' + ((number >>> 8) & 0xFFFFFF).toString(16)).slice(-6).toUpperCase();
            return ('000000' + (number & 0xFFFFFF).toString(16)).slice(-6).toUpperCase();
        }
        if (typeof value !== 'string') return '';
        var text = value.trim().replace(/^#/, '');
        if (/^[0-9a-f]{8}$/i.test(text)) text = text.slice(0, 6);
        return /^[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : '';
    }

    function byteHex(value) {
        if (value === null || value === undefined || value === '') return '';
        var number = Number(value);
        if (!isFinite(number) || Math.floor(number) !== number || number < 0 || number > 0xFF) {
            return '';
        }
        return ('0' + number.toString(16)).slice(-2).toUpperCase();
    }

    function colorFromRaw(raw, index) {
        var suffix = index === 1 ? '' : String(index);
        var legacySuffix = index === 1 ? '' : '_' + index;
        var red = byteHex(first(raw, ['color_r' + suffix, 'color' + index + '_r', 'colorR' + legacySuffix], null));
        var green = byteHex(first(raw, ['color_g' + suffix, 'color' + index + '_g', 'colorG' + legacySuffix], null));
        var blue = byteHex(first(raw, ['color_b' + suffix, 'color' + index + '_b', 'colorB' + legacySuffix], null));
        return red && green && blue ? red + green + blue : '';
    }

    function alphaFromColor(value) {
        if (typeof value === 'number' && isFinite(value) && value > 0xFFFFFF) {
            return (value >>> 24) & 0xFF;
        }
        if (typeof value !== 'string') return null;
        var text = value.trim().replace(/^#/, '');
        return /^[0-9a-f]{8}$/i.test(text) ? parseInt(text.slice(6), 16) : null;
    }

    function colorsFromValues(source, encoding) {
        if (!Array.isArray(source)) source = [source];
        var result = [];
        source.forEach(function (value) {
            var color = normalizeColor(value, encoding);
            // Equal colors in different slots are meaningful protocol data.
            if (color && result.length < 3) result.push(color);
        });
        return result;
    }

    function colorsFromFields(fields) {
        if (own(fields, 'colors_rgba_hex')) return colorsFromValues(fields.colors_rgba_hex, 'rgba');
        if (own(fields, 'colors_rgba')) return colorsFromValues(fields.colors_rgba, 'rgba');
        if (own(fields, 'colors')) return colorsFromValues(fields.colors, 'argb');
        return [];
    }

    function optionRecord(options, group, value) {
        var collection = options && Array.isArray(options[group]) ? options[group] : [];
        if (value === null || value === undefined || value === '') return null;
        if (object(value)) value = own(value, 'id') ? value.id : value.label;
        var wanted = String(value).trim().toLowerCase();
        for (var index = 0; index < collection.length; index += 1) {
            var entry = collection[index];
            if (!entry) continue;
            if (String(entry.id) === String(value)
                    || String(entry.label || '').trim().toLowerCase() === wanted) return entry;
        }
        return null;
    }

    function aspectColorCount(record) {
        if (!object(record)) return 0;
        var value = Number(first(record, ['color_count', 'colorCount'], 0));
        return isFinite(value) && value > 0 ? Math.min(3, Math.floor(value)) : 0;
    }

    function activeColorCount(firstAspect, secondAspect) {
        var firstCount = aspectColorCount(firstAspect);
        var secondCount = aspectColorCount(secondAspect);
        // TigerTag gives a multi-color aspect in slot 2 precedence over slot 1.
        if (secondCount > 1) return secondCount;
        if (firstCount > 1) return firstCount;
        return 1;
    }

    function draftActiveColorCount(options, draft) {
        return activeColorCount(
            optionRecord(options, 'aspects', draft && draft.aspect1),
            optionRecord(options, 'aspects', draft && draft.aspect2)
        );
    }

    function rawTagData(channel) {
        var decoded = channel && channel.decoded;
        var formatData = decoded && (decoded.formatData || decoded.format_data);
        return object(formatData) && object(formatData.raw) ? formatData.raw : {};
    }

    function formatData(channel) {
        var decoded = channel && channel.decoded;
        var value = decoded && (decoded.formatData || decoded.format_data);
        return object(value) ? value : {};
    }

    function tagFormat(channel) {
        var decoded = channel && channel.decoded;
        var fields = decoded && object(decoded.fields) ? decoded.fields : {};
        var value = channel && (channel.tag_format || channel.tagFormat)
            || decoded && (decoded.tagFormat || decoded.tag_format)
            || fields.tag_format || fields.tagFormat || '';
        return String(value || '').trim().toLowerCase();
    }

    function tagVariant(channel) {
        var value = formatData(channel).variant;
        return String(value || '').trim().toLowerCase();
    }

    function protocolTagVariant(channel) {
        var variant = tagVariant(channel);
        if (variant === 'maker' || variant === 'init' || variant === 'plus'
                || LEGACY_VARIANTS.indexOf(variant) !== -1
                || /^legacy_openrfid_/.test(variant)
                || /^legacy_.*plus/.test(variant)) {
            return variant;
        }
        return '';
    }

    function first(objectValue, keys, fallback) {
        for (var index = 0; index < keys.length; index += 1) {
            if (own(objectValue, keys[index]) && objectValue[keys[index]] !== null
                    && objectValue[keys[index]] !== undefined) return objectValue[keys[index]];
        }
        return fallback;
    }

    function recordValue(value, key) {
        if (!object(value)) return value;
        if (own(value, key)) return value[key];
        if (own(value, 'id')) return value.id;
        if (own(value, 'label')) return value.label;
        if (own(value, 'name')) return value.name;
        return value;
    }

    function aspectValue(formatValue, index, fallback) {
        var aspects = Array.isArray(formatValue.aspects) ? formatValue.aspects : [];
        if (aspects[index]) return recordValue(aspects[index], 'id');
        return fallback;
    }

    function tdValue(fields, raw, formatValue) {
        if (own(raw, 'td_raw')) return Number(raw.td_raw) / 10;
        if (own(raw, 'tdRaw')) return Number(raw.tdRaw) / 10;
        return first(fields, ['td_mm', 'td'], first(formatValue, ['td_mm', 'td'], 0));
    }

    function storedColorsFromTag(fields, raw) {
        var fieldColors = colorsFromFields(fields);
        var stored = [1, 2, 3].map(function (index) {
            return colorFromRaw(raw, index) || fieldColors[index - 1] || '000000';
        });
        return stored;
    }

    function alphaFromNumericColor(value, encoding) {
        if (typeof value !== 'number' || !isFinite(value)) return null;
        var number = value >>> 0;
        if (encoding === 'argb') return (number >>> 24) & 0xFF;
        if (encoding === 'rgba') return number & 0xFF;
        return null;
    }

    function primaryAlphaFromTag(fields, raw) {
        var rawAlpha = Number(first(raw, ['color_a', 'color1_a', 'colorA'], undefined));
        if (isFinite(rawAlpha) && Math.floor(rawAlpha) === rawAlpha
                && rawAlpha >= 0 && rawAlpha <= 0xFF) return rawAlpha;
        var source = [];
        var encoding = '';
        if (own(fields, 'colors_rgba_hex')) { source = fields.colors_rgba_hex; encoding = 'rgba'; }
        else if (own(fields, 'colors_rgba')) { source = fields.colors_rgba; encoding = 'rgba'; }
        else if (own(fields, 'colors')) { source = fields.colors; encoding = 'argb'; }
        if (!Array.isArray(source)) source = [source];
        var fieldAlpha = source.length && typeof source[0] === 'number'
            ? alphaFromNumericColor(source[0], encoding)
            : source.length ? alphaFromColor(source[0]) : null;
        if (fieldAlpha !== null) return fieldAlpha;
        var explicitAlpha = Number(fields.alpha);
        return isFinite(explicitAlpha) && explicitAlpha >= 0 && explicitAlpha <= 0xFF
            ? Math.floor(explicitAlpha) : 0xFF;
    }

    function draftFromTag(channel) {
        var decoded = channel && channel.decoded;
        var fields = decoded && object(decoded.fields) ? decoded.fields : {};
        var raw = rawTagData(channel);
        var modifiers = Array.isArray(fields.modifiers) ? fields.modifiers : [];
        var fieldColors = colorsFromFields(fields);
        var storedColors = storedColorsFromTag(fields, raw);
        var data = formatData(channel);
        var aspects = data.aspects;
        var activeCount = Array.isArray(aspects)
            ? activeColorCount(aspects[0], aspects[1])
            : Math.max(1, Math.min(3, fieldColors.length || 1));
        return {
            inventoryName: '',
            material: recordValue(first(raw, ['id_material', 'materialId'],
                first(data, ['material'], first(fields, ['material_name', 'type', 'material'], ''))), 'id'),
            brand: recordValue(first(raw, ['id_brand', 'brandId'],
                first(data, ['brand'], first(fields, ['manufacturer', 'brand'], ''))), 'id'),
            aspect1: first(raw, ['id_aspect1', 'id_aspect_1', 'aspect1Id'],
                aspectValue(data, 0, modifiers[0] || 104)),
            aspect2: first(raw, ['id_aspect2', 'id_aspect_2', 'aspect2Id'],
                aspectValue(data, 1, modifiers[1] || 0)),
            productType: recordValue(first(raw, ['id_type', 'typeId'], first(data, ['product_type', 'type'], 142)), 'id'),
            diameter: recordValue(first(raw, ['id_diameter', 'diameterId'],
                first(data, ['diameter'], first(fields, ['diameter_mm'], 1.75))), 'id'),
            // `colors` is the active aspect-driven edit surface. Keep all
            // three raw slots separately so inactive colors survive an edit.
            colors: storedColors.slice(0, activeCount),
            storedColors: storedColors,
            primaryColorAlpha: primaryAlphaFromTag(fields, raw),
            measure: first(raw, ['measure'], first(fields, ['weight_grams'], 0)),
            measureAvailable: first(raw, ['measure_available'],
                first(fields, ['available_quantity', 'available_weight_grams'],
                    first(fields, ['weight_grams'], 0))),
            unit: first(raw, ['id_unit'], first(fields, ['quantity_unit'], 21)),
            nozzleMin: first(raw, ['nozzle_min'], first(fields, ['hotend_min_temp_c'], 0)),
            nozzleMax: first(raw, ['nozzle_max'], first(fields, ['hotend_max_temp_c'], 0)),
            dryTemp: first(raw, ['dry_temp'], first(fields, ['drying_temp_c'], 0)),
            dryTime: first(raw, ['dry_time'], first(fields, ['drying_time_hours'], 0)),
            bedMin: first(raw, ['bed_min'], first(fields, ['bed_temp_min_c', 'bed_temp_c'], 0)),
            bedMax: first(raw, ['bed_max'], first(fields, ['bed_temp_max_c'], 0)),
            manufacturingDate: first(fields, ['manufacturing_date'], ''),
            timestamp: first(raw, ['timestamp'], null),
            tdMm: tdValue(fields, raw, data),
            message: first(raw, ['message'], first(fields, ['message', 'custom_message'], ''))
        };
    }

    function splitText(value) {
        value = decodeExtra(value);
        if (Array.isArray(value)) return value.map(String).map(function (item) {
            return item.trim();
        }).filter(Boolean);
        if (value === null || value === undefined) return [];
        return String(value).split(/[,;|]+/).map(function (item) {
            return item.trim();
        }).filter(Boolean);
    }

    function spoolColors(filament) {
        var values = [];
        if (filament.multi_color_hexes) values = String(filament.multi_color_hexes).split(',');
        if (filament.color_hex) values.unshift(filament.color_hex);
        var result = [];
        values.forEach(function (value) {
            var color = normalizeColor(value);
            if (color && result.indexOf(color) === -1 && result.length < 3) result.push(color);
        });
        return result;
    }

    function extraValue(extra, key, fallback) {
        if (!own(extra, key)) return fallback;
        var value = decodeExtra(extra[key]);
        return value === '' || value === null || value === undefined ? fallback : value;
    }

    function draftFromSpool(spool, copyNameToMessage) {
        var filament = spool && object(spool.filament) ? spool.filament : {};
        var extra = object(filament.extra) ? filament.extra : {};
        var aspects = splitText(extraValue(extra, 'tag_aspects', extraValue(extra, 'variant', 'Basic')));
        var inventoryName = String(filament.name || '').trim();
        var tagMessage = extraValue(extra, 'tag_message', '');
        if (!tagMessage && copyNameToMessage === true) tagMessage = inventoryName;
        var total = Number(filament.weight || 0);
        var remaining = Number(spool && spool.remaining_weight != null
            ? spool.remaining_weight : total);
        var colors = spoolColors(filament);
        return {
            inventoryName: inventoryName,
            material: extraValue(extra, 'tag_material_name', filament.material || ''),
            brand: filament.vendor && filament.vendor.name || '',
            aspect1: aspects[0] || 'Basic',
            aspect2: aspects[1] || '-',
            productType: extraValue(extra, 'tag_product_type', 'Filament'),
            diameter: filament.diameter || 1.75,
            colors: colors,
            storedColors: colors.concat(['000000', '000000', '000000']).slice(0, 3),
            primaryColorAlpha: 0xFF,
            measure: isFinite(total) ? Math.max(0, Math.round(total)) : 0,
            measureAvailable: isFinite(remaining) ? Math.max(0, Math.round(remaining)) : 0,
            unit: 'g',
            nozzleMin: extraValue(extra, 'min_extruder_temp', 0),
            nozzleMax: extraValue(extra, 'max_extruder_temp', filament.settings_extruder_temp || 0),
            dryTemp: extraValue(extra, 'drying_temp', 0),
            dryTime: extraValue(extra, 'drying_time', 0),
            bedMin: extraValue(extra, 'min_bed_temp', filament.settings_bed_temp || 0),
            bedMax: extraValue(extra, 'max_bed_temp', filament.settings_bed_temp || 0),
            manufacturingDate: extraValue(extra, 'mfg_date', ''),
            timestamp: null,
            tdMm: extraValue(extra, 'td', 0),
            message: String(tagMessage || '')
        };
    }

    function finiteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        var number = Number(value);
        return isFinite(number) ? number : null;
    }

    function integerField(errors, label, value, minimum, maximum) {
        var number = finiteNumber(value);
        if (number === null || Math.floor(number) !== number || number < minimum || number > maximum) {
            errors.push(label + ' must be an integer between ' + minimum + ' and ' + maximum);
            return 0;
        }
        return number;
    }

    function resolveOption(errors, options, draftKey, value, required) {
        if ((value === '' || value === null || value === undefined) && !required) return 0;
        var group = GROUPS[draftKey];
        var record = optionRecord(options, group, value);
        if (!record) {
            errors.push(draftKey + ' is not present in the pinned TigerTag registry');
            return 0;
        }
        return record.id;
    }

    function validateDraft(draft, options) {
        draft = object(draft) ? draft : {};
        var errors = [];
        var message = String(draft.message || '');
        var messageBytes = utf8ByteLength(message);
        if (messageBytes > 28) errors.push('Tag message is ' + messageBytes + ' UTF-8 bytes; maximum is 28');

        var colorCount = draftActiveColorCount(options, draft);
        var activeInput = Array.isArray(draft.colors) ? draft.colors.slice() : [];
        var activeColors = activeInput.map(normalizeColor).filter(Boolean).slice(0, 3);
        if (activeInput.length !== colorCount || activeColors.length !== colorCount) {
            errors.push('Selected aspects require exactly ' + colorCount
                + ' valid RGB color' + (colorCount === 1 ? '' : 's'));
        }
        var storedInput = Array.isArray(draft.storedColors)
            ? draft.storedColors.slice(0, 3) : activeInput.slice(0, 3);
        while (storedInput.length < 3) storedInput.push('000000');
        var storedColors = storedInput.map(normalizeColor);
        if (storedColors.some(function (color) { return !color; })) {
            errors.push('Stored colors must use six hexadecimal RGB digits');
            storedColors = storedColors.map(function (color) { return color || '000000'; });
        }
        for (var colorIndex = 0; colorIndex < Math.min(colorCount, activeColors.length); colorIndex += 1) {
            storedColors[colorIndex] = activeColors[colorIndex];
        }
        var primaryColorAlpha = integerField(
            errors, 'Primary alpha',
            own(draft, 'primaryColorAlpha') ? draft.primaryColorAlpha : 0xFF,
            0, 0xFF
        );

        var td = finiteNumber(draft.tdMm);
        if (td === null || (td !== 0 && (td < 1 || td > 100))) {
            errors.push('Transmission distance must be 0 (unknown) or between 1.0 and 100.0 mm');
            td = 0;
        }

        var manufacturingDate = String(draft.manufacturingDate || '').trim();
        if (manufacturingDate && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(manufacturingDate)) {
            errors.push('Manufacturing date must be an ISO-8601 date');
        }

        var spec = {
            product_id: 0xFFFFFFFF,
            material: resolveOption(errors, options, 'material', draft.material, true),
            brand: resolveOption(errors, options, 'brand', draft.brand, false),
            aspect_1: resolveOption(errors, options, 'aspect1', draft.aspect1, false),
            aspect_2: resolveOption(errors, options, 'aspect2', draft.aspect2, false),
            type: resolveOption(errors, options, 'productType', draft.productType, false),
            diameter: resolveOption(errors, options, 'diameter', draft.diameter, false),
            // The SDK always stores three RGB slots. Only the selected aspect
            // determines how many are active; preserving the dormant slots is
            // required for a byte-for-byte unchanged edit.
            colors: storedColors.map(function (color, index) {
                return '#' + color + (index === 0 ? byteHex(primaryColorAlpha) : '');
            }),
            measure: integerField(errors, 'Initial quantity', draft.measure, 0, 0xFFFFFF),
            measure_available: integerField(errors, 'Available quantity', draft.measureAvailable, 0, 0xFFFFFF),
            unit: resolveOption(errors, options, 'unit', draft.unit, false),
            temp_min_c: integerField(errors, 'Nozzle minimum', draft.nozzleMin, 0, 0xFFFF),
            temp_max_c: integerField(errors, 'Nozzle maximum', draft.nozzleMax, 0, 0xFFFF),
            dry_temp_c: integerField(errors, 'Drying temperature', draft.dryTemp, 0, 0xFF),
            dry_time_h: integerField(errors, 'Drying duration', draft.dryTime, 0, 0xFF),
            bed_temp_min_c: integerField(errors, 'Bed minimum', draft.bedMin, 0, 0xFF),
            bed_temp_max_c: integerField(errors, 'Bed maximum', draft.bedMax, 0, 0xFF),
            td_mm: td,
            message: message
        };
        if (draft.timestamp !== null && draft.timestamp !== undefined && draft.timestamp !== '') {
            spec.timestamp = integerField(errors, 'TigerTag timestamp', draft.timestamp, 0, 0xFFFFFFFF);
        } else if (manufacturingDate) {
            spec.manufacturing_date = manufacturingDate;
        }

        return {
            ok: errors.length === 0,
            errors: errors,
            messageBytes: messageBytes,
            inventoryName: String(draft.inventoryName || '').trim(),
            activeColorCount: colorCount,
            storedColors: storedColors,
            spec: spec
        };
    }

    function writeRequest(slot, uid, spec, allowUnrecognized, allowLegacyMigration) {
        var normalizedUid = normalizeUid(uid);
        if (!Number.isInteger(slot) || slot < 0) throw new Error('A valid RFID slot is required');
        if (!normalizedUid) throw new Error('A 7-byte NTAG UID is required');
        if (!object(spec)) throw new Error('A validated TigerTag spec is required');
        if (allowUnrecognized === true && allowLegacyMigration === true) {
            throw new Error('Legacy migration and unrecognized initialization are mutually exclusive');
        }
        var request = {
            slot: slot,
            expected_uid: normalizedUid,
            expected_format: 'tigertag',
            spec: spec,
            allow_unrecognized: allowUnrecognized === true
        };
        if (allowLegacyMigration === true) request.allow_legacy_migration = true;
        return request;
    }

    function clearRequest(slot, uid, allowUnrecognized, allowLegacyMigration) {
        var request = writeRequest(
            slot, uid, {}, allowUnrecognized, allowLegacyMigration
        );
        delete request.spec;
        return request;
    }

    function writePayloadRequest(slot, uid, dataHex, allowUnrecognized, allowLegacyMigration) {
        if (typeof dataHex !== 'string' || !/^[0-9a-f]{160}$/i.test(dataHex)) {
            throw new Error('A reviewed 80-byte TigerTag payload is required');
        }
        var request = writeRequest(
            slot, uid, {}, allowUnrecognized, allowLegacyMigration
        );
        delete request.spec;
        request.data_hex = dataHex.toUpperCase();
        return request;
    }

    function protectedTigerTag(channel) {
        var raw = rawTagData(channel);
        var id = Number(first(raw, ['id_tigertag'], 0));
        return tagFormat(channel) === 'tigertag'
            && id === TIGERTAG_PLUS_ID
            && LEGACY_VARIANTS.indexOf(protocolTagVariant(channel)) === -1;
    }

    function migratableLegacyTag(channel) {
        return tagFormat(channel) === 'tigertag'
            && LEGACY_VARIANTS.indexOf(protocolTagVariant(channel)) !== -1;
    }

    function writableTigerTagVariant(channel) {
        var variant = protocolTagVariant(channel);
        if (variant === 'maker' || variant === 'init' || LEGACY_VARIANTS.indexOf(variant) !== -1) {
            return true;
        }
        if (variant) return false;
        var id = Number(first(rawTagData(channel), ['id_tigertag'], 0));
        return id === TIGERTAG_MAKER_ID || id === TIGERTAG_INIT_ID || id === 0;
    }

    function authoringGate(api, channel, allowUnrecognized, allowLegacyMigration) {
        var reasons = [];
        var uid = normalizeUid(channel && channel.physical && channel.physical.uidHex || '');
        var capabilities = channel && channel.openRfidCapabilities;
        var writer = capabilities && capabilities.tigertag_write;
        if (!api || api.write_enabled !== true) reasons.push('Tag writing is disabled');
        if (api && api.write_allowed === false) {
            reasons.push(api.write_block && api.write_block.error || 'The printer write gate is closed');
        }
        if (!writer || writer.supported !== true) reasons.push('This reader does not support guarded TigerTag writes');
        if (writer && writer.busy === true) reasons.push('This reader slot is busy');
        if (!uid) reasons.push('The current tag does not have a 7-byte NTAG UID');
        if (channel && channel.physical && channel.physical.hardwareType !== 'ultralight') {
            reasons.push('Only Ultralight / NTAG hardware is writable');
        }
        var format = tagFormat(channel);
        var legacyMigration = migratableLegacyTag(channel);
        if (protectedTigerTag(channel)) {
            reasons.push('TigerTag+ tags are read-only; only legacy_openrfid_v1 is migratable');
        } else if (format === 'tigertag' && !writableTigerTagVariant(channel)) {
            reasons.push('Only TigerTag Maker, Init, or legacy_openrfid_v1 payloads are writable');
        }
        if (format !== 'tigertag' && allowUnrecognized !== true) {
            reasons.push('A non-TigerTag payload requires the explicit initialization override');
        }
        if (allowUnrecognized === true && (!api || api.allow_unrecognized_write !== true)) {
            reasons.push('Blank/unrecognized tag initialization is disabled');
        }
        if (legacyMigration && allowLegacyMigration !== true) {
            reasons.push('legacy_openrfid_v1 migration requires its separate explicit confirmation');
        }
        if (allowLegacyMigration === true && !legacyMigration) {
            reasons.push('Legacy migration can only target an exact legacy_openrfid_v1 payload');
        }
        if (allowLegacyMigration === true
                && (!api || api.allow_legacy_migration_write !== true)) {
            reasons.push('Legacy OpenRFID migration is disabled');
        }
        if (allowLegacyMigration === true
                && (!writer || writer.allow_legacy_migration_supported !== true)) {
            reasons.push('This reader does not support guarded legacy migration');
        }
        if (allowLegacyMigration === true && allowUnrecognized === true) {
            reasons.push('Legacy migration cannot use the unrecognized-tag override');
        }
        return { ok: reasons.length === 0, reasons: reasons, uid: uid };
    }

    function colorChannels(value, primary) {
        if (typeof value === 'number' && isFinite(value)) {
            var packed = value >>> 0;
            return {
                r: (packed >> 16) & 0xFF,
                g: (packed >> 8) & 0xFF,
                b: packed & 0xFF,
                a: (packed >> 24) & 0xFF
            };
        }
        var text = String(value == null ? '' : value).trim().replace(/^#/, '');
        if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text)) {
            return { r: 0, g: 0, b: 0, a: primary ? 0xFF : null };
        }
        return {
            r: parseInt(text.slice(0, 2), 16),
            g: parseInt(text.slice(2, 4), 16),
            b: parseInt(text.slice(4, 6), 16),
            a: text.length === 8 ? parseInt(text.slice(6, 8), 16) : (primary ? 0xFF : null)
        };
    }

    function timestampFromSpec(spec) {
        if (own(spec, 'timestamp')) return Number(spec.timestamp);
        if (!spec.manufacturing_date) return null;
        var parsed = Date.parse(String(spec.manufacturing_date));
        return isFinite(parsed) ? Math.floor((parsed - TIGERTAG_EPOCH_MS) / 1000) : null;
    }

    function verifyRescan(channel, spec) {
        spec = object(spec) ? spec : {};
        var raw = rawTagData(channel);
        var mismatches = [];
        var expected = {};
        var actual = {};

        function compare(key, expectedValue, actualValue) {
            if (expectedValue === null || expectedValue === undefined) return;
            expected[key] = expectedValue;
            actual[key] = actualValue;
            if (actualValue !== expectedValue) {
                mismatches.push(key + ': expected ' + expectedValue + ', read ' + actualValue);
            }
        }

        compare('tag_format', 'tigertag', tagFormat(channel));
        compare('tag_variant', 'maker', tagVariant(channel));
        [
            ['id_tigertag', TIGERTAG_MAKER_ID],
            ['id_product', TIGERTAG_MAKER_PRODUCT_ID],
            ['id_material', Number(spec.material)],
            ['id_aspect1', Number(spec.aspect_1)],
            ['id_aspect2', Number(spec.aspect_2)],
            ['id_type', Number(spec.type)],
            ['id_diameter', Number(spec.diameter)],
            ['id_brand', Number(spec.brand)],
            ['measure', Number(spec.measure)],
            ['measure_available', Number(spec.measure_available)],
            ['id_unit', Number(spec.unit)],
            ['nozzle_min', Number(spec.temp_min_c)],
            ['nozzle_max', Number(spec.temp_max_c)],
            ['dry_temp', Number(spec.dry_temp_c)],
            ['dry_time', Number(spec.dry_time_h)],
            ['bed_min', Number(spec.bed_temp_min_c)],
            ['bed_max', Number(spec.bed_temp_max_c)],
            ['timestamp', timestampFromSpec(spec)],
            ['td_raw', Math.round(Number(spec.td_mm) * 10)]
        ].forEach(function (entry) {
            compare(entry[0], entry[1], Number(raw[entry[0]]));
        });

        var colors = Array.isArray(spec.colors) ? spec.colors.slice(0, 3) : [];
        while (colors.length < 3) colors.push('#000000');
        colors.forEach(function (value, index) {
            var channels = colorChannels(value, index === 0);
            var suffix = index === 0 ? '' : String(index + 1);
            compare('color_r' + suffix, channels.r, Number(raw['color_r' + suffix]));
            compare('color_g' + suffix, channels.g, Number(raw['color_g' + suffix]));
            compare('color_b' + suffix, channels.b, Number(raw['color_b' + suffix]));
            if (index === 0) compare('color_a', channels.a, Number(raw.color_a));
        });
        compare('message', String(spec.message || ''), String(raw.message || ''));

        return {
            ok: mismatches.length === 0,
            errors: mismatches.slice(),
            mismatches: mismatches,
            expected: expected,
            actual: actual
        };
    }

    return Object.freeze({
        utf8ByteLength: utf8ByteLength,
        normalizeUid: normalizeUid,
        normalizeColor: normalizeColor,
        optionRecord: optionRecord,
        draftFromTag: draftFromTag,
        draftFromSpool: draftFromSpool,
        validateDraft: validateDraft,
        writeRequest: writeRequest,
        writePayloadRequest: writePayloadRequest,
        clearRequest: clearRequest,
        migratableLegacyTag: migratableLegacyTag,
        protectedTigerTag: protectedTigerTag,
        authoringGate: authoringGate,
        verifyRescan: verifyRescan
    });
}));
