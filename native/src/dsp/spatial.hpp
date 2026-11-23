// Tonal and spatial processors: graphic/tone/device equaliser, dynamic bass,
// dialogue enhancement, stereo widening, virtual surround and channel mapping
// (up-mix / down-mix).
#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include "biquad.hpp"
#include "params.hpp"

namespace msfx {

// Smooths a parameter at block rate and reports whether it moved.
struct BlockSmoother {
  float value = 0.f;
  bool initialised = false;
  bool step(float target, float coeff, float epsilon = 1e-3f) {
    if (!initialised) {
      value = target;
      initialised = true;
      return true;
    }
    if (std::fabs(target - value) < epsilon) {
      if (value != target) {
        value = target;
        return true;
      }
      return false;
    }
    value = coeff * value + (1.f - coeff) * target;
    return true;
  }
};

// Fixed-capacity delay line (allocated in prepare, never on the audio thread).
class DelayLine {
 public:
  void prepare(int maxSamples) {
    buf_.assign(std::max(2, maxSamples + 1), 0.f);
    pos_ = 0;
  }
  void reset() {
    std::fill(buf_.begin(), buf_.end(), 0.f);
    pos_ = 0;
  }
  inline void push(float x) {
    buf_[pos_] = x;
    pos_ = (pos_ + 1) % static_cast<int>(buf_.size());
  }
  // Delay in samples (1 = previous sample). Fractional, linear interpolation.
  inline float read(float delay) const {
    const int size = static_cast<int>(buf_.size());
    if (delay < 1.f) delay = 1.f;
    if (delay > size - 1) delay = static_cast<float>(size - 1);
    const int d = static_cast<int>(delay);
    const float frac = delay - d;
    const int i0 = (pos_ - d + size * 2) % size;
    const int i1 = (i0 - 1 + size) % size;
    return buf_[i0] + (buf_[i1] - buf_[i0]) * frac;
  }

 private:
  std::vector<float> buf_;
  int pos_ = 0;
};

struct OnePoleLP {
  float a = 0.f, z = 0.f;
  void setCutoff(double fc, double fs) { a = static_cast<float>(std::exp(-2.0 * kPi * fc / fs)); }
  inline float process(float x) {
    z = x + a * (z - x);
    return z;
  }
  void reset() { z = 0.f; }
};

// -----------------------------------------------------------------------------
// Equaliser: 10-band graphic EQ + bass/mid/treble tone + device correction.
class Equalizer {
 public:
  static constexpr int kToneBands = 3;
  static constexpr double kBassFreq = 105.0, kMidFreq = 1200.0, kTrebleFreq = 7000.0;

  void prepare(double fs) {
    fs_ = fs;
    for (auto& sm : gainSm_) sm.initialised = false;
    deviceVersion_ = -1;
    reset();
  }

  void reset() {
    for (int c = 0; c < kMaxChannels; ++c) {
      for (auto& b : graphic_[c]) b.reset();
      for (auto& b : tone_[c]) b.reset();
      for (auto& b : device_[c]) b.reset();
    }
  }

  // Coefficient updates (block rate).
  void update(const EngineParams& p, int blockLen, int deviceVersion) {
    const float coeff = static_cast<float>(std::exp(-blockLen / (0.025 * fs_)));
    for (int b = 0; b < kEqBands; ++b) {
      const float target = p.eqEnabled ? p.eqGainsDb[b] : 0.f;
      if (gainSm_[b].step(target, coeff) || q_ != p.eqQ) {
        const BiquadCoeffs c = designGraphic(b, gainSm_[b].value, p.eqQ, fs_);
        for (int ch = 0; ch < kMaxChannels; ++ch) graphic_[ch][b].c = c;
      }
    }
    const float toneTargets[kToneBands] = {p.eqEnabled ? p.bassDb : 0.f, p.eqEnabled ? p.midDb : 0.f,
                                           p.eqEnabled ? p.trebleDb : 0.f};
    for (int t = 0; t < kToneBands; ++t) {
      if (gainSm_[kEqBands + t].step(toneTargets[t], coeff)) {
        const BiquadCoeffs c = designTone(t, gainSm_[kEqBands + t].value, fs_);
        for (int ch = 0; ch < kMaxChannels; ++ch) tone_[ch][t].c = c;
      }
    }
    q_ = p.eqQ;
    if (deviceVersion != deviceVersion_) {
      deviceVersion_ = deviceVersion;
      deviceCount_ = p.deviceEqEnabled ? p.deviceFilterCount : 0;
      for (int i = 0; i < kMaxDeviceFilters; ++i) {
        BiquadCoeffs c;
        if (i < deviceCount_) c = designDevice(p.deviceFilters[i], fs_);
        for (int ch = 0; ch < kMaxChannels; ++ch) device_[ch][i].c = c;
      }
    }
    devicePreamp_ = p.deviceEqEnabled ? dbToGain(p.deviceEqPreampDb) : 1.f;
  }

