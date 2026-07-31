'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.resolve(
    __dirname,
    '../../overlays/firmware-extended/68-app-filament-ui/root/usr/local/filament-ui/html/spoolman-rfid-fields.js'
);
const fields = require(modulePath);

function manifestShape(definitions) {
    return definitions.map(({ entity, key, type }) => ({ entity, key, type }));
}

test('exports the exact core, optional, and legacy manifests', () => {
    assert.deepEqual(manifestShape(fields.CORE_FIELDS), [
        { entity: 'spool', key: 'card_uids', type: 'text' },
        { entity: 'filament', key: 'variant', type: 'text' }
    ]);
    assert.deepEqual(manifestShape(fields.OPTIONAL_FIELDS), [
        { entity: 'filament', key: 'min_extruder_temp', type: 'integer' },
        { entity: 'filament', key: 'max_extruder_temp', type: 'integer' },
        { entity: 'filament', key: 'min_bed_temp', type: 'integer' },
        { entity: 'filament', key: 'max_bed_temp', type: 'integer' },
        { entity: 'filament', key: 'drying_temp', type: 'integer' },
        { entity: 'filament', key: 'drying_time', type: 'integer' },
        { entity: 'filament', key: 'td', type: 'number' },
        { entity: 'filament', key: 'mfg_date', type: 'text' },
        { entity: 'filament', key: 'tag_message', type: 'text' },
        { entity: 'filament', key: 'tag_material_name', type: 'text' },
        { entity: 'filament', key: 'tag_aspects', type: 'text' },
        { entity: 'filament', key: 'tag_product_type', type: 'text' },
        { entity: 'filament', key: 'tag_color_alpha', type: 'integer' },
        { entity: 'filament', key: 'tag_format', type: 'text' },
        { entity: 'filament', key: 'tag_hardware', type: 'text' }
    ]);
    assert.deepEqual(manifestShape(fields.LEGACY_FIELDS), [
        { entity: 'spool', key: 'rfid_uid', type: 'text' },
        { entity: 'filament', key: 'modifiers', type: 'text' }
    ]);
    assert.equal(fields.OPTIONAL_FIELDS.find(field => field.key === 'td').field_type, 'float');
});

test('UMD build exposes the same API as a browser global', () => {
    const context = { self: {} };
    vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context);

    assert.equal(typeof context.self.SpoolmanRfidFields.buildFieldStatus, 'function');
    assert.equal(context.self.SpoolmanRfidFields.OPTIONAL_FIELDS.length, 15);
});

test('decodeFieldType accepts Spoolman field shapes and safe aliases', () => {
    assert.equal(fields.decodeFieldType(' Integer '), 'integer');
    assert.equal(fields.decodeFieldType({ field_type: 'number' }), 'number');
    assert.equal(fields.decodeFieldType({ fieldType: 'text' }), 'text');
    assert.equal(fields.decodeFieldType({ schema: { type: 'float' } }), 'number');
    assert.equal(fields.decodeFieldType('{"field_type":"string"}'), 'text');
    assert.equal(fields.decodeFieldType('"integer"'), 'integer');
    assert.equal(fields.decodeFieldType({}), null);
    assert.equal(fields.decodeFieldType(null), null);
});

test('buildFieldStatus marks an empty schema as missing without mutating manifests', () => {
    const rows = fields.buildFieldStatus({ spool: [], filament: [] });

    assert.equal(rows.length, 19);
    assert.ok(rows.every(row => row.status === 'Missing'));
    assert.ok(rows.filter(row => row.selectable).every(row => row.group === 'optional'));
    assert.equal(rows.filter(row => row.selectable).length, 15);
    assert.ok(Object.isFrozen(fields.CORE_FIELDS));
    assert.ok(Object.isFrozen(fields.CORE_FIELDS[0]));
});

test('buildFieldStatus distinguishes ready, legacy, and type mismatch fields', () => {
    const rows = fields.buildFieldStatus({
        spool: {
            fields: [
                { key: 'card_uids', field_type: 'text' },
                { key: 'rfid_uid', field_type: 'text' }
            ]
        },
        filament: {
            result: {
                fields: [
                    { key: 'variant', fieldType: 'string' },
                    { key: 'min_extruder_temp', field_type: 'integer' },
                    { key: 'max_extruder_temp', field_type: 'text' },
                    { key: 'modifiers', field_type: 'text' }
                ]
            }
        }
    });
    const byKey = Object.fromEntries(rows.map(row => [`${row.entity}.${row.key}`, row]));

    assert.equal(byKey['spool.card_uids'].status, 'Ready');
    assert.equal(byKey['filament.variant'].status, 'Ready');
    assert.equal(byKey['filament.min_extruder_temp'].status, 'Ready');
    assert.equal(byKey['filament.max_extruder_temp'].status, 'Type mismatch');
    assert.equal(byKey['filament.max_extruder_temp'].actualType, 'text');
    assert.equal(byKey['filament.max_extruder_temp'].selectable, false);
    assert.equal(byKey['spool.rfid_uid'].status, 'Legacy');
    assert.equal(byKey['filament.modifiers'].status, 'Legacy');
    assert.equal(byKey['filament.td'].status, 'Missing');
});

