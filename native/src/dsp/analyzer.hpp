// Spectrum analysis for the visualiser: Hann-windowed radix-2 FFT folded into
// logarithmically spaced bands. Runs on the control thread, never in the
// audio callback.
#pragma once

#include <cmath>
#include <complex>
#include <vector>

#include "biquad.hpp"

namespace msfx {

class SpectrumAnalyzer {
 public:
  explicit SpectrumAnalyzer(int fftSize = 2048) { setSize(fftSize); }

  void setSize(int n) {
    int p = 1;
    while (p < n) p <<= 1;
    n_ = p;
    window_.resize(n_);
    double sum = 0.0;
    for (int i = 0; i < n_; ++i) {
      window_[i] = 0.5 - 0.5 * std::cos(2.0 * kPi * i / (n_ - 1));
      sum += window_[i];
    }
    windowGain_ = sum / n_;
    data_.resize(n_);
    mags_.resize(n_ / 2 + 1);
  }

  int size() const { return n_; }

  // In-place iterative radix-2 FFT.
  static void fft(std::vector<std::complex<double>>& a) {
    const int n = static_cast<int>(a.size());
    for (int i = 1, j = 0; i < n; ++i) {
      int bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) std::swap(a[i], a[j]);
    }
    for (int len = 2; len <= n; len <<= 1) {
      const double ang = -2.0 * kPi / len;
      const std::complex<double> wl(std::cos(ang), std::sin(ang));
      for (int i = 0; i < n; i += len) {
        std::complex<double> w(1.0, 0.0);
        for (int k = 0; k < len / 2; ++k) {
          const std::complex<double> u = a[i + k];
          const std::complex<double> v = a[i + k + len / 2] * w;
          a[i + k] = u + v;
          a[i + k + len / 2] = u - v;
          w *= wl;
        }
      }
    }
  }

  // samples: n_ most recent samples (oldest first). Writes `bands` values in
  // dBFS (sine at full scale ~ 0 dB) for log-spaced bands between fMin..fMax.
  void analyze(const float* samples, double fs, float* out, int bands, double fMin = 20.0,
               double fMax = 20000.0) {
    for (int i = 0; i < n_; ++i) data_[i] = std::complex<double>(samples[i] * window_[i], 0.0);
    fft(data_);
    const double scale = 2.0 / (n_ * windowGain_);
    for (int k = 0; k <= n_ / 2; ++k) mags_[k] = std::abs(data_[k]) * scale;

    const double nyq = fs * 0.5;
    if (fMax > nyq) fMax = nyq;
    const double binHz = fs / n_;
    const double ratio = std::log(fMax / fMin);
    for (int b = 0; b < bands; ++b) {
      const double lo = fMin * std::exp(ratio * b / bands);
      const double hi = fMin * std::exp(ratio * (b + 1) / bands);
      int k0 = static_cast<int>(std::floor(lo / binHz));
      int k1 = static_cast<int>(std::ceil(hi / binHz));
      if (k0 < 1) k0 = 1;
      if (k1 > n_ / 2) k1 = n_ / 2;
      double peak = 0.0;
      if (k1 <= k0) {
        // Band narrower than a bin: interpolate the magnitude at its centre.
        const double centre = std::sqrt(lo * hi) / binHz;
        const int kc = static_cast<int>(centre);
        const double frac = centre - kc;
        const int ka = std::min(std::max(kc, 1), n_ / 2);
        const int kb = std::min(ka + 1, n_ / 2);
        peak = mags_[ka] * (1.0 - frac) + mags_[kb] * frac;
      } else {
        for (int k = k0; k < k1; ++k) peak = std::max(peak, mags_[k]);
      }
      out[b] = static_cast<float>(20.0 * std::log10(peak + 1e-9));
    }
  }

 private:
  int n_ = 2048;
  std::vector<double> window_;
  double windowGain_ = 0.5;
  std::vector<std::complex<double>> data_;
  std::vector<double> mags_;
};

}  // namespace msfx
