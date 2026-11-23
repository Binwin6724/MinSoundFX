// Dynamics processors: compressor (night mode / DRC), loudness normaliser
// (ITU-R BS.1770 K-weighted measurement driving a slow AGC) and a
// look-ahead brick-wall peak limiter that guarantees the output ceiling.
#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include "biquad.hpp"
#include "params.hpp"

namespace msfx {

// Stereo-linked feed-forward compressor with a soft knee.
class Compressor {
 public:
  void prepare(double fs) {
    fs_ = fs;
    envDb_ = -120.f;
    grDb_ = 0.f;
  }

  void reset() {
    envDb_ = -120.f;
    grDb_ = 0.f;
  }

  // ch: planar buffers, n frames. Returns the maximum gain reduction (dB, >= 0).
  float process(float* const* ch, int numCh, int n, float thresholdDb, float ratio, float attackMs,
                float releaseMs, float makeupDb) {
    const float att = onePoleCoeff(attackMs * 0.001, fs_);
    const float rel = onePoleCoeff(releaseMs * 0.001, fs_);
    const float detRel = onePoleCoeff(0.030, fs_);  // RMS-ish detector smoothing
    const float knee = 6.f;
    const float makeup = dbToGain(makeupDb);
    float maxGr = 0.f;
    for (int i = 0; i < n; ++i) {
      float peak = 0.f;
      for (int c = 0; c < numCh; ++c) peak = std::max(peak, std::fabs(ch[c][i]));
      const float inDb = gainToDb(peak);
      // Peak-hold detector with smooth decay.
      envDb_ = inDb > envDb_ ? inDb : detRel * envDb_ + (1.f - detRel) * inDb;
      const float over = envDb_ - thresholdDb;
      float targetGr = 0.f;
      if (over > knee * 0.5f) {
        targetGr = over * (1.f - 1.f / ratio);
      } else if (over > -knee * 0.5f) {
        const float x = over + knee * 0.5f;
        targetGr = (1.f - 1.f / ratio) * x * x / (2.f * knee);
      }
      const float coeff = targetGr > grDb_ ? att : rel;
      grDb_ = coeff * grDb_ + (1.f - coeff) * targetGr;
      const float g = dbToGain(-grDb_) * makeup;
      for (int c = 0; c < numCh; ++c) ch[c][i] *= g;
      maxGr = std::max(maxGr, grDb_);
    }
    return maxGr;
  }

  float gainReductionDb() const { return grDb_; }

 private:
  double fs_ = 48000.0;
  float envDb_ = -120.f;
  float grDb_ = 0.f;
};

// K-weighting pre-filter from ITU-R BS.1770 (shelf + RLB high-pass), designed
// for any sample rate with the cookbook equivalents.
struct KWeighting {
  Biquad shelf, hp;
  void prepare(double fs) {
    shelf.c = designBiquad(FilterType::HighShelf, fs, 1681.97, 0.7071752, 3.99984);
    hp.c = designBiquad(FilterType::HighPass, fs, 38.1355, 0.5003270, 0.0);
    shelf.reset();
    hp.reset();
  }
  inline float process(float x) { return hp.process(shelf.process(x)); }
};

// Loudness normaliser: measures short-term K-weighted loudness and steers a
// slowly moving gain toward the target. Silence is gated so quiet passages
// are not pumped up.
class LoudnessNormalizer {
 public:
  void prepare(double fs, int numCh) {
    fs_ = fs;
    numCh_ = numCh;
    for (int c = 0; c < kMaxChannels; ++c) kw_[c].prepare(fs);
    msShort_ = 0.0;
    gainDb_ = 0.f;
    loudness_ = -70.f;
  }

  void reset() {
    msShort_ = 0.0;
    gainDb_ = 0.f;
    loudness_ = -70.f;
  }

  // Channel weights per BS.1770: surrounds +1.5 dB, LFE excluded.
  static float channelWeight(int c, int numCh) {
    if (numCh >= 6) {
      if (c == 3) return 0.f;          // LFE
      if (c >= 4) return 1.41f;        // surrounds / backs
    }
    return 1.f;
  }

  // Measures `in` (pre-gain) and applies the gain in-place.
  void process(float* const* ch, int numCh, int n, float targetLufs, float maxBoostDb, bool apply = true) {
    const double shortCoeff = std::exp(-1.0 / (3.0 * fs_));  // ~3 s short-term window
    double blockMs = 0.0;
    for (int c = 0; c < numCh; ++c) {
      const float w = channelWeight(c, numCh);
      double acc = 0.0;
      for (int i = 0; i < n; ++i) {
        const float k = kw_[c].process(ch[c][i]);
        acc += static_cast<double>(k) * k;
      }
      blockMs += w * acc / std::max(1, n);
      kw_[c].shelf.sanitize();
      kw_[c].hp.sanitize();
    }
    const double blockCoeff = std::pow(shortCoeff, n);
    const double blockLufs = -0.691 + 10.0 * std::log10(blockMs + 1e-12);
    // Absolute gate: ignore silence/near-silence so the AGC holds its gain.
    if (blockLufs > -55.0) msShort_ = blockCoeff * msShort_ + (1.0 - blockCoeff) * blockMs;
    loudness_ = static_cast<float>(-0.691 + 10.0 * std::log10(msShort_ + 1e-12));

    if (!apply) {
      gainDb_ = 0.f;
      return;
    }
    float target = gainDb_;
    if (blockLufs > -55.0 && loudness_ > -60.f) {
      target = std::min(maxBoostDb, std::max(-12.f, targetLufs - loudness_));
    }
    // Slow, asymmetric gain ballistics: turn down faster than up.
    const double tau = target < gainDb_ ? 0.6 : 2.5;
    const float coeff = static_cast<float>(std::exp(-static_cast<double>(n) / (tau * fs_)));
    const float startGain = dbToGain(gainDb_);
    gainDb_ = coeff * gainDb_ + (1.f - coeff) * target;
    const float endGain = dbToGain(gainDb_);
    const float step = n > 0 ? (endGain - startGain) / n : 0.f;
    for (int c = 0; c < numCh; ++c) {
      float g = startGain;
      for (int i = 0; i < n; ++i) {
        ch[c][i] *= g;
        g += step;
      }
    }
  }