  // lfeIndex: channel index that only receives tone bass (or -1).
  void process(float* const* ch, int numCh, int n, int lfeIndex) {
    for (int c = 0; c < numCh; ++c) {
      float* x = ch[c];
      if (c == lfeIndex) {
        tone_[c][0].processBlock(x, n);
        tone_[c][0].sanitize();
        continue;
      }
      if (devicePreamp_ != 1.f)
        for (int i = 0; i < n; ++i) x[i] *= devicePreamp_;
      for (int i = 0; i < deviceCount_; ++i) {
        device_[c][i].processBlock(x, n);
        device_[c][i].sanitize();
      }
      for (auto& b : graphic_[c]) {
        b.processBlock(x, n);
        b.sanitize();
      }
      for (auto& b : tone_[c]) {
        b.processBlock(x, n);
        b.sanitize();
      }
    }
  }

  static BiquadCoeffs designGraphic(int band, float gainDb, float q, double fs) {
    if (std::fabs(gainDb) < 0.01f) return BiquadCoeffs{};
    // Shelves at the extremes behave more naturally than narrow peaks.
    if (band == 0) return designBiquad(FilterType::LowShelf, fs, kEqFrequencies[0] * 1.4, 0.8, gainDb);
    if (band == kEqBands - 1)
      return designBiquad(FilterType::HighShelf, fs, kEqFrequencies[kEqBands - 1] * 0.75, 0.8, gainDb);
    return designBiquad(FilterType::Peak, fs, kEqFrequencies[band], q, gainDb);
  }

  static BiquadCoeffs designTone(int t, float gainDb, double fs) {
    if (std::fabs(gainDb) < 0.01f) return BiquadCoeffs{};
    switch (t) {
      case 0: return designBiquad(FilterType::LowShelf, fs, kBassFreq, 0.7, gainDb);
      case 1: return designBiquad(FilterType::Peak, fs, kMidFreq, 0.6, gainDb);
      default: return designBiquad(FilterType::HighShelf, fs, kTrebleFreq, 0.7, gainDb);
    }
  }

  static BiquadCoeffs designDevice(const DeviceFilter& f, double fs) {
    const FilterType t = static_cast<FilterType>(f.type);
    const bool gainType = t == FilterType::Peak || t == FilterType::LowShelf || t == FilterType::HighShelf;
    if (gainType && std::fabs(f.gainDb) < 0.01f) return BiquadCoeffs{};
    return designBiquad(t, fs, f.freq, f.q, f.gainDb);
  }

 private:
  double fs_ = 48000.0;
  Biquad graphic_[kMaxChannels][kEqBands];
  Biquad tone_[kMaxChannels][kToneBands];
  Biquad device_[kMaxChannels][kMaxDeviceFilters];
  BlockSmoother gainSm_[kEqBands + kToneBands];
  float q_ = 1.41f;
  int deviceCount_ = 0;
  int deviceVersion_ = -1;
  float devicePreamp_ = 1.f;
};

// -----------------------------------------------------------------------------
// Dynamic bass: a level-dependent low shelf (more lift at low levels, backing
// off as bass energy rises) plus psychoacoustic harmonics so small speakers
// and earbuds reproduce the perceived fundamental.
class BassEnhancer {
 public:
  void prepare(double fs) {
    fs_ = fs;
    freqSm_.initialised = false;
    gainSm_.initialised = false;
    env_ = 0.f;
    reset();
  }
  void reset() {
    lp1_.reset();
    lp2_.reset();
    hHp_.reset();
    hLp_.reset();
    for (auto& s : shelf_) s.reset();
    env_ = 0.f;
  }

