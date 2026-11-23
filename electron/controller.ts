// AudioController: the single owner of the native engine. It keeps the
// engine parameters in sync with the active device's saved settings, reacts
// to device changes, persists everything and repairs audio routing.
import { EventEmitter } from 'node:events';
import { classifyDevice, DEVICE_PROFILES, matchProfile, profileById } from '../shared/devices';
import { composeParams, safetyLimits } from '../shared/compose';
import {
  applyPreset,
  createPreset,
  deletePreset,
  DEFAULT_SETTINGS,
  editSound,
  normalizeSettings,
  renamePreset,
  resetSound,
  resolveRecord,
  selectExperience,
  setProfile,
  updatePreset,
} from '../shared/records';
import { EQ_PROFILES, EXPERIENCES, mergeSound } from '../shared/sound';
import type {
  AppSettings,
  AppState,
  ChannelConfig,
  DeepPartial,
  DeviceRecord,
  EngineStatus,
  NativeDevice,
  SoundSettings,
  UserPreset,
} from '../shared/types';
import { log } from './logger';
import type { NativeModule } from './native';
import { JsonStore } from './store';

export interface PersistedData {
  version: number;
  settings: AppSettings;
  records: Record<string, DeviceRecord>;
  presets: UserPreset[];
  /** Windows: real default output to restore if we crash while routed. */
  pendingRestore: string;
}

const EMPTY_STATUS: EngineStatus = {
  state: 'stopped',
  message: '',
  deviceId: '',
  deviceName: '',
  captureDeviceId: '',
  sampleRate: 0,
  inChannels: 0,
  outChannels: 0,
  bufferFrames: 0,
  latencyMs: 0,
  generation: 0,
  rebuilds: 0,
  originalDefaultId: '',
};

