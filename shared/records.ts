// Pure state transitions for per-device settings and user presets. The main
// process persists the results; keeping the logic here makes it testable.
import { classifyDevice, matchProfile, profileById } from './devices';
import { cloneSound, defaultSound, experienceById, mergeSound, normalizeSound, soundForExperience } from './sound';
import { AppSettings, DeviceRecord, NativeDevice, SoundSettings, UserPreset } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  processing: false,
  bufferFrames: 256,
  autoHeadroom: true,
  limiterCeilingDb: -1,
  hearingProtection: true,
  autoSwitchProfiles: true,
  launchAtLogin: false,
  startHidden: false,
  pinnedOutputId: '',
  captureDeviceId: '',
  visualizerFps: 60,
};

export function normalizeSettings(input: unknown): AppSettings {
  const s = { ...DEFAULT_SETTINGS, ...((input ?? {}) as Partial<AppSettings>) };
  const pick = <T>(v: T, allowed: readonly T[], def: T) => (allowed.includes(v) ? v : def);
  return {
    theme: pick(s.theme, ['system', 'dark', 'light'] as const, 'system'),
    processing: !!s.processing,
    bufferFrames: pick(Number(s.bufferFrames) as AppSettings['bufferFrames'], [128, 256, 512, 1024] as const, 256),
    autoHeadroom: s.autoHeadroom !== false,
    limiterCeilingDb: Math.min(-0.1, Math.max(-12, Number.isFinite(s.limiterCeilingDb) ? s.limiterCeilingDb : -1)),
    hearingProtection: s.hearingProtection !== false,
    autoSwitchProfiles: s.autoSwitchProfiles !== false,
    launchAtLogin: !!s.launchAtLogin,
    startHidden: !!s.startHidden,
    pinnedOutputId: typeof s.pinnedOutputId === 'string' ? s.pinnedOutputId : '',
    captureDeviceId: typeof s.captureDeviceId === 'string' ? s.captureDeviceId : '',
    visualizerFps: pick(Number(s.visualizerFps) as 30 | 60, [30, 60] as const, 60),
  };
}

/** New record for a device seen for the first time. */
export function createRecord(device: NativeDevice, now = Date.now()): DeviceRecord {
  const classification = classifyDevice(device);
  const profile = matchProfile(device, classification);
  const experienceId = classification.headphoneLike ? 'music' : classification.category === 'tv' ? 'cinema' : 'music';
  const sound = applyRecommendations(soundForExperience(experienceId), profile?.recommended);
  return {
    id: device.id,
    name: device.name,
    firstSeen: now,
    lastSeen: now,
    category: classification.category,
    brand: classification.brand,
    profileMode: 'auto',
    profileId: profile?.id ?? null,
    channelConfig: 'auto',
    experienceId,
    sound,
    customSound: cloneSound(sound),
  };
}

function applyRecommendations(sound: SoundSettings, rec: Parameters<typeof mergeSound>[1]): SoundSettings {
  if (!rec) return sound;
  // Recommendations only switch on helpers; they never override an explicit choice
  // of the experience, except the surround mode which depends on the hardware.
  const merged = mergeSound(sound, { surround: { mode: rec.surround?.mode ?? sound.surround.mode } });
  if (rec.bass?.enabled && !merged.bass.enabled) merged.bass = { ...merged.bass, ...rec.bass, enabled: true } as SoundSettings['bass'];
  return normalizeSound(merged);
}

/** Restores (or creates) the record for a device; updates its name/last-seen. */
export function resolveRecord(
  records: Record<string, DeviceRecord>,
  device: NativeDevice,
  now = Date.now(),
): { record: DeviceRecord; created: boolean } {
  const existing = records[device.id];
  if (!existing) return { record: createRecord(device, now), created: true };
  const record = { ...existing, name: device.name, lastSeen: now, sound: normalizeSound(existing.sound), customSound: normalizeSound(existing.customSound) };
  if (record.profileMode === 'auto') {
    // Pick up newly added profiles for devices still on automatic matching.
    const cls = classifyDevice(device);
    record.profileId = matchProfile(device, cls)?.id ?? record.profileId;
  } else if (record.profileMode === 'manual' && !profileById(record.profileId)) {
    record.profileMode = 'auto';
    record.profileId = matchProfile(device, classifyDevice(device))?.id ?? null;
  }
  return { record, created: false };
}