  void process(float* L, float* R, float* lfe, int n, float amount, float freq) {
    const float bc = static_cast<float>(std::exp(-n / (0.05 * fs_)));
    if (freqSm_.step(freq, bc, 0.5f)) {
      lp1_.c = designBiquad(FilterType::LowPass, fs_, freqSm_.value, 0.7071, 0);
      lp2_.c = lp1_.c;
      hHp_.c = designBiquad(FilterType::HighPass, fs_, freqSm_.value * 1.2, 0.7071, 0);
      hLp_.c = designBiquad(FilterType::LowPass, fs_, freqSm_.value * 5.0, 0.7071, 0);
    }
    // Envelope of the bass band (computed first so the shelf reacts to this block).
    const float envRel = onePoleCoeff(0.15, fs_);
    float lowBuf[256];
    const int m = std::min(n, 256);
    for (int i = 0; i < m; ++i) {
      const float mono = 0.5f * (L[i] + R[i]);
      const float low = lp2_.process(lp1_.process(mono));
      lowBuf[i] = low;
      const float a = std::fabs(low);
      env_ = a > env_ ? a : envRel * env_ + (1.f - envRel) * a;
    }
    const float envDb = gainToDb(env_);
    const float maxBoost = 10.f * amount;
    // Full lift below -30 dBFS bass level, tapering to 25% of it at -6 dBFS.
    const float t = std::min(1.f, std::max(0.f, (envDb + 30.f) / 24.f));
    const float targetGain = maxBoost * (1.f - 0.75f * t);
    if (gainSm_.step(targetGain, bc, 0.02f)) {
      const BiquadCoeffs c = designBiquad(FilterType::LowShelf, fs_, freqSm_.value, 0.7, gainSm_.value);
      for (auto& s : shelf_) s.c = c;
    }
    // Harmonic generation: soft saturation of the bass band minus the fundamental.
    const float drive = 4.f;
    const float harmGain = 1.6f * amount;
    for (int i = 0; i < m; ++i) {
      const float low = lowBuf[i];
      const float sat = std::tanh(drive * low) / drive + 0.15f * low * std::fabs(low);  // odd + even
      const float harm = hLp_.process(hHp_.process(sat - low)) * harmGain;
      L[i] = shelf_[0].process(L[i]) + harm;
      R[i] = shelf_[1].process(R[i]) + harm;
      if (lfe) lfe[i] = shelf_[2].process(lfe[i]);
    }
    for (auto* b : {&lp1_, &lp2_, &hHp_, &hLp_, &shelf_[0], &shelf_[1], &shelf_[2]}) b->sanitize();
  }

  float currentBoostDb() const { return gainSm_.value; }

 private:
  double fs_ = 48000.0;
  Biquad lp1_, lp2_, hHp_, hLp_;
  Biquad shelf_[3];
  BlockSmoother freqSm_, gainSm_;
  float env_ = 0.f;
};

// -----------------------------------------------------------------------------
// Dialogue enhancement. Stereo: lifts presence and trims low-mid mud on the
// mid (centre-panned) signal while pulling the side (ambience/music bed) back.
// Multichannel: the same voicing on the centre channel.
class DialogueEnhancer {
 public:
  void prepare(double fs) {
    fs_ = fs;
    sm_.initialised = false;
    reset();
  }
  void reset() {
    for (auto& b : f_) b.reset();
  }

  void process(float* L, float* R, float* C, int n, float amount) {
    const float bc = static_cast<float>(std::exp(-n / (0.04 * fs_)));
    if (sm_.step(amount, bc, 0.002f)) {
      const float a = sm_.value;
      f_[0].c = designBiquad(FilterType::LowShelf, fs_, 200.0, 0.7, -4.0 * a);
      f_[1].c = designBiquad(FilterType::Peak, fs_, 2600.0, 0.9, 6.5 * a);
      f_[2].c = designBiquad(FilterType::Peak, fs_, 4800.0, 1.2, 2.0 * a);
    }
    const float a = sm_.value;
    if (C) {
      const float duck = dbToGain(-2.5f * a);
      for (int i = 0; i < n; ++i) {
        C[i] = f_[2].process(f_[1].process(f_[0].process(C[i]))) * dbToGain(1.5f * a);
        L[i] *= duck;
        R[i] *= duck;
      }
    } else {
      const float sideGain = 1.f - 0.4f * a;
      for (int i = 0; i < n; ++i) {
        const float m = 0.5f * (L[i] + R[i]);
        const float s = 0.5f * (L[i] - R[i]) * sideGain;
        const float mv = f_[2].process(f_[1].process(f_[0].process(m)));
        L[i] = mv + s;
        R[i] = mv - s;
      }
    }
    for (auto& b : f_) b.sanitize();
  }

