// Device recognition and the device-profile catalogue.
//
// Profiles come in three clearly labelled tiers:
//   measured  – published frequency-response corrections (AutoEq), credited.
//   estimated – tuned for the product's known design (driver size, enclosure,
//               channel layout); NOT measured by us.
//   generic   – category defaults (e.g. "Laptop speakers").
import measured from './data/measured-headphones.json';
import { DeviceCategory, DeviceClassification, DeviceProfile, FilterType, NativeDevice } from './types';

const PK = FilterType.Peak;
const LS = FilterType.LowShelf;
const HP = FilterType.HighPass;

const ESTIMATE_NOTE =
  'Estimated from the product category and published specifications. Not a measurement — adjust to taste.';

const GENERIC: DeviceProfile[] = [
  {
    id: 'generic:headphones',
    brand: 'Generic',
    model: 'Over-ear / on-ear headphones',
    category: 'headphones',
    channels: '2.0',
    verification: 'generic',
    source: 'Category default',
    match: [],
    preampDb: 0,
    filters: [{ type: PK, freq: 3000, q: 1.2, gainDb: 1.0 }],
    recommended: { surround: { mode: 'headphones' } },
  },
  {
    id: 'generic:earbuds',
    brand: 'Generic',
    model: 'Earbuds / in-ear',
    category: 'earbuds',
    channels: '2.0',
    verification: 'generic',
    source: 'Category default',
    match: [],
    preampDb: 0,
    filters: [{ type: PK, freq: 6500, q: 2, gainDb: -1.5 }],
    recommended: { surround: { mode: 'headphones' } },
  },
  {
    id: 'generic:laptop',
    brand: 'Generic',
    model: 'Laptop speakers',
    category: 'laptop',
    channels: '2.0',
    verification: 'generic',
    source: 'Category default: protects small drivers, adds presence',
    match: [],
    preampDb: 0,
    filters: [
      { type: HP, freq: 80, q: 0.7, gainDb: 0 },
      { type: PK, freq: 180, q: 1, gainDb: 2 },
      { type: PK, freq: 3500, q: 1.2, gainDb: 1.5 },
    ],
    recommended: { bass: { enabled: true, amount: 0.5, freq: 110 }, surround: { mode: 'speakers' } },
  },
  {
    id: 'generic:speakers',
    brand: 'Generic',
    model: 'Desktop speakers',
    category: 'speakers',
    channels: '2.0',
    verification: 'generic',
    source: 'Category default',
    match: [],
    preampDb: 0,
    filters: [],
    recommended: { surround: { mode: 'speakers' } },
  },
  {
    id: 'generic:bluetooth-speaker',
    brand: 'Generic',
    model: 'Portable Bluetooth speaker',
    category: 'bluetooth-speaker',
    channels: '2.0',
    verification: 'generic',
    source: 'Category default',
    match: [],
    preampDb: 0,
    filters: [
      { type: HP, freq: 55, q: 0.7, gainDb: 0 },
      { type: PK, freq: 2500, q: 1, gainDb: 1 },
    ],
    recommended: { bass: { enabled: true, amount: 0.4, freq: 90 }, surround: { mode: 'speakers' } },
  },
  {
    id: 'generic:soundbar',
    brand: 'Generic',
    model: 'Soundbar',
    category: 'soundbar',
    channels: '2.1',
    verification: 'generic',
    source: 'Category default',
    match: [],
    preampDb: 0,
    filters: [{ type: PK, freq: 250, q: 1, gainDb: -1.5 }],
    recommended: { dialogue: { enabled: true, amount: 0.3 }, surround: { mode: 'speakers' } },
  },
  {
    id: 'generic:tv',
    brand: 'Generic',
    model: 'TV / monitor speakers (HDMI)',
    category: 'tv',
    channels: '2.0',
    verification: 'generic',
    source: 'Category default',
    match: [],
    preampDb: 0,
    filters: [
      { type: HP, freq: 70, q: 0.7, gainDb: 0 },
      { type: PK, freq: 3000, q: 1, gainDb: 2 },
    ],
    recommended: { dialogue: { enabled: true, amount: 0.4 }, surround: { mode: 'speakers' } },
  },
  {
    id: 'generic:home-theater',
    brand: 'Generic',
    model: 'Home theatre / AV receiver',
    category: 'home-theater',
    channels: '5.1',
    verification: 'generic',
    source: 'Category default (flat; the receiver handles room correction)',
    match: [],
    preampDb: 0,
    filters: [],
    recommended: { upmix: true, surround: { mode: 'speakers' } },
  },
];

