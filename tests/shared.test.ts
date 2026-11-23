import { describe, expect, it } from 'vitest';
import { composeParams, safetyLimits } from '../shared/compose';
import { classifyDevice, DEVICE_PROFILES, matchProfile, profileById } from '../shared/devices';
import {
  applyPreset,
  createPreset,
  createRecord,
  deletePreset,
  DEFAULT_SETTINGS,
  editSound,
  normalizeSettings,
  renamePreset,
  resetSound,
  resolveRecord,
  selectExperience,
} from '../shared/records';
import { defaultSound, EQ_PROFILES, EXPERIENCES, mergeSound, normalizeSound, soundForExperience } from '../shared/sound';
import type { NativeDevice } from '../shared/types';

const dev = (name: string, extra: Partial<NativeDevice> = {}): NativeDevice => ({
  id: `id:${name}`,
  name,
  manufacturer: '',
  modelId: '',
  transport: 'bluetooth',
  formFactor: 'unknown',
  dataSource: '',
  channels: 2,
  sampleRate: 48000,
  isDefault: true,
  isVirtual: false,
  ...extra,
});

describe('experiences and EQ profiles', () => {
  it('provides all ten required experiences', () => {
    expect(EXPERIENCES.map((e) => e.id)).toEqual([
      'music', 'cinema', 'gaming', 'podcast', 'bass-boost', 'vocal', 'studio', 'night', 'immersive', 'custom',
    ]);
  });
  it('provides the required genre EQ profiles with 10 bands each', () => {
    for (const name of ['Pop', 'Rock', 'Jazz', 'Classical', 'Hip-Hop', 'EDM', 'Acoustic'])
      expect(EQ_PROFILES.find((p) => p.name === name)?.gains).toHaveLength(10);
  });
  it('every experience normalises to valid, in-range settings', () => {
    for (const e of EXPERIENCES) {
      const s = soundForExperience(e.id);
      expect(normalizeSound(s)).toEqual(s);
    }
  });
  it('studio is neutral', () => {
    const s = soundForExperience('studio');
    expect(s.eqGainsDb.every((g) => g === 0)).toBe(true);
    expect(s.bass.enabled || s.surround.enabled || s.comp.enabled || s.loudness.enabled).toBe(false);
  });
  it('night mode compresses and normalises loudness', () => {
    const s = soundForExperience('night');
    expect(s.comp.enabled && s.loudness.enabled && s.dialogue.enabled).toBe(true);
  });
});

describe('normalizeSound', () => {
  it('clamps hostile input', () => {
    const s = normalizeSound({ preampDb: 99, eqGainsDb: [50, -50, NaN], comp: { ratio: -3 }, surround: { mode: 'bogus' } });
    expect(s.preampDb).toBe(12);
    expect(s.eqGainsDb.slice(0, 3)).toEqual([12, -12, 0]);
    expect(s.eqGainsDb).toHaveLength(10);
    expect(s.comp.ratio).toBe(1);
    expect(s.surround.mode).toBe('auto');
  });
  it('mergeSound deep-merges without mutating', () => {
    const base = defaultSound();
    const out = mergeSound(base, { bass: { amount: 0.9 } });
    expect(out.bass).toEqual({ enabled: false, amount: 0.9, freq: 90 });
    expect(base.bass.amount).toBe(0.5);
  });
});

describe('device classification', () => {
  it.each([
    ['WH-1000XM5', 'headphones', 'Sony'],
    ['AirPods Pro', 'earbuds', 'Apple'],
    ['AirPods Max', 'headphones', 'Apple'],
    ['Galaxy Buds2 Pro', 'earbuds', 'Samsung'],
    ['JBL Flip 6', 'bluetooth-speaker', 'JBL'],
    ['Bose QC45', 'headphones', 'Bose'],
    ['Samsung HW-Q990C Soundbar', 'soundbar', 'Samsung'],
    ['LG TV SSCR2', 'tv', 'LG'],
    ['Sonos Arc', 'soundbar', 'Sonos'],
  ])('%s → %s (%s)', (name, category, brand) => {
    const c = classifyDevice(dev(name));
    expect(c.category).toBe(category);
    expect(c.brand).toBe(brand);
  });
  it('recognises built-in laptop speakers and wired headphones', () => {
    expect(classifyDevice(dev('MacBook Air Speakers', { transport: 'builtin', dataSource: 'ispk' })).category).toBe('laptop');
    expect(classifyDevice(dev('External Headphones', { transport: 'builtin', dataSource: 'hdpn' })).headphoneLike).toBe(true);
    expect(classifyDevice(dev('Speakers (Realtek)', { transport: 'builtin', formFactor: 'speakers' })).category).toBe('laptop');
  });
  it('flags virtual endpoints', () => {
    expect(classifyDevice(dev('CABLE Input (VB-Audio Virtual Cable)', { isVirtual: true, transport: 'virtual' })).category).toBe('virtual');
  });
});