test('flat entity-tagged schema arrays are classified', () => {
    const rows = fields.buildFieldStatus([
        { entity_type: 'spool', key: 'card_uids', field_type: 'text' },
        { entity: 'filament', key: 'td', data_type: 'decimal' }
    ]);

    assert.equal(rows.find(row => row.key === 'card_uids').status, 'Ready');
    assert.equal(rows.find(row => row.key === 'td').status, 'Ready');
});

test('classifyField is available for individual schema refreshes', () => {
    const optional = fields.OPTIONAL_FIELDS.find(definition => definition.key === 'td');
    const legacy = fields.LEGACY_FIELDS.find(definition => definition.key === 'rfid_uid');

    assert.equal(fields.classifyField(optional, null).status, 'Missing');
    assert.equal(fields.classifyField(optional, { key: 'td', field_type: 'number' }).status, 'Ready');
    assert.equal(fields.classifyField(optional, { key: 'td', field_type: 'text' }).status, 'Type mismatch');
    assert.equal(fields.classifyField(legacy, { key: 'rfid_uid', field_type: 'text' }).status, 'Legacy');
});

test('selected helper returns only checked missing optional definitions', () => {
    const rows = fields.buildFieldStatus({
        spool: [
            { key: 'card_uids', field_type: 'text' },
            { key: 'rfid_uid', field_type: 'text' }
        ],
        filament: [
            { key: 'variant', field_type: 'text' },
            { key: 'max_extruder_temp', field_type: 'integer' },
            { key: 'min_bed_temp', field_type: 'text' }
        ]
    });
    const selected = {
        'spool.card_uids': true,
        'spool.rfid_uid': true,
        'filament.min_extruder_temp': true,
        'filament.max_extruder_temp': true,
        'filament.min_bed_temp': true,
        'filament.td': false,
        'filament.tag_message': true
    };

    assert.deepEqual(
        fields.getSelectedMissingOptionalFields(rows, selected).map(definition => definition.key),
        ['min_extruder_temp', 'tag_message']
    );
});

test('selected helper accepts sets, arrays, and predicates', () => {
    const rows = fields.buildFieldStatus({});

    assert.deepEqual(
        fields.getSelectedMissingOptionalFields(rows, new Set(['filament.td'])).map(field => field.key),
        ['td']
    );
    assert.deepEqual(
        fields.getSelectedMissingOptionalFields(rows, ['mfg_date']).map(field => field.key),
        ['mfg_date']
    );
    assert.deepEqual(
        fields.getSelectedMissingOptionalFields(rows, row => row.key === 'tag_aspects').map(field => field.key),
        ['tag_aspects']
    );
});

function readySchema() {
    return fields.buildFieldStatus({
        spool: [{ key: 'card_uids', field_type: 'text' }],
        filament: [
            { key: 'variant', field_type: 'text' },
            ...fields.OPTIONAL_FIELDS.map(definition => ({
                key: definition.key,
                field_type: definition.field_type
            }))
        ]
    });
}

function richTigerTag() {
    const tagFields = {
        message: 'Ocean blue',
        colors_rgba_hex: ['11223380', '445566FF'],
        diameter_mm: 1.75,
        hotend_min_temp_c: 205,
        hotend_max_temp_c: 225,
        bed_temp_min_c: 55,
        bed_temp_max_c: 65,
        drying_temp_c: 50,
        drying_time_hours: 6,
        td_mm: 0.42,
        manufacturing_date: '2026-07-30',
        material_name: 'PLA Marble',
        modifiers: ['Silk', 'Matte']
    };
    return {
        tagFormat: 'tigertag',
        fields: tagFields,
        presentFields: Object.keys(tagFields),
        formatData: {
            material: { id: 9456, label: 'PLA Marble' },
            product_type: { id: 142, label: 'Filament' }
        }
    };
}

function spoolWithFilament(overrides = {}) {
    return {
        id: 17,
        filament: {
            id: 23,
            name: '',
            color_hex: null,
            multi_color_hexes: null,
            diameter: null,
            settings_extruder_temp: null,
            settings_bed_temp: null,
            extra: {},
            ...overrides
        }
    };
}

