// Biquad filters (RBJ "Audio EQ Cookbook" designs), transposed direct form II
// with double-precision state so low-frequency bands stay stable and quiet.
#pragma once

#include <cmath>
#include <complex>

namespace msfx {

constexpr double kPi = 3.14159265358979323846;

enum class FilterType : int {
  Peak = 0,
  LowShelf = 1,
  HighShelf = 2,
  LowPass = 3,
  HighPass = 4,
  BandPass = 5,
  AllPass = 6,
};

struct BiquadCoeffs {
  double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;

  bool isIdentity() const {
    return b0 == 1.0 && b1 == 0.0 && b2 == 0.0 && a1 == 0.0 && a2 == 0.0;
  }
};

inline BiquadCoeffs designBiquad(FilterType type, double fs, double f0, double q, double gainDb) {
  BiquadCoeffs c;
  if (fs <= 0.0) return c;
  // Keep the centre frequency inside (0, Nyquist) so designs never blow up.
  const double nyq = fs * 0.5;
  if (f0 < 1.0) f0 = 1.0;
  if (f0 > nyq * 0.98) f0 = nyq * 0.98;
  if (q < 0.05) q = 0.05;

  const double A = std::pow(10.0, gainDb / 40.0);
  const double w0 = 2.0 * kPi * f0 / fs;
  const double cw = std::cos(w0);
  const double sw = std::sin(w0);
  const double alpha = sw / (2.0 * q);

  double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case FilterType::Peak:
      b0 = 1 + alpha * A;
      b1 = -2 * cw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cw;
      a2 = 1 - alpha / A;
      break;
    case FilterType::LowShelf: {
      const double sa = 2 * std::sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + sa);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sa);
      a0 = (A + 1) + (A - 1) * cw + sa;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - sa;
      break;
    }
    case FilterType::HighShelf: {
      const double sa = 2 * std::sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + sa);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - sa);
      a0 = (A + 1) - (A - 1) * cw + sa;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - sa;
      break;
    }
    case FilterType::LowPass:
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case FilterType::HighPass:
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case FilterType::BandPass:  // constant 0 dB peak gain
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case FilterType::AllPass:
      b0 = 1 - alpha;
      b1 = -2 * cw;
      b2 = 1 + alpha;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
  }
  c.b0 = b0 / a0;
  c.b1 = b1 / a0;
  c.b2 = b2 / a0;
  c.a1 = a1 / a0;
  c.a2 = a2 / a0;
  return c;
}

// Magnitude response in dB at frequency f.
inline double biquadMagnitudeDb(const BiquadCoeffs& c, double f, double fs) {
  const double w = 2.0 * kPi * f / fs;
  const std::complex<double> z1 = std::polar(1.0, -w);
  const std::complex<double> z2 = z1 * z1;
  const std::complex<double> num = c.b0 + c.b1 * z1 + c.b2 * z2;
  const std::complex<double> den = 1.0 + c.a1 * z1 + c.a2 * z2;
  const double mag = std::abs(num / den);
  return 20.0 * std::log10(mag > 1e-12 ? mag : 1e-12);
}

struct Biquad {
  BiquadCoeffs c;
  double z1 = 0.0, z2 = 0.0;

  inline float process(float xf) {
    const double x = xf;
    const double y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    return static_cast<float>(y);
  }

  void processBlock(float* buf, int n) {
    if (c.isIdentity()) return;
    for (int i = 0; i < n; ++i) buf[i] = process(buf[i]);
  }

  void reset() { z1 = z2 = 0.0; }

  // Flush denormals / recover from any non-finite state.
  void sanitize() {
    if (!std::isfinite(z1) || !std::isfinite(z2)) reset();
    if (std::fabs(z1) < 1e-25) z1 = 0.0;
    if (std::fabs(z2) < 1e-25) z2 = 0.0;
  }
};

// One-pole smoothing coefficient for a time constant in seconds.
inline float onePoleCoeff(double seconds, double fs) {
  if (seconds <= 0.0 || fs <= 0.0) return 0.0f;
  return static_cast<float>(std::exp(-1.0 / (seconds * fs)));
}

inline float dbToGain(float db) { return std::pow(10.0f, db / 20.0f); }
inline float gainToDb(float g) { return 20.0f * std::log10(g > 1e-9f ? g : 1e-9f); }

}  // namespace msfx