 private:
  double fs_ = 48000.0;
  Biquad f_[3];
  BlockSmoother sm_;
};

// -----------------------------------------------------------------------------
// Mid/side stereo widener. Side content below ~150 Hz is left untouched so the
// bass stays centred and mono compatibility is preserved (mid is never altered).
class StereoWidener {
 public:
  void prepare(double fs) {
    fs_ = fs;
    lp_.setCutoff(150.0, fs);
    sm_.initialised = false;
    reset();
  }
  void reset() { lp_.reset(); }

  void process(float* L, float* R, int n, float width) {
    const float bc = static_cast<float>(std::exp(-n / (0.03 * fs_)));
    const float w0 = sm_.initialised ? sm_.value : width;
    sm_.step(width, bc, 1e-4f);
    const float w1 = sm_.value;
    for (int i = 0; i < n; ++i) {
      const float w = w0 + (w1 - w0) * (static_cast<float>(i) / n);
      const float m = 0.5f * (L[i] + R[i]);
      const float s = 0.5f * (L[i] - R[i]);
      const float sLow = lp_.process(s);
      const float sOut = sLow + w * (s - sLow);
      // Gentle level compensation when widening so loudness stays comparable.
      const float comp = w > 1.f ? 1.f / (1.f + 0.22f * (w - 1.f)) : 1.f;
      L[i] = (m + sOut) * comp;
      R[i] = (m - sOut) * comp;
    }
  }

 private:
  double fs_ = 48000.0;
  OnePoleLP lp_;
  BlockSmoother sm_;
};

// -----------------------------------------------------------------------------
// Virtual surround for stereo outputs.
//  Headphones: interaural crossfeed (ITD + head-shadow low-pass) plus a sparse
//              early-reflection network to move the image out of the head.
//  Speakers:   first-order crosstalk reduction widening the phantom image beyond
//              the speakers, with lighter reflections.
// This is MinSoundFX's own processing; it is not a licensed surround format.
class VirtualSurround {
 public:
  static constexpr int kTaps = 6;

  void prepare(double fs) {
    fs_ = fs;
    const int maxDelay = static_cast<int>(fs * 0.075) + 8;  // 75 ms
    dl_.prepare(maxDelay);
    dr_.prepare(maxDelay);
    amtSm_.initialised = false;
    reset();
  }

  void reset() {
    dl_.reset();
    dr_.reset();
    for (auto& f : damp_) f.reset();
    for (auto& f : shadow_) f.reset();
    ap_[0].reset();
    ap_[1].reset();
  }

