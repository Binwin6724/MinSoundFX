// Default sound settings, the predefined listening experiences and the
// equaliser genre profiles.
import { DeepPartial, EQ_BANDS, EqProfile, Experience, SoundSettings } from './types';

export function defaultSound(): SoundSettings {
  return {
    preampDb: 0,
    outputGainDb: 0,
    balance: 0,
    eqEnabled: true,
    eqGainsDb: new Array(EQ_BANDS).fill(0),
    eqQ: 1.41,
    bassDb: 0,
    midDb: 0,
    trebleDb: 0,
    bass: { enabled: false, amount: 0.5, freq: 90 },
    dialogue: { enabled: false, amount: 0.5 },
    widen: { enabled: false, width: 1.3 },
    surround: { enabled: false, amount: 0.5, room: 0.5, mode: 'auto' },
    comp: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 10, releaseMs: 180, makeupDb: 0 },
    loudness: { enabled: false, targetLufs: -16, maxBoostDb: 9 },
    upmix: false,
  };
}

export function cloneSound(s: SoundSettings): SoundSettings {
  return JSON.parse(JSON.stringify(s)) as SoundSettings;
}

/** Deep-merges a partial over a full settings object (arrays replace). */
export function mergeSound(base: SoundSettings, patch: DeepPartial<SoundSettings> | undefined): SoundSettings {
  const out = cloneSound(base);
  if (!patch) return out;
  const rec = (target: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) target[k] = [...v];
      else if (v && typeof v === 'object' && target[k] && typeof target[k] === 'object')
        rec(target[k] as Record<string, unknown>, v as Record<string, unknown>);
      else target[k] = v;
    }
  };
  rec(out as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  return out;
}

/** Clamps every field to the range the UI and engine support. */
export function normalizeSound(input: unknown): SoundSettings {
  const s = mergeSound(defaultSound(), (input ?? {}) as DeepPartial<SoundSettings>);
  const c = (v: unknown, lo: number, hi: number, def: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
    return Math.min(hi, Math.max(lo, n));
  };
  const b = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  const d = defaultSound();
  const gains = Array.isArray(s.eqGainsDb) ? s.eqGainsDb : d.eqGainsDb;
  return {
    preampDb: c(s.preampDb, -24, 12, 0),
    outputGainDb: c(s.outputGainDb, -24, 6, 0),
    balance: c(s.balance, -1, 1, 0),
    eqEnabled: b(s.eqEnabled, true),
    eqGainsDb: Array.from({ length: EQ_BANDS }, (_, i) => c(gains[i], -12, 12, 0)),
    eqQ: c(s.eqQ, 0.3, 4, 1.41),
    bassDb: c(s.bassDb, -12, 12, 0),
    midDb: c(s.midDb, -12, 12, 0),
    trebleDb: c(s.trebleDb, -12, 12, 0),
    bass: { enabled: b(s.bass.enabled, false), amount: c(s.bass.amount, 0, 1, 0.5), freq: c(s.bass.freq, 40, 160, 90) },
    dialogue: { enabled: b(s.dialogue.enabled, false), amount: c(s.dialogue.amount, 0, 1, 0.5) },
    widen: { enabled: b(s.widen.enabled, false), width: c(s.widen.width, 0, 2, 1.3) },
    surround: {
      enabled: b(s.surround.enabled, false),
      amount: c(s.surround.amount, 0, 1, 0.5),
      room: c(s.surround.room, 0, 1, 0.5),
      mode: ['auto', 'headphones', 'speakers'].includes(s.surround.mode) ? s.surround.mode : 'auto',
    },
    comp: {
      enabled: b(s.comp.enabled, false),
      thresholdDb: c(s.comp.thresholdDb, -60, 0, -24),
      ratio: c(s.comp.ratio, 1, 20, 3),
      attackMs: c(s.comp.attackMs, 0.5, 200, 10),
      releaseMs: c(s.comp.releaseMs, 10, 2000, 180),
      makeupDb: c(s.comp.makeupDb, 0, 18, 0),
    },
    loudness: {
      enabled: b(s.loudness.enabled, false),
      targetLufs: c(s.loudness.targetLufs, -30, -10, -16),
      maxBoostDb: c(s.loudness.maxBoostDb, 0, 12, 9),
    },
    upmix: b(s.upmix, false),
  };
}

