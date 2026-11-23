# Architecture

MinSoundFX is split into a native real-time audio engine and a shared TypeScript application layer.

```
┌─────────────────────────────── Electron ───────────────────────────────┐
│ Renderer (React)            Main process (Node)                        │
│  Dashboard / EQ / Effects ──IPC──► AudioController ── JsonStore        │
│  canvas visualisers  ◄─analysis──  (shared/: presets, device           │
│  tray mini player                   profiles, safety, composition)     │
└───────────────────────────────────────┬────────────────────────────────┘
                                        │ Node-API (native/src/addon.cpp)
┌───────────────────────────────────────▼────────────────────────────────┐
│ Native engine (C++17, no dependencies)                                 │
│  Engine ── lock-free param triple buffer ── analysis SPSC rings        │
│  ChannelMapper → Preamp/Headroom → Device EQ → Graphic EQ + Tone       │
│  → Dialogue → Dynamic Bass → Widener → Virtual Surround                │
│  → Compressor → Loudness AGC → Balance/Output → Look-ahead Limiter     │
│  → 30 ms equal-power crossfade with the latency-aligned original       │
├──────────────────────────────┬─────────────────────────────────────────┤
│ macOS backend (Obj-C++)      │ Windows backend (C++)                   │
│ Core Audio process tap       │ WASAPI loopback of a virtual endpoint   │
│ (muted, private) + private   │ + event-driven shared-mode render,      │
│ aggregate device, IOProc     │ MMCSS "Pro Audio", adaptive resampler   │
└──────────────────────────────┴─────────────────────────────────────────┘
```

## Native engine (`native/src/dsp`)

| File | Contents |
|---|---|
| `biquad.hpp` | RBJ cookbook filters, double-precision TDF-II state, magnitude response |
| `spatial.hpp` | Equaliser, dynamic bass, dialogue enhancer, stereo widener, virtual surround, channel mapper (up/down-mix) |
| `dynamics.hpp` | Compressor, BS.1770 K-weighted loudness normaliser, look-ahead brick-wall limiter |
| `analyzer.hpp` | Hann-windowed radix-2 FFT folded into log-spaced bands |
| `lockfree.hpp` | Triple buffer (parameters), SPSC ring (analysis), atomic float meters |
| `engine.cpp` | Signal chain, block processing (128-frame sub-blocks), meters, bypass crossfade |

Real-time rules: no allocation, locks, logging or system calls on the audio thread. Parameters arrive as whole snapshots through a triple buffer; gains and filter settings are smoothed per block, so every control can move while audio plays without zipper noise. `sanitize()` clamps every parameter to a safe range regardless of what the UI sends.

**Performance** (Apple M-series, `npm run test:native`): the full chain with every effect enabled runs at ~180× real time for stereo (~0.5 % of one core) and ~100× for 5.1.

## Platform backends (`native/src/platform`)

### macOS — Core Audio process taps (macOS 14.2+)
1. `CATapDescription initExcludingProcesses:[self] andDeviceUID:<output> withStream:0` with `muteBehavior = CATapMuted` and `privateTap = YES` captures what every other app sends to the output device and silences the original path. Our own process is excluded, so the processed signal can never feed back.
2. A private aggregate device combines the output device (clock master) with the tap (drift-compensated).
3. An IOProc on the aggregate reads the tap, runs the engine, and writes to the device.
4. Default-device, sample-rate, stream-layout and alive notifications trigger a rebuild on the control thread (with debounce so the aggregate's own notifications don't loop).

Nothing is installed and no system setting changes. When the tap is destroyed (stop, quit or crash) macOS immediately restores normal playback.

### Windows — WASAPI
Windows offers no public API for an app to replace the system mix; the options are a signed APO driver or a virtual endpoint. MinSoundFX uses a virtual endpoint (e.g. VB-CABLE) without shipping a driver:
1. The virtual endpoint becomes the default output (via the `IPolicyConfig` interface used by the Sound control panel) only after processing has started successfully.
2. A dedicated MMCSS thread captures it with WASAPI loopback, feeds a jitter buffer with a PI-controlled cubic resampler (clock-drift compensation), runs the engine, and renders to the real device in event-driven shared mode.
3. Endpoint notifications handle device changes: plugging in headphones (Windows changes the default) makes that device the new target; a disappearing device (Bluetooth) falls back to the previous or first physical endpoint.
4. On stop/quit the original default is restored — only if the virtual endpoint is still the default, so a choice the user made meanwhile is respected. The original id is also persisted so a crash is repaired at next launch, and the uninstaller runs `MinSoundFX.exe --restore-audio`.

## Application layer

* `shared/` — pure TypeScript, fully unit-tested: experiences and EQ profiles (`sound.ts`), device recognition and profile catalogue (`devices.ts`), per-device records and presets (`records.ts`), engine parameter composition and hearing-safety rules (`compose.ts`).
* `electron/controller.ts` — the only owner of the engine: polls status at 4 Hz, restores the right per-device settings when the output changes, persists everything atomically.
* `src/` — React UI. High-rate data (spectrum, meters) bypasses React and is drawn on canvas each animation frame. The EQ graph shows the engine's own computed response, not a UI approximation.

## Tests

* `native/tests/test_dsp.cpp` — 32 tests: filter accuracy, transparency, limiter ceiling guarantee on hot random input, NaN containment, crossfade continuity, every effect's behaviour, up/down-mix, analyser accuracy, performance.
* `tests/*.test.ts` — 37 tests: presets, classification of real device names, profile matching and tiers, per-device memory, presets CRUD/validation, safety limits, settings and store robustness.