const ESTIMATED: DeviceProfile[] = [
  // Apple
  est('apple:macbook-air', 'Apple', 'MacBook Air speakers', 'laptop', '2.0', ['macbook air.*speaker'],
    [{ type: HP, freq: 85, q: 0.7, gainDb: 0 }, { type: PK, freq: 160, q: 1.1, gainDb: 2 }, { type: PK, freq: 4000, q: 1.5, gainDb: 1 }],
    { bass: { enabled: true, amount: 0.5, freq: 110 } }),
  est('apple:macbook-pro', 'Apple', 'MacBook Pro speakers', 'laptop', '2.0', ['macbook pro.*speaker'],
    [{ type: HP, freq: 60, q: 0.7, gainDb: 0 }, { type: PK, freq: 3500, q: 1.2, gainDb: 1 }],
    { bass: { enabled: true, amount: 0.35, freq: 90 } }),
  est('apple:imac', 'Apple', 'iMac speakers', 'speakers', '2.0', ['imac.*speaker'],
    [{ type: PK, freq: 3000, q: 1, gainDb: 0.5 }]),
  est('apple:studio-display', 'Apple', 'Studio Display speakers', 'display', '2.0', ['studio display'],
    [{ type: HP, freq: 65, q: 0.7, gainDb: 0 }]),
  est('apple:homepod-mini', 'Apple', 'HomePod mini (AirPlay)', 'bluetooth-speaker', '2.0', ['homepod mini'],
    [{ type: PK, freq: 2500, q: 1, gainDb: 1 }], { bass: { enabled: true, amount: 0.35, freq: 90 } }),
  est('apple:homepod', 'Apple', 'HomePod (AirPlay)', 'speakers', '2.0', ['homepod(?! mini)'],
    [{ type: LS, freq: 100, q: 0.7, gainDb: -1.5 }]),
  // Sony
  est('sony:ht-a7000', 'Sony', 'HT-A7000 soundbar', 'soundbar', '7.1', ['ht-a7000'],
    [{ type: PK, freq: 250, q: 1, gainDb: -1 }], { dialogue: { enabled: true, amount: 0.25 }, upmix: true }),
  est('sony:ht-s400', 'Sony', 'HT-S400 soundbar', 'soundbar', '2.1', ['ht-s400'],
    [{ type: PK, freq: 200, q: 1, gainDb: -1.5 }, { type: PK, freq: 3000, q: 1, gainDb: 1 }], { dialogue: { enabled: true, amount: 0.3 } }),
  est('sony:srs-xb', 'Sony', 'SRS-XB / ULT series speaker', 'bluetooth-speaker', '2.0', ['srs-xb', 'ult field', 'srs-ult'],
    [{ type: LS, freq: 90, q: 0.7, gainDb: -2 }, { type: PK, freq: 3000, q: 1, gainDb: 1.5 }]),
  // Bose
  est('bose:smart-soundbar', 'Bose', 'Smart Soundbar 600 / 900 / Ultra', 'soundbar', '5.1', ['bose smart (soundbar|ultra)', 'soundbar (600|700|900)'],
    [{ type: PK, freq: 220, q: 1, gainDb: -1 }], { dialogue: { enabled: true, amount: 0.25 }, upmix: true }),
  est('bose:soundlink', 'Bose', 'SoundLink Flex / Revolve / Micro', 'bluetooth-speaker', '2.0', ['soundlink'],
    [{ type: HP, freq: 60, q: 0.7, gainDb: 0 }, { type: PK, freq: 2800, q: 1, gainDb: 1 }]),
  // JBL
  est('jbl:flip', 'JBL', 'Flip / Charge series speaker', 'bluetooth-speaker', '2.0', ['jbl (flip|charge)'],
    [{ type: LS, freq: 100, q: 0.7, gainDb: -1.5 }, { type: PK, freq: 3200, q: 1, gainDb: 1.5 }]),
  est('jbl:go', 'JBL', 'Go / Clip series speaker', 'bluetooth-speaker', '2.0', ['jbl (go|clip)'],
    [{ type: HP, freq: 110, q: 0.7, gainDb: 0 }, { type: PK, freq: 3000, q: 1, gainDb: 1.5 }],
    { bass: { enabled: true, amount: 0.5, freq: 120 } }),
  est('jbl:bar', 'JBL', 'Bar series soundbar', 'soundbar', '5.1', ['jbl bar'],
    [{ type: PK, freq: 230, q: 1, gainDb: -1 }], { dialogue: { enabled: true, amount: 0.3 }, upmix: true }),
  // Samsung
  est('samsung:hw-q', 'Samsung', 'HW-Q series soundbar', 'soundbar', '5.1', ['hw-q\\d', 'samsung soundbar'],
    [{ type: PK, freq: 240, q: 1, gainDb: -1.5 }], { dialogue: { enabled: true, amount: 0.3 }, upmix: true }),
  est('samsung:hw-b', 'Samsung', 'HW-B / HW-C series soundbar', 'soundbar', '2.1', ['hw-[bc]\\d'],
    [{ type: PK, freq: 200, q: 1, gainDb: -2 }, { type: PK, freq: 3000, q: 1, gainDb: 1.5 }], { dialogue: { enabled: true, amount: 0.35 } }),
  est('samsung:tv', 'Samsung', 'Samsung TV (HDMI)', 'tv', '2.0', ['samsung.*(tv|qled|neo)', '^samsung$'],
    [{ type: HP, freq: 70, q: 0.7, gainDb: 0 }, { type: PK, freq: 3000, q: 1, gainDb: 2 }], { dialogue: { enabled: true, amount: 0.4 } }),
  // LG
  est('lg:soundbar', 'LG', 'LG soundbar (S / SN / SP series)', 'soundbar', '5.1', ['lg.*(soundbar|s\\d{2}|sn\\d|sp\\d)'],
    [{ type: PK, freq: 230, q: 1, gainDb: -1.5 }], { dialogue: { enabled: true, amount: 0.3 }, upmix: true }),
  est('lg:tv', 'LG', 'LG TV (HDMI)', 'tv', '2.0', ['lg (tv|oled|webos)', '^lg tv'],
    [{ type: HP, freq: 70, q: 0.7, gainDb: 0 }, { type: PK, freq: 3000, q: 1, gainDb: 2 }], { dialogue: { enabled: true, amount: 0.4 } }),
  est('lg:monitor', 'LG', 'LG UltraFine / monitor speakers', 'display', '2.0', ['lg ultrafine', 'lg hdr', 'lg ultra'],
    [{ type: HP, freq: 120, q: 0.7, gainDb: 0 }, { type: PK, freq: 3000, q: 1, gainDb: 1.5 }], { bass: { enabled: true, amount: 0.5, freq: 130 } }),
  // Sonos (reachable as an output via AirPlay on macOS, or HDMI eARC through a TV)
  est('sonos:arc', 'Sonos', 'Arc / Arc Ultra', 'soundbar', '5.1', ['sonos arc', '^arc$'],
    [{ type: PK, freq: 220, q: 1, gainDb: -1 }], { upmix: true }),
  est('sonos:beam', 'Sonos', 'Beam / Ray', 'soundbar', '2.1', ['sonos (beam|ray)', '^(beam|ray)$'],
    [{ type: PK, freq: 230, q: 1, gainDb: -1.5 }, { type: PK, freq: 3000, q: 1, gainDb: 1 }], { dialogue: { enabled: true, amount: 0.25 } }),
  est('sonos:era', 'Sonos', 'Era 100 / Era 300 / One', 'speakers', '2.0', ['sonos (era|one)', '^era (100|300)'],
    [{ type: LS, freq: 100, q: 0.7, gainDb: -1 }]),
  est('sonos:portable', 'Sonos', 'Roam / Move', 'bluetooth-speaker', '2.0', ['sonos (roam|move)', '^(roam|move)( 2)?$'],
    [{ type: PK, freq: 2800, q: 1, gainDb: 1 }]),
];