  float gainDb() const { return gainDb_; }
  float loudnessLufs() const { return loudness_; }

 private:
  double fs_ = 48000.0;
  int numCh_ = 2;
  KWeighting kw_[kMaxChannels];
  double msShort_ = 0.0;
  float gainDb_ = 0.f;
  float loudness_ = -70.f;
};

// Look-ahead peak limiter. A sliding-window minimum of the required gain is
// smoothed by a box filter of the same length, so the gain is already fully
// down when a peak leaves the delay line. A final clamp makes the ceiling a
// hard guarantee even for pathological input.
class Limiter {
 public:
  void prepare(double fs, int numCh, double lookaheadMs = 1.5) {
    fs_ = fs;
    numCh_ = numCh;
    look_ = std::max(1, static_cast<int>(std::round(lookaheadMs * 0.001 * fs)));
    for (int c = 0; c < kMaxChannels; ++c) delay_[c].assign(look_, 0.f);
    boxRing_.assign(look_, 1.f);
    dqVal_.assign(look_ + 2, 1.f);
    dqIdx_.assign(look_ + 2, 0);
    reset();
  }

  void reset() {
    for (int c = 0; c < kMaxChannels; ++c) std::fill(delay_[c].begin(), delay_[c].end(), 0.f);
    std::fill(boxRing_.begin(), boxRing_.end(), 1.f);
    boxSum_ = static_cast<double>(look_);
    pos_ = 0;
    sampleIndex_ = 0;
    dqHead_ = dqTail_ = 0;
    env_ = 1.f;
    minGain_ = 1.f;
  }

  int latencySamples() const { return look_; }

  // Returns the deepest gain reduction in this block (dB, >= 0).
  float process(float* const* ch, int numCh, int n, float ceilingDb, float releaseMs = 80.f) {
    const float ceiling = dbToGain(ceilingDb);
    const float rel = onePoleCoeff(releaseMs * 0.001, fs_);
    float deepest = 1.f;
    const int cap = look_ + 2;
    for (int i = 0; i < n; ++i) {
      float peak = 0.f;
      for (int c = 0; c < numCh; ++c) {
        float x = ch[c][i];
        if (!std::isfinite(x)) x = 0.f;
        peak = std::max(peak, std::fabs(x));
      }
      const float req = peak > ceiling ? ceiling / peak : 1.f;

      // Sliding-window minimum over the last look_+1 required gains (monotonic
      // deque). One sample longer than the box filter so every term of the
      // average already covers the sample leaving the delay line.
      while (dqTail_ != dqHead_) {
        const int last = (dqTail_ - 1 + cap) % cap;
        if (dqVal_[last] >= req) dqTail_ = last;
        else break;
      }
      dqVal_[dqTail_] = req;
      dqIdx_[dqTail_] = sampleIndex_;
      dqTail_ = (dqTail_ + 1) % cap;
      while (dqIdx_[dqHead_] <= sampleIndex_ - (look_ + 1)) dqHead_ = (dqHead_ + 1) % cap;
      const float windowMin = dqVal_[dqHead_];

      // Box filter (moving average) over the same window.
      boxSum_ += windowMin - boxRing_[pos_];
      boxRing_[pos_] = windowMin;
      float g = static_cast<float>(boxSum_ / look_);
      if (g > 1.f) g = 1.f;

      // Release smoothing: drop instantly to the (already smooth) target, recover slowly.
      env_ = g < env_ ? g : rel * env_ + (1.f - rel) * g;

      for (int c = 0; c < numCh; ++c) {
        float x = ch[c][i];
        if (!std::isfinite(x)) x = 0.f;
        const float delayed = delay_[c][pos_];
        delay_[c][pos_] = x;
        float y = delayed * env_;
        // Hard guarantee.
        if (y > ceiling) y = ceiling;
        else if (y < -ceiling) y = -ceiling;
        ch[c][i] = y;
      }
      deepest = std::min(deepest, env_);
      pos_ = (pos_ + 1) % look_;
      ++sampleIndex_;
      if (sampleIndex_ > (1LL << 60)) {  // practically never; keep indices bounded
        sampleIndex_ = 0;
        dqHead_ = dqTail_ = 0;
      }
    }
    minGain_ = deepest;
    // Periodically re-sum the box filter to cancel floating-point drift.
    if (++blocks_ % 256 == 0) {
      double s = 0.0;
      for (float v : boxRing_) s += v;
      boxSum_ = s;
    }
    return -gainToDb(deepest);
  }

 private:
  double fs_ = 48000.0;
  int numCh_ = 2;
  int look_ = 72;
  std::vector<float> delay_[kMaxChannels];
  std::vector<float> boxRing_;
  std::vector<float> dqVal_;
  std::vector<long long> dqIdx_;
  int dqHead_ = 0, dqTail_ = 0;
  double boxSum_ = 0.0;
  int pos_ = 0;
  long long sampleIndex_ = 0;
  float env_ = 1.f;
  float minGain_ = 1.f;
  unsigned blocks_ = 0;
};

}  // namespace msfx