export class AudioController extends EventEmitter {
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private records: Record<string, DeviceRecord> = {};
  private presets: UserPreset[] = [];
  private devices: NativeDevice[] = [];
  private status: EngineStatus = { ...EMPTY_STATUS };
  private activeId = '';
  private bypass = false;
  private headroomDb = 0;
  private lastGeneration = -1;
  private lastDevicesGen = -1;
  private pollTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly native: NativeModule,
    private readonly store: JsonStore<PersistedData>,
    private readonly version: string,
  ) {
    super();
  }

  // ---------------------------------------------------------------- lifecycle
  init() {
    const data = this.store.get();
    this.settings = normalizeSettings(data.settings);
    this.records = data.records ?? {};
    this.presets = Array.isArray(data.presets) ? data.presets : [];
    this.refreshDevices();
    this.repairRouting(data.pendingRestore);
    this.selectActiveDevice();
    if (this.settings.processing) this.start();
    else this.applyParams();
    this.pollTimer = setInterval(() => this.tick(), 250);
    log.info('Controller ready', { devices: this.devices.length, platform: this.native.platformInfo() });
  }

  shutdown() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    try {
      this.native.stop();
      this.store.set({ pendingRestore: '' });
    } catch (err) {
      log.error('Error while stopping engine', err);
    }
    this.store.flush();
    log.info('Engine stopped, routing restored');
  }

  /** Windows: if a previous session crashed while routed, put the real device back. */
  private repairRouting(pending: string) {
    if (!pending || process.platform !== 'win32') return;
    const def = this.devices.find((d) => d.isDefault);
    if (def?.isVirtual && this.devices.some((d) => d.id === pending)) {
      const r = this.native.setSystemDefaultOutput(pending);
      log.warn('Restored default output after an unclean exit', { ok: r.ok, error: r.error });
    }
    this.store.set({ pendingRestore: '' });
  }

  // ---------------------------------------------------------------- engine control
  start(): { ok: boolean; error: string } {
    const r = this.native.start({
      outputDeviceId: this.settings.pinnedOutputId || undefined,
      captureDeviceId: this.settings.captureDeviceId || undefined,
      bufferFrames: this.settings.bufferFrames,
    });
    this.status = r.status;
    this.setSettingsInternal({ processing: true });
    if (r.ok) log.info('Processing started', { device: r.status.deviceName, rate: r.status.sampleRate, ch: r.status.outChannels, latencyMs: r.status.latencyMs.toFixed(1) });
    else log.warn('Processing failed to start', { error: r.error, state: r.status.state });
    if (r.status.originalDefaultId) this.store.set({ pendingRestore: r.status.originalDefaultId });
    this.onEngineStatus(true);
    return { ok: r.ok, error: r.error };
  }

  stop() {
    this.status = this.native.stop();
    this.setSettingsInternal({ processing: false });
    this.store.set({ pendingRestore: '' });
    log.info('Processing stopped');
    this.onEngineStatus(true);
  }

  setProcessing(on: boolean) {
    return on ? this.start() : (this.stop(), { ok: true, error: '' });
  }

  setBypass(on: boolean) {
    this.bypass = on;
    this.applyParams();
    this.emitState();
  }

  private tick() {
    try {
      this.status = this.native.poll();
      const devGen = this.native.devicesGeneration();
      if (devGen !== this.lastDevicesGen) {
        this.lastDevicesGen = devGen;
        this.refreshDevices();
        if (this.status.state !== 'running') this.selectActiveDevice();
        this.emitState();
      }
      this.onEngineStatus(false);
    } catch (err) {
      log.error('Engine poll failed', err);
    }
  }

  private onEngineStatus(force: boolean) {
    if (force || this.status.generation !== this.lastGeneration) {
      const changed = this.status.generation !== this.lastGeneration;
      this.lastGeneration = this.status.generation;
      if (changed && this.status.state === 'running') {
        this.refreshDevices();
        log.info('Processing device', { name: this.status.deviceName, rate: this.status.sampleRate, ch: this.status.outChannels });
      }
      const before = this.activeId;
      this.selectActiveDevice();
      if (before && before !== this.activeId) {
        const rec = this.records[this.activeId];
        this.emit('device-switched', { name: rec?.name ?? this.status.deviceName, experience: rec?.experienceId });
      }
      this.emitState();
    }
  }

  private refreshDevices() {
    try {
      this.devices = this.native.listDevices();
    } catch (err) {
      log.error('Listing devices failed', err);
      this.devices = [];
    }
  }

  /** The device we process to, or (when stopped) the system default output. */
  private selectActiveDevice() {
    const running = this.status.state === 'running' && this.status.deviceId;
    const id = running
      ? this.status.deviceId
      : this.settings.pinnedOutputId && this.devices.some((d) => d.id === this.settings.pinnedOutputId)
        ? this.settings.pinnedOutputId
        : (this.devices.find((d) => d.isDefault && !d.isVirtual)?.id ?? this.devices.find((d) => !d.isVirtual)?.id ?? '');
    const device = this.devices.find((d) => d.id === id);
    if (!device) {
      this.activeId = '';
      return;
    }
    const prev = this.activeId;
    const { record, created } = resolveRecord(this.records, device);
    if (!this.settings.autoSwitchProfiles && !created && prev && prev !== id) {
      // Keep using the previous device's sound on the new device.
      const prevRec = this.records[prev];
      if (prevRec) {
        record.sound = prevRec.sound;
        record.experienceId = prevRec.experienceId;
      }
    }
    this.records[id] = record;
    if (created) log.info('New audio device remembered', { name: device.name, category: record.category, profile: record.profileId });
    this.activeId = id;
    this.persistRecords();
    this.applyParams();
  }

  private activeDevice() {
    return this.devices.find((d) => d.id === this.activeId) ?? null;
  }

  private activeRecord(): DeviceRecord | null {
    return this.activeId ? (this.records[this.activeId] ?? null) : null;
  }

  private effectiveChannels(): number {
    const rec = this.activeRecord();
    const deviceCh = this.status.state === 'running' ? this.status.outChannels : (this.activeDevice()?.channels ?? 2);
    if (!rec || rec.channelConfig === 'auto') return deviceCh;
    const declared = { '2.0': 2, '2.1': 3, '5.1': 6, '7.1': 8 }[rec.channelConfig];
    return Math.min(declared, deviceCh);
  }

  applyParams() {
    const rec = this.activeRecord();
    const device = this.activeDevice();
    if (!rec) return;
    const classification = device ? classifyDevice(device) : null;
    const params = composeParams({
      sound: rec.sound,
      settings: this.settings,
      classification,
      profile: rec.profileMode === 'none' ? null : profileById(rec.profileId),
      deviceCorrection: rec.profileMode !== 'none',
      bypass: this.bypass,
      outputChannels: this.effectiveChannels(),
    });
    try {
      this.headroomDb = this.native.setParams(params).headroomDb;
    } catch (err) {
      log.error('setParams failed', err);
    }
  }

  // ---------------------------------------------------------------- user actions
  private mutateRecord(fn: (r: DeviceRecord) => DeviceRecord) {
    const rec = this.activeRecord();
    if (!rec) throw new Error('No output device is available.');
    this.records[rec.id] = fn(rec);
    this.persistRecords();
    this.applyParams();
    this.emitStateSoon();
  }

  selectExperience(id: string) {
    this.mutateRecord((r) => selectExperience(r, id));
  }

  editSound(patch: DeepPartial<SoundSettings>) {
    this.mutateRecord((r) => editSound(r, patch));
  }

  resetSound(section?: keyof SoundSettings) {
    this.mutateRecord((r) => resetSound(r, section));
  }

  applyEqProfile(id: string) {
    const p = EQ_PROFILES.find((e) => e.id === id);
    if (!p) throw new Error('Unknown equaliser profile');
    this.editSound({ eqEnabled: true, eqGainsDb: [...p.gains] });
  }

  setDeviceProfile(profileId: string | null, mode: DeviceRecord['profileMode']) {
    const device = this.activeDevice();
    this.mutateRecord((r) => {
      if (mode === 'auto' && device) return { ...r, profileMode: 'auto', profileId: matchProfile(device, classifyDevice(device))?.id ?? null };
      return setProfile(r, profileId, mode);
    });
  }

  setChannelConfig(config: 'auto' | ChannelConfig) {
    this.mutateRecord((r) => ({ ...r, channelConfig: config }));
  }

  forgetDevice(id: string) {
    if (id === this.activeId) throw new Error('The active device cannot be forgotten.');
    delete this.records[id];
    this.persistRecords();
    this.emitState();
  }

  savePreset(name: string) {
    const rec = this.activeRecord();
    if (!rec) throw new Error('No device');
    this.presets = createPreset(this.presets, name, rec.sound);
    this.store.set({ presets: this.presets });
    this.emitState();
  }

  renamePreset(id: string, name: string) {
    this.presets = renamePreset(this.presets, id, name);
    this.store.set({ presets: this.presets });
    this.emitState();
  }

  overwritePreset(id: string) {
    const rec = this.activeRecord();
    if (!rec) throw new Error('No device');
    this.presets = updatePreset(this.presets, id, rec.sound);
    this.store.set({ presets: this.presets });
    this.emitState();
  }

  deletePreset(id: string) {
    this.presets = deletePreset(this.presets, id);
    this.store.set({ presets: this.presets });
    this.emitState();
  }

  applyPreset(id: string) {
    const p = this.presets.find((x) => x.id === id);
    if (!p) throw new Error('Preset not found');
    this.mutateRecord((r) => applyPreset(r, p));
  }

  setSettings(patch: Partial<AppSettings>) {
    const before = this.settings;
    this.setSettingsInternal(patch);
    const restart =
      this.settings.processing &&
      (before.bufferFrames !== this.settings.bufferFrames ||
        before.pinnedOutputId !== this.settings.pinnedOutputId ||
        before.captureDeviceId !== this.settings.captureDeviceId);
    if (restart) {
      this.native.stop();
      this.start();
    } else {
      this.selectActiveDevice();
    }
    this.applyParams();
    this.emitState();
    this.emit('settings-changed', this.settings);
  }

  private setSettingsInternal(patch: Partial<AppSettings>) {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    this.store.set({ settings: this.settings });
  }

  getResponse(freqs: number[], patch?: DeepPartial<SoundSettings>, includeDevice = true): number[] {
    const rec = this.activeRecord();
    if (!rec) return freqs.map(() => 0);
    const device = this.activeDevice();
    const sound = patch ? mergeSound(rec.sound, patch) : rec.sound;
    const params = composeParams({
      sound,
      settings: this.settings,
      classification: device ? classifyDevice(device) : null,
      profile: rec.profileMode === 'none' ? null : profileById(rec.profileId),
      deviceCorrection: rec.profileMode !== 'none',
      bypass: false,
      outputChannels: this.effectiveChannels(),
    });
    return Array.from(this.native.getResponse(Float32Array.from(freqs), params, { includeDevice, includeGain: false }));
  }

  getAnalysis(bands: number) {
    return this.native.getAnalysis(bands);
  }

  get currentSettings() {
    return this.settings;
  }

  get isBypassed() {
    return this.bypass;
  }

  // ---------------------------------------------------------------- state
  getState(): AppState {
    const withCls = (d: NativeDevice) => ({ ...d, classification: classifyDevice(d) });
    const device = this.activeDevice();
    const record = this.activeRecord();
    const profile = record && record.profileMode !== 'none' ? profileById(record.profileId) : null;
    const limits = record
      ? safetyLimits(record.sound, this.settings, device ? classifyDevice(device).headphoneLike : false)
      : { ceilingDb: this.settings.limiterCeilingDb, maxBoostDb: 18, totalBoostDb: 0, warning: null };
    return {
      settings: this.settings,
      platform: this.native.platformInfo(),
      status: this.status,
      bypass: this.bypass,
      devices: this.devices.map(withCls),
      activeDevice: device ? withCls(device) : null,
      record,
      profile,
      suggestedProfileId: device ? (matchProfile(device, classifyDevice(device))?.id ?? null) : null,
      experiences: EXPERIENCES,
      eqProfiles: EQ_PROFILES,
      userPresets: this.presets,
      profiles: DEVICE_PROFILES,
      safety: limits,
      headroomDb: this.headroomDb,
      remembered: this.knownDevices().map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        lastSeen: r.lastSeen,
        experienceId: r.experienceId,
        profileId: r.profileId,
        connected: this.devices.some((d) => d.id === r.id),
      })),
      logPath: log.path,
      version: this.version,
    };
  }

  knownDevices(): DeviceRecord[] {
    return Object.values(this.records).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private persistRecords() {
    this.store.set({ records: this.records });
  }

  private emitState() {
    this.emit('state', this.getState());
  }

  private emitStateSoon() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.emitState();
    }, 16);
  }
}
