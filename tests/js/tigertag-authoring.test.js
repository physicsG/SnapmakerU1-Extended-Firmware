'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TigerTagAuthoring = require('../../overlays/firmware-extended/68-app-filament-ui/root/usr/local/filament-ui/html/tigertag-authoring.js');

const options = {
    materials: [{ id: 38219, label: 'PLA' }],
    brands: [{ id: 65535, label: 'Generic' }, { id: 42, label: 'Example' }],
    aspects: [
        { id: 0, label: '-', color_count: 0 },
        { id: 104, label: 'Basic', color_count: 1 },
        { id: 252, label: 'Bicolor', color_count: 2 },
    ],
    types: [{ id: 142, label: 'Filament' }],
    diameters: [{ id: 56, label: '1.75' }],
    units: [{ id: 21, label: 'g', type: 'weight' }],
};

function validDraft() {
    return {
        inventoryName: 'PLA black inventory name',
        material: 'PLA',
        brand: 'Example',
        aspect1: 'Bicolor',
        aspect2: '-',
        productType: 'Filament',
        diameter: '1.75',
        colors: ['112233', '445566'],
        storedColors: ['112233', '445566', 'AABBCC'],
        primaryColorAlpha: 0x7F,
        measure: 1000,
        measureAvailable: 750,
        unit: 'g',
        nozzleMin: 190,
        nozzleMax: 230,
        dryTemp: 50,
        dryTime: 8,
        bedMin: 45,
        bedMax: 60,
        manufacturingDate: '2026-07-31',
        tdMm: 4.2,
        message: 'Workshop spool',
    };
}

test('UTF-8 length counts code points as bytes, not JavaScript characters', () => {
    assert.equal(TigerTagAuthoring.utf8ByteLength('abc'), 3);
    assert.equal(TigerTagAuthoring.utf8ByteLength('é'), 2);
    assert.equal(TigerTagAuthoring.utf8ByteLength('😀'), 4);
    assert.equal(TigerTagAuthoring.utf8ByteLength('😀'.repeat(7)), 28);
});

test('valid draft resolves official registry IDs and preserves all fields', () => {
    const result = TigerTagAuthoring.validateDraft(validDraft(), options);
    assert.equal(result.ok, true);
    assert.equal(result.inventoryName, 'PLA black inventory name');
    assert.deepEqual(result.spec, {
        product_id: 0xFFFFFFFF,
        material: 38219,
        brand: 42,
        aspect_1: 252,
        aspect_2: 0,
        type: 142,
        diameter: 56,
        colors: ['#1122337F', '#445566', '#AABBCC'],
        measure: 1000,
        measure_available: 750,
        unit: 21,
        temp_min_c: 190,
        temp_max_c: 230,
        dry_temp_c: 50,
        dry_time_h: 8,
        bed_temp_min_c: 45,
        bed_temp_max_c: 60,
        td_mm: 4.2,
        message: 'Workshop spool',
        manufacturing_date: '2026-07-31',
    });
    assert.equal(result.activeColorCount, 2);
    assert.deepEqual(result.storedColors, ['112233', '445566', 'AABBCC']);
});

test('validation rejects overlong UTF-8, unknown registry values, and ranges', () => {
    const draft = validDraft();
    draft.message = '😀'.repeat(8);
    draft.material = 'Not in registry';
    draft.colors = ['nope'];
    draft.primaryColorAlpha = 300;
    draft.tdMm = 0.5;
    draft.dryTemp = 300;
    const result = TigerTagAuthoring.validateDraft(draft, options);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('32 UTF-8 bytes')));
    assert.ok(result.errors.some(error => error.includes('material')));
    assert.ok(result.errors.some(error => error.includes('RGB color')));
    assert.ok(result.errors.some(error => error.includes('Primary alpha')));
    assert.ok(result.errors.some(error => error.includes('Transmission distance')));
    assert.ok(result.errors.some(error => error.includes('Drying temperature')));
});

