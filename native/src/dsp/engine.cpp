#include "engine.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace msfx {

namespace {

bool deviceFiltersEqual(const EngineParams& a, const EngineParams& b) {
  if (a.deviceEqEnabled != b.deviceEqEnabled || a.deviceFilterCount != b.deviceFilterCount) return false;
  for (int i = 0; i < a.deviceFilterCount; ++i) {
    const DeviceFilter& x = a.deviceFilters[i];
    const DeviceFilter& y = b.deviceFilters[i];
    if (x.type != y.type || x.freq != y.freq || x.q != y.q || x.gainDb != y.gainDb) return false;
  }
  return true;
}

// Channel side for the balance control in the supported layouts.
// -1 = left, +1 = right, 0 = centre/LFE.
int channelSide(int c, int numCh) {
  if (numCh == 1) return 0;
  if (c == 0) return -1;
  if (c == 1) return 1;
  if (numCh == 3) return 0;                       // 2.1: LFE
  if (numCh == 4) return c == 2 ? -1 : 1;         // quad
  if (numCh >= 6 && (c == 2 || c == 3)) return 0;  // C, LFE
  return (c % 2 == 0) ? -1 : 1;                    // Ls/Rs, Lb/Rb
}

}  // namespace

Engine::Engine() {
  EngineParams d;
  d.sanitize();
  controlParams_ = d;
  p_ = d;
  envelope_.write(ParamEnvelope{d, 0});
}

void Engine::prepare(double sampleRate, int inChannels, int outChannels) {
  prepared_.store(false, std::memory_order_release);
  fs_ = sampleRate > 1000.0 ? sampleRate : 48000.0;
  inCh_ = std::min(kMaxChannels, std::max(1, inChannels));
  outCh_ = std::min(kMaxChannels, std::max(1, outChannels));

  wetMapper_.prepare(fs_);
  dryMapper_.prepare(fs_);
  eq_.prepare(fs_);
  bass_.prepare(fs_);
  dialogue_.prepare(fs_);
  widener_.prepare(fs_);
  surround_.prepare(fs_);
  comp_.prepare(fs_);
  loudness_.prepare(fs_, outCh_);
  limiter_.prepare(fs_, outCh_, 1.5);

  wetStore_.assign(static_cast<size_t>(kMaxChannels) * kSubBlock, 0.f);
  dryStore_.assign(static_cast<size_t>(kMaxChannels) * kSubBlock, 0.f);
  for (int c = 0; c < kMaxChannels; ++c) {
    wet_[c] = wetStore_.data() + static_cast<size_t>(c) * kSubBlock;
    dry_[c] = dryStore_.data() + static_cast<size_t>(c) * kSubBlock;
    dryDelay_[c].assign(limiter_.latencySamples(), 0.f);
  }
  dryDelayPos_ = 0;
  ringIn_.resize(kAnalysisRing);
  ringOut_.resize(kAnalysisRing);

  ParamEnvelope e;
  if (envelope_.read(e)) {
    p_ = e.params;
    deviceVersion_ = e.deviceVersion;
  }
  gainLin_ = dbToGain(std::min(p_.maxBoostDb, p_.preampDb + p_.headroomDb));
  balL_ = balR_ = 1.f;
  mix_ = p_.enabled ? 1.f : 0.f;
  wetActive_ = p_.enabled;
  prepared_.store(true, std::memory_order_release);
}

void Engine::setParams(const EngineParams& in) {
  EngineParams q = in;
  q.sanitize();
  if (!deviceFiltersEqual(q, controlParams_)) ++controlDeviceVersion_;
  controlParams_ = q;
  envelope_.write(ParamEnvelope{q, controlDeviceVersion_});
}

void Engine::resetWetChain() {
  wetMapper_.reset();
  eq_.reset();
  bass_.reset();
  dialogue_.reset();
  widener_.reset();
  surround_.reset();
  comp_.reset();
  loudness_.reset();
  limiter_.reset();
}

