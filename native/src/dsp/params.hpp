// Engine parameters. Everything the UI can change ends up in this plain struct,
// which is published to the audio thread through a lock-free triple buffer.
// `sanitize()` enforces the hard safety limits no matter what the caller sends.
#pragma once

#include <algorithm>
#include <cmath>

namespace msfx {

constexpr int kMaxChannels = 8;
constexpr int kEqBands = 10;
constexpr int kMaxDeviceFilters = 10;

// ISO octave centres used by the 10-band graphic equalizer.
constexpr float kEqFrequencies[kEqBands] = {31.25f, 62.5f, 125.f, 250.f, 500.f,
                                             1000.f, 2000.f, 4000.f, 8000.f, 16000.f};

struct DeviceFilter {
  int type = 0;  // FilterType
  float freq = 1000.f;
  float q = 0.707f;
  float gainDb = 0.f;
};

enum class SurroundMode : int { Headphones = 0, Speakers = 1 };

struct EngineParams {
  // Master
  bool enabled = true;        // false = bypass (crossfaded) for A/B comparison
  float preampDb = 0.f;       // -24 .. +12
  float headroomDb = 0.f;     // automatic clipping-prevention trim, computed off the audio thread (<= 0)
  float outputGainDb = 0.f;   // -24 .. +6
  float balance = 0.f;        // -1 (left) .. +1 (right)

  // Graphic equalizer and tone controls
  bool eqEnabled = true;
  float eqGainsDb[kEqBands] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0};  // -12 .. +12
  float eqQ = 1.41f;                                           // ~1 octave
  float bassDb = 0.f;     // low shelf @ 105 Hz, -12 .. +12
  float midDb = 0.f;      // peak @ 1.2 kHz, -12 .. +12
  float trebleDb = 0.f;   // high shelf @ 7 kHz, -12 .. +12

  // Device correction (measured or estimated profile)
  bool deviceEqEnabled = false;
  int deviceFilterCount = 0;
  DeviceFilter deviceFilters[kMaxDeviceFilters];
  float deviceEqPreampDb = 0.f;

  // Enhancements, each independently switchable
  bool bassEnabled = false;
  float bassAmount = 0.5f;   // 0..1
  float bassFreq = 90.f;     // 40..160 Hz

  bool dialogueEnabled = false;
  float dialogueAmount = 0.5f;  // 0..1

  bool widenEnabled = false;
  float width = 1.3f;  // 0 (mono) .. 2 (extra wide), 1 = unchanged

  bool surroundEnabled = false;
  float surroundAmount = 0.5f;  // 0..1
  float surroundRoom = 0.5f;    // 0..1 (small .. large)
  int surroundMode = 0;         // SurroundMode

  bool compEnabled = false;
  float compThresholdDb = -24.f;  // -60 .. 0
  float compRatio = 3.f;          // 1 .. 20
  float compAttackMs = 10.f;      // 0.5 .. 200
  float compReleaseMs = 180.f;    // 10 .. 2000
  float compMakeupDb = 0.f;       // 0 .. 18

  bool loudnessEnabled = false;
  float loudnessTargetLufs = -16.f;  // -30 .. -10
  float loudnessMaxBoostDb = 9.f;    // 0 .. 12

  bool upmixEnabled = false;  // stereo -> multichannel when output has more channels

  // Output protection (always active)
  float limiterCeilingDb = -1.0f;  // -12 .. -0.1 dBFS
  float maxBoostDb = 18.f;         // cap for the sum of all user gain stages (safety)

  void sanitize() {
    auto clampf = [](float v, float lo, float hi, float def) {
      if (!std::isfinite(v)) return def;
      return std::min(hi, std::max(lo, v));
    };
    preampDb = clampf(preampDb, -24.f, 12.f, 0.f);
    headroomDb = clampf(headroomDb, -30.f, 0.f, 0.f);
    outputGainDb = clampf(outputGainDb, -24.f, 6.f, 0.f);
    balance = clampf(balance, -1.f, 1.f, 0.f);
    for (float& g : eqGainsDb) g = clampf(g, -12.f, 12.f, 0.f);
    eqQ = clampf(eqQ, 0.3f, 4.f, 1.41f);
    bassDb = clampf(bassDb, -12.f, 12.f, 0.f);
    midDb = clampf(midDb, -12.f, 12.f, 0.f);
    trebleDb = clampf(trebleDb, -12.f, 12.f, 0.f);
    deviceFilterCount = std::min(kMaxDeviceFilters, std::max(0, deviceFilterCount));
    for (int i = 0; i < kMaxDeviceFilters; ++i) {
      DeviceFilter& f = deviceFilters[i];
      if (f.type < 0 || f.type > 6) f.type = 0;
      f.freq = clampf(f.freq, 10.f, 22000.f, 1000.f);
      f.q = clampf(f.q, 0.1f, 10.f, 0.707f);
      f.gainDb = clampf(f.gainDb, -20.f, 12.f, 0.f);
    }
    deviceEqPreampDb = clampf(deviceEqPreampDb, -20.f, 0.f, 0.f);
    bassAmount = clampf(bassAmount, 0.f, 1.f, 0.5f);
    bassFreq = clampf(bassFreq, 40.f, 160.f, 90.f);
    dialogueAmount = clampf(dialogueAmount, 0.f, 1.f, 0.5f);
    width = clampf(width, 0.f, 2.f, 1.f);
    surroundAmount = clampf(surroundAmount, 0.f, 1.f, 0.5f);
    surroundRoom = clampf(surroundRoom, 0.f, 1.f, 0.5f);
    if (surroundMode != 0 && surroundMode != 1) surroundMode = 0;
    compThresholdDb = clampf(compThresholdDb, -60.f, 0.f, -24.f);
    compRatio = clampf(compRatio, 1.f, 20.f, 3.f);
    compAttackMs = clampf(compAttackMs, 0.5f, 200.f, 10.f);
    compReleaseMs = clampf(compReleaseMs, 10.f, 2000.f, 180.f);
    compMakeupDb = clampf(compMakeupDb, 0.f, 18.f, 0.f);
    loudnessTargetLufs = clampf(loudnessTargetLufs, -30.f, -10.f, -16.f);
    loudnessMaxBoostDb = clampf(loudnessMaxBoostDb, 0.f, 12.f, 9.f);
    limiterCeilingDb = clampf(limiterCeilingDb, -12.f, -0.1f, -1.f);
    maxBoostDb = clampf(maxBoostDb, 0.f, 24.f, 18.f);
  }
};

}  // namespace msfx