test('spool prefill keeps inventory name separate from tag message', () => {
    const spool = {
        remaining_weight: 640,
        filament: {
            name: 'Inventory Name',
            material: 'PLA',
            vendor: { name: 'Example' },
            diameter: 1.75,
            weight: 1000,
            color_hex: '112233',
            multi_color_hexes: '112233,445566',
            settings_extruder_temp: 225,
            settings_bed_temp: 55,
            extra: {
                variant: '"Basic"',
                tag_material_name: '"PLA"',
                min_extruder_temp: '"190"',
                tag_message: '"On-tag note"',
                td: '"4.2"',
            },
        },
    };
    const draft = TigerTagAuthoring.draftFromSpool(spool, false);
    assert.equal(draft.inventoryName, 'Inventory Name');
    assert.equal(draft.material, 'PLA');
    assert.equal(draft.message, 'On-tag note');
    assert.deepEqual(draft.colors, ['112233', '445566']);
    assert.deepEqual(draft.storedColors, ['112233', '445566', '000000']);
    assert.equal(draft.primaryColorAlpha, 255);
    assert.equal(draft.measureAvailable, 640);
    assert.equal(draft.nozzleMin, 190);

    delete spool.filament.extra.tag_message;
    assert.equal(TigerTagAuthoring.draftFromSpool(spool, false).message, '');
    assert.equal(TigerTagAuthoring.draftFromSpool(spool, true).message, 'Inventory Name');
});

test('tag prefill preserves raw IDs, all colors, available quantity, message, and TD', () => {
    const channel = {
        decoded: {
            fields: {
                type: 'PLA', manufacturer: 'Example', modifiers: ['Bicolor'],
                colors_rgba_hex: ['112233FF', '445566FF'], diameter_mm: 1.75,
                weight_grams: 1000, available_quantity: 700, quantity_unit: 'g',
                hotend_min_temp_c: 190, hotend_max_temp_c: 230,
                bed_temp_min_c: 45, bed_temp_max_c: 60,
                drying_temp_c: 50, drying_time_hours: 8,
                manufacturing_date: '2026-07-31', td_mm: 4.2, message: 'Demo',
            },
            formatData: {
                variant: 'maker',
                aspects: [{ id: 252, label: 'Bicolor', color_count: 2 }, { id: 0, label: '-', color_count: 0 }],
                raw: {
                id_material: 38219, id_brand: 42, id_aspect1: 252, id_aspect2: 0,
                id_type: 142, id_diameter: 56, measure: 1000,
                measure_available: 700, id_unit: 21,
                color_r: 0x11, color_g: 0x22, color_b: 0x33, color_a: 0x47,
                color_r2: 0x44, color_g2: 0x55, color_b2: 0x66,
                color_r3: 0x44, color_g3: 0x55, color_b3: 0x66,
                timestamp: 0x12345678, td_raw: 42, message: 'Demo',
            } },
        },
    };
    const draft = TigerTagAuthoring.draftFromTag(channel);
    assert.equal(draft.material, 38219);
    assert.equal(draft.aspect1, 252);
    assert.deepEqual(draft.colors, ['112233', '445566']);
    assert.deepEqual(draft.storedColors, ['112233', '445566', '445566']);
    assert.equal(draft.primaryColorAlpha, 0x47);
    assert.equal(draft.timestamp, 0x12345678);
    assert.equal(draft.measureAvailable, 700);
    assert.equal(draft.message, 'Demo');
    assert.equal(draft.tdMm, 4.2);
});