void Engine::process(const float* in, float* out, int frames) {
  if (frames <= 0) return;
  if (!prepared_.load(std::memory_order_acquire)) {
    if (out) std::memset(out, 0, sizeof(float) * static_cast<size_t>(frames) * outCh_);
    return;
  }
  const auto t0 = std::chrono::steady_clock::now();

  ParamEnvelope e;
  if (envelope_.read(e)) {
    p_ = e.params;
    deviceVersion_ = e.deviceVersion;
  }

  int offset = 0;
  while (offset < frames) {
    const int n = std::min(kSubBlock, frames - offset);
    processSubBlock(in ? in + static_cast<size_t>(offset) * inCh_ : nullptr,
                    out + static_cast<size_t>(offset) * outCh_, n);
    offset += n;
  }

  const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  const double budget = frames / fs_;
  mCpu_.storeMax(static_cast<float>(elapsed / budget));
  framesProcessed_.fetch_add(static_cast<uint64_t>(frames), std::memory_order_relaxed);
}

void Engine::processSubBlock(const float* in, float* out, int n) {
  static const float kZeros[kSubBlock * kMaxChannels] = {};
  const float* src = in ? in : kZeros;

  // Original signal (for bypass / A-B and the "original" analyser trace).
  dryMapper_.map(src, inCh_, dry_, outCh_, n, false);
  float inPeak = 0.f;
  for (int i = 0; i < n; ++i) {
    float acc = 0.f;
    for (int c = 0; c < outCh_; ++c) {
      acc += dry_[c][i];
      inPeak = std::max(inPeak, std::fabs(dry_[c][i]));
    }
    monoIn_[i] = acc / outCh_;
  }
  mInPeak_.storeMax(inPeak);

  const bool wantWet = p_.enabled;
  if (wantWet && !wetActive_) {
    resetWetChain();
    wetActive_ = true;
  }

  float limGr = 0.f, compGr = 0.f;
  if (wetActive_) {
    wetMapper_.map(src, inCh_, wet_, outCh_, n, p_.upmixEnabled);
    eq_.update(p_, n, deviceVersion_);

    // Preamp + automatic headroom, capped by the global boost limit.
    const float targetGain = dbToGain(std::min(p_.maxBoostDb, p_.preampDb + p_.headroomDb));
    const float gc = static_cast<float>(std::exp(-n / (0.02 * fs_)));
    const float g0 = gainLin_;
    gainLin_ = gc * gainLin_ + (1.f - gc) * targetGain;
    if (std::fabs(gainLin_ - targetGain) < 1e-5f) gainLin_ = targetGain;
    const float gStep = (gainLin_ - g0) / n;
    for (int c = 0; c < outCh_; ++c) {
      float g = g0;
      for (int i = 0; i < n; ++i) {
        wet_[c][i] *= g;
        g += gStep;
      }
    }

    const int lfe = lfeIndexFor(outCh_);
    const int ctr = centerIndexFor(outCh_);
    eq_.process(wet_, outCh_, n, lfe);

    if (outCh_ >= 2) {
      if (p_.dialogueEnabled)
        dialogue_.process(wet_[0], wet_[1], ctr >= 0 ? wet_[ctr] : nullptr, n, p_.dialogueAmount);
      if (p_.bassEnabled)
        bass_.process(wet_[0], wet_[1], lfe >= 0 ? wet_[lfe] : nullptr, n, p_.bassAmount, p_.bassFreq);
      if (p_.widenEnabled) widener_.process(wet_[0], wet_[1], n, p_.width);
      if (p_.surroundEnabled && outCh_ == 2)
        surround_.process(wet_[0], wet_[1], n, p_.surroundAmount, p_.surroundRoom, p_.surroundMode);
    }

    if (p_.compEnabled)
      compGr = comp_.process(wet_, outCh_, n, p_.compThresholdDb, p_.compRatio, p_.compAttackMs,
                             p_.compReleaseMs, p_.compMakeupDb);
    // Always measured (for the loudness meter); gain applied only when enabled.
    loudness_.process(wet_, outCh_, n, p_.loudnessTargetLufs, p_.loudnessMaxBoostDb, p_.loudnessEnabled);

    // Balance (attenuate the opposite side) and output gain.
    const float b = p_.balance;
    const float tL = b > 0.f ? 1.f - b : 1.f;
    const float tR = b < 0.f ? 1.f + b : 1.f;
    const float outG = dbToGain(p_.outputGainDb);
    const float l0 = balL_, r0 = balR_;
    balL_ = gc * balL_ + (1.f - gc) * tL;
    balR_ = gc * balR_ + (1.f - gc) * tR;
    for (int c = 0; c < outCh_; ++c) {
      const int side = channelSide(c, outCh_);
      const float s0 = side < 0 ? l0 : side > 0 ? r0 : 1.f;
      const float s1 = side < 0 ? balL_ : side > 0 ? balR_ : 1.f;
      const float step = (s1 - s0) / n;
      float g = s0;
      for (int i = 0; i < n; ++i) {
        wet_[c][i] *= g * outG;
        g += step;
      }
    }

    limGr = limiter_.process(wet_, outCh_, n, p_.limiterCeilingDb);
  }

  // Delay the original by the limiter's look-ahead so A/B switching is seamless.
  const int dl = static_cast<int>(dryDelay_[0].size());
  for (int i = 0; i < n; ++i) {
    for (int c = 0; c < outCh_; ++c) {
      float& slot = dryDelay_[c][dryDelayPos_];
      const float d = slot;
      slot = dry_[c][i];
      dry_[c][i] = d;
    }
    dryDelayPos_ = (dryDelayPos_ + 1) % dl;
  }

  // Crossfade between original and enhanced (30 ms) and write interleaved output.
  const float target = wantWet ? 1.f : 0.f;
  const float mixStep = static_cast<float>(1.0 / (0.030 * fs_));
  float peaks[kMaxChannels] = {};
  double sums[kMaxChannels] = {};
  uint32_t bad = 0;
  for (int i = 0; i < n; ++i) {
    if (mix_ < target) mix_ = std::min(target, mix_ + mixStep);
    else if (mix_ > target) mix_ = std::max(target, mix_ - mixStep);
    // Equal-power-ish curve keeps loudness steady through the fade.
    const float wm = wetActive_ ? std::sin(mix_ * 1.5707963f) : 0.f;
    const float dm = wetActive_ ? std::cos(mix_ * 1.5707963f) : 1.f;
    float acc = 0.f;
    for (int c = 0; c < outCh_; ++c) {
      float y = wetActive_ ? dry_[c][i] * dm + wet_[c][i] * wm : dry_[c][i];
      if (!std::isfinite(y)) {
        y = 0.f;
        ++bad;
      }
      if (y > 1.f) y = 1.f;
      else if (y < -1.f) y = -1.f;
      out[static_cast<size_t>(i) * outCh_ + c] = y;
      peaks[c] = std::max(peaks[c], std::fabs(y));
      sums[c] += static_cast<double>(y) * y;
      acc += y;
    }
    monoOut_[i] = acc / outCh_;
  }
  if (!wantWet && mix_ <= 0.f) wetActive_ = false;
  if (bad) {
    nonFinite_.fetch_add(bad, std::memory_order_relaxed);
    resetWetChain();
  }

  for (int c = 0; c < outCh_; ++c) {
    mOutPeak_[c].storeMax(peaks[c]);
    mOutRms_[c].storeMax(static_cast<float>(std::sqrt(sums[c] / n)));
  }
  mLimGr_.storeMax(limGr);
  mCompGr_.storeMax(compGr);
  mAgc_.store(p_.loudnessEnabled && wetActive_ ? loudness_.gainDb() : 0.f);
  mLufs_.store(loudness_.loudnessLufs());
  mBass_.store(p_.bassEnabled && wetActive_ ? bass_.currentBoostDb() : 0.f);
  mMix_.store(mix_);
  ringIn_.push(monoIn_, n);
  ringOut_.push(monoOut_, n);
}