test('metadata plan maps rich tag fields to native fields and registered extras', () => {
    const plan = fields.buildMetadataSyncPlan(
        richTigerTag(),
        { hardwareType: 'ultralight' },
        spoolWithFilament(),
        readySchema()
    );
    const byId = Object.fromEntries(plan.rows.map(row => [row.id, row]));

    assert.equal(plan.ok, true);
    assert.equal(plan.spoolId, 17);
    assert.equal(plan.filamentId, 23);
    assert.equal(byId['filament.name'].value, 'Ocean blue');
    assert.equal(byId['filament.color_hex'].value, '112233');
    assert.equal(byId['filament.multi_color_hexes'].value, '112233,445566');
    assert.equal(byId['filament.diameter'].value, 1.75);
    assert.equal(byId['filament.settings_extruder_temp'].value, 225);
    assert.equal(byId['filament.settings_bed_temp'].value, 55);
    assert.equal(byId['filament.extra.min_extruder_temp'].value, 205);
    assert.equal(byId['filament.extra.max_bed_temp'].value, 65);
    assert.equal(byId['filament.extra.drying_time'].value, 6);
    assert.equal(byId['filament.extra.td'].value, 0.42);
    assert.equal(byId['filament.extra.mfg_date'].value, '2026-07-30');
    assert.equal(byId['filament.extra.tag_message'].value, 'Ocean blue');
    assert.equal(byId['filament.extra.tag_material_name'].value, 'PLA Marble');
    assert.equal(byId['filament.extra.tag_aspects'].value, 'Silk, Matte');
    assert.equal(byId['filament.extra.tag_product_type'].value, 'Filament');
    assert.equal(byId['filament.extra.tag_color_alpha'].value, 128);
    assert.equal(byId['filament.extra.tag_format'].value, 'tigertag');
    assert.equal(byId['filament.extra.tag_hardware'].value, 'ultralight');
    assert.ok(plan.rows.every(row => row.state === 'add'));
    assert.ok(plan.rows.every(row => row.selectedByDefault));
});

test('metadata plan blocks unregistered extras and defaults conflicts to unchecked', () => {
    const schema = fields.buildFieldStatus({
        filament: [{ key: 'tag_message', field_type: 'text' }]
    });
    const plan = fields.buildMetadataSyncPlan(
        richTigerTag(),
        { hardwareType: 'ultralight' },
        spoolWithFilament({
            name: 'Existing catalog name',
            diameter: 2.85,
            extra: { tag_message: JSON.stringify('Existing message') }
        }),
        schema
    );
    const byId = Object.fromEntries(plan.rows.map(row => [row.id, row]));

    assert.equal(byId['filament.name'].state, 'conflict');
    assert.equal(byId['filament.name'].selectedByDefault, false);
    assert.equal(byId['filament.diameter'].state, 'conflict');
    assert.equal(byId['filament.extra.tag_message'].state, 'conflict');
    assert.equal(byId['filament.extra.td'].state, 'blocked');
    assert.match(byId['filament.extra.td'].note, /not registered/i);
    assert.equal(byId['filament.extra.td'].selectable, false);
});

test('semantic comparison decodes Spoolman extras and normalizes colors and numbers', () => {
    assert.equal(fields.valuesEqual('tag_message', JSON.stringify('Ocean blue'), 'Ocean blue'), true);
    assert.equal(fields.valuesEqual('td', '0.420', 0.42), true);
    assert.equal(fields.valuesEqual('color_hex', '#aabbcc', 'AABBCC'), true);
    assert.equal(fields.valuesEqual('multi_color_hexes', '#112233, 445566', '112233,445566'), true);

    const plan = fields.buildMetadataSyncPlan(
        richTigerTag(),
        { hardwareType: 'ultralight' },
        spoolWithFilament({
            name: 'Ocean blue',
            color_hex: '#112233',
            multi_color_hexes: '112233, 445566',
            diameter: '1.750',
            settings_extruder_temp: 225,
            settings_bed_temp: 55,
            extra: {
                tag_message: JSON.stringify('Ocean blue'),
                td: JSON.stringify(0.42),
                tag_format: JSON.stringify('tigertag'),
                tag_hardware: JSON.stringify('ultralight')
            }
        }),
        readySchema()
    );

    assert.equal(plan.rows.find(row => row.id === 'filament.name').state, 'same');
    assert.equal(plan.rows.find(row => row.id === 'filament.color_hex').state, 'same');
    assert.equal(plan.rows.find(row => row.id === 'filament.multi_color_hexes').state, 'same');
    assert.equal(plan.rows.find(row => row.id === 'filament.extra.td').state, 'same');
});