test('tag prefill accepts overview color encodings and old spools raw names', () => {
    const channel = {
        decoded: {
            fields: {
                type: 'PLA', manufacturer: 'Example', modifiers: ['Bicolor'],
                colors_rgba: [0x11223380, 0x445566FF], diameter_mm: 1.75,
                weight_grams: 1000, available_weight_grams: 650, quantity_unit: 'g',
                hotend_min_temp_c: 190, hotend_max_temp_c: 230,
                bed_temp_min_c: 45, bed_temp_max_c: 60,
                drying_temp_c: 50, drying_time_hours: 8,
                manufacturing_date: '2026-07-31', message: 'Overview mapped',
            },
            formatData: {
                variant: 'maker',
                product_type: { id: 142, label: 'Filament' },
                material: { id: 38219, label: 'PLA' },
                aspects: [{ id: 252, label: 'Bicolor', color_count: 2 }, { id: 0, label: '-', color_count: 0 }],
                raw: {
                    materialId: 38219, brandId: 42, aspect1Id: 252, aspect2Id: 0,
                    typeId: 142, diameterId: 56, measure: 1000,
                    measure_available: 650, id_unit: 21,
                    timestamp: 0x12345678, tdRaw: 42,
                },
            },
        },
    };
    const draft = TigerTagAuthoring.draftFromTag(channel);
    assert.equal(draft.material, 38219);
    assert.equal(draft.brand, 42);
    assert.equal(draft.aspect1, 252);
    assert.equal(draft.productType, 142);
    assert.equal(draft.diameter, 56);
    assert.deepEqual(draft.colors, ['112233', '445566']);
    assert.deepEqual(draft.storedColors, ['112233', '445566', '000000']);
    assert.equal(draft.primaryColorAlpha, 0x80);
    assert.equal(draft.measureAvailable, 650);
    assert.equal(draft.tdMm, 4.2);
});
test('unchanged tag draft keeps raw alpha, dormant colors, and timestamp in the encoder spec', () => {
    const channel = {
        tag_format: 'tigertag',
        decoded: {
            fields: {
                type: 'PLA', manufacturer: 'Example', modifiers: ['Basic'],
                colors_rgba_hex: ['1020304A'], diameter_mm: 1.75,
                weight_grams: 1000, available_quantity: 900, quantity_unit: 'g',
                hotend_min_temp_c: 190, hotend_max_temp_c: 230,
                bed_temp_min_c: 45, bed_temp_max_c: 60,
                drying_temp_c: 50, drying_time_hours: 8,
                manufacturing_date: '2024-03-26', td_mm: 4.2, message: 'Raw',
            },
            format_data: {
                variant: 'maker',
                aspects: [{ id: 104, label: 'Basic', color_count: 1 }, { id: 0, label: '-', color_count: 0 }],
                raw: {
                    id_tigertag: 0x5BF59264, id_product: 0xFFFFFFFF,
                    id_material: 38219, id_brand: 42, id_aspect1: 104, id_aspect2: 0,
                    id_type: 142, id_diameter: 56,
                    color_r: 0x10, color_g: 0x20, color_b: 0x30, color_a: 0x4A,
                    color_r2: 0xAA, color_g2: 0xBB, color_b2: 0xCC,
                    color_r3: 0xAA, color_g3: 0xBB, color_b3: 0xCC,
                    measure: 1000, measure_available: 900, id_unit: 21,
                    nozzle_min: 190, nozzle_max: 230, dry_temp: 50, dry_time: 8,
                    bed_min: 45, bed_max: 60, timestamp: 0x2D94CC80,
                    td_raw: 42, message: 'Raw',
                },
            },
        },
    };
    const draft = TigerTagAuthoring.draftFromTag(channel);
    const result = TigerTagAuthoring.validateDraft(draft, options);

    assert.equal(result.ok, true);
    assert.deepEqual(draft.colors, ['102030']);
    assert.deepEqual(draft.storedColors, ['102030', 'AABBCC', 'AABBCC']);
    assert.deepEqual(result.spec.colors, ['#1020304A', '#AABBCC', '#AABBCC']);
    assert.equal(result.spec.timestamp, 0x2D94CC80);
    assert.equal('manufacturing_date' in result.spec, false);
});

test('write and clear requests bind the reviewed seven-byte UID and format', () => {
    const write = TigerTagAuthoring.writeRequest(
        2, '04:A1:B2:C3:D4:E5:F6', { material: 38219 }, true
    );
    assert.deepEqual(write, {
        slot: 2,
        expected_uid: '04A1B2C3D4E5F6',
        expected_format: 'tigertag',
        spec: { material: 38219 },
        allow_unrecognized: true,
    });
    assert.deepEqual(TigerTagAuthoring.clearRequest(2, '04A1B2C3D4E5F6', false), {
        slot: 2,
        expected_uid: '04A1B2C3D4E5F6',
        expected_format: 'tigertag',
        allow_unrecognized: false,
    });
    assert.deepEqual(TigerTagAuthoring.writeRequest(
        2, '04A1B2C3D4E5F6', { material: 38219 }, false, true
    ), {
        slot: 2,
        expected_uid: '04A1B2C3D4E5F6',
        expected_format: 'tigertag',
        spec: { material: 38219 },
        allow_unrecognized: false,
        allow_legacy_migration: true,
    });
    const payloadRequest = TigerTagAuthoring.writePayloadRequest(
        2, '04A1B2C3D4E5F6', 'ab'.repeat(80), false, true
    );
    assert.equal(payloadRequest.data_hex, 'AB'.repeat(80));
    assert.equal('spec' in payloadRequest, false);
    assert.equal(payloadRequest.allow_legacy_migration, true);
    assert.throws(
        () => TigerTagAuthoring.writePayloadRequest(
            2, '04A1B2C3D4E5F6', 'ABCD', false, false
        ),
        /80-byte/
    );
    assert.throws(
        () => TigerTagAuthoring.writeRequest(2, '04A1B2C3D4E5F6', {}, true, true),
        /mutually exclusive/
    );
    assert.throws(() => TigerTagAuthoring.writeRequest(0, 'AABBCCDD', {}, false), /7-byte/);
});