EngineMeters Engine::readMeters() {
  EngineMeters m;
  m.channels = outCh_;
  for (int c = 0; c < outCh_; ++c) {
    m.outPeak[c] = mOutPeak_[c].exchange(0.f);
    m.outRms[c] = mOutRms_[c].exchange(0.f);
  }
  m.inPeak = mInPeak_.exchange(0.f);
  m.limiterGrDb = mLimGr_.exchange(0.f);
  m.compGrDb = mCompGr_.exchange(0.f);
  m.agcGainDb = mAgc_.load();
  m.bassBoostDb = mBass_.load();
  m.loudnessLufs = mLufs_.load();
  m.cpuLoad = mCpu_.exchange(0.f);
  m.wetMix = mMix_.load();
  m.framesProcessed = framesProcessed_.load(std::memory_order_relaxed);
  m.nonFiniteEvents = nonFinite_.load(std::memory_order_relaxed);
  return m;
}

bool Engine::readAnalysis(float* original, float* processed, int n) {
  if (!prepared_.load(std::memory_order_acquire)) return false;
  const size_t want = static_cast<size_t>(n);
  if (ringIn_.available() < want || ringOut_.available() < want) return false;
  ringIn_.skipToLatest(want);
  ringOut_.skipToLatest(want);
  ringIn_.pop(original, want);
  ringOut_.pop(processed, want);
  return true;
}