test('patch builder writes only approved fields and never UID ownership', () => {
    const plan = fields.buildMetadataSyncPlan(
        richTigerTag(),
        { hardwareType: 'ultralight' },
        spoolWithFilament(),
        readySchema()
    );
    const selected = new Set([
        'filament.color_hex',
        'filament.multi_color_hexes',
        'filament.extra.td',
        'filament.extra.tag_message',
        'filament.extra.tag_format'
    ]);
    const built = fields.buildFilamentPatch(plan, selected, false);

    assert.deepEqual(built.patch, {
        color_hex: '112233',
        multi_color_hexes: '112233,445566',
        extra: {
            td: JSON.stringify(0.42),
            tag_message: JSON.stringify('Ocean blue'),
            tag_format: JSON.stringify('tigertag')
        }
    });
    assert.equal('card_uids' in built.patch, false);
    assert.equal('rfid_uid' in built.patch, false);
    assert.equal('card_uids' in built.patch.extra, false);
    assert.equal('rfid_uid' in built.patch.extra, false);
});

test('conflicting values require explicit patch confirmation', () => {
    const plan = fields.buildMetadataSyncPlan(
        richTigerTag(),
        { hardwareType: 'ultralight' },
        spoolWithFilament({ name: 'Existing name' }),
        readySchema()
    );
    const selected = new Set(['filament.name']);

    assert.throws(
        () => fields.buildFilamentPatch(plan, selected, false),
        /explicit confirmation/
    );
    assert.deepEqual(fields.buildFilamentPatch(plan, selected, true).patch, {
        name: 'Ocean blue'
    });
});

test('single-color sync previews clearing stale multicolor only as a conflict', () => {
    const decoded = richTigerTag();
    decoded.fields.colors_rgba_hex = ['ABCDEF40'];
    const plan = fields.buildMetadataSyncPlan(
        decoded,
        { hardwareType: 'ultralight' },
        spoolWithFilament({ multi_color_hexes: '111111,222222' }),
        readySchema()
    );
    const row = plan.rows.find(candidate => candidate.id === 'filament.multi_color_hexes');

    assert.equal(row.value, null);
    assert.equal(row.state, 'conflict');
    assert.equal(row.selectedByDefault, false);
    assert.deepEqual(
        fields.buildFilamentPatch(plan, new Set([row.id]), true).patch,
        { multi_color_hexes: null }
    );
});

test('sentinel and zero-valued placeholder metadata is not proposed', () => {
    const decoded = {
        tagFormat: 'unknown',
        fields: {
            diameter_mm: 0,
            hotend_min_temp_c: 0,
            drying_time_hours: 0,
            td_mm: 0,
            manufacturing_date: '0001-01-01'
        },
        presentFields: [
            'diameter_mm', 'hotend_min_temp_c', 'drying_time_hours',
            'td_mm', 'manufacturing_date'
        ],
        formatData: {}
    };
    const plan = fields.buildMetadataSyncPlan(
        decoded,
        { hardwareType: 'unknown' },
        spoolWithFilament(),
        readySchema()
    );

    assert.equal(plan.ok, false);
    assert.match(plan.errors[0], /no supported metadata/i);
});

test('sync plan fails closed when scan, spool, or schema is missing', () => {
    assert.equal(fields.buildMetadataSyncPlan(null, {}, spoolWithFilament(), readySchema()).ok, false);
    assert.equal(fields.buildMetadataSyncPlan(richTigerTag(), {}, null, readySchema()).ok, false);
    assert.equal(fields.buildMetadataSyncPlan(richTigerTag(), {}, spoolWithFilament(), []).ok, false);
});

test('post-PATCH verification checks every selected native and extra value', () => {
    const plan = fields.buildMetadataSyncPlan(
        richTigerTag(),
        { hardwareType: 'ultralight' },
        spoolWithFilament(),
        readySchema()
    );
    const selected = new Set(['filament.diameter', 'filament.extra.td']);
    const updated = spoolWithFilament({
        diameter: 1.75,
        extra: { td: JSON.stringify(0.42) }
    });

    assert.deepEqual(fields.verifyFilamentPatch(plan, selected, updated), {
        ok: true,
        verified: ['filament.diameter', 'filament.extra.td'],
        mismatches: []
    });
    updated.filament.extra.td = JSON.stringify(0.5);
    assert.deepEqual(
        fields.verifyFilamentPatch(plan, selected, updated).mismatches,
        ['filament.extra.td']
    );
});
