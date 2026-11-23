// Typed access to the preload bridge plus a tiny external store for app
// state and the high-rate analysis stream.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AnalysisFrame, AppSettings, AppState, ChannelConfig, DeepPartial, DeviceRecord, SoundSettings } from '../shared/types';

export interface MsfxApi {
  platform: string;
  getState(): Promise<AppState>;
  setProcessing(on: boolean): Promise<{ ok: boolean; error: string }>;
  setBypass(on: boolean): Promise<void>;
  selectExperience(id: string): Promise<void>;
  editSound(patch: DeepPartial<SoundSettings>): Promise<void>;
  resetSound(section?: keyof SoundSettings): Promise<void>;
  applyEqProfile(id: string): Promise<void>;
  setDeviceProfile(id: string | null, mode: DeviceRecord['profileMode']): Promise<void>;
  setChannelConfig(cfg: 'auto' | ChannelConfig): Promise<void>;
  forgetDevice(id: string): Promise<void>;
  savePreset(name: string): Promise<void>;
  renamePreset(id: string, name: string): Promise<void>;
  overwritePreset(id: string): Promise<void>;
  deletePreset(id: string): Promise<void>;
  applyPreset(id: string): Promise<void>;
  setSettings(patch: Partial<AppSettings>): Promise<void>;
  getResponse(freqs: number[], patch?: DeepPartial<SoundSettings>, includeDevice?: boolean): Promise<number[]>;
  openPrivacy(): Promise<void>;
  openSoundSettings(): Promise<void>;
  openLogs(): Promise<void>;
  openExternal(url: string): Promise<void>;
  showMain(): Promise<void>;
  hideMini(): Promise<void>;
  quit(): Promise<void>;
  onState(cb: (s: AppState) => void): () => void;
  onAnalysis(cb: (a: AnalysisFrame) => void): () => void;
  onToast(cb: (t: { kind: string; text: string }) => void): () => void;
  onNav(cb: (route: string) => void): () => void;
}

declare global {
  interface Window {
    msfx: MsfxApi;
  }
}

export const api: MsfxApi = window.msfx;

// ---------------------------------------------------------------- app state
let state: AppState | null = null;
const listeners = new Set<() => void>();

function setState(s: AppState) {
  state = s;
  listeners.forEach((l) => l());
}

api.onState((s) => setState(s));
api.getState().then(setState).catch(() => {});

export function refreshState() {
  return api.getState().then(setState);
}

export function useAppState(): AppState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// ---------------------------------------------------------------- analysis (no React re-renders)
export const analysis: { latest: AnalysisFrame | null; receivedAt: number; silentSince: number } = {
  latest: null,
  receivedAt: 0,
  silentSince: 0,
};
api.onAnalysis((a) => {
  analysis.latest = a;
  analysis.receivedAt = performance.now();
  if (a.meters.inPeak > 1e-5) analysis.silentSince = 0;
  else if (!analysis.silentSince) analysis.silentSince = performance.now();
});

/** Re-renders at a low rate with the latest meters (for numeric readouts). */
export function useMetersTick(intervalMs = 200) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return analysis.latest?.meters ?? null;
}

// ---------------------------------------------------------------- helpers
export function useThrottledCommit<T>(commit: (v: T) => void) {
  const pending = useRef<{ v: T } | null>(null);
  const frame = useRef<number | null>(null);
  return (v: T) => {
    pending.current = { v };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) commit(pending.current.v);
      pending.current = null;
    });
  };
}

export function run<T>(p: Promise<T>) {
  p.catch((err: Error) => toast('error', err.message));
}

type ToastListener = (t: { id: number; kind: string; text: string }) => void;
const toastListeners = new Set<ToastListener>();
let toastId = 0;
export function toast(kind: string, text: string) {
  const t = { id: ++toastId, kind, text };
  toastListeners.forEach((l) => l(t));
}
export function onToast(l: ToastListener) {
  toastListeners.add(l);
  return () => {
    toastListeners.delete(l);
  };
}
api.onToast((t) => toast(t.kind, t.text));