export const EXPERIENCES: Experience[] = [
  {
    id: 'music',
    name: 'Music',
    tagline: 'Balanced, open and immersive',
    icon: 'music',
    accent: ['#7c5cff', '#22d3ee'],
    sound: {
      eqGainsDb: [2, 1.5, 0.5, 0, -0.5, 0, 0.5, 1, 1.5, 1.5],
      bass: { enabled: true, amount: 0.35, freq: 80 },
      widen: { enabled: true, width: 1.2 },
    },
  },
  {
    id: 'cinema',
    name: 'Cinema',
    tagline: 'Deep bass, clear dialogue, wide stage',
    icon: 'film',
    accent: ['#f97316', '#ef4444'],
    sound: {
      eqGainsDb: [3, 2.5, 1, 0, -0.5, 0.5, 1.5, 1, 0.5, 0.5],
      bass: { enabled: true, amount: 0.6, freq: 70 },
      dialogue: { enabled: true, amount: 0.45 },
      surround: { enabled: true, amount: 0.55, room: 0.7 },
      comp: { enabled: true, thresholdDb: -22, ratio: 2, attackMs: 15, releaseMs: 250, makeupDb: 2 },
      upmix: true,
    },
  },
  {
    id: 'gaming',
    name: 'Gaming',
    tagline: 'Sharper positioning and footsteps',
    icon: 'gamepad',
    accent: ['#22c55e', '#06b6d4'],
    sound: {
      eqGainsDb: [0, 0, -1, -1, 0, 1, 2.5, 3, 2, 1],
      bass: { enabled: true, amount: 0.25, freq: 70 },
      widen: { enabled: true, width: 1.35 },
      surround: { enabled: true, amount: 0.6, room: 0.35 },
      comp: { enabled: true, thresholdDb: -24, ratio: 2.5, attackMs: 3, releaseMs: 120, makeupDb: 4 },
    },
  },
  {
    id: 'podcast',
    name: 'Podcast',
    tagline: 'Clear, natural, even voices',
    icon: 'mic',
    accent: ['#eab308', '#f97316'],
    sound: {
      eqGainsDb: [-3, -2, -1, 0, 0, 0.5, 1.5, 1, 0, -1],
      dialogue: { enabled: true, amount: 0.6 },
      widen: { enabled: true, width: 0.85 },
      comp: { enabled: true, thresholdDb: -26, ratio: 3, attackMs: 8, releaseMs: 200, makeupDb: 3 },
      loudness: { enabled: true, targetLufs: -16, maxBoostDb: 9 },
    },
  },
  {
    id: 'bass-boost',
    name: 'Bass Boost',
    tagline: 'Powerful, controlled low end',
    icon: 'speaker',
    accent: ['#ec4899', '#8b5cf6'],
    sound: {
      eqGainsDb: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0],
      bassDb: 2,
      bass: { enabled: true, amount: 0.8, freq: 85 },
    },
  },
  {
    id: 'vocal',
    name: 'Vocal Clarity',
    tagline: 'Forward vocals and dialogue',
    icon: 'voice',
    accent: ['#14b8a6', '#3b82f6'],
    sound: {
      eqGainsDb: [-2, -1.5, -1, 0, 1, 2, 3, 2, 0.5, 0],
      dialogue: { enabled: true, amount: 0.5 },
    },
  },
  {
    id: 'studio',
    name: 'Studio',
    tagline: 'Neutral and accurate reference',
    icon: 'sliders',
    accent: ['#64748b', '#94a3b8'],
    sound: {},
  },
  {
    id: 'night',
    name: 'Night Mode',
    tagline: 'Tamed peaks, clear dialogue at low volume',
    icon: 'moon',
    accent: ['#6366f1', '#0ea5e9'],
    sound: {
      eqGainsDb: [-3, -2, -1, 0, 0, 0.5, 1, 0.5, 0, 0],
      dialogue: { enabled: true, amount: 0.5 },
      comp: { enabled: true, thresholdDb: -32, ratio: 4, attackMs: 5, releaseMs: 250, makeupDb: 8 },
      loudness: { enabled: true, targetLufs: -20, maxBoostDb: 6 },
    },
  },
  {
    id: 'immersive',
    name: 'Immersive',
    tagline: 'Virtual surround and a wider soundstage',
    icon: 'orbit',
    accent: ['#06b6d4', '#a855f7'],
    sound: {
      eqGainsDb: [2, 1.5, 0.5, 0, 0, 0, 0.5, 1.5, 2, 2],
      bass: { enabled: true, amount: 0.4, freq: 80 },
      widen: { enabled: true, width: 1.5 },
      surround: { enabled: true, amount: 0.8, room: 0.8 },
      upmix: true,
    },
  },
  {
    id: 'custom',
    name: 'Custom',
    tagline: 'Your own configuration',
    icon: 'wand',
    accent: ['#f43f5e', '#f59e0b'],
    sound: {},
  },
];

export const EQ_PROFILES: EqProfile[] = [
  { id: 'flat', name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'pop', name: 'Pop', gains: [-1.5, -0.5, 1, 2.5, 3.5, 2.5, 1, -0.5, -1, -1.5] },
  { id: 'rock', name: 'Rock', gains: [4, 3, 1.5, -0.5, -1.5, -1, 1, 2.5, 3.5, 4] },
  { id: 'jazz', name: 'Jazz', gains: [3, 2, 1, 1.5, -1, -1, 0, 1, 2, 3] },
  { id: 'classical', name: 'Classical', gains: [2.5, 2, 1.5, 1, 0, 0, 0, 1, 1.5, 2] },
  { id: 'hiphop', name: 'Hip-Hop', gains: [5, 4.5, 2, 3, -1, -1, 1, -0.5, 1, 2] },
  { id: 'edm', name: 'EDM', gains: [5, 4, 1.5, 0, -1, 0.5, 0, 1.5, 3.5, 4] },
  { id: 'acoustic', name: 'Acoustic', gains: [2, 2, 1.5, 0.5, 1, 1, 2, 2.5, 2, 1.5] },
];

export function experienceById(id: string): Experience | undefined {
  return EXPERIENCES.find((e) => e.id === id);
}

/** Full settings for an experience on top of the neutral defaults. */
export function soundForExperience(id: string, custom?: SoundSettings): SoundSettings {
  if (id === 'custom' && custom) return normalizeSound(custom);
  const exp = experienceById(id);
  return normalizeSound(mergeSound(defaultSound(), exp?.sound));
}
