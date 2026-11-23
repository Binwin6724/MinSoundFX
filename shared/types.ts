// Types shared by the Electron main process and the renderer.

export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_BANDS = EQ_FREQUENCIES.length;

export type SurroundModeSetting = 'auto' | 'headphones' | 'speakers';

/** Everything the user can tune for a device. Stored per device. */
export interface SoundSettings {
  preampDb: number;
  outputGainDb: number;
  balance: number;
  eqEnabled: boolean;
  eqGainsDb: number[];
  eqQ: number;
  bassDb: number;
  midDb: number;
  trebleDb: number;
  bass: { enabled: boolean; amount: number; freq: number };
  dialogue: { enabled: boolean; amount: number };
  widen: { enabled: boolean; width: number };
  surround: { enabled: boolean; amount: number; room: number; mode: SurroundModeSetting };
  comp: { enabled: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number };
  loudness: { enabled: boolean; targetLufs: number; maxBoostDb: number };
  upmix: boolean;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export interface Experience {
  id: string;
  name: string;
  tagline: string;
  icon: string;
  accent: [string, string];
  sound: DeepPartial<SoundSettings>;
}

export interface EqProfile {
  id: string;
  name: string;
  gains: number[];
}

export interface UserPreset {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sound: SoundSettings;
}

/** Filter types map 1:1 to the native engine's FilterType. */
export enum FilterType {
  Peak = 0,
  LowShelf = 1,
  HighShelf = 2,
  LowPass = 3,
  HighPass = 4,
}

export interface DeviceFilter {
  type: FilterType;
  freq: number;
  q: number;
  gainDb: number;
}

export type ProfileVerification = 'measured' | 'estimated' | 'generic';
export type DeviceCategory =
  | 'headphones'
  | 'earbuds'
  | 'speakers'
  | 'laptop'
  | 'soundbar'
  | 'tv'
  | 'bluetooth-speaker'
  | 'display'
  | 'home-theater'
  | 'virtual'
  | 'unknown';

export type ChannelConfig = '2.0' | '2.1' | '5.1' | '7.1';

export interface DeviceProfile {
  id: string;
  brand: string;
  model: string;
  category: DeviceCategory;
  channels: ChannelConfig;
  verification: ProfileVerification;
  /** Where the correction comes from (measurement source or tuning basis). */
  source: string;
  sourceUrl?: string;
  /** Case-insensitive regular expressions matched against the OS device name. */
  match: string[];
  preampDb: number;
  filters: DeviceFilter[];
  /** Settings the profile suggests (e.g. speaker-style virtualisation). */
  recommended?: DeepPartial<SoundSettings>;
  notes?: string;
}

/** As reported by the native backend. */
export interface NativeDevice {
  id: string;
  name: string;
  manufacturer: string;
  modelId: string;
  transport: string;
  formFactor: string;
  dataSource: string;
  channels: number;
  sampleRate: number;
  isDefault: boolean;
  isVirtual: boolean;
}

export interface DeviceClassification {
  category: DeviceCategory;
  brand: string | null;
  headphoneLike: boolean;
  label: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  category: DeviceCategory;
  brand: string | null;
  /** 'auto' follows name matching; 'manual' keeps the user's pick; 'none' disables correction. */
  profileMode: 'auto' | 'manual' | 'none';
  profileId: string | null;
  channelConfig: 'auto' | ChannelConfig;
  experienceId: string;
  sound: SoundSettings;
  customSound: SoundSettings;
}

export interface AppSettings {
  theme: 'system' | 'dark' | 'light';
  processing: boolean;
  bufferFrames: 128 | 256 | 512 | 1024;
  autoHeadroom: boolean;
  limiterCeilingDb: number;
  hearingProtection: boolean;
  autoSwitchProfiles: boolean;
  launchAtLogin: boolean;
  startHidden: boolean;
  pinnedOutputId: string;
  captureDeviceId: string;
  visualizerFps: 30 | 60;
}

export interface EngineStatus {
  state: 'stopped' | 'running' | 'error' | 'unsupported' | 'needs-setup';
  message: string;
  deviceId: string;
  deviceName: string;
  captureDeviceId: string;
  sampleRate: number;
  inChannels: number;
  outChannels: number;
  bufferFrames: number;
  latencyMs: number;
  generation: number;
  rebuilds: number;
  originalDefaultId: string;
}

export interface PlatformInfo {
  platform: string;
  captureMethod: string;
  supported: boolean;
  reason: string;
  requiresVirtualDevice: boolean;
}

export interface Meters {
  peaks: number[];
  rms: number[];
  inPeak: number;
  limiterGrDb: number;
  compGrDb: number;
  agcGainDb: number;
  bassBoostDb: number;
  loudnessLufs: number;
  cpuLoad: number;
  wetMix: number;
  framesProcessed: number;
  nonFiniteEvents: number;
}

export interface AnalysisFrame {
  original?: number[];
  processed?: number[];
  waveform?: number[];
  waveformOriginal?: number[];
  meters: Meters;
  bands: number;
}

/** Snapshot sent to the renderer. */
export interface AppState {
  settings: AppSettings;
  platform: PlatformInfo;
  status: EngineStatus;
  bypass: boolean;
  devices: Array<NativeDevice & { classification: DeviceClassification }>;
  activeDevice: (NativeDevice & { classification: DeviceClassification }) | null;
  record: DeviceRecord | null;
  profile: DeviceProfile | null;
  suggestedProfileId: string | null;
  experiences: Experience[];
  eqProfiles: EqProfile[];
  userPresets: UserPreset[];
  profiles: DeviceProfile[];
  safety: { ceilingDb: number; maxBoostDb: number; totalBoostDb: number; warning: string | null };
  headroomDb: number;
  remembered: Array<Pick<DeviceRecord, 'id' | 'name' | 'category' | 'lastSeen' | 'experienceId' | 'profileId'> & { connected: boolean }>;
  logPath: string | null;
  version: string;
}
