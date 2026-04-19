// ─────────────────────────────────────────────────────────────
// Spoolman API constants
// ─────────────────────────────────────────────────────────────
export const SM_API   = '/api/v1';
export const SM_PROXY = '/rfid-spools/spoolman';

// ─────────────────────────────────────────────────────────────
// TigerTag core constants
// ─────────────────────────────────────────────────────────────
export const TT_TAG_ID_MAKER = 0x5BF59264;
export const TT_EPOCH = 946684800; // seconds between Unix epoch and 2000-01-01

// ─────────────────────────────────────────────────────────────
// TigerTag byte offsets (within 96-byte user data block)
// ─────────────────────────────────────────────────────────────
export const TT_OFF_TAG_ID      = 0;   // uint32
export const TT_OFF_PRODUCT_ID  = 4;   // uint32
export const TT_OFF_MATERIAL    = 8;   // uint16
export const TT_OFF_ASPECT1     = 10;  // uint8
export const TT_OFF_ASPECT2     = 11;  // uint8
export const TT_OFF_TYPE        = 12;  // uint8
export const TT_OFF_DIAMETER    = 13;  // uint8
export const TT_OFF_BRAND       = 14;  // uint16
export const TT_OFF_COLOR_R     = 16;  // uint8
export const TT_OFF_COLOR_G     = 17;  // uint8
export const TT_OFF_COLOR_B     = 18;  // uint8
export const TT_OFF_COLOR_A     = 19;  // uint8
export const TT_OFF_WEIGHT      = 20;  // 3 bytes big-endian
export const TT_OFF_UNIT        = 23;  // uint8
export const TT_OFF_HOTEND_MIN  = 24;  // uint16
export const TT_OFF_HOTEND_MAX  = 26;  // uint16
export const TT_OFF_DRY_TEMP    = 28;  // uint8
export const TT_OFF_DRY_TIME    = 29;  // uint8
export const TT_OFF_BED_MIN     = 30;  // uint8
export const TT_OFF_BED_MAX     = 31;  // uint8
export const TT_OFF_TIMESTAMP   = 32;  // uint32
export const TT_OFF_TD          = 44;  // uint16
export const TT_OFF_RESERVED    = 46;  // 2 bytes
export const TT_OFF_MESSAGE     = 48;  // 28 bytes UTF-8
export const TT_MESSAGE_SIZE    = 28;  // 28 bytes UTF-8
export const TT_USER_DATA_SIZE  = 96;

// ─────────────────────────────────────────────────────────────
// TigerTag registry data (from TigerTag database JSONs)
// ─────────────────────────────────────────────────────────────

export const TT_MATERIALS = [
{i:38219,l:'PLA',t:'PLA'},{i:46591,l:'PLA+',t:'PLA'},{i:10602,l:'PLA Silk',t:'PLA'},{i:8345,l:'PLA+ Silk',t:'PLA'},{i:9456,l:'PLA Marble',t:'PLA'},{i:48001,l:'PLA Wood',t:'PLA'},{i:24629,l:'PLA High Speed',t:'PLA'},{i:11506,l:'PLA-LW',t:'PLA'},{i:48310,l:'PLA-CF',t:'PLA'},{i:18922,l:'PLA-ESD',t:'PLA'},
{i:38256,l:'PETG',t:'PETG'},{i:57469,l:'PETG HF',t:'PETG'},{i:7649,l:'PETG HS',t:'PETG'},{i:55418,l:'PETG-CF',t:'PETG'},{i:7951,l:'PETG-rCF',t:'PETG'},{i:5238,l:'PETG-PTFE',t:'PETG'},{i:51861,l:'PETG-ESD',t:'PETG'},
{i:20562,l:'ABS',t:'ABS'},{i:425,l:'ABS-CF',t:'ABS'},{i:49074,l:'ABS-GF',t:'ABS'},{i:735,l:'ABS-AF',t:'ABS'},
{i:12844,l:'ASA',t:'ASA'},{i:27676,l:'ASA-CF',t:'ASA'},{i:35100,l:'ASA-GF',t:'ASA'},{i:49804,l:'ASA-AF',t:'ASA'},{i:31011,l:'ASA-LW',t:'ASA'},{i:54568,l:'ASA+',t:'ASA'},
{i:43518,l:'TPU',t:'TPU'},{i:48047,l:'TPU High Speed',t:'TPU'},{i:5733,l:'TPU for AMS',t:'TPU'},{i:58142,l:'TPU-GF',t:'TPU'},
{i:59328,l:'PA',t:'PA'},{i:39944,l:'PA-CF',t:'PA'},{i:30594,l:'PA-GF',t:'PA'},{i:56666,l:'PA6',t:'PA6'},{i:12264,l:'PA6-CF',t:'PA6'},{i:1173,l:'PA6-GF',t:'PA6'},{i:55796,l:'PA12',t:'PA12'},{i:39667,l:'PA12-CF',t:'PA12'},{i:2053,l:'PA12-GF',t:'PA12'},{i:48815,l:'PAHT-CF',t:'PAHT'},
{i:30458,l:'PC',t:'PC'},{i:3368,l:'PC-ABS',t:'PC'},{i:4587,l:'PC-PBT',t:'PC'},{i:10738,l:'PC-PTFE',t:'PC'},{i:47651,l:'PC-PBT-CF',t:'PC'},{i:61563,l:'PC-PBT-GF',t:'PC'},
{i:15041,l:'PCTG',t:'PCTG'},{i:53890,l:'PCTG-CF',t:'PCTG'},{i:3481,l:'PCTG-GF',t:'PCTG'},
{i:52077,l:'PET',t:'PET'},{i:11053,l:'PET-CF',t:'PET'},{i:22678,l:'PET-GF',t:'PET'},
{i:30884,l:'PP',t:'PP'},{i:50497,l:'PP-CF',t:'PP'},{i:42962,l:'PP-GF',t:'PP'},
{i:13850,l:'PPA',t:'PPA'},{i:8504,l:'PPA-CF',t:'PPA'},{i:46276,l:'PPA-GF',t:'PPA'},
{i:33958,l:'TPE',t:'TPE'},{i:58498,l:'PEBA',t:'PEBA'},{i:24115,l:'SEBS',t:'SEBS'},{i:24116,l:'TPC',t:'TPC'},
{i:26029,l:'HIPS',t:'HIPS'},{i:9483,l:'PVA',t:'PVA'},{i:34049,l:'BVOH',t:'BVOH'},{i:45962,l:'PVB',t:'PVB'},
{i:29815,l:'PEEK',t:'PEEK'},{i:53970,l:'PEKK',t:'PEKK'},{i:56527,l:'PEI',t:'PEI'},{i:46154,l:'PPS',t:'PPS'},{i:24270,l:'PPS-CF',t:'PPS'},{i:10272,l:'PSU',t:'PSU'},{i:49152,l:'PPSU',t:'PPSU'},
{i:42623,l:'PMMA',t:'PMMA'},{i:50206,l:'POM',t:'POM'},{i:18130,l:'PS',t:'PS'},{i:20073,l:'PVC',t:'PVC'},{i:55279,l:'PBT',t:'PBT'},{i:61048,l:'PVDF',t:'PVDF'},
{i:27635,l:'PE',t:'PE'},{i:18775,l:'PE-CF',t:'PE'},{i:9691,l:'EVA',t:'EVA'},{i:18703,l:'PETP',t:'PET'},{i:10187,l:'PHA',t:'PHA'},{i:28110,l:'SBC',t:'SBC'},{i:27268,l:'PCTPE',t:'PCPTFE'},{i:34409,l:'TPS',t:'TPS'},{i:63946,l:'TPI',t:'TPI'},
{i:51007,l:'Biopolymer',t:''},{i:10478,l:'Castable Filament',t:''},{i:65535,l:'None',t:'None'},
];

