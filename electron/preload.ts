// Exposes a narrow, typed API to the renderer. No Node access leaks through.
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function on(channel: string, cb: (payload: unknown) => void) {
  const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  platform: process.platform,
  getState: () => call('state:get'),
  setProcessing: (on: boolean) => call('engine:setProcessing', on),
  setBypass: (on: boolean) => call('engine:setBypass', on),
  selectExperience: (id: string) => call('sound:experience', id),
  editSound: (patch: object) => call('sound:edit', patch),
  resetSound: (section?: string) => call('sound:reset', section),
  applyEqProfile: (id: string) => call('sound:eqProfile', id),
  setDeviceProfile: (id: string | null, mode: string) => call('device:profile', id, mode),
  setChannelConfig: (cfg: string) => call('device:channels', cfg),
  forgetDevice: (id: string) => call('device:forget', id),
  savePreset: (name: string) => call('preset:save', name),
  renamePreset: (id: string, name: string) => call('preset:rename', id, name),
  overwritePreset: (id: string) => call('preset:overwrite', id),
  deletePreset: (id: string) => call('preset:delete', id),
  applyPreset: (id: string) => call('preset:apply', id),
  setSettings: (patch: object) => call('settings:set', patch),
  getResponse: (freqs: number[], patch?: object, includeDevice?: boolean) => call<number[]>('eq:response', freqs, patch, includeDevice),
  openPrivacy: () => call('app:openPrivacy'),
  openSoundSettings: () => call('app:openSoundSettings'),
  openLogs: () => call('app:openLogs'),
  openExternal: (url: string) => call('app:openExternal', url),
  showMain: () => call('app:showMain'),
  hideMini: () => call('mini:hide'),
  quit: () => call('app:quit'),
  onState: (cb: (s: unknown) => void) => on('state', cb),
  onAnalysis: (cb: (a: unknown) => void) => on('analysis', cb),
  onToast: (cb: (t: unknown) => void) => on('toast', cb),
  onNav: (cb: (route: unknown) => void) => on('nav', cb),
};

contextBridge.exposeInMainWorld('msfx', api);
export type MsfxApi = typeof api;