describe('device profiles', () => {
  it('measured profiles are credited and carry real filters', () => {
    const measured = DEVICE_PROFILES.filter((p) => p.verification === 'measured');
    expect(measured.length).toBeGreaterThan(20);
    for (const p of measured) {
      expect(p.source).toMatch(/AutoEq/);
      expect(p.sourceUrl).toMatch(/^https:\/\/github.com\/jaakkopasanen\/AutoEq/);
      expect(p.filters.length).toBeGreaterThan(0);
    }
  });
  it('covers the required brands', () => {
    for (const b of ['Sony', 'Bose', 'JBL', 'Samsung', 'LG', 'Sonos', 'Apple'])
      expect(DEVICE_PROFILES.some((p) => p.brand === b)).toBe(true);
  });
  it('speakers and soundbars are never labelled measured', () => {
    for (const p of DEVICE_PROFILES.filter((x) => !['headphones', 'earbuds'].includes(x.category)))
      expect(p.verification).not.toBe('measured');
  });
  it('matches measured profiles by name', () => {
    const d = dev('WH-1000XM4');
    expect(matchProfile(d, classifyDevice(d))?.id).toBe('measured:sony-wh-1000xm4');
    const e = dev("Binwin's AirPods Pro 2");
    expect(matchProfile(e, classifyDevice(e))?.model).toBe('AirPods Pro 2');
    const f = dev('AirPods Pro');
    expect(matchProfile(f, classifyDevice(f))?.model).toBe('AirPods Pro');
  });
  it('falls back to estimated, then generic', () => {
    const s = dev('JBL Charge 5');
    expect(matchProfile(s, classifyDevice(s))?.verification).toBe('estimated');
    const g = dev('Unknown BT Thing');
    expect(matchProfile(g, classifyDevice(g))?.verification).toBe('generic');
  });
  it('profile ids are unique and filters valid', () => {
    const ids = new Set(DEVICE_PROFILES.map((p) => p.id));
    expect(ids.size).toBe(DEVICE_PROFILES.length);
    for (const p of DEVICE_PROFILES) {
      expect(p.filters.length).toBeLessThanOrEqual(10);
      for (const f of p.filters) {
        expect(f.freq).toBeGreaterThan(10);
        expect(f.q).toBeGreaterThan(0);
        expect(Math.abs(f.gainDb)).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe('per-device records', () => {
  it('creates a record with a matched profile', () => {
    const r = createRecord(dev('WH-1000XM5'), 1);
    expect(r.profileMode).toBe('auto');
    expect(r.profileId).toBe('measured:sony-wh-1000xm5');
    expect(r.sound.surround.mode).toBe('headphones');
  });
  it('remembers settings and restores them on reconnect', () => {
    const d = dev('JBL Flip 6');
    let r = createRecord(d, 1);
    r = selectExperience(r, 'cinema');
    const { record, created } = resolveRecord({ [d.id]: r }, d, 5);
    expect(created).toBe(false);
    expect(record.experienceId).toBe('cinema');
    expect(record.lastSeen).toBe(5);
  });
  it('editing turns the configuration into Custom without losing it', () => {
    let r = createRecord(dev('X'), 1);
    r = selectExperience(r, 'gaming');
    r = editSound(r, { trebleDb: 4 });
    expect(r.experienceId).toBe('custom');
    expect(r.customSound.trebleDb).toBe(4);
    r = selectExperience(r, 'music');
    expect(r.sound.trebleDb).toBe(0);
    r = selectExperience(r, 'custom');
    expect(r.sound.trebleDb).toBe(4);
  });
  it('resets one section or everything', () => {
    let r = editSound(createRecord(dev('X'), 1), { bass: { enabled: true, amount: 1 }, trebleDb: 5 });
    r = resetSound(r, 'bass');
    expect(r.sound.bass).toEqual(defaultSound().bass);
    expect(r.sound.trebleDb).toBe(5);
    r = resetSound(r);
    expect(r.sound).toEqual(defaultSound());
  });
  it('falls back to automatic matching if a manual profile disappears', () => {
    const d = dev('WH-1000XM4');
    const r = { ...createRecord(d), profileMode: 'manual' as const, profileId: 'gone:profile' };
    const { record } = resolveRecord({ [d.id]: r }, d);
    expect(record.profileMode).toBe('auto');
    expect(profileById(record.profileId)).not.toBeNull();
  });
});

describe('user presets', () => {
  it('creates, renames, applies and deletes', () => {
    const s = mergeSound(defaultSound(), { bassDb: 3 });
    let p = createPreset([], '  Late   night  ', s, 10);
    expect(p[0].name).toBe('Late night');
    p = renamePreset(p, p[0].id, 'Movie night');
    expect(p[0].name).toBe('Movie night');
    const r = applyPreset(createRecord(dev('X')), p[0]);
    expect(r.sound.bassDb).toBe(3);
    expect(deletePreset(p, p[0].id)).toEqual([]);
  });
  it('rejects empty, duplicate and over-long names', () => {
    const p = createPreset([], 'One', defaultSound());
    expect(() => createPreset(p, '   ', defaultSound())).toThrow(/empty/);
    expect(() => createPreset(p, 'one', defaultSound())).toThrow(/exists/);
    expect(() => createPreset(p, 'x'.repeat(41), defaultSound())).toThrow(/40/);
  });
});

describe('engine parameter composition & safety', () => {
  const settings = { ...DEFAULT_SETTINGS };
  it('lowers the ceiling for headphones with hearing protection', () => {
    expect(safetyLimits(defaultSound(), settings, true).ceilingDb).toBe(-3);
    expect(safetyLimits(defaultSound(), settings, false).ceilingDb).toBe(-1);
    expect(safetyLimits(defaultSound(), { ...settings, hearingProtection: false }, true).ceilingDb).toBe(-1);
  });
  it('warns when boosts stack up', () => {
    const loud = mergeSound(defaultSound(), { preampDb: 12, eqGainsDb: new Array(10).fill(12), comp: { enabled: true, makeupDb: 10 } });
    expect(safetyLimits(loud, settings, false).warning).toMatch(/hearing/);
  });
  it('maps bypass, device filters and channel-dependent up-mix', () => {
    const d = dev('WH-1000XM4');
    const cls = classifyDevice(d);
    const profile = matchProfile(d, cls);
    const sound = mergeSound(soundForExperience('cinema'), {});
    const p = composeParams({ sound, settings, classification: cls, profile, deviceCorrection: true, bypass: true, outputChannels: 2 });
    expect(p.enabled).toBe(false);
    expect(p.deviceEqEnabled).toBe(true);
    expect(p.deviceFilters.length).toBe(profile!.filters.length);
    expect(p.upmixEnabled).toBe(false);
    expect(p.surroundMode).toBe(0);
    const six = composeParams({ sound, settings, classification: classifyDevice(dev('AVR', { transport: 'hdmi', channels: 6 })), profile: null, deviceCorrection: true, bypass: false, outputChannels: 6 });
    expect(six.upmixEnabled).toBe(true);
    expect(six.surroundMode).toBe(1);
    expect(six.deviceEqEnabled).toBe(false);
  });
});

describe('settings', () => {
  it('normalises unknown and invalid values', () => {
    const s = normalizeSettings({ theme: 'neon', bufferFrames: 7, limiterCeilingDb: 3, visualizerFps: 144 });
    expect(s.theme).toBe('system');
    expect(s.bufferFrames).toBe(256);
    expect(s.limiterCeilingDb).toBe(-0.1);
    expect(s.visualizerFps).toBe(60);
  });
});