function est(
  id: string,
  brand: string,
  model: string,
  category: DeviceCategory,
  channels: DeviceProfile['channels'],
  match: string[],
  filters: DeviceProfile['filters'],
  recommended: DeviceProfile['recommended'] = {},
): DeviceProfile {
  const speakerLike = !['headphones', 'earbuds'].includes(category);
  return {
    id: `estimated:${id}`,
    brand,
    model,
    category,
    channels,
    verification: 'estimated',
    source: ESTIMATE_NOTE,
    match,
    preampDb: 0,
    filters,
    recommended: { ...recommended, surround: { mode: speakerLike ? 'speakers' : 'headphones', ...(recommended.surround ?? {}) } },
  };
}

const MEASURED: DeviceProfile[] = (measured.profiles as unknown as DeviceProfile[]).map((p) => ({
  ...p,
  model: p.model.replace(/Pro2$/, 'Pro 2'),
  recommended: { surround: { mode: 'headphones' } },
}));

export const DEVICE_PROFILES: DeviceProfile[] = [...MEASURED, ...ESTIMATED, ...GENERIC];

export function profileById(id: string | null | undefined): DeviceProfile | null {
  if (!id) return null;
  return DEVICE_PROFILES.find((p) => p.id === id) ?? null;
}

const BRANDS: Array<[string, RegExp]> = [
  ['Apple', /\b(apple|airpods|macbook|imac|homepod|studio display|earpods)\b/i],
  ['Beats', /\b(beats|powerbeats)\b/i],
  ['Sony', /\b(sony|wh-|wf-|mdr-|ht-a|ht-s|srs-|bravia)/i],
  ['Bose', /\b(bose|quietcomfort|soundlink)\b/i],
  ['JBL', /\bjbl\b/i],
  ['Samsung', /\b(samsung|galaxy buds|hw-[a-z]\d)/i],
  ['LG', /\blg\b/i],
  ['Sonos', /\bsonos\b/i],
  ['Sennheiser', /\b(sennheiser|momentum)\b/i],
];