  void process(float* L, float* R, int n, float amount, float room, int mode) {
    const float bc = static_cast<float>(std::exp(-n / (0.04 * fs_)));
    const float a0 = amtSm_.initialised ? amtSm_.value : amount;
    amtSm_.step(amount, bc, 1e-4f);
    const float a1 = amtSm_.value;

    if (room != room_ || mode != mode_ || !configured_) {
      room_ = room;
      mode_ = mode;
      configured_ = true;
      const double damping = 7500.0 - 3500.0 * room;
      for (auto& f : damp_) f.setCutoff(damping, fs_);
      shadow_[0].setCutoff(mode == 0 ? 900.0 : 2500.0, fs_);
      shadow_[1].setCutoff(mode == 0 ? 900.0 : 2500.0, fs_);
      ap_[0].c = designBiquad(FilterType::AllPass, fs_, 1100.0, 0.6, 0);
      ap_[1].c = designBiquad(FilterType::AllPass, fs_, 1700.0, 0.6, 0);
      const double scale = 0.55 + 0.9 * room;
      static const double base[kTaps] = {7.3, 11.9, 17.1, 23.7, 31.3, 41.9};
      for (int t = 0; t < kTaps; ++t) {
        tapDelay_[t] = static_cast<float>(base[t] * scale * 0.001 * fs_);
        tapGain_[t] = static_cast<float>(0.55 * std::pow(0.72, t));
      }
      itd_ = static_cast<float>((mode == 0 ? 0.00027 : 0.00020) * fs_);
    }

    const bool headphones = mode == 0;
    for (int i = 0; i < n; ++i) {
      const float a = a0 + (a1 - a0) * (static_cast<float>(i) / n);
      const float l = L[i], r = R[i];
      dl_.push(l);
      dr_.push(r);

      // Interaural path (crossfeed for headphones, crosstalk cancellation for speakers).
      const float xl = shadow_[0].process(dr_.read(itd_));
      const float xr = shadow_[1].process(dl_.read(itd_));
      float outL, outR;
      if (headphones) {
        const float k = 0.35f * a;
        outL = (l + k * xl) / (1.f + 0.5f * k);
        outR = (r + k * xr) / (1.f + 0.5f * k);
      } else {
        const float k = 0.45f * a;
        outL = (l - k * xl) / (1.f - 0.25f * k);
        outR = (r - k * xr) / (1.f - 0.25f * k);
      }

      // Early reflections: alternate same-side and opposite-side taps.
      float wl = 0.f, wr = 0.f;
      for (int t = 0; t < kTaps; ++t) {
        const float g = tapGain_[t];
        const bool cross = (t & 1) != 0;
        wl += g * (cross ? dr_.read(tapDelay_[t]) : dl_.read(tapDelay_[t]));
        wr += g * (cross ? dl_.read(tapDelay_[t] * 1.07f) : dr_.read(tapDelay_[t] * 1.07f));
      }
      wl = ap_[0].process(damp_[0].process(wl));
      wr = ap_[1].process(damp_[1].process(wr));
      const float wet = (headphones ? 0.42f : 0.28f) * a;
      const float norm = 1.f / (1.f + 0.35f * a);
      L[i] = (outL + wet * wl) * norm;
      R[i] = (outR + wet * wr) * norm;
    }
    ap_[0].sanitize();
    ap_[1].sanitize();
  }

 private:
  double fs_ = 48000.0;
  DelayLine dl_, dr_;
  OnePoleLP damp_[2], shadow_[2];
  Biquad ap_[2];
  float tapDelay_[kTaps] = {};
  float tapGain_[kTaps] = {};
  float itd_ = 13.f;
  float room_ = -1.f;
  int mode_ = -1;
  bool configured_ = false;
  BlockSmoother amtSm_;
};

// -----------------------------------------------------------------------------
// Channel layout helpers. Layout conventions (WAVE / Core Audio default order):
//   2: L R            3: L R LFE (2.1)        4: L R Ls Rs (quad)
//   6: L R C LFE Ls Rs (5.1)   8: L R C LFE Lb Rb Ls Rs (7.1)
inline int lfeIndexFor(int numCh) {
  if (numCh == 3) return 2;
  if (numCh >= 6) return 3;
  return -1;
}
inline int centerIndexFor(int numCh) { return numCh >= 6 ? 2 : -1; }

class ChannelMapper {
 public:
  void prepare(double fs) {
    fs_ = fs;
    const int maxDelay = static_cast<int>(fs * 0.03) + 4;
    sideDelay_.prepare(maxDelay);
    lfeLp1_.c = designBiquad(FilterType::LowPass, fs, 120.0, 0.7071, 0);
    lfeLp2_.c = lfeLp1_.c;
    cBp_[0].c = designBiquad(FilterType::HighPass, fs, 180.0, 0.7071, 0);
    cBp_[1].c = designBiquad(FilterType::LowPass, fs, 7000.0, 0.7071, 0);
    surLp_.setCutoff(7000.0, fs);
    reset();
  }
  void reset() {
    sideDelay_.reset();
    lfeLp1_.reset();
    lfeLp2_.reset();
    cBp_[0].reset();
    cBp_[1].reset();
    surLp_.reset();
  }

