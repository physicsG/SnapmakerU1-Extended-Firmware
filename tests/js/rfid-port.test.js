'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RfidPort = require('../../overlays/firmware-extended/68-app-filament-ui/root/usr/local/filament-ui/html/rfid-port.js');

function spool(id, overrides = {}) {
    const filament = Object.assign({
        name: '',
        material: '',
        vendor: { name: '' },
        color_hex: null,
        multi_color_hexes: null,
        external_id: null,
        extra: {},
    }, overrides.filament || {});
    return Object.assign({
        id,
        archived: false,
        lot_nr: null,
        extra: {},
        filament,
    }, overrides, { filament });
}

function ids(rows) {
    return rows.map(row => row.id);
}

test('normalizeUid canonicalizes byte arrays and separated strings', () => {
    assert.equal(RfidPort.normalizeUid([0x04, 0xa1, 0x0b, 0xff]), '04A10BFF');
    assert.equal(RfidPort.normalizeUid(new Uint8Array([0x04, 0xa1])), '04A1');
    assert.equal(RfidPort.normalizeUid('04:a1-0b ff'), '04A10BFF');
    assert.equal(RfidPort.normalizeUid('0x04_a1'), '04A1');
    assert.equal(RfidPort.normalizeUid([0, 0, 0, 0]), '');
    assert.equal(RfidPort.normalizeUid('ABC'), '');
    assert.equal(RfidPort.normalizeUid('04-zz'), '');
    assert.equal(RfidPort.normalizeUid(4012), '');
});

test('decodeExtra handles Spoolman JSON and double-serialized values', () => {
    assert.equal(RfidPort.decodeExtra('plain text'), 'plain text');
    assert.equal(RfidPort.decodeExtra('"Silk"'), 'Silk');
    assert.equal(RfidPort.decodeExtra('"\\"Silk\\""'), 'Silk');
    assert.equal(RfidPort.decodeExtra('0'), 0);
    assert.equal(RfidPort.decodeExtra('false'), false);
    assert.deepEqual(RfidPort.decodeExtra('["Silk","Matte"]'), ['Silk', 'Matte']);
});

test('format and hardware helpers keep payload format independent from technology', () => {
    assert.equal(RfidPort.formatFromFilament({ tag_format: 'tiger-tag' }), 'tigertag');
    assert.equal(RfidPort.formatFromFilament({ source_processor: 'bambu_lab_tag_processor' }), 'bambu');
    assert.equal(RfidPort.formatFromFilament({}, 'OpenSpool'), 'openspool');
    assert.equal(RfidPort.formatFromFilament({}, 'MifareUltralight'), 'unknown');
    assert.equal(RfidPort.formatLabel('tigertag'), 'TigerTag');
    assert.equal(RfidPort.formatLabel('spoolease'), 'SpoolEase');
    assert.equal(RfidPort.formatLabel('not-a-format'), 'Unknown');
    assert.equal(RfidPort.hardwareFrom('MifareUltralight', null), 'ultralight');
    assert.equal(RfidPort.hardwareFrom('NTAG215', null), 'ultralight');
    assert.equal(RfidPort.hardwareFrom(null, 'MIFARE Classic 1K'), 'mifare_classic');
    assert.equal(RfidPort.hardwareFrom(null, 7), 'unknown');
    assert.equal(RfidPort.hardwareLabel('ultralight'), 'Ultralight / NTAG');
    assert.equal(RfidPort.hardwareLabel('mifare_classic'), 'MIFARE Classic / M1');
    assert.equal(RfidPort.hardwareLabel('unknown'), 'Unknown');
    assert.equal(RfidPort.hardwareLabel(null), 'Unknown');
});