export const TT_BRANDS = [
{i:35123,n:'Bambu Lab'},{i:26956,n:'Creality'},{i:57632,n:'ELEGOO'},{i:47930,n:'eSun'},{i:7812,n:'Jayo'},{i:28988,n:'KINGROON'},{i:46203,n:'Overture'},{i:50604,n:'Polymaker'},{i:46392,n:'Prusament'},{i:12635,n:'Snapmaker'},{i:51857,n:'Sunlu'},
{i:15962,n:'Anycubic'},{i:58410,n:'AzureFilm'},{i:51443,n:'BASF'},{i:52222,n:'ColorFabb'},{i:28940,n:'Eryone'},{i:7674,n:'Extrudr'},{i:8182,n:'Fiberlogy'},{i:7980,n:'Fillamentum'},{i:55229,n:'Filament PM'},{i:63340,n:'Flashforge'},{i:53043,n:'FormFutura'},
{i:3132,n:'Hatchbox'},{i:12345,n:'MakerBot'},{i:4344,n:'MatterHackers'},{i:48804,n:'R3D'},{i:20523,n:'Raise3D'},{i:60882,n:'Recreus'},{i:19961,n:'Rosa3D'},{i:26595,n:'Sovol'},{i:22652,n:'Spectrum'},{i:42911,n:'UltiMaker'},{i:37434,n:'Winkle'},{i:9596,n:'Ziro'},
{i:1,n:'Atome3D'},{i:1068,n:'SainSmart'},{i:1120,n:'Proto-Pasta'},{i:1421,n:'3DJake'},{i:2517,n:'Smart Materials 3D'},{i:4011,n:'QIDI Tech'},{i:8303,n:'GST3D'},{i:8586,n:'NinjaTek'},{i:8921,n:'Duramic 3D'},{i:9192,n:'3D Solutech'},{i:11429,n:'3D4Makers'},
{i:14982,n:'3D-Fuel'},{i:15899,n:'Kimya'},{i:23181,n:'ArianePlast'},{i:24363,n:'Tecbears'},{i:28055,n:'TAGin3D'},{i:32348,n:'Addnorth'},{i:33566,n:'Siraya Tech'},{i:35501,n:'Zortrax'},{i:39652,n:'3DXTech'},{i:45678,n:'Atomic Filament'},{i:46010,n:'AceAddity'},
{i:52467,n:'Geeetech'},{i:54112,n:'Kexcelled'},{i:55763,n:'Nanovia'},{i:65535,n:'Generic'},
];

export const TT_ASPECTS = [
{i:255,l:'None'},{i:104,l:'Basic'},{i:92,l:'Silk'},{i:129,l:'Gloss'},{i:134,l:'Satin'},{i:247,l:'Matt'},{i:21,l:'Clear'},{i:67,l:'Translucent'},{i:232,l:'Marble'},{i:64,l:'Glitter'},{i:126,l:'Pearl'},{i:216,l:'Neon'},{i:220,l:'Pastel'},
{i:91,l:'Glow in the Dark'},{i:123,l:'Wood'},{i:173,l:'Stone'},{i:238,l:'Carbon'},{i:97,l:'Lithophane'},{i:168,l:'Thermoreactif'},{i:145,l:'Rainbow'},{i:252,l:'Bicolor'},{i:24,l:'Tricolor'},
];

export const TT_DIAMETERS = [{i:56,l:'1.75'},{i:221,l:'2.85'}];
export const TT_UNITS = [{i:21,l:'g'},{i:35,l:'kg'},{i:10,l:'mg'},{i:48,l:'ml'},{i:79,l:'L'},{i:112,l:'mm'},{i:149,l:'m'}];