const RULES: Array<[DeviceCategory, RegExp]> = [
  ['earbuds', /airpods(?! max)|earpods|\bbuds\b|earbuds|\bwf-|powerbeats|in-ear|galaxy buds/i],
  ['headphones', /headphone|headset|airpods max|\bwh-|quietcomfort|\bqc ?\d|momentum|beats (studio|solo)|tune \d|live \d|tour one|\bhd ?\d{3}|mdr-/i],
  ['soundbar', /sound ?bar|\bhw-[a-z]\d|\bht-[as]|\bsonos (arc|beam|ray)|\bjbl bar|\bbar \d/i],
  ['home-theater', /receiver|\bavr\b|denon|marantz|yamaha rx|onkyo|home theat/i],
  ['tv', /\btv\b|bravia|oled|qled|webos|television/i],
  ['display', /studio display|ultrafine|monitor|display/i],
  ['bluetooth-speaker', /\b(flip|charge|go \d|clip \d|soundlink|boom|megaboom|srs-|roam|move|homepod|xb\d)/i],
];

export function classifyDevice(d: Pick<NativeDevice, 'name' | 'transport' | 'formFactor' | 'dataSource' | 'manufacturer' | 'modelId' | 'isVirtual' | 'channels'>): DeviceClassification {
  const text = `${d.name} ${d.modelId ?? ''}`;
  const brand = BRANDS.find(([, re]) => re.test(`${text} ${d.manufacturer ?? ''}`))?.[0] ?? null;
  let category: DeviceCategory = 'unknown';
  if (d.isVirtual || d.transport === 'virtual') category = 'virtual';
  else {
    for (const [cat, re] of RULES) {
      if (re.test(text)) {
        category = cat;
        break;
      }
    }
    if (category === 'unknown') {
      if (d.formFactor === 'headphones' || d.formFactor === 'headset' || d.dataSource === 'hdpn') category = 'headphones';
      else if (d.transport === 'builtin' && /macbook|laptop|notebook/i.test(text)) category = 'laptop';
      else if (d.transport === 'builtin' || d.formFactor === 'speakers') category = d.transport === 'builtin' ? 'laptop' : 'speakers';
      else if (d.transport === 'hdmi' || d.transport === 'displayport' || d.formFactor === 'hdmi') category = d.channels > 2 ? 'home-theater' : 'tv';
      else if (d.transport === 'bluetooth') category = 'headphones';
      else if (d.transport === 'airplay') category = 'speakers';
      else if (d.transport === 'usb') category = 'speakers';
    }
    // macOS reports wired headphones on the built-in output as data source 'hdpn'.
    if (d.dataSource === 'hdpn') category = 'headphones';
    if (/imac/i.test(text) && category === 'laptop') category = 'speakers';
  }
  const headphoneLike = category === 'headphones' || category === 'earbuds';
  return { category, brand, headphoneLike, label: CATEGORY_LABELS[category] };
}

