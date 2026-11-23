// Unit, safety and performance tests for the MinSoundFX DSP engine.
// Built and run by `npm run test:native` (scripts/test-native.mjs).
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <random>
#include <string>
#include <vector>

#include "../src/dsp/analyzer.hpp"
#include "../src/dsp/biquad.hpp"
#include "../src/dsp/dynamics.hpp"
#include "../src/dsp/engine.hpp"
#include "../src/dsp/lockfree.hpp"
#include "../src/dsp/spatial.hpp"

using namespace msfx;

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                                 \
  do {                                                                              \
    ++g_checks;                                                                     \
    if (!(cond)) {                                                                  \
      ++g_failures;                                                                 \
      std::printf("    FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);              \
    }                                                                               \
  } while (0)

#define CHECK_NEAR(a, b, tol)                                                       \
  do {                                                                              \
    ++g_checks;                                                                     \
    const double _a = (a), _b = (b);                                                \
    if (!(std::fabs(_a - _b) <= (tol))) {                                           \
      ++g_failures;                                                                 \
      std::printf("    FAIL %s:%d: %s = %g, expected %g ± %g\n", __FILE__, __LINE__, \
                  #a, _a, _b, (double)(tol));                                       \
    }                                                                               \
  } while (0)

struct TestCase {
  const char* name;
  std::function<void()> fn;
};
static std::vector<TestCase>& registry() {
  static std::vector<TestCase> r;
  return r;
}
struct Reg {
  Reg(const char* n, std::function<void()> f) { registry().push_back({n, std::move(f)}); }
};
#define TEST(name)                         \
  static void name();                      \
  static Reg reg_##name(#name, name);      \
  static void name()

// ---------------------------------------------------------------- helpers
static constexpr double kFs = 48000.0;

static std::vector<float> sine(double freq, double amp, int frames, int channels, double fs = kFs) {
  std::vector<float> v(static_cast<size_t>(frames) * channels);
  for (int i = 0; i < frames; ++i)
    for (int c = 0; c < channels; ++c)
      v[static_cast<size_t>(i) * channels + c] = static_cast<float>(amp * std::sin(2.0 * kPi * freq * i / fs));
  return v;
}

static double rmsOf(const std::vector<float>& v, int channels, int ch, int from = 0) {
  double s = 0.0;
  int n = 0;
  for (size_t i = static_cast<size_t>(from) * channels + ch; i < v.size(); i += channels) {
    s += static_cast<double>(v[i]) * v[i];
    ++n;
  }
  return n ? std::sqrt(s / n) : 0.0;
}

static double peakOf(const std::vector<float>& v) {
  double p = 0.0;
  for (float x : v) p = std::max(p, static_cast<double>(std::fabs(x)));
  return p;
}

static std::vector<float> runEngine(Engine& e, const std::vector<float>& in, int inCh, int outCh,
                                    int block = 512) {
  const int frames = static_cast<int>(in.size() / inCh);
  std::vector<float> out(static_cast<size_t>(frames) * outCh);
  for (int f = 0; f < frames; f += block) {
    const int n = std::min(block, frames - f);
    e.process(in.data() + static_cast<size_t>(f) * inCh, out.data() + static_cast<size_t>(f) * outCh, n);
  }
  return out;
}

static EngineParams flatParams() {
  EngineParams p;
  p.enabled = true;
  p.sanitize();
  return p;
}

// ---------------------------------------------------------------- biquad
TEST(biquad_peak_has_requested_gain_at_centre) {
  const auto c = designBiquad(FilterType::Peak, kFs, 1000.0, 1.41, 6.0);
  CHECK_NEAR(biquadMagnitudeDb(c, 1000.0, kFs), 6.0, 0.01);
  CHECK_NEAR(biquadMagnitudeDb(c, 20.0, kFs), 0.0, 0.1);
  CHECK_NEAR(biquadMagnitudeDb(c, 20000.0, kFs), 0.0, 0.2);
}

TEST(biquad_shelves_reach_their_plateau) {
  const auto lo = designBiquad(FilterType::LowShelf, kFs, 100.0, 0.7, 9.0);
  CHECK_NEAR(biquadMagnitudeDb(lo, 10.0, kFs), 9.0, 0.2);
  CHECK_NEAR(biquadMagnitudeDb(lo, 10000.0, kFs), 0.0, 0.05);
  const auto hi = designBiquad(FilterType::HighShelf, kFs, 8000.0, 0.7, -6.0);
  CHECK_NEAR(biquadMagnitudeDb(hi, 22000.0, kFs), -6.0, 0.3);
  CHECK_NEAR(biquadMagnitudeDb(hi, 100.0, kFs), 0.0, 0.05);
}

TEST(biquad_processing_matches_designed_response) {
  Biquad b;
  b.c = designBiquad(FilterType::Peak, kFs, 2000.0, 1.0, -9.0);
  auto x = sine(2000.0, 0.5, 48000, 1);
  for (float& s : x) s = b.process(s);
  const double outDb = 20.0 * std::log10(rmsOf(x, 1, 0, 24000) / (0.5 / std::sqrt(2.0)));
  CHECK_NEAR(outDb, -9.0, 0.1);
}

TEST(biquad_stays_finite_at_extreme_settings) {
  for (double fs : {8000.0, 44100.0, 192000.0}) {
    for (double f : {1.0, 20.0, 1000.0, fs * 0.49, fs}) {
      const auto c = designBiquad(FilterType::Peak, fs, f, 0.01, 12.0);
      CHECK(std::isfinite(c.b0) && std::isfinite(c.a1) && std::isfinite(c.a2));
    }
  }
}

// ---------------------------------------------------------------- lock-free
TEST(triple_buffer_delivers_latest_value) {
  TripleBuffer<int> tb;
  int v = 0;
  CHECK(!tb.read(v) || v == 0);
  tb.write(1);
  tb.write(2);
  tb.write(3);
  CHECK(tb.read(v));
  CHECK(v == 3);
  CHECK(!tb.read(v));
  tb.write(4);
  CHECK(tb.read(v) && v == 4);
}

TEST(spsc_ring_round_trips_and_skips) {
  SpscRing r(16);
  float in[10], out[10];
  for (int i = 0; i < 10; ++i) in[i] = static_cast<float>(i);
  CHECK(r.push(in, 10) == 10);
  CHECK(r.available() == 10);
  r.skipToLatest(4);
  CHECK(r.pop(out, 10) == 4);
  CHECK(out[0] == 6.f && out[3] == 9.f);
  CHECK(r.push(in, 10) == 10);
  CHECK(r.push(in, 10) == 6);  // only 6 slots free
}

// ---------------------------------------------------------------- engine basics
TEST(flat_engine_is_transparent_apart_from_latency) {
  Engine e;
  e.prepare(kFs, 2, 2);
  e.setParams(flatParams());
  auto in = sine(440.0, 0.25, 48000, 2);
  auto out = runEngine(e, in, 2, 2);
  const int lat = e.latencySamples();
  double maxErr = 0.0;
  for (int i = 4800; i < 48000; ++i)
    for (int c = 0; c < 2; ++c)
      maxErr = std::max(maxErr, std::fabs(out[i * 2 + c] - in[(i - lat) * 2 + c]) + 0.0);
  CHECK(maxErr < 1e-4);
}

TEST(silence_in_gives_silence_out_with_all_effects) {
  Engine e;
  e.prepare(kFs, 2, 2);
  EngineParams p = flatParams();
  p.bassEnabled = p.dialogueEnabled = p.widenEnabled = p.surroundEnabled = true;
  p.compEnabled = p.loudnessEnabled = true;
  p.compMakeupDb = 12.f;
  for (float& g : p.eqGainsDb) g = 12.f;
  e.setParams(p);
  std::vector<float> in(48000 * 2, 0.f);
  auto out = runEngine(e, in, 2, 2);
  CHECK(peakOf(out) < 1e-6);
}

TEST(unprepared_engine_outputs_silence) {
  Engine e;
  std::vector<float> in(256 * 2, 0.5f), out(256 * 2, 1.f);
  e.process(in.data(), out.data(), 256);
  CHECK(peakOf(out) == 0.0);
}

TEST(eq_band_boost_is_audible_at_band_centre) {
  Engine e;
  e.prepare(kFs, 2, 2);
  EngineParams p = flatParams();
  p.eqGainsDb[5] = 6.f;  // 1 kHz
  e.setParams(p);
  auto in = sine(1000.0, 0.1, 48000, 2);
  auto out = runEngine(e, in, 2, 2);
  const double gain = 20.0 * std::log10(rmsOf(out, 2, 0, 24000) / rmsOf(in, 2, 0, 24000));
  CHECK_NEAR(gain, 6.0, 0.3);
}

TEST(response_curve_matches_band_settings) {
  EngineParams p = flatParams();
  p.eqGainsDb[3] = -8.f;  // 250 Hz
  p.trebleDb = 4.f;
  float f[3] = {250.f, 20000.f, 1000.f}, db[3];
  Engine::computeResponseDb(p, kFs, f, db, 3);
  CHECK_NEAR(db[0], -8.0, 0.6);
  CHECK(db[1] > 3.5);
  CHECK(std::fabs(db[2]) < 1.5);
}

TEST(auto_headroom_compensates_eq_boost) {
  EngineParams p = flatParams();
  CHECK_NEAR(Engine::computeHeadroomDb(p, kFs), 0.0, 1e-6);
  p.eqGainsDb[1] = 9.f;
  const float h = Engine::computeHeadroomDb(p, kFs);
  CHECK(h < -8.0f && h > -10.5f);
  for (float& g : p.eqGainsDb) g = -6.f;
  CHECK_NEAR(Engine::computeHeadroomDb(p, kFs), 0.0, 1e-6);
}

// ---------------------------------------------------------------- safety
TEST(limiter_never_exceeds_ceiling_on_hot_random_input) {
  Limiter lim;
  lim.prepare(kFs, 2);
  std::mt19937 rng(42);
  std::normal_distribution<float> dist(0.f, 2.5f);
  std::vector<float> l(48000), r(48000);
  for (int i = 0; i < 48000; ++i) {
    l[i] = dist(rng);
    r[i] = dist(rng) * ((i / 3000) % 2 ? 8.f : 0.1f);
  }
  const float ceilingDb = -1.f;
  const float ceiling = dbToGain(ceilingDb);
  float maxOut = 0.f;
  for (int f = 0; f < 48000; f += 128) {
    float* ch[2] = {l.data() + f, r.data() + f};
    lim.process(ch, 2, 128, ceilingDb);
  }
  for (int i = 0; i < 48000; ++i) maxOut = std::max({maxOut, std::fabs(l[i]), std::fabs(r[i])});
  CHECK(maxOut <= ceiling + 1e-6f);
}

TEST(limiter_reduces_gain_smoothly_before_peak) {
  // The gain must already be down when a transient leaves the look-ahead
  // delay, so the hard clamp should never have to act (no clipping).
  Limiter lim;
  lim.prepare(kFs, 1);
  std::vector<float> x(4800, 0.1f);
  for (int i = 2400; i < 2460; ++i) x[i] = 4.f;
  std::vector<float> copy = x;
  for (int f = 0; f < 4800; f += 128) {
    float* ch[1] = {x.data() + f};
    lim.process(ch, 1, std::min(128, 4800 - f), -1.f);
  }
  const int lat = lim.latencySamples();
  const float ceiling = dbToGain(-1.f);
  int clamped = 0;
  for (int i = 2400; i < 2460; ++i) {
    const float g = std::fabs(x[i + lat]) / copy[i];
    if (std::fabs(x[i + lat]) >= ceiling - 1e-7f && g < ceiling / 4.f - 1e-4f) ++clamped;
  }
  CHECK(clamped == 0);
  CHECK(std::fabs(x[2400 + lat]) <= ceiling + 1e-6f);
}

TEST(engine_output_respects_ceiling_with_maximum_boosts) {
  Engine e;
  e.prepare(kFs, 2, 2);
  EngineParams p = flatParams();
  p.preampDb = 12.f;
  for (float& g : p.eqGainsDb) g = 12.f;
  p.bassDb = p.trebleDb = p.midDb = 12.f;
  p.bassEnabled = true;
  p.bassAmount = 1.f;
  p.loudnessEnabled = true;
  p.compEnabled = true;
  p.compMakeupDb = 18.f;
  p.outputGainDb = 6.f;
  p.limiterCeilingDb = -3.f;
  e.setParams(p);
  auto in = sine(60.0, 0.9, 96000, 2);
  auto out = runEngine(e, in, 2, 2);
  CHECK(peakOf(out) <= dbToGain(-3.f) + 1e-5);
}

TEST(sanitize_clamps_unsafe_values) {
  EngineParams p;
  p.preampDb = 80.f;
  p.eqGainsDb[0] = 100.f;
  p.limiterCeilingDb = 6.f;
  p.width = NAN;
  p.compRatio = -5.f;
  p.outputGainDb = INFINITY;
  p.deviceFilterCount = 99;
  p.sanitize();
  CHECK(p.preampDb == 12.f);
  CHECK(p.eqGainsDb[0] == 12.f);
  CHECK(p.limiterCeilingDb == -0.1f);
  CHECK(p.width == 1.f);
  CHECK(p.compRatio == 1.f);
  CHECK(p.outputGainDb == 0.f);
  CHECK(p.deviceFilterCount == kMaxDeviceFilters);
}

TEST(nan_input_is_contained) {
  Engine e;
  e.prepare(kFs, 2, 2);
  e.setParams(flatParams());
  auto in = sine(300.0, 0.3, 4800, 2);
  in[1000] = NAN;
  in[2001] = INFINITY;
  auto out = runEngine(e, in, 2, 2);
  bool finite = true;
  for (float v : out) finite = finite && std::isfinite(v);
  CHECK(finite);
}

TEST(bypass_crossfade_has_no_discontinuity) {
  Engine e;
  e.prepare(kFs, 2, 2);
  EngineParams p = flatParams();
  p.eqGainsDb[5] = 9.f;
  p.bassEnabled = true;
  e.setParams(p);
  auto in = sine(1000.0, 0.3, 48000, 2);
  std::vector<float> out(in.size());
  int frames = 48000;
  for (int f = 0; f < frames; f += 256) {
    if (f == 24064) {
      p.enabled = false;
      e.setParams(p);
    }
    e.process(in.data() + f * 2, out.data() + f * 2, 256);
  }
  double maxStep = 0.0;
  for (int i = 20000; i < 30000; ++i) maxStep = std::max(maxStep, (double)std::fabs(out[i * 2] - out[(i - 1) * 2]));
  // A 1 kHz sine at peak ~0.85 changes by at most ~0.11 per sample.
  CHECK(maxStep < 0.13);
  // Fully bypassed afterwards: equals the delayed original.
  const int lat = e.latencySamples();
  CHECK_NEAR(out[47000 * 2], in[(47000 - lat) * 2], 1e-5);
}

// ---------------------------------------------------------------- effects
TEST(widener_preserves_mono_and_scales_side) {
  StereoWidener w;
  w.prepare(kFs);
  // Pure mono stays identical at any width.
  std::vector<float> l(4800), r(4800);
  for (int i = 0; i < 4800; ++i) l[i] = r[i] = 0.3f * std::sin(i * 0.05f);
  w.process(l.data(), r.data(), 4800, 2.f);
  double diff = 0.0;
  for (int i = 2000; i < 4800; ++i) diff = std::max(diff, (double)std::fabs(l[i] - r[i]));
  CHECK(diff < 1e-6);
  // Width 0 collapses a hard-panned high-frequency tone to mono.
  StereoWidener w2;
  w2.prepare(kFs);
  for (int i = 0; i < 4800; ++i) {
    l[i] = 0.3f * std::sin(2 * kPi * 3000 * i / kFs);
    r[i] = 0.f;
  }
  for (int f = 0; f < 4800; f += 128) w2.process(l.data() + f, r.data() + f, std::min(128, 4800 - f), 0.f);
  double side = 0.0;
  for (int i = 3000; i < 4800; ++i) side = std::max(side, (double)std::fabs(l[i] - r[i]));
  CHECK(side < 0.02);
}

TEST(dialogue_enhancer_lifts_centre_presence_more_than_sides) {
  auto measure = [](bool centred) {
    DialogueEnhancer d;
    d.prepare(kFs);
    std::vector<float> l(48000), r(48000);
    for (int i = 0; i < 48000; ++i) {
      const float s = 0.2f * std::sin(2 * kPi * 2600 * i / kFs);
      l[i] = s;
      r[i] = centred ? s : -s;
    }
    for (int f = 0; f < 48000; f += 128) d.process(l.data() + f, r.data() + f, nullptr, 128, 1.f);
    double acc = 0;
    for (int i = 24000; i < 48000; ++i) acc += l[i] * l[i];
    return 20 * std::log10(std::sqrt(acc / 24000) / (0.2 / std::sqrt(2.0)));
  };
  const double centreGain = measure(true);
  const double sideGain = measure(false);
  CHECK(centreGain > 5.0);
  CHECK(sideGain < -2.0);
}

TEST(bass_enhancer_adds_low_end_and_backs_off_when_loud) {
  auto gainAt = [](float amp) {
    BassEnhancer b;
    b.prepare(kFs);
    std::vector<float> l(96000), r(96000);
    for (int i = 0; i < 96000; ++i) l[i] = r[i] = amp * std::sin(2 * kPi * 50 * i / kFs);
    for (int f = 0; f < 96000; f += 128) b.process(l.data() + f, r.data() + f, nullptr, 128, 1.f, 90.f);
    double acc = 0;
    for (int i = 48000; i < 96000; ++i) acc += l[i] * l[i];
    return 20 * std::log10(std::sqrt(acc / 48000) / (amp / std::sqrt(2.0)));
  };
  const double quiet = gainAt(0.02f);
  const double loud = gainAt(0.7f);
  CHECK(quiet > 6.0);
  CHECK(loud < quiet - 3.0);
}

TEST(compressor_reduces_loud_signal_by_ratio) {
  Compressor c;
  c.prepare(kFs);
  std::vector<float> x(96000);
  for (int i = 0; i < 96000; ++i) x[i] = 0.5f * std::sin(2 * kPi * 200 * i / kFs);  // peak -6 dBFS
  for (int f = 0; f < 96000; f += 128) {
    float* ch[1] = {x.data() + f};
    c.process(ch, 1, 128, -26.f, 4.f, 5.f, 100.f, 0.f);
  }
  // 20 dB over threshold at 4:1 -> 15 dB reduction.
  CHECK_NEAR(c.gainReductionDb(), 15.0, 1.0);
}

TEST(loudness_normalizer_converges_toward_target) {
  LoudnessNormalizer ln;
  ln.prepare(kFs, 2);
  const int frames = 48000 * 20;
  std::vector<float> l(128), r(128);
  float lastGain = 0.f;
  for (int f = 0; f < frames; f += 128) {
    for (int i = 0; i < 128; ++i) l[i] = r[i] = 0.02f * std::sin(2 * kPi * 1000 * (f + i) / kFs);  // ~-34 LUFS
    float* ch[2] = {l.data(), r.data()};
    ln.process(ch, 2, 128, -16.f, 9.f);
    lastGain = ln.gainDb();
  }
  CHECK_NEAR(lastGain, 9.0, 0.5);  // capped by max boost
  CHECK(ln.loudnessLufs() < -25.f);
}

TEST(loudness_normalizer_holds_gain_during_silence) {
  LoudnessNormalizer ln;
  ln.prepare(kFs, 2);
  std::vector<float> l(128), r(128);
  for (int f = 0; f < 48000 * 10; f += 128) {
    for (int i = 0; i < 128; ++i) l[i] = r[i] = 0.5f * std::sin(2 * kPi * 1000 * (f + i) / kFs);
    float* ch[2] = {l.data(), r.data()};
    ln.process(ch, 2, 128, -20.f, 9.f);
  }
  const float before = ln.gainDb();
  for (int f = 0; f < 48000 * 5; f += 128) {
    std::fill(l.begin(), l.end(), 0.f);
    std::fill(r.begin(), r.end(), 0.f);
    float* ch[2] = {l.data(), r.data()};
    ln.process(ch, 2, 128, -20.f, 9.f);
  }
  CHECK(before < -2.f);
  CHECK_NEAR(ln.gainDb(), before, 0.5);
}

TEST(virtual_surround_stays_bounded_and_decorrelates) {
  for (int mode : {0, 1}) {
    VirtualSurround vs;
    vs.prepare(kFs);
    std::vector<float> l(48000), r(48000);
    std::mt19937 rng(7);
    std::uniform_real_distribution<float> u(-0.5f, 0.5f);
    for (int i = 0; i < 48000; ++i) l[i] = r[i] = u(rng);
    for (int f = 0; f < 48000; f += 128) vs.process(l.data() + f, r.data() + f, 128, 1.f, 0.7f, mode);
    double corrNum = 0, el = 0, er = 0;
    float peak = 0;
    for (int i = 24000; i < 48000; ++i) {
      corrNum += l[i] * r[i];
      el += l[i] * l[i];
      er += r[i] * r[i];
      peak = std::max({peak, std::fabs(l[i]), std::fabs(r[i])});
    }
    const double corr = corrNum / std::sqrt(el * er);
    CHECK(corr < 0.995);  // mono input gains some spatial decorrelation
    CHECK(peak < 2.0f);
  }
}

// ---------------------------------------------------------------- channels
TEST(stereo_upmix_to_51_fills_centre_lfe_and_surrounds) {
  Engine e;
  e.prepare(kFs, 2, 6);
  EngineParams p = flatParams();
  p.upmixEnabled = true;
  e.setParams(p);
  std::vector<float> in(48000 * 2);
  for (int i = 0; i < 48000; ++i) {
    in[i * 2] = 0.3f * std::sin(2 * kPi * 60 * i / kFs) + 0.2f * std::sin(2 * kPi * 900 * i / kFs);
    in[i * 2 + 1] = 0.3f * std::sin(2 * kPi * 60 * i / kFs) + 0.2f * std::sin(2 * kPi * 1500 * i / kFs);
  }
  auto out = runEngine(e, in, 2, 6);
  CHECK(rmsOf(out, 6, 2, 24000) > 0.01);  // centre
  CHECK(rmsOf(out, 6, 3, 24000) > 0.05);  // LFE
  CHECK(rmsOf(out, 6, 4, 24000) > 0.01);  // Ls
  CHECK(rmsOf(out, 6, 5, 24000) > 0.01);  // Rs
}

TEST(stereo_to_51_without_upmix_leaves_extra_channels_silent) {
  Engine e;
  e.prepare(kFs, 2, 6);
  e.setParams(flatParams());
  auto in = sine(500.0, 0.3, 9600, 2);
  auto out = runEngine(e, in, 2, 6);
  for (int c = 2; c < 6; ++c) CHECK(rmsOf(out, 6, c) < 1e-9);
  CHECK(rmsOf(out, 6, 0, 2000) > 0.1);
}

TEST(downmix_51_to_stereo_keeps_centre_in_both_sides) {
  ChannelMapper m;
  m.prepare(kFs);
  std::vector<float> in(256 * 6, 0.f);
  for (int i = 0; i < 256; ++i) in[i * 6 + 2] = 0.5f;  // centre only
  std::vector<float> l(256), r(256);
  float* out[2] = {l.data(), r.data()};
  m.map(in.data(), 6, out, 2, 256, false);
  CHECK(l[10] > 0.1f && std::fabs(l[10] - r[10]) < 1e-6f);
}

TEST(balance_attenuates_opposite_side) {
  Engine e;
  e.prepare(kFs, 2, 2);
  EngineParams p = flatParams();
  p.balance = 1.f;  // full right
  e.setParams(p);
  auto in = sine(440.0, 0.3, 48000, 2);
  auto out = runEngine(e, in, 2, 2);
  CHECK(rmsOf(out, 2, 0, 24000) < 1e-3);
  CHECK(rmsOf(out, 2, 1, 24000) > 0.2);
}

// ---------------------------------------------------------------- analysis
TEST(analyzer_finds_sine_in_right_band) {
  SpectrumAnalyzer a(4096);
  std::vector<float> x(4096);
  for (int i = 0; i < 4096; ++i) x[i] = static_cast<float>(std::sin(2 * kPi * 1000.0 * i / kFs));
  const int bands = 64;
  std::vector<float> out(bands);
  a.analyze(x.data(), kFs, out.data(), bands);
  int best = 0;
  for (int b = 1; b < bands; ++b)
    if (out[b] > out[best]) best = b;
  const double lo = 20.0 * std::exp(std::log(1000.0) * best / bands);
  const double hi = 20.0 * std::exp(std::log(1000.0) * (best + 1) / bands);
  CHECK(lo <= 1060.0 && hi >= 940.0);
  CHECK_NEAR(out[best], 0.0, 1.5);  // full-scale sine reads ~0 dBFS
}

TEST(engine_meters_and_analysis_report_real_signal) {
  Engine e;
  e.prepare(kFs, 2, 2);
  e.setParams(flatParams());
  auto in = sine(1000.0, 0.5, 8192, 2);
  runEngine(e, in, 2, 2);
  EngineMeters m = e.readMeters();
  CHECK_NEAR(m.outPeak[0], 0.5, 0.01);
  CHECK_NEAR(m.outRms[0], 0.3535, 0.02);
  CHECK(m.framesProcessed == 8192);
  std::vector<float> a(2048), b(2048);
  CHECK(e.readAnalysis(a.data(), b.data(), 2048));
  CHECK(peakOf(b) > 0.45);
}

// ---------------------------------------------------------------- performance
TEST(performance_realtime_factor) {
  for (int ch : {2, 6}) {
    Engine e;
    e.prepare(kFs, ch, ch);
    EngineParams p = flatParams();
    for (int i = 0; i < kEqBands; ++i) p.eqGainsDb[i] = (i % 2 ? 3.f : -2.f);
    p.bassDb = 2.f;
    p.trebleDb = 1.f;
    p.bassEnabled = p.dialogueEnabled = p.widenEnabled = p.compEnabled = p.loudnessEnabled = true;
    p.surroundEnabled = true;
    p.upmixEnabled = true;
    e.setParams(p);
    const int seconds = 20;
    auto in = sine(220.0, 0.3, 48000, ch);
    std::vector<float> out(in.size());
    const auto t0 = std::chrono::steady_clock::now();
    for (int s = 0; s < seconds; ++s)
      for (int f = 0; f < 48000; f += 256) e.process(in.data() + f * ch, out.data() + f * ch, 256);
    const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    const double rtf = seconds / elapsed;
    std::printf("    %d ch, all effects: %.0fx real time (%.2f%% of one core)\n", ch, rtf, 100.0 / rtf);
    CHECK(rtf > 20.0);
  }
}

int main(int argc, char** argv) {
  std::setvbuf(stdout, nullptr, _IONBF, 0);  // keep output if a test crashes
  const char* filter = argc > 1 ? argv[1] : nullptr;
  int ran = 0;
  for (auto& t : registry()) {
    if (filter && std::string(t.name).find(filter) == std::string::npos) continue;
    const int before = g_failures;
    std::printf("  ...  %s\r", t.name);
    t.fn();
    ++ran;
    std::printf("%s %s\n", g_failures == before ? "  ok  " : "  FAIL", t.name);
  }
  std::printf("\n%d tests, %d checks, %d failures\n", ran, g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
