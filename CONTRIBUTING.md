# Contributing to MinSoundFX

Thanks for helping! A few rules keep the app safe and honest.

## Getting started

```bash
npm install
npm run build:native   # native engine for your platform/arch
npm test               # native DSP tests + unit tests
npm run dev            # Vite + Electron with live reload
```

## Rules for changes

1. **Real audio only.** Every control must drive the native engine. No simulated meters or placeholder data.
2. **Audio-thread discipline.** No allocation, locks, logging, or system calls inside `Engine::process` or platform IO callbacks.
3. **Safety first.** Changes to gain staging, the limiter, or parameter ranges need tests in `native/tests/test_dsp.cpp`.
4. **Honest labels.** A device profile is *Measured* only if it comes from a published measurement of that exact model, with its source credited.
5. **No licensed-format claims** (Dolby, DTS, THX…) without a licence and a real integration.
6. Keep `shared/` free of Electron and DOM code so it stays unit-testable.

## Regenerating data and images

```bash
node scripts/import-autoeq.mjs                     # measured headphone corrections
swift scripts/make-icons.swift build               # app + tray icons (macOS)
electron . --capture-screenshots docs/images       # README screenshots (real engine state)
```
