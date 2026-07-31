(function (root, factory) {
    'use strict';

    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SpoolmanRfidFields = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function field(group, entity, key, type, name, apiType) {
        return Object.freeze({
            group: group,
            entity: entity,
            key: key,
            type: type,
            field_type: apiType || type,
            name: name
        });
    }

    var CORE_FIELDS = Object.freeze([
        field('core', 'spool', 'card_uids', 'text', 'Card UIDs'),
        field('core', 'filament', 'variant', 'text', 'Variant')
    ]);

    var OPTIONAL_FIELDS = Object.freeze([
        field('optional', 'filament', 'min_extruder_temp', 'integer', 'Minimum extruder temperature'),
        field('optional', 'filament', 'max_extruder_temp', 'integer', 'Maximum extruder temperature'),
        field('optional', 'filament', 'min_bed_temp', 'integer', 'Minimum bed temperature'),
        field('optional', 'filament', 'max_bed_temp', 'integer', 'Maximum bed temperature'),
        field('optional', 'filament', 'drying_temp', 'integer', 'Drying temperature'),
        field('optional', 'filament', 'drying_time', 'integer', 'Drying time'),
        field('optional', 'filament', 'td', 'number', 'Transmission distance', 'float'),
        field('optional', 'filament', 'mfg_date', 'text', 'Manufacturing date'),
        field('optional', 'filament', 'tag_message', 'text', 'Tag message'),
        field('optional', 'filament', 'tag_material_name', 'text', 'TigerTag SDK material label'),
        field('optional', 'filament', 'tag_aspects', 'text', 'Tag aspects'),
        field('optional', 'filament', 'tag_product_type', 'text', 'Tag product type'),
        field('optional', 'filament', 'tag_color_alpha', 'integer', 'Tag color alpha'),
        field('optional', 'filament', 'tag_format', 'text', 'RFID payload format'),
        field('optional', 'filament', 'tag_hardware', 'text', 'RFID tag hardware')
    ]);

    var LEGACY_FIELDS = Object.freeze([
        field('legacy', 'spool', 'rfid_uid', 'text', 'RFID Tag UID'),
        field('legacy', 'filament', 'modifiers', 'text', 'Modifiers / finish')
    ]);

    var ALL_FIELDS = CORE_FIELDS.concat(OPTIONAL_FIELDS, LEGACY_FIELDS);

    function decodeJson(value) {
        var decoded = value;
        var attempts = 0;

        while (typeof decoded === 'string' && attempts < 2) {
            var trimmed = decoded.trim();
            if (!trimmed || (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '"')) {
                break;
            }
            try {
                decoded = JSON.parse(trimmed);
            } catch (_error) {
                break;
            }
            attempts += 1;
        }
        return decoded;
    }

    function decodeFieldType(value) {
        var decoded = decodeJson(value);

        if (decoded && typeof decoded === 'object') {
            if (decoded.field_type != null) decoded = decoded.field_type;
            else if (decoded.fieldType != null) decoded = decoded.fieldType;
            else if (decoded.data_type != null) decoded = decoded.data_type;
            else if (decoded.dataType != null) decoded = decoded.dataType;
            else if (decoded.type != null) decoded = decoded.type;
            else if (decoded.schema != null) return decodeFieldType(decoded.schema);
            else if (decoded.definition != null) return decodeFieldType(decoded.definition);
            else return null;
        }

        if (typeof decoded !== 'string') return null;

        var normalized = decoded.trim().toLowerCase();
        if (!normalized) return null;
        if (normalized === 'int') return 'integer';
        if (normalized === 'float' || normalized === 'decimal') return 'number';
        if (normalized === 'str' || normalized === 'string') return 'text';
        return normalized;
    }

    function unwrapSchemaList(value) {
        var decoded = decodeJson(value);
        if (Array.isArray(decoded)) return decoded;
        if (!decoded || typeof decoded !== 'object') return [];
        if (Array.isArray(decoded.fields)) return decoded.fields;
        if (Array.isArray(decoded.result)) return decoded.result;
        if (decoded.result && Array.isArray(decoded.result.fields)) {
            return decoded.result.fields;
        }
        return [];
    }

    function schemaEntity(entry, fallbackEntity) {
        if (!entry || typeof entry !== 'object') return fallbackEntity || null;
        return entry.entity || entry.entity_type || entry.entityType || fallbackEntity || null;
    }

    function normalizeSchemaEntry(entry, fallbackEntity) {
        var decoded = decodeJson(entry);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
        if (decoded.key == null) return null;

        return {
            entity: schemaEntity(decoded, fallbackEntity),
            key: String(decoded.key).trim(),
            type: decodeFieldType(decoded),
            raw: decoded
        };
    }

    function indexEntitySchemas(entitySchemas) {
        var index = { spool: Object.create(null), filament: Object.create(null) };
        var schemas = decodeJson(entitySchemas);

        if (Array.isArray(schemas)) {
            schemas.forEach(function (entry) {
                var normalized = normalizeSchemaEntry(entry, null);
                if (!normalized || !index[normalized.entity] || !normalized.key) return;
                if (!index[normalized.entity][normalized.key]) {
                    index[normalized.entity][normalized.key] = normalized;
                }
            });
            return index;
        }

        if (!schemas || typeof schemas !== 'object') return index;

        ['spool', 'filament'].forEach(function (entity) {
            unwrapSchemaList(schemas[entity]).forEach(function (entry) {
                var normalized = normalizeSchemaEntry(entry, entity);
                if (!normalized || !normalized.key) return;
                if (!index[entity][normalized.key]) {
                    index[entity][normalized.key] = normalized;
                }
            });
        });

        return index;
    }

    function classifyField(definition, schemaField) {
        var normalizedSchema = schemaField && schemaField.raw
            ? schemaField
            : normalizeSchemaEntry(schemaField, definition.entity);
        var exists = !!normalizedSchema;
        var actualType = exists ? normalizedSchema.type : null;
        var expectedType = decodeFieldType(definition.type);
        var status;

        if (!exists) status = 'Missing';
        else if (actualType !== expectedType) status = 'Type mismatch';
        else if (definition.group === 'legacy') status = 'Legacy';
        else status = 'Ready';

        return {
            group: definition.group,
            entity: definition.entity,
            key: definition.key,
            name: definition.name,
            expectedType: expectedType,
            actualType: actualType,
            exists: exists,
            status: status,
            selectable: definition.group === 'optional' && status === 'Missing',
            definition: definition,
            schema: exists ? normalizedSchema.raw : null
        };
    }

    function buildFieldStatus(entitySchemas) {
        var index = indexEntitySchemas(entitySchemas);
        return ALL_FIELDS.map(function (definition) {
            return classifyField(definition, index[definition.entity][definition.key]);
        });
    }

    function isSelected(selected, row) {
        if (typeof selected === 'function') return !!selected(row);
        if (!selected) return false;

        var qualifiedKey = row.entity + '.' + row.key;
        if (typeof Set !== 'undefined' && selected instanceof Set) {
            return selected.has(qualifiedKey) || selected.has(row.key);
        }
        if (Array.isArray(selected)) {
            return selected.indexOf(qualifiedKey) !== -1 || selected.indexOf(row.key) !== -1;
        }
        if (typeof selected === 'object') {
            return selected[qualifiedKey] === true || selected[row.key] === true;
        }
        return false;
    }

    function getSelectedMissingOptionalFields(statusRows, selected) {
        if (!Array.isArray(statusRows)) return [];
        return statusRows.filter(function (row) {
            return row && row.group === 'optional' && row.status === 'Missing' &&
                row.selectable === true && isSelected(selected, row);
        }).map(function (row) {
            return row.definition;
        });
    }

    function hasOwn(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    }

    function isObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function decodeExtraValue(value) {
        var decoded = value;
        for (var attempt = 0; attempt < 4 && typeof decoded === 'string'; attempt += 1) {
            var trimmed = decoded.trim();
            if (!trimmed) return '';
            try {
                var next = JSON.parse(trimmed);
                if (next === decoded) break;
                decoded = next;
            } catch (_error) {
                break;
            }
        }
        return decoded;
    }

    function isEmptyValue(value) {
        var decoded = decodeExtraValue(value);
        return decoded === null || decoded === undefined || decoded === '' ||
            (Array.isArray(decoded) && decoded.length === 0);
    }

    function finiteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        var number = Number(value);
        return isFinite(number) ? number : null;
    }

    function positiveNumber(value) {
        var number = finiteNumber(value);
        return number !== null && number > 0 ? number : null;
    }

    function roundedPositiveInteger(value) {
        var number = positiveNumber(value);
        return number === null ? null : Math.round(number);
    }

    function tagField(decoded, keys, requirePresence) {
        if (!decoded || !isObject(decoded.fields)) return undefined;
        var present = Array.isArray(decoded.presentFields) ? decoded.presentFields : [];
        for (var index = 0; index < keys.length; index += 1) {
            var key = keys[index];
            if (requirePresence && present.indexOf(key) === -1) continue;
            if (hasOwn(decoded.fields, key)) return decoded.fields[key];
        }
        return undefined;
    }

    function normalizeHex(value) {
        if (typeof value === 'number' && isFinite(value)) {
            return ('000000' + ((value >>> 0) & 0xFFFFFF).toString(16)).slice(-6).toUpperCase();
        }
        if (typeof value !== 'string') return '';
        var text = value.trim().replace(/^#/, '');
        if (/^[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
        if (/^[0-9a-f]{8}$/i.test(text)) return text.slice(0, 6).toUpperCase();
        return '';
    }

    function uniqueColors(values) {
        var result = [];
        var seen = Object.create(null);
        values.forEach(function (value) {
            if (!value || seen[value]) return;
            seen[value] = true;
            result.push(value);
        });
        return result;
    }

    function tagColors(decoded) {
        var fields = decoded && decoded.fields;
        if (!isObject(fields)) return { colors: [], alpha: null };
        var present = Array.isArray(decoded.presentFields) ? decoded.presentFields : [];
        var colors = [];
        var alpha = null;

        if (present.indexOf('colors_rgba_hex') !== -1 && Array.isArray(fields.colors_rgba_hex)) {
            fields.colors_rgba_hex.forEach(function (value) {
                if (typeof value !== 'string') return;
                var text = value.trim().replace(/^#/, '');
                if (!/^[0-9a-f]{8}$/i.test(text)) return;
                colors.push(text.slice(0, 6).toUpperCase());
                if (alpha === null) alpha = parseInt(text.slice(6, 8), 16);
            });
        }

        if (!colors.length && present.indexOf('colors') !== -1 && Array.isArray(fields.colors)) {
            fields.colors.forEach(function (value) {
                var number = finiteNumber(value);
                if (number === null) return;
                var unsigned = number >>> 0;
                colors.push(('000000' + (unsigned & 0xFFFFFF).toString(16)).slice(-6).toUpperCase());
                if (alpha === null) alpha = (unsigned >>> 24) & 0xFF;
            });
        }

        if (!colors.length && present.indexOf('colors_rgba') !== -1 && Array.isArray(fields.colors_rgba)) {
            fields.colors_rgba.forEach(function (value) {
                var number = finiteNumber(value);
                if (number === null) return;
                var unsigned = number >>> 0;
                colors.push(('000000' + ((unsigned >>> 8) & 0xFFFFFF).toString(16)).slice(-6).toUpperCase());
                if (alpha === null) alpha = unsigned & 0xFF;
            });
        }

        if (!colors.length && present.indexOf('rgb') !== -1) {
            var rgb = normalizeHex(fields.rgb);
            if (rgb) colors.push(rgb);
            var directAlpha = finiteNumber(fields.alpha);
            if (directAlpha !== null && directAlpha >= 0 && directAlpha <= 255) {
                alpha = Math.round(directAlpha);
            }
        }

        return { colors: uniqueColors(colors), alpha: alpha };
    }

    function validDate(value) {
        if (value === null || value === undefined) return null;
        var text = String(value).trim();
        if (!text || text === '0001-01-01' || text === '1970-01-01') return null;
        return text;
    }

    function joinedText(value) {
        if (Array.isArray(value)) {
            var parts = value.map(function (item) { return String(item).trim(); }).filter(Boolean);
            return parts.length ? parts.join(', ') : null;
        }
        if (value === null || value === undefined) return null;
        var text = String(value).trim();
        return text || null;
    }

    function structuredLabel(value) {
        if (!isObject(value)) return joinedText(value);
        return joinedText(value.label || value.name || value.title || value.id);
    }

    function tagMetadata(decoded, physical) {
        var colors = tagColors(decoded);
        var message = joinedText(tagField(decoded, ['message', 'tag_message', 'custom_message'], true));
        var hotendMin = roundedPositiveInteger(tagField(decoded, ['hotend_min_temp_c'], true));
        var hotendMax = roundedPositiveInteger(tagField(decoded, ['hotend_max_temp_c'], true));
        var bedMin = roundedPositiveInteger(tagField(decoded, ['bed_temp_min_c', 'bed_temp_c'], true));
        var bedMax = roundedPositiveInteger(tagField(decoded, ['bed_temp_max_c'], true));
        var dryingTemp = roundedPositiveInteger(tagField(decoded, ['drying_temp_c'], true));
        var dryingTime = roundedPositiveInteger(tagField(decoded, ['drying_time_hours'], true));
        var td = positiveNumber(tagField(decoded, ['td_mm', 'td'], true));
        var diameter = positiveNumber(tagField(decoded, ['diameter_mm'], true));
        var manufacturingDate = validDate(tagField(decoded, ['manufacturing_date'], true));
        var aspects = joinedText(tagField(decoded, ['modifiers', 'aspects', 'tag_aspects'], true));
        var formatData = isObject(decoded && decoded.formatData) ? decoded.formatData : {};
        var materialName = joinedText(tagField(decoded, ['material_name'], true))
            || structuredLabel(formatData.material);
        var productType = structuredLabel(
            tagField(decoded, ['product_type', 'tag_product_type'], true) ||
            formatData.product_type || formatData.productType
        );
        var tagFormat = joinedText(decoded && decoded.tagFormat);
        if (tagFormat === 'unknown') tagFormat = null;
        var hardware = joinedText(physical && physical.hardwareType);
        if (hardware === 'unknown') hardware = null;

        return {
            name: message,
            color_hex: colors.colors.length ? colors.colors[0] : null,
            multi_color_hexes: colors.colors.length > 1 ? colors.colors.join(',') : null,
            colorsPresent: colors.colors.length > 0,
            diameter: diameter,
            settings_extruder_temp: hotendMax,
            settings_bed_temp: bedMin || bedMax,
            min_extruder_temp: hotendMin,
            max_extruder_temp: hotendMax,
            min_bed_temp: bedMin,
            max_bed_temp: bedMax,
            drying_temp: dryingTemp,
            drying_time: dryingTime,
            td: td,
            mfg_date: manufacturingDate,
            tag_message: message,
            tag_material_name: materialName,
            tag_aspects: aspects,
            tag_product_type: productType,
            tag_color_alpha: colors.alpha,
            tag_format: tagFormat,
            tag_hardware: hardware
        };
    }

    function normalizedComparisonValue(key, value) {
        if (key === 'color_hex') return normalizeHex(value) || String(value || '').trim().toUpperCase() || null;
        if (key === 'multi_color_hexes') {
            if (value === undefined || value === null || value === '') return null;
            return String(value).split(',').map(function (part) {
                return normalizeHex(part) || String(part).trim().toUpperCase();
            }).filter(Boolean).join(',');
        }
        var decoded = decodeExtraValue(value);
        if (decoded === undefined || decoded === null || decoded === '') return null;
        if (typeof decoded === 'number') return isFinite(decoded) ? decoded : null;
        if (typeof decoded === 'boolean') return decoded;
        if (Array.isArray(decoded)) return decoded.map(String).join(', ');
        var numeric = finiteNumber(decoded);
        if (numeric !== null && typeof decoded === 'string' && /^[-+]?\d+(\.\d+)?$/.test(decoded.trim())) {
            return numeric;
        }
        return String(decoded).trim();
    }

    function valuesEqual(key, left, right) {
        return normalizedComparisonValue(key, left) === normalizedComparisonValue(key, right);
    }

    function syncRow(kind, key, label, value, current, schemaStatus) {
        var id = kind === 'extra' ? 'filament.extra.' + key : 'filament.' + key;
        if (kind === 'extra' && (!schemaStatus || schemaStatus.status !== 'Ready')) {
            var schemaNote = !schemaStatus || schemaStatus.status === 'Missing'
                ? 'Custom field is not registered'
                : (schemaStatus.status === 'Type mismatch'
                    ? 'Custom field has the wrong type'
                    : 'Custom field is unavailable');
            return {
                id: id,
                kind: kind,
                key: key,
                label: label,
                value: value,
                current: current,
                state: 'blocked',
                selectable: false,
                selectedByDefault: false,
                conflict: false,
                note: schemaNote
            };
        }

        var same = valuesEqual(key, current, value);
        var conflict = !same && !isEmptyValue(current);
        return {
            id: id,
            kind: kind,
            key: key,
            label: label,
            value: value,
            current: current,
            state: same ? 'same' : (conflict ? 'conflict' : 'add'),
            selectable: !same,
            selectedByDefault: !same && !conflict,
            conflict: conflict,
            note: same ? 'Already matches' : (conflict ? 'Existing value differs' : 'Will add')
        };
    }

    function buildMetadataSyncPlan(decoded, physical, spool, statusRows) {
        var errors = [];
        if (!decoded || !isObject(decoded.fields)) errors.push('No current decoded OpenRFID scan');
        if (!spool || !isObject(spool.filament) || spool.filament.id === null ||
                spool.filament.id === undefined) {
            errors.push('The selected Spoolman spool has no filament record');
        }
        if (!Array.isArray(statusRows) || !statusRows.length) {
            errors.push('Spoolman custom-field schema is unavailable');
        }
        if (errors.length) return { ok: false, errors: errors, rows: [] };

        var schemaByKey = Object.create(null);
        statusRows.forEach(function (row) {
            if (row && row.entity === 'filament') schemaByKey[row.key] = row;
        });

        var metadata = tagMetadata(decoded, physical || {});
        var filament = spool.filament;
        var extra = isObject(filament.extra) ? filament.extra : {};
        var rows = [];
        var nativeFields = [
            ['name', 'Filament name (from tag message)'],
            ['color_hex', 'Primary color'],
            ['multi_color_hexes', 'All colors'],
            ['diameter', 'Diameter'],
            ['settings_extruder_temp', 'Recommended extruder temperature'],
            ['settings_bed_temp', 'Recommended bed temperature']
        ];
        nativeFields.forEach(function (definition) {
            var key = definition[0];
            var value = metadata[key];
            if (key === 'multi_color_hexes' && metadata.colorsPresent) {
                rows.push(syncRow('native', key, definition[1], value, filament[key], null));
            } else if (!isEmptyValue(value)) {
                rows.push(syncRow('native', key, definition[1], value, filament[key], null));
            }
        });

        var extraFields = [
            ['min_extruder_temp', 'Minimum extruder temperature'],
            ['max_extruder_temp', 'Maximum extruder temperature'],
            ['min_bed_temp', 'Minimum bed temperature'],
            ['max_bed_temp', 'Maximum bed temperature'],
            ['drying_temp', 'Drying temperature'],
            ['drying_time', 'Drying time'],
            ['td', 'Transmission distance'],
            ['mfg_date', 'Manufacturing date'],
            ['tag_message', 'Tag message'],
            ['tag_material_name', 'TigerTag SDK material label'],
            ['tag_aspects', 'Tag aspects'],
            ['tag_product_type', 'Tag product type'],
            ['tag_color_alpha', 'Tag color alpha'],
            ['tag_format', 'RFID payload format'],
            ['tag_hardware', 'RFID tag hardware']
        ];
        extraFields.forEach(function (definition) {
            var key = definition[0];
            var value = metadata[key];
            if (isEmptyValue(value)) return;
            rows.push(syncRow('extra', key, definition[1], value, extra[key], schemaByKey[key]));
        });

        if (!rows.length) {
            return { ok: false, errors: ['The current tag has no supported metadata to sync'], rows: [] };
        }
        return {
            ok: true,
            errors: [],
            spoolId: spool.id,
            filamentId: filament.id,
            rows: rows
        };
    }

    function syncRowSelected(selected, row) {
        if (typeof selected === 'function') return !!selected(row);
        if (typeof Set !== 'undefined' && selected instanceof Set) return selected.has(row.id);
        if (Array.isArray(selected)) return selected.indexOf(row.id) !== -1;
        return !!(selected && selected[row.id] === true);
    }

    function selectedSyncRows(plan, selected) {
        if (!plan || plan.ok !== true || !Array.isArray(plan.rows)) return [];
        return plan.rows.filter(function (row) {
            return row.selectable && syncRowSelected(selected, row);
        });
    }

    function buildFilamentPatch(plan, selected, allowConflicts) {
        if (!plan || plan.ok !== true) throw new Error('Cannot sync an invalid metadata plan');
        var rows = selectedSyncRows(plan, selected);
        if (!rows.length) throw new Error('Select at least one metadata field to sync');
        if (!allowConflicts && rows.some(function (row) { return row.conflict; })) {
            throw new Error('Conflicting non-empty Spoolman values require explicit confirmation');
        }

        var patch = {};
        var extra = {};
        rows.forEach(function (row) {
            if (row.key === 'card_uids' || row.key === 'rfid_uid') {
                throw new Error('UID ownership fields are managed by SpoolLink');
            }
            if (row.kind === 'extra') extra[row.key] = JSON.stringify(row.value);
            else patch[row.key] = row.value;
        });
        if (Object.keys(extra).length) patch.extra = extra;
        return { filamentId: plan.filamentId, patch: patch, rows: rows };
    }

    function verifyFilamentPatch(plan, selected, spool) {
        var rows = selectedSyncRows(plan, selected);
        var filament = spool && spool.filament;
        if (!isObject(filament)) {
            return { ok: false, verified: [], mismatches: rows.map(function (row) { return row.id; }) };
        }
        var extra = isObject(filament.extra) ? filament.extra : {};
        var verified = [];
        var mismatches = [];
        rows.forEach(function (row) {
            var actual = row.kind === 'extra' ? extra[row.key] : filament[row.key];
            if (valuesEqual(row.key, actual, row.value)) verified.push(row.id);
            else mismatches.push(row.id);
        });
        return { ok: mismatches.length === 0 && rows.length > 0, verified: verified, mismatches: mismatches };
    }

    return Object.freeze({
        CORE_FIELDS: CORE_FIELDS,
        OPTIONAL_FIELDS: OPTIONAL_FIELDS,
        LEGACY_FIELDS: LEGACY_FIELDS,
        decodeFieldType: decodeFieldType,
        normalizeSchemaEntry: normalizeSchemaEntry,
        indexEntitySchemas: indexEntitySchemas,
        classifyField: classifyField,
        buildFieldStatus: buildFieldStatus,
        getSelectedMissingOptionalFields: getSelectedMissingOptionalFields,
        decodeExtraValue: decodeExtraValue,
        tagMetadata: tagMetadata,
        valuesEqual: valuesEqual,
        buildMetadataSyncPlan: buildMetadataSyncPlan,
        selectedSyncRows: selectedSyncRows,
        buildFilamentPatch: buildFilamentPatch,
        verifyFilamentPatch: verifyFilamentPatch
    });
}));
