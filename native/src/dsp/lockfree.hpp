// Real-time-safe primitives: a triple buffer for parameter snapshots and a
// single-producer / single-consumer ring buffer for analysis samples.
// Neither allocates or locks on the audio thread.
#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>
#include <vector>

namespace msfx {

// Writer (UI/control thread) publishes complete snapshots; reader (audio
// thread) picks up the newest one without ever blocking.
template <typename T>
class TripleBuffer {
 public:
  TripleBuffer() { state_.store(encode(1, false), std::memory_order_relaxed); }

  // Control thread only.
  void write(const T& value) {
    slots_[back_] = value;
    const uint32_t prev = state_.exchange(encode(back_, true), std::memory_order_acq_rel);
    back_ = index(prev);
  }

  // Audio thread only. Returns true when a new value was picked up.
  bool read(T& out) {
    if (!dirty(state_.load(std::memory_order_acquire))) return false;
    const uint32_t prev = state_.exchange(encode(front_, false), std::memory_order_acq_rel);
    front_ = index(prev);
    out = slots_[front_];
    return true;
  }

 private:
  static constexpr uint32_t encode(uint32_t idx, bool d) { return idx | (d ? 4u : 0u); }
  static constexpr uint32_t index(uint32_t s) { return s & 3u; }
  static constexpr bool dirty(uint32_t s) { return (s & 4u) != 0; }

  T slots_[3];
  std::atomic<uint32_t> state_{0};
  uint32_t back_ = 0;   // owned by writer
  uint32_t front_ = 2;  // owned by reader
};

// Lock-free SPSC float ring. Capacity is rounded to a power of two.
class SpscRing {
 public:
  explicit SpscRing(size_t capacity = 8192) { resize(capacity); }

  // Not real-time safe; call before streaming starts.
  void resize(size_t capacity) {
    size_t cap = 1;
    while (cap < capacity) cap <<= 1;
    buf_.assign(cap, 0.f);
    mask_ = cap - 1;
    head_.store(0);
    tail_.store(0);
  }

  // Producer. Drops the oldest data when full is not possible in SPSC, so we
  // drop the newest samples that do not fit (analysis only; never audible).
  size_t push(const float* data, size_t n) {
    const size_t head = head_.load(std::memory_order_relaxed);
    const size_t tail = tail_.load(std::memory_order_acquire);
    const size_t free = buf_.size() - (head - tail);
    if (n > free) n = free;
    for (size_t i = 0; i < n; ++i) buf_[(head + i) & mask_] = data[i];
    head_.store(head + n, std::memory_order_release);
    return n;
  }

  size_t available() const {
    return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_relaxed);
  }

  // Consumer.
  size_t pop(float* out, size_t n) {
    const size_t tail = tail_.load(std::memory_order_relaxed);
    const size_t head = head_.load(std::memory_order_acquire);
    const size_t avail = head - tail;
    if (n > avail) n = avail;
    for (size_t i = 0; i < n; ++i) out[i] = buf_[(tail + i) & mask_];
    tail_.store(tail + n, std::memory_order_release);
    return n;
  }

  // Consumer: discard everything except the newest `keep` samples.
  void skipToLatest(size_t keep) {
    const size_t tail = tail_.load(std::memory_order_relaxed);
    const size_t head = head_.load(std::memory_order_acquire);
    if (head - tail > keep) tail_.store(head - keep, std::memory_order_release);
  }

  size_t capacity() const { return buf_.size(); }

 private:
  std::vector<float> buf_;
  size_t mask_ = 0;
  std::atomic<size_t> head_{0};
  std::atomic<size_t> tail_{0};
};

// Lock-free float stored in an atomic integer (for meters).
class AtomicFloat {
 public:
  void store(float v) {
    uint32_t u;
    std::memcpy(&u, &v, 4);
    bits_.store(u, std::memory_order_relaxed);
  }
  float load() const {
    const uint32_t u = bits_.load(std::memory_order_relaxed);
    float v;
    std::memcpy(&v, &u, 4);
    return v;
  }
  // Keep the maximum until the reader exchanges it.
  void storeMax(float v) {
    uint32_t cur = bits_.load(std::memory_order_relaxed);
    for (;;) {
      float cf;
      std::memcpy(&cf, &cur, 4);
      if (!(v > cf)) return;
      uint32_t nu;
      std::memcpy(&nu, &v, 4);
      if (bits_.compare_exchange_weak(cur, nu, std::memory_order_relaxed)) return;
    }
  }
  float exchange(float v) {
    uint32_t nu;
    std::memcpy(&nu, &v, 4);
    const uint32_t old = bits_.exchange(nu, std::memory_order_relaxed);
    float o;
    std::memcpy(&o, &old, 4);
    return o;
  }

 private:
  std::atomic<uint32_t> bits_{0};
};

}  // namespace msfx