test('scan acceptance requires slot, UID identity, and fresh absence confirmation', () => {
    const previous = { event: 'tag_read', slot: 0, uid: '04A1', ts: 20 };
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'tag_read', slot: 0, uid: '04:A1', ts: 21 },
        [0x04, 0xA1],
        previous
    ), true);
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'tag_read', slot: 0, uid: '04A2', ts: 21 },
        '04A1',
        previous
    ), false);
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'tag_parse_error', slot: 0, uid: null, ts: 21 },
        '04A1',
        previous
    ), false);
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'tag_parse_error', slot: 0, uid: '04A1', ts: 21 },
        '04A1',
        previous
    ), true);
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'tag_not_present', slot: 0, uid: null, ts: 21 },
        '',
        previous
    ), true);
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'tag_not_present', slot: 0, uid: null, ts: 20 },
        '',
        previous
    ), false);
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'tag_not_present', slot: 0, uid: null, ts: 21 },
        '04A1',
        previous
    ), false);
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'tag_read', slot: 9, uid: '04A1', ts: 21 },
        '04A1',
        previous
    ), false);
    assert.equal(RfidPort.shouldAcceptScan(
        { event: 'unexpected', slot: 0, uid: '04A1', ts: 21 },
        '04A1',
        previous
    ), false);
});

test('normalizeDecoded preserves fields and honors explicit presence metadata', () => {
    const colors = [0xff112233, 0xff445566];
    const decoded = RfidPort.normalizeDecoded({
        source_processor: 'tigertag_tag_processor',
        unique_id: 'content-id',
        message: '',
        td: 0,
        colors,
        present_fields: ['message', 'td', 'message'],
        format_data: { product_id: 0xffffffff },
        authentication: { verification: 'unsigned', signed: false },
    });

    assert.equal(decoded.tagFormat, 'tigertag');
    assert.equal(decoded.sourceProcessor, 'tigertag_tag_processor');
    assert.deepEqual(decoded.fields.colors, colors);
    assert.equal(decoded.fields.td, 0);
    assert.equal(decoded.fields.message, '');
    assert.deepEqual(decoded.presentFields, ['message', 'td']);
    assert.deepEqual(decoded.formatData, { product_id: 0xffffffff });
    assert.deepEqual(decoded.authentication, { verification: 'unsigned', signed: false });
});

test('normalizeDecoded derives presence without dropping zero, false, or arrays', () => {
    const decoded = RfidPort.normalizeDecoded({
        source_processor: 'openspool_tag_processor',
        zero: 0,
        disabled: false,
        emptyText: '',
        missing: null,
        colors: [],
    });

    assert.ok(decoded.presentFields.includes('zero'));
    assert.ok(decoded.presentFields.includes('disabled'));
    assert.ok(decoded.presentFields.includes('colors'));
    assert.ok(!decoded.presentFields.includes('emptyText'));
    assert.ok(!decoded.presentFields.includes('missing'));
});

test('buildTagMatchContext normalizes decoded identity, variants, and every color', () => {
    const decoded = RfidPort.normalizeDecoded({
        manufacturer: '  Example Brand ',
        type: ' PLA ',
        message: ' Galaxy Black ',
        aspect_1: 'Silk',
        modifiers: ['Matte', 'Silk'],
        colors: [0xff112233, 0xffabcdef],
    }, 'tigertag');
    const context = RfidPort.buildTagMatchContext(decoded, '04:a1:b2:c3:d4:e5:f6');

    assert.deepEqual(context, {
        uid: '04A1B2C3D4E5F6',
        vendor: 'example brand',
        material: 'pla',
        materialName: '',
        variant: ['silk', 'matte'],
        message: 'galaxy black',
        colors: ['112233', 'ABCDEF'],
    });
});

test('TigerTag material_name distinguishes Marble and Wood while type stays base PLA', () => {
    const marbleContext = RfidPort.buildTagMatchContext(
        RfidPort.normalizeDecoded({
            type: 'PLA',
            material_name: 'PLA Marble',
            colors: [],
        }, 'tigertag'),
        null
    );
    assert.equal(marbleContext.material, 'pla');
    assert.equal(marbleContext.materialName, 'pla marble');
    assert.deepEqual(marbleContext.variant, ['pla marble', 'marble']);

    const marble = spool(1, {
        filament: {
            name: 'PLA Marble',
            material: 'PLA',
            extra: { variant: JSON.stringify('Marble') },
        },
    });
    const wood = spool(2, {
        filament: {
            name: 'PLA Wood',
            material: 'PLA',
            extra: { variant: JSON.stringify('Wood') },
        },
    });
    const grouped = RfidPort.groupSpools([wood, marble], marbleContext, null, '');

    assert.deepEqual(grouped.suggested.map(match => match.spool.id), [1, 2]);
    assert.equal(grouped.suggested[0].score, 6);
    assert.deepEqual(grouped.suggested[0].reasons, ['material', 'name exact', 'variant']);
    assert.equal(grouped.suggested[1].score, 2);
    assert.deepEqual(grouped.suggested[1].reasons, ['material']);
});

