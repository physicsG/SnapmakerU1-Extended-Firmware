// ─────────────────────────────────────────────────────────────
// TigerTag binary encoder / decoder
// ─────────────────────────────────────────────────────────────
import {
    TT_TAG_ID_MAKER,
    TT_OFF_TAG_ID, TT_OFF_PRODUCT_ID, TT_OFF_MATERIAL, TT_OFF_ASPECT1,
    TT_OFF_ASPECT2, TT_OFF_TYPE, TT_OFF_DIAMETER, TT_OFF_BRAND,
    TT_OFF_COLOR_R, TT_OFF_COLOR_G, TT_OFF_COLOR_B, TT_OFF_COLOR_A,
    TT_OFF_WEIGHT, TT_OFF_UNIT, TT_OFF_HOTEND_MIN, TT_OFF_HOTEND_MAX,
    TT_OFF_DRY_TEMP, TT_OFF_DRY_TIME, TT_OFF_BED_MIN, TT_OFF_BED_MAX,
    TT_OFF_TIMESTAMP, TT_OFF_TD, TT_OFF_MESSAGE,
    TT_USER_DATA_SIZE,
} from './constants.js';

export function encodeTigerTag(f) {
    const buf = new Uint8Array(TT_USER_DATA_SIZE);
    const v = new DataView(buf.buffer);
    v.setUint32(TT_OFF_TAG_ID, f.tagId ?? TT_TAG_ID_MAKER);
    v.setUint32(TT_OFF_PRODUCT_ID, f.productId ?? 0);
    v.setUint16(TT_OFF_MATERIAL, f.materialId ?? 65535);
    buf[TT_OFF_ASPECT1] = f.aspect1Id ?? 255;
    buf[TT_OFF_ASPECT2] = f.aspect2Id ?? 255;
    buf[TT_OFF_TYPE] = f.typeId ?? 142; // filament
    buf[TT_OFF_DIAMETER] = f.diameterId ?? 56; // 1.75
    v.setUint16(TT_OFF_BRAND, f.brandId ?? 65535);
    buf[TT_OFF_COLOR_R] = f.colorR || 0;
    buf[TT_OFF_COLOR_G] = f.colorG || 0;
    buf[TT_OFF_COLOR_B] = f.colorB || 0;
    buf[TT_OFF_COLOR_A] = f.colorA ?? 255;
    const w = f.weight ?? 0;
    buf[TT_OFF_WEIGHT]     = (w >> 16) & 0xFF;
    buf[TT_OFF_WEIGHT + 1] = (w >> 8) & 0xFF;
    buf[TT_OFF_WEIGHT + 2] = w & 0xFF;
    buf[TT_OFF_UNIT] = f.unitId ?? 21; // grams
    v.setUint16(TT_OFF_HOTEND_MIN, f.hotendMin ?? 0);
    v.setUint16(TT_OFF_HOTEND_MAX, f.hotendMax ?? 0);
    buf[TT_OFF_DRY_TEMP] = f.dryingTemp ?? 0;
    buf[TT_OFF_DRY_TIME] = f.dryingTime ?? 0;
    buf[TT_OFF_BED_MIN] = f.bedTempMin ?? 0;
    buf[TT_OFF_BED_MAX] = f.bedTempMax ?? 0;
    v.setUint32(TT_OFF_TIMESTAMP, f.timestamp ?? 0);
    v.setUint16(TT_OFF_TD, f.tdRaw ?? 0); // TD * 10
    // bytes 46-47: reserved
    if (f._raw) { buf[46] = f._raw[46] || 0; buf[47] = f._raw[47] || 0; }
    // bytes 48-95: message (UTF-8, null-padded)
    if (f.message) {
        const enc = new TextEncoder().encode(f.message);
        const len = Math.min(enc.length, 48);
        buf.set(enc.subarray(0, len), TT_OFF_MESSAGE);
    }
    return buf;
}

export function decodeTigerTag(raw, opts) {
    // raw = Uint8Array of user data (96+ bytes, starting at page 4 = byte 16)
    // We receive the full NTAG data (540 bytes); user data starts at byte 16
    const ud = raw.length > TT_USER_DATA_SIZE ? raw.slice(16) : raw;
    const v = new DataView(ud.buffer, ud.byteOffset, ud.byteLength);
    return {
        tagId:      v.getUint32(TT_OFF_TAG_ID),
        productId:  v.getUint32(TT_OFF_PRODUCT_ID),
        materialId: v.getUint16(TT_OFF_MATERIAL),
        aspect1Id:  ud[TT_OFF_ASPECT1],
        aspect2Id:  ud[TT_OFF_ASPECT2],
        typeId:     ud[TT_OFF_TYPE],
        diameterId: ud[TT_OFF_DIAMETER],
        brandId:    v.getUint16(TT_OFF_BRAND),
        colorR:     ud[TT_OFF_COLOR_R], colorG: ud[TT_OFF_COLOR_G], colorB: ud[TT_OFF_COLOR_B], colorA: ud[TT_OFF_COLOR_A],
        weight:     (ud[TT_OFF_WEIGHT] << 16) | (ud[TT_OFF_WEIGHT + 1] << 8) | ud[TT_OFF_WEIGHT + 2],
        unitId:     ud[TT_OFF_UNIT],
        hotendMin:  v.getUint16(TT_OFF_HOTEND_MIN),
        hotendMax:  v.getUint16(TT_OFF_HOTEND_MAX),
        dryingTemp: ud[TT_OFF_DRY_TEMP],
        dryingTime: ud[TT_OFF_DRY_TIME],
        bedTempMin: ud[TT_OFF_BED_MIN],
        bedTempMax: ud[TT_OFF_BED_MAX],
        timestamp:  v.getUint32(TT_OFF_TIMESTAMP),
        tdRaw:      v.getUint16(TT_OFF_TD),
        message:    decodeMessage(ud),
        _raw:       ud,
    };
}

function decodeMessage(ud) {
    // bytes 48-95: UTF-8 message, null-terminated
    let end = TT_OFF_MESSAGE;
    while (end < TT_USER_DATA_SIZE && ud[end] !== 0) end++;
    if (end === TT_OFF_MESSAGE) return '';
    return new TextDecoder().decode(ud.slice(TT_OFF_MESSAGE, end));
}