test('authoring gate permits Maker and separately confirmed exact legacy migration', () => {
    const api = {
        write_enabled: true,
        write_allowed: true,
        allow_unrecognized_write: false,
        allow_legacy_migration_write: true,
    };
    const channel = {
        tag_format: 'tigertag',
        physical: { uidHex: '04A1B2C3D4E5F6', hardwareType: 'ultralight' },
        openRfidCapabilities: { tigertag_write: {
            supported: true,
            busy: false,
            allow_legacy_migration_supported: true,
        } },
        decoded: { formatData: {
            variant: 'maker',
            raw: { id_tigertag: 0x5BF59264, id_product: 0xFFFFFFFF },
        } },
    };
    assert.equal(TigerTagAuthoring.authoringGate(api, channel, false).ok, true);

    channel.decoded.formatData.variant = 'Basic';
    channel.decoded.formatData.raw = { id_tigertag: 0x5BF59264, id_product: 0xFFFFFFFF };
    assert.equal(TigerTagAuthoring.authoringGate(api, channel, false).ok, true);

    channel.decoded.formatData.variant = 'plus';
    channel.decoded.formatData.raw = { id_tigertag: 0xBC0FCB97, id_product: 123 };
    assert.ok(TigerTagAuthoring.authoringGate(api, channel, false).reasons
        .some(reason => reason.includes('TigerTag+')));

    channel.decoded.formatData.raw = { id_tigertag: 0xBC0FCB97, id_product: 0 };
    assert.equal(TigerTagAuthoring.protectedTigerTag(channel), true);

    channel.decoded.formatData.variant = 'legacy_openrfid_v1';
    assert.equal(TigerTagAuthoring.migratableLegacyTag(channel), true);
    assert.equal(TigerTagAuthoring.protectedTigerTag(channel), false);
    assert.equal(TigerTagAuthoring.authoringGate(api, channel, false, false).ok, false);
    assert.equal(TigerTagAuthoring.authoringGate(api, channel, false, true).ok, true);

    channel.decoded.formatData.variant = 'legacy_unsigned_plus';
    assert.equal(TigerTagAuthoring.migratableLegacyTag(channel), false);
    assert.equal(TigerTagAuthoring.protectedTigerTag(channel), true);

    channel.decoded.formatData.variant = 'legacy_openrfid_v2';
    assert.equal(TigerTagAuthoring.authoringGate(api, channel, false).ok, false);

    api.write_allowed = false;
    api.write_block = { error: 'Print is active' };
    assert.ok(TigerTagAuthoring.authoringGate(api, channel, false).reasons.includes('Print is active'));
});

test('non-TigerTag initialization requires both explicit UI and server permission', () => {
    const api = {
        write_enabled: true, write_allowed: true, allow_unrecognized_write: false,
    };
    const channel = {
        tag_format: 'unknown',
        physical: { uidHex: '04A1B2C3D4E5F6', hardwareType: 'ultralight' },
        openRfidCapabilities: { tigertag_write: { supported: true, busy: false } },
        decoded: null,
    };
    assert.equal(TigerTagAuthoring.authoringGate(api, channel, false).ok, false);
    assert.equal(TigerTagAuthoring.authoringGate(api, channel, true).ok, false);
    api.allow_unrecognized_write = true;
    assert.equal(TigerTagAuthoring.authoringGate(api, channel, true).ok, true);
});

test('verified rescan compares every written Maker field including dormant colors', () => {
    const spec = TigerTagAuthoring.validateDraft(validDraft(), options).spec;
    const timestamp = Math.floor((Date.parse(spec.manufacturing_date) - Date.UTC(2000, 0, 1)) / 1000);
    const channel = {
        tag_format: 'tigertag',
        decoded: { formatData: {
            variant: 'maker',
            raw: {
                id_tigertag: 0x5BF59264, id_product: 0xFFFFFFFF,
                id_material: 38219, id_aspect1: 252, id_aspect2: 0,
                id_type: 142, id_diameter: 56, id_brand: 42,
                color_r: 0x11, color_g: 0x22, color_b: 0x33, color_a: 0x7F,
                color_r2: 0x44, color_g2: 0x55, color_b2: 0x66,
                color_r3: 0xAA, color_g3: 0xBB, color_b3: 0xCC,
                measure: 1000, measure_available: 750, id_unit: 21,
                nozzle_min: 190, nozzle_max: 230, dry_temp: 50, dry_time: 8,
                bed_min: 45, bed_max: 60, timestamp, td_raw: 42,
                message: 'Workshop spool',
            },
        } },
    };
    assert.equal(TigerTagAuthoring.verifyRescan(channel, spec).ok, true);
    channel.decoded.formatData.raw.color_b3 = 0xCD;
    const failed = TigerTagAuthoring.verifyRescan(channel, spec);
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some(error => error.includes('color_b3')));
});
