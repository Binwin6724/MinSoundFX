// Loads the native engine addon (dev build or packaged copy).
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { EngineStatus, Meters, NativeDevice, PlatformInfo } from '../shared/types';
import type { NativeParams } from '../shared/compose';

export interface NativeAnalysis {
  original?: Float32Array;
  processed?: Float32Array;
  waveform?: Float32Array;
  waveformOriginal?: Float32Array;
  meters: Meters;
}

export interface NativeModule {
  platformInfo(): PlatformInfo;
  listDevices(): NativeDevice[];
  start(opts: { outputDeviceId?: string; captureDeviceId?: string; bufferFrames?: number }): {
    ok: boolean;
    error: string;
    status: EngineStatus;
  };
  stop(): EngineStatus;
  poll(): EngineStatus;
  status(): EngineStatus;
  devicesGeneration(): number;
  setParams(p: NativeParams): { headroomDb: number };
  getResponse(freqs: Float32Array, params?: NativeParams, opts?: { includeDevice?: boolean; includeGain?: boolean }): Float32Array;
  getAnalysis(bands?: number): NativeAnalysis;
  setSystemDefaultOutput(id: string): { ok: boolean; error: string };
  shutdown(): void;
}

export function loadNative(): NativeModule {
  const name = 'minsoundfx_native.node';
  const candidates = [
    path.join(process.resourcesPath ?? '', 'native', name),
    path.join(app.getAppPath(), 'native', 'build-out', `${process.platform}-${process.arch}`, name),
    path.join(__dirname, '..', '..', 'native', 'build-out', `${process.platform}-${process.arch}`, name),
  ];
  for (const file of candidates) {
    if (file && fs.existsSync(file)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(file) as NativeModule;
    }
  }
  throw new Error(`Native audio engine not found. Looked in:\n${candidates.join('\n')}\nRun "npm run build:native".`);
}