export const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  headphones: 'Headphones',
  earbuds: 'Earbuds',
  speakers: 'Speakers',
  laptop: 'Built-in speakers',
  soundbar: 'Soundbar',
  tv: 'TV / HDMI',
  'bluetooth-speaker': 'Bluetooth speaker',
  display: 'Display speakers',
  'home-theater': 'Home theatre',
  virtual: 'Virtual device',
  unknown: 'Audio device',
};

/** Best profile for a device: measured > estimated (by name) > category default. */
export function matchProfile(d: Pick<NativeDevice, 'name' | 'modelId'>, classification: DeviceClassification): DeviceProfile | null {
  const name = `${d.name} ${d.modelId ?? ''}`.toLowerCase();
  for (const tier of ['measured', 'estimated'] as const) {
    const hit = DEVICE_PROFILES.find(
      (p) => p.verification === tier && p.match.some((m) => safeRegex(m)?.test(name)),
    );
    if (hit) return hit;
  }
  return genericProfileFor(classification.category);
}

export function genericProfileFor(category: DeviceCategory): DeviceProfile | null {
  const map: Partial<Record<DeviceCategory, string>> = {
    headphones: 'generic:headphones',
    earbuds: 'generic:earbuds',
    laptop: 'generic:laptop',
    speakers: 'generic:speakers',
    'bluetooth-speaker': 'generic:bluetooth-speaker',
    soundbar: 'generic:soundbar',
    tv: 'generic:tv',
    display: 'generic:speakers',
    'home-theater': 'generic:home-theater',
  };
  return profileById(map[category]);
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, 'i');
  } catch {
    return null;
  }
}

export const VERIFICATION_LABELS: Record<DeviceProfile['verification'], { label: string; description: string }> = {
  measured: {
    label: 'Measured',
    description: 'Correction derived from a published lab measurement of this exact model.',
  },
  estimated: {
    label: 'Estimated',
    description: 'Tuned from the product type and specifications. Not measured.',
  },
  generic: {
    label: 'Generic',
    description: 'A starting point for this kind of device.',
  },
};