export function selectExperience(record: DeviceRecord, experienceId: string): DeviceRecord {
  if (!experienceById(experienceId)) throw new Error(`Unknown experience: ${experienceId}`);
  const profile = profileById(record.profileId);
  const base = experienceId === 'custom' ? normalizeSound(record.customSound) : soundForExperience(experienceId);
  const sound =
    experienceId === 'custom'
      ? base
      : normalizeSound(mergeSound(base, { surround: { mode: profile?.recommended?.surround?.mode ?? 'auto' } }));
  return { ...record, experienceId, sound };
}

/**
 * Applies an edit. Editing any control turns the configuration into the
 * device's "Custom" experience, so a predefined experience is never lost.
 */
export function editSound(record: DeviceRecord, patch: Parameters<typeof mergeSound>[1]): DeviceRecord {
  const sound = normalizeSound(mergeSound(record.sound, patch));
  return { ...record, experienceId: 'custom', sound, customSound: cloneSound(sound) };
}

export function resetSound(record: DeviceRecord, section?: keyof SoundSettings): DeviceRecord {
  const neutral = defaultSound();
  if (!section) return editSound(record, neutral);
  return editSound(record, { [section]: neutral[section] } as Parameters<typeof mergeSound>[1]);
}

export function setProfile(record: DeviceRecord, profileId: string | null, mode: DeviceRecord['profileMode']): DeviceRecord {
  if (mode === 'manual' && !profileById(profileId)) throw new Error('Unknown device profile');
  return { ...record, profileMode: mode, profileId: mode === 'none' ? record.profileId : profileId };
}

// ---------------------------------------------------------------- presets
export const MAX_PRESET_NAME = 40;

export function validatePresetName(name: string, presets: UserPreset[], ignoreId?: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new Error('Preset name cannot be empty.');
  if (trimmed.length > MAX_PRESET_NAME) throw new Error(`Preset names are limited to ${MAX_PRESET_NAME} characters.`);
  if (presets.some((p) => p.id !== ignoreId && p.name.toLowerCase() === trimmed.toLowerCase()))
    throw new Error(`A preset named “${trimmed}” already exists.`);
  return trimmed;
}

export function createPreset(presets: UserPreset[], name: string, sound: SoundSettings, now = Date.now()): UserPreset[] {
  const clean = validatePresetName(name, presets);
  const id = `user-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return [...presets, { id, name: clean, createdAt: now, updatedAt: now, sound: normalizeSound(sound) }];
}

export function renamePreset(presets: UserPreset[], id: string, name: string, now = Date.now()): UserPreset[] {
  if (!presets.some((p) => p.id === id)) throw new Error('Preset not found.');
  const clean = validatePresetName(name, presets, id);
  return presets.map((p) => (p.id === id ? { ...p, name: clean, updatedAt: now } : p));
}

export function updatePreset(presets: UserPreset[], id: string, sound: SoundSettings, now = Date.now()): UserPreset[] {
  if (!presets.some((p) => p.id === id)) throw new Error('Preset not found.');
  return presets.map((p) => (p.id === id ? { ...p, sound: normalizeSound(sound), updatedAt: now } : p));
}

export function deletePreset(presets: UserPreset[], id: string): UserPreset[] {
  return presets.filter((p) => p.id !== id);
}

export function applyPreset(record: DeviceRecord, preset: UserPreset): DeviceRecord {
  return { ...record, experienceId: 'custom', sound: normalizeSound(preset.sound), customSound: normalizeSound(preset.sound) };
}