test('TigerTag matching falls back to the SDK format_data material label', () => {
    const context = RfidPort.buildTagMatchContext(
        RfidPort.normalizeDecoded({
            type: 'PLA',
            format_data: { material: { id: 123, label: 'PLA Wood' } },
        }, 'tigertag'),
        null
    );

    assert.equal(context.material, 'pla');
    assert.equal(context.materialName, 'pla wood');
    assert.deepEqual(context.variant, ['pla wood', 'wood']);
});

test('canonical card_uids create linked rows and duplicate-owner conflicts', () => {
    const context = RfidPort.buildTagMatchContext(
        RfidPort.normalizeDecoded({ manufacturer: 'Other', type: 'ABS' }),
        '04:A1:B2:C3:D4:E5:F6'
    );
    const canonical = JSON.stringify('04A1B2C3D4E5F6');
    const rows = [
        spool(1, { extra: { card_uids: canonical } }),
        spool(2, { extra: { card_uids: JSON.stringify(['04A1B2C3D4E5F6']) } }),
        spool(3),
    ];
    const grouped = RfidPort.groupSpools(rows, context, 3, '');

    assert.deepEqual(ids(grouped.linked), [1, 2]);
    assert.deepEqual(ids(grouped.current), [3]);
    assert.deepEqual(grouped.suggested, []);
    assert.deepEqual(grouped.all, []);
    assert.equal(grouped.conflicts.length, 1);
    assert.deepEqual(grouped.conflicts[0].spoolIds, [1, 2]);
});

test('legacy rfid_uid is advisory and never becomes an authoritative link', () => {
    const context = RfidPort.buildTagMatchContext(null, '04:A1:B2:C3:D4:E5:F6');
    const legacy = spool(8, {
        extra: { rfid_uid: JSON.stringify('04A1B2C3D4E5F6') },
    });
    const grouped = RfidPort.groupSpools([legacy], context, null, '');

    assert.deepEqual(grouped.linked, []);
    assert.deepEqual(ids(grouped.legacy), [8]);
    assert.deepEqual(ids(grouped.all), [8]);
});

test('fuzzy scoring applies documented weights and compares all colors', () => {
    const context = RfidPort.buildTagMatchContext(
        RfidPort.normalizeDecoded({
            manufacturer: 'Acme',
            type: 'PLA',
            message: 'Galaxy',
            modifiers: ['Silk'],
            colors: [0xffff0000, 0xff00ff00],
        }),
        null
    );
    const exact = spool(10, {
        filament: {
            name: 'Galaxy',
            material: 'PLA',
            vendor: { name: 'Acme' },
            color_hex: '0000FF',
            multi_color_hexes: '0000FF,00FF05',
            extra: { variant: JSON.stringify('Silk') },
        },
    });
    const grouped = RfidPort.groupSpools([exact], context, null, '');

    assert.equal(grouped.suggested.length, 1);
    assert.equal(grouped.suggested[0].score, 12);
    assert.equal(grouped.suggested[0].matchedCategories, 5);
    assert.ok(grouped.suggested[0].colorDistance <= 8);
    assert.deepEqual(grouped.suggested[0].reasons,
        ['vendor', 'material', 'color exact', 'name exact', 'variant']);
});

test('color thresholds and minimum score are enforced', () => {
    const context = {
        uid: '', vendor: '', material: '', variant: [], message: '', colors: ['000000'],
    };
    const rows = [
        spool(1, { filament: { color_hex: '000008' } }),
        spool(2, { filament: { color_hex: '000009' } }),
        spool(3, { filament: { color_hex: '00001F' } }),
    ];
    const grouped = RfidPort.groupSpools(rows, context, null, '');

    assert.deepEqual(grouped.suggested.map(match => [match.spool.id, match.score]), [
        [1, 3],
        [2, 2],
    ]);
    assert.deepEqual(ids(grouped.all), [3]);
});