void Engine::computeResponseDb(const EngineParams& pin, double fs, const float* freqs, float* outDb, int n,
                               bool includeDevice, bool includeGain) {
  EngineParams p = pin;
  p.sanitize();
  BiquadCoeffs coeffs[kEqBands + Equalizer::kToneBands + kMaxDeviceFilters];
  int count = 0;
  if (p.eqEnabled) {
    for (int b = 0; b < kEqBands; ++b) coeffs[count++] = Equalizer::designGraphic(b, p.eqGainsDb[b], p.eqQ, fs);
    const float tone[3] = {p.bassDb, p.midDb, p.trebleDb};
    for (int t = 0; t < 3; ++t) coeffs[count++] = Equalizer::designTone(t, tone[t], fs);
  }
  double offset = 0.0;
  if (includeDevice && p.deviceEqEnabled) {
    for (int i = 0; i < p.deviceFilterCount; ++i) coeffs[count++] = Equalizer::designDevice(p.deviceFilters[i], fs);
    offset += p.deviceEqPreampDb;
  }
  if (includeGain) offset += std::min(p.maxBoostDb, p.preampDb + p.headroomDb);
  for (int i = 0; i < n; ++i) {
    double db = offset;
    const double f = std::min(static_cast<double>(freqs[i]), fs * 0.499);
    for (int k = 0; k < count; ++k)
      if (!coeffs[k].isIdentity()) db += biquadMagnitudeDb(coeffs[k], f, fs);
    outDb[i] = static_cast<float>(db);
  }
}

float Engine::computeHeadroomDb(const EngineParams& p, double fs) {
  constexpr int kPoints = 160;
  float freqs[kPoints], db[kPoints];
  for (int i = 0; i < kPoints; ++i) freqs[i] = static_cast<float>(20.0 * std::pow(1000.0, i / (kPoints - 1.0)));
  computeResponseDb(p, fs, freqs, db, kPoints, true, false);
  float peak = 0.f;
  for (float v : db) peak = std::max(peak, v);
  // Only the equaliser boost is compensated; the preamp stays the user's choice
  // and the output limiter still guarantees the ceiling.
  return -std::max(0.f, peak);
}

}  // namespace msfx
