// Turns the user's settings for a device into the flat parameter object the
// native engine expects, applying the hearing-safety rules on the way.
import { AppSettings, DeviceClassification, DeviceProfile, SoundSettings } from './types';

export interface NativeParams {
  enabled: boolean;
  preampDb: number;
  outputGainDb: number;
  balance: number;
  eqEnabled: boolean;
  eqGainsDb: number[];
  eqQ: number;
  bassDb: number;
  midDb: number;
  trebleDb: number;
  deviceEqEnabled: boolean;
  deviceEqPreampDb: number;
  deviceFilters: Array<{ type: number; freq: number; q: number; gainDb: number }>;
  bassEnabled: boolean;
  bassAmount: number;
  bassFreq: number;
  dialogueEnabled: boolean;
  dialogueAmount: number;
  widenEnabled: boolean;
  width: number;
  surroundEnabled: boolean;
  surroundAmount: number;
  surroundRoom: number;
  surroundMode: number;
  compEnabled: boolean;
  compThresholdDb: number;
  compRatio: number;
  compAttackMs: number;
  compReleaseMs: number;
  compMakeupDb: number;
  loudnessEnabled: boolean;
  loudnessTargetLufs: number;
  loudnessMaxBoostDb: number;
  upmixEnabled: boolean;
  limiterCeilingDb: number;
  maxBoostDb: number;
  autoHeadroom: boolean;
}

export interface SafetyLimits {
  ceilingDb: number;
  maxBoostDb: number;
  totalBoostDb: number;
  warning: string | null;
}

/** Headphone listening gets a lower ceiling and a tighter boost cap. */
export function safetyLimits(
  sound: SoundSettings,
  settings: Pick<AppSettings, 'limiterCeilingDb' | 'hearingProtection'>,
  headphoneLike: boolean,
): SafetyLimits {
  const protect = settings.hearingProtection;
  const ceilingDb = protect && headphoneLike ? Math.min(settings.limiterCeilingDb, -3) : settings.limiterCeilingDb;
  const maxBoostDb = protect ? 12 : 18;
  const eqPeak = Math.max(0, ...sound.eqGainsDb);
  const tonePeak = Math.max(0, sound.bassDb, sound.midDb, sound.trebleDb);
  const totalBoostDb =
    Math.max(0, sound.preampDb) +
    Math.max(0, sound.outputGainDb) +
    (sound.comp.enabled ? sound.comp.makeupDb : 0) +
    (sound.loudness.enabled ? sound.loudness.maxBoostDb : 0) +
    eqPeak +
    tonePeak;
  let warning: string | null = null;
  if (totalBoostDb > 18) {
    warning = `Combined boosts reach about +${totalBoostDb.toFixed(0)} dB. The limiter prevents clipping, but consider lowering your system volume to protect your hearing.`;
  } else if (headphoneLike && totalBoostDb > 12) {
    warning = 'High boost on headphones. Keep the system volume moderate.';
  }
  return { ceilingDb, maxBoostDb, totalBoostDb, warning };
}

export function surroundModeFor(sound: SoundSettings, classification: DeviceClassification | null): number {
  if (sound.surround.mode === 'headphones') return 0;
  if (sound.surround.mode === 'speakers') return 1;
  return classification && !classification.headphoneLike ? 1 : 0;
}

export function composeParams(opts: {
  sound: SoundSettings;
  settings: Pick<AppSettings, 'limiterCeilingDb' | 'hearingProtection' | 'autoHeadroom'>;
  classification: DeviceClassification | null;
  profile: DeviceProfile | null;
  deviceCorrection: boolean;
  bypass: boolean;
  outputChannels: number;
}): NativeParams {
  const { sound, settings, classification, profile, deviceCorrection, bypass, outputChannels } = opts;
  const limits = safetyLimits(sound, settings, classification?.headphoneLike ?? false);
  const useDevice = deviceCorrection && !!profile && profile.filters.length > 0;
  return {
    enabled: !bypass,
    preampDb: sound.preampDb,
    outputGainDb: sound.outputGainDb,
    balance: sound.balance,
    eqEnabled: sound.eqEnabled,
    eqGainsDb: [...sound.eqGainsDb],
    eqQ: sound.eqQ,
    bassDb: sound.bassDb,
    midDb: sound.midDb,
    trebleDb: sound.trebleDb,
    deviceEqEnabled: useDevice,
    // With automatic headroom the engine computes the trim from the full
    // response; otherwise use the profile's own clip-safe preamp.
    deviceEqPreampDb: useDevice && !settings.autoHeadroom ? Math.min(0, profile!.preampDb) : 0,
    deviceFilters: useDevice ? profile!.filters.slice(0, 10).map((f) => ({ ...f })) : [],
    bassEnabled: sound.bass.enabled,
    bassAmount: sound.bass.amount,
    bassFreq: sound.bass.freq,
    dialogueEnabled: sound.dialogue.enabled,
    dialogueAmount: sound.dialogue.amount,
    widenEnabled: sound.widen.enabled,
    width: sound.widen.width,
    surroundEnabled: sound.surround.enabled,
    surroundAmount: sound.surround.amount,
    surroundRoom: sound.surround.room,
    surroundMode: surroundModeFor(sound, classification),
    compEnabled: sound.comp.enabled,
    compThresholdDb: sound.comp.thresholdDb,
    compRatio: sound.comp.ratio,
    compAttackMs: sound.comp.attackMs,
    compReleaseMs: sound.comp.releaseMs,
    compMakeupDb: sound.comp.makeupDb,
    loudnessEnabled: sound.loudness.enabled,
    loudnessTargetLufs: sound.loudness.targetLufs,
    loudnessMaxBoostDb: sound.loudness.maxBoostDb,
    upmixEnabled: sound.upmix && outputChannels > 2,
    limiterCeilingDb: limits.ceilingDb,
    maxBoostDb: limits.maxBoostDb,
    autoHeadroom: settings.autoHeadroom,
  };
}