test('matched category count breaks equal-score ties before spool id', () => {
    const context = {
        uid: '',
        vendor: 'acme',
        material: 'pla',
        variant: ['silk'],
        message: 'galaxy',
        colors: [],
    };
    const rows = [
        spool(1, { filament: { vendor: { name: 'Acme' } } }),
        spool(2, { filament: { material: 'PLA', extra: { variant: '"Silk"' } } }),
        spool(3, { filament: { name: 'Galaxy' } }),
    ];
    const grouped = RfidPort.groupSpools(rows, context, null, '');

    assert.deepEqual(grouped.suggested.map(match => match.spool.id), [2, 1, 3]);
    assert.equal(grouped.suggested[0].score, 3);
    assert.equal(grouped.suggested[0].matchedCategories, 2);
});

test('canonical variant wins; legacy modifiers are used only as fallback', () => {
    const context = {
        uid: '', vendor: '', material: 'pla', variant: ['silk'], message: '', colors: [],
    };
    const legacy = spool(1, {
        filament: {
            material: 'PLA',
            extra: { modifiers: JSON.stringify('Matte, Silk') },
        },
    });
    const canonical = spool(2, {
        filament: {
            material: 'PLA',
            extra: {
                variant: JSON.stringify('Gloss'),
                modifiers: JSON.stringify('Silk'),
            },
        },
    });
    const grouped = RfidPort.groupSpools([legacy, canonical], context, null, '');
    const byId = new Map(grouped.suggested.map(match => [match.spool.id, match]));

    assert.equal(byId.get(1).score, 3);
    assert.ok(byId.get(1).reasons.includes('variant'));
    assert.equal(byId.get(2).score, 2);
    assert.ok(!byId.get(2).reasons.includes('variant'));
});

test('suggestions are capped at five and remaining matches stay in All', () => {
    const context = {
        uid: '', vendor: '', material: 'pla', variant: [], message: '', colors: [],
    };
    const rows = Array.from({ length: 7 }, (_value, index) => spool(index + 1, {
        filament: { material: 'PLA' },
    }));
    const grouped = RfidPort.groupSpools(rows, context, null, '');

    assert.deepEqual(grouped.suggested.map(match => match.spool.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(ids(grouped.all), [6, 7]);
});

test('search uses AND terms across canonical fields and excludes archived spools', () => {
    const searchable = spool(42, {
        lot_nr: 'LOT-X',
        external_id: 'wrong-spool-field',
        filament: {
            name: 'Galaxy Black',
            material: 'PLA',
            vendor: { name: 'Acme' },
            external_id: 'FIL-77',
            extra: { variant: JSON.stringify('Silk') },
        },
    });
    const archived = spool(43, {
        archived: true,
        filament: { name: 'Galaxy Black', material: 'PLA', vendor: { name: 'Acme' } },
    });
    const context = { uid: '', vendor: '', material: '', variant: [], message: '', colors: [] };

    const found = RfidPort.groupSpools(
        [searchable, archived], context, null, 'acme galaxy pla silk lot-x fil-77 42'
    );
    assert.deepEqual(ids(found.all), [42]);

    const wrongField = RfidPort.groupSpools([searchable], context, null, 'wrong-spool-field');
    assert.deepEqual(wrongField.all, []);
    assert.deepEqual(wrongField.suggested, []);

    const missingOneTerm = RfidPort.groupSpools([searchable], context, null, 'acme nylon');
    assert.deepEqual(missingOneTerm.all, []);
});

test('a spool appears in only one display group', () => {
    const uid = '04A1B2C3D4E5F6';
    const context = {
        uid,
        vendor: 'acme',
        material: 'pla',
        variant: [],
        message: '',
        colors: [],
    };
    const linked = spool(1, {
        extra: { card_uids: JSON.stringify(uid) },
        filament: { material: 'PLA', vendor: { name: 'Acme' } },
    });
    const current = spool(2, {
        filament: { material: 'PLA', vendor: { name: 'Acme' } },
    });
    const suggested = spool(3, {
        filament: { material: 'PLA', vendor: { name: 'Acme' } },
    });
    const all = spool(4);
    const grouped = RfidPort.groupSpools([linked, current, suggested, all], context, 2, '');
    const displayIds = ids(grouped.linked)
        .concat(ids(grouped.current))
        .concat(grouped.suggested.map(match => match.spool.id))
        .concat(ids(grouped.all));

    assert.deepEqual(displayIds.sort((a, b) => a - b), [1, 2, 3, 4]);
    assert.equal(new Set(displayIds).size, displayIds.length);
});
