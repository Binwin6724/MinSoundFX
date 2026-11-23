// The MinSoundFX processing engine. Platform backends feed it interleaved
// float audio from their real-time callback; everything else (parameter
// changes, meters, analysis) happens on the control thread through lock-free
// hand-offs.
#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

#include "analyzer.hpp"
#include "dynamics.hpp"
#include "lockfree.hpp"
#include "params.hpp"
#include "spatial.hpp"

namespace msfx {

struct EngineMeters {
  int channels = 0;
  float outPeak[kMaxChannels] = {};
  float outRms[kMaxChannels] = {};
  float inPeak = 0.f;
  float limiterGrDb = 0.f;
  float compGrDb = 0.f;
  float agcGainDb = 0.f;
  float bassBoostDb = 0.f;
  float loudnessLufs = -70.f;
  float cpuLoad = 0.f;     // fraction of the real-time budget used (peak since last read)
  float wetMix = 1.f;      // 0 = bypassed, 1 = fully enhanced
  uint64_t framesProcessed = 0;
  uint32_t nonFiniteEvents = 0;
};

class Engine {
 public:
  static constexpr int kSubBlock = 128;
  static constexpr int kAnalysisRing = 16384;

  Engine();

  // Control thread, while the audio callback is NOT running.
  void prepare(double sampleRate, int inChannels, int outChannels);
  bool isPrepared() const { return prepared_.load(std::memory_order_acquire); }
  void unprepare() { prepared_.store(false, std::memory_order_release); }

  // Control thread. Thread-safe with respect to process().
  void setParams(const EngineParams& p);
  const EngineParams& params() const { return controlParams_; }

  // Audio thread. `in` holds inChannels interleaved, `out` outChannels interleaved.
  // Safe to call before prepare (outputs silence).
  void process(const float* in, float* out, int frames);

  // Control thread.
  EngineMeters readMeters();
  // Copies the newest `n` analysis samples (mono) of the original and the
  // processed signal. Returns false if not enough audio has been seen yet.
  bool readAnalysis(float* original, float* processed, int n);

  double sampleRate() const { return fs_; }
  int inChannels() const { return inCh_; }
  int outChannels() const { return outCh_; }
  int latencySamples() const { return limiter_.latencySamples(); }

  // Static helpers (no engine state), usable from the control thread.
  // Static magnitude response of the tonal chain (device EQ + graphic EQ +
  // tone + preamp) in dB at the given frequencies.
  static void computeResponseDb(const EngineParams& p, double fs, const float* freqs, float* outDb,
                                int n, bool includeDevice = true, bool includeGain = false);
  // Automatic headroom (<= 0 dB) that keeps the tonal chain from boosting
  // above unity, used by the clipping-prevention option.
  static float computeHeadroomDb(const EngineParams& p, double fs);

 private:
  void processSubBlock(const float* in, float* out, int n);
  void resetWetChain();

  std::atomic<bool> prepared_{false};
  double fs_ = 48000.0;
  int inCh_ = 2, outCh_ = 2;

  EngineParams controlParams_;  // control-thread copy
  EngineParams p_;              // audio-thread copy
  int controlDeviceVersion_ = 0;
  struct ParamEnvelope {
    EngineParams params;
    int deviceVersion = 0;
  };
  TripleBuffer<ParamEnvelope> envelope_;
  int deviceVersion_ = 0;

  // Processors
  ChannelMapper wetMapper_, dryMapper_;
  Equalizer eq_;
  BassEnhancer bass_;
  DialogueEnhancer dialogue_;
  StereoWidener widener_;
  VirtualSurround surround_;
  Compressor comp_;
  LoudnessNormalizer loudness_;
  Limiter limiter_;

  // Planar work buffers
  std::vector<float> wetStore_, dryStore_;
  float* wet_[kMaxChannels] = {};
  float* dry_[kMaxChannels] = {};
  std::vector<float> dryDelay_[kMaxChannels];
  int dryDelayPos_ = 0;

  // Smoothed gains / mix
  float gainLin_ = 1.f;
  float balL_ = 1.f, balR_ = 1.f;
  float mix_ = 1.f;
  bool wetActive_ = true;

  // Meters (audio -> control)
  AtomicFloat mOutPeak_[kMaxChannels], mOutRms_[kMaxChannels], mInPeak_;
  AtomicFloat mLimGr_, mCompGr_, mAgc_, mBass_, mLufs_, mCpu_, mMix_;
  std::atomic<uint64_t> framesProcessed_{0};
  std::atomic<uint32_t> nonFinite_{0};

  SpscRing ringIn_{kAnalysisRing}, ringOut_{kAnalysisRing};
  float monoIn_[kSubBlock] = {}, monoOut_[kSubBlock] = {};
};

}  // namespace msfx