  // Interleaved `in` (inCh) -> planar `out` (outCh).
  void map(const float* in, int inCh, float* const* out, int outCh, int n, bool upmix) {
    for (int c = 0; c < outCh; ++c) std::fill(out[c], out[c] + n, 0.f);
    if (inCh <= 0) return;
    auto s = [&](int i, int c) {
      const float v = in[i * inCh + c];
      return std::isfinite(v) ? v : 0.f;
    };

    if (inCh == outCh) {
      for (int i = 0; i < n; ++i)
        for (int c = 0; c < outCh; ++c) out[c][i] = s(i, c);
      return;
    }
    if (inCh == 1) {
      for (int i = 0; i < n; ++i) {
        const float v = s(i, 0);
        out[0][i] = v;
        if (outCh > 1) out[1][i] = v;
      }
      return;
    }
    if (outCh == 1) {
      for (int i = 0; i < n; ++i) {
        float acc = 0.f;
        for (int c = 0; c < std::min(inCh, 2); ++c) acc += s(i, c);
        out[0][i] = acc * 0.5f;
      }
      return;
    }
    if (inCh == 2 && outCh > 2) {
      const int lfe = lfeIndexFor(outCh);
      const int ctr = centerIndexFor(outCh);
      int surL = -1, surR = -1, backL = -1, backR = -1;
      if (outCh == 4) { surL = 2; surR = 3; }
      if (outCh == 6) { surL = 4; surR = 5; }
      if (outCh == 8) { backL = 4; backR = 5; surL = 6; surR = 7; }
      const float sDelay = static_cast<float>(0.012 * fs_);
      const float bDelay = static_cast<float>(0.020 * fs_);
      for (int i = 0; i < n; ++i) {
        const float l = s(i, 0), r = s(i, 1);
        const float m = 0.5f * (l + r);
        const float side = 0.5f * (l - r);
        out[0][i] = l;
        out[1][i] = r;
        if (!upmix) continue;
        sideDelay_.push(surLp_.process(side));
        if (ctr >= 0) {
          const float c = cBp_[1].process(cBp_[0].process(m)) * 0.6f;
          out[ctr][i] = c;
          out[0][i] = l - 0.35f * c;
          out[1][i] = r - 0.35f * c;
        }
        if (lfe >= 0) out[lfe][i] = lfeLp2_.process(lfeLp1_.process(m)) * 0.7f;
        if (surL >= 0) {
          const float sv = sideDelay_.read(sDelay) * 0.8f;
          out[surL][i] = sv;
          out[surR][i] = -sv;
        }
        if (backL >= 0) {
          const float bv = sideDelay_.read(bDelay) * 0.6f;
          out[backL][i] = bv;
          out[backR][i] = -bv;
        }
      }
      return;
    }
    if (outCh == 2 && inCh > 2) {
      // ITU-R BS.775 style down-mix, scaled to keep headroom.
      const int lfe = lfeIndexFor(inCh);
      const int ctr = centerIndexFor(inCh);
      const float k = 0.7071f;
      const float norm = inCh >= 6 ? 0.55f : 0.75f;
      for (int i = 0; i < n; ++i) {
        float l = s(i, 0), r = s(i, 1);
        if (ctr >= 0) {
          l += k * s(i, ctr);
          r += k * s(i, ctr);
        }
        if (lfe >= 0) {
          l += 0.5f * s(i, lfe);
          r += 0.5f * s(i, lfe);
        }
        for (int c = 2; c < inCh; ++c) {
          if (c == ctr || c == lfe) continue;
          if (((c - 2) & 1) == 0) l += k * s(i, c);
          else r += k * s(i, c);
        }
        out[0][i] = l * norm;
        out[1][i] = r * norm;
      }
      return;
    }
    // Generic: copy the overlapping channels.
    const int common = std::min(inCh, outCh);
    for (int i = 0; i < n; ++i)
      for (int c = 0; c < common; ++c) out[c][i] = s(i, c);
  }

 private:
  double fs_ = 48000.0;
  DelayLine sideDelay_;
  Biquad lfeLp1_, lfeLp2_, cBp_[2];
  OnePoleLP surLp_;
};

}  // namespace msfx
