// Windows backend: WASAPI loopback through a virtual endpoint.
//
// Windows has no public API for apps to intercept and replace the system mix.
// The two legitimate routes are a signed Audio Processing Object (APO) driver
// or a virtual audio endpoint. MinSoundFX uses the latter without installing
// any driver itself:
//   1. A virtual render endpoint (e.g. VB-Audio "CABLE Input") becomes the
//      system default, so apps play into it instead of the speakers.
//   2. We capture that endpoint with WASAPI loopback, process it with the
//      Engine and render the result to the real device (event-driven, shared
//      mode, MMCSS "Pro Audio").
//   3. On stop/quit/uninstall the original default device is restored. The id
//      is also persisted by the app so a crash is repaired on the next launch.
// A small adaptive resampler keeps the two device clocks locked.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <audioclient.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <propidl.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../backend.hpp"

namespace msfx {
namespace {

// ---------------------------------------------------------------- COM helpers
template <typename T>
class ComPtr {
 public:
  ComPtr() = default;
  ~ComPtr() { reset(); }
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;
  T** put() {
    reset();
    return &p_;
  }
  void** putVoid() { return reinterpret_cast<void**>(put()); }
  T* get() const { return p_; }
  T* operator->() const { return p_; }
  explicit operator bool() const { return p_ != nullptr; }
  void reset() {
    if (p_) p_->Release();
    p_ = nullptr;
  }

 private:
  T* p_ = nullptr;
};

std::string narrow(const wchar_t* w) {
  if (!w) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(static_cast<size_t>(n - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  return w;
}

std::string hr(HRESULT h) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(h));
  return buf;
}

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
  return s;
}

// Undocumented but stable since Windows 7; used by the Sound control panel and
// widely by audio switchers. Only SetDefaultEndpoint is used.
struct __declspec(uuid("f8679f50-850a-41cf-9c72-430f290290c8")) IPolicyConfig : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetMixFormat(PCWSTR, WAVEFORMATEX**) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDeviceFormat(PCWSTR, INT, WAVEFORMATEX**) = 0;
  virtual HRESULT STDMETHODCALLTYPE ResetDeviceFormat(PCWSTR) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDeviceFormat(PCWSTR, WAVEFORMATEX*, WAVEFORMATEX*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetProcessingPeriod(PCWSTR, INT, PINT64, PINT64) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetProcessingPeriod(PCWSTR, PINT64) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetShareMode(PCWSTR, void*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetShareMode(PCWSTR, void*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDefaultEndpoint(PCWSTR wszDeviceId, ERole eRole) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetEndpointVisibility(PCWSTR, INT) = 0;
};
const CLSID kCLSID_PolicyConfigClient = {0x870af99c, 0x171d, 0x4f9e, {0xaf, 0x0d, 0xe6, 0x3d, 0xf4, 0x0c, 0x2b, 0xc9}};

// DEVPKEY_Device_EnumeratorName as a PROPERTYKEY (e.g. "BTHENUM", "USB", "HDAUDIO").
const PROPERTYKEY kPKEY_EnumeratorName = {{0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}},
                                          24};

bool looksVirtual(const std::string& name, const std::string& adapter) {
  const std::string n = lower(name + " " + adapter);
  static const char* patterns[] = {"cable input", "vb-audio", "voicemeeter", "virtual audio", "virtual cable",
                                   "minsoundfx", "blackhole", "loopback"};
  for (const char* p : patterns)
    if (n.find(p) != std::string::npos) return true;
  return false;
}

std::string readStringProp(IPropertyStore* store, const PROPERTYKEY& key) {
  PROPVARIANT v;
  PropVariantInit(&v);
  std::string s;
  if (SUCCEEDED(store->GetValue(key, &v)) && v.vt == VT_LPWSTR) s = narrow(v.pwszVal);
  PropVariantClear(&v);
  return s;
}

UINT readUIntProp(IPropertyStore* store, const PROPERTYKEY& key, UINT def) {
  PROPVARIANT v;
  PropVariantInit(&v);
  UINT r = def;
  if (SUCCEEDED(store->GetValue(key, &v)) && v.vt == VT_UI4) r = v.ulVal;
  PropVariantClear(&v);
  return r;
}

DWORD channelMaskFor(int ch) {
  switch (ch) {
    case 1: return KSAUDIO_SPEAKER_MONO;
    case 2: return KSAUDIO_SPEAKER_STEREO;
    case 3: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_LOW_FREQUENCY;
    case 4: return KSAUDIO_SPEAKER_QUAD;
    case 6: return KSAUDIO_SPEAKER_5POINT1;
    case 8: return KSAUDIO_SPEAKER_7POINT1_SURROUND;
    default: return 0;
  }
}

WAVEFORMATEXTENSIBLE floatFormat(int channels, DWORD rate) {
  WAVEFORMATEXTENSIBLE f{};
  f.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  f.Format.nChannels = static_cast<WORD>(channels);
  f.Format.nSamplesPerSec = rate;
  f.Format.wBitsPerSample = 32;
  f.Format.nBlockAlign = static_cast<WORD>(channels * 4);
  f.Format.nAvgBytesPerSec = rate * f.Format.nBlockAlign;
  f.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  f.Samples.wValidBitsPerSample = 32;
  f.dwChannelMask = channelMaskFor(channels);
  f.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
  return f;
}

enum class SampleKind { Float32, Int16, Int24, Int32, Unknown };

SampleKind kindOf(const WAVEFORMATEX* wf) {
  WORD tag = wf->wFormatTag;
  WORD bits = wf->wBitsPerSample;
  if (tag == WAVE_FORMAT_EXTENSIBLE) {
    const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wf);
    if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) return bits == 32 ? SampleKind::Float32 : SampleKind::Unknown;
    if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) tag = WAVE_FORMAT_PCM;
    else return SampleKind::Unknown;
  }
  if (tag == WAVE_FORMAT_IEEE_FLOAT && bits == 32) return SampleKind::Float32;
  if (tag == WAVE_FORMAT_PCM) {
    if (bits == 16) return SampleKind::Int16;
    if (bits == 24) return SampleKind::Int24;
    if (bits == 32) return SampleKind::Int32;
  }
  return SampleKind::Unknown;
}

// ---------------------------------------------------------------- FIFO + resampler
// Interleaved frame FIFO with an adaptive cubic (Catmull-Rom) resampler.
class ResamplingFifo {
 public:
  void prepare(int channels, double inRate, double outRate, int targetFrames) {
    ch_ = channels;
    cap_ = static_cast<size_t>(std::max(inRate, 8000.0)) * 2;  // 2 s
    buf_.assign(cap_ * ch_, 0.f);
    write_ = 0;
    readPos_ = 0.0;
    baseStep_ = inRate / outRate;
    target_ = targetFrames;
    primed_ = false;
    integ_ = 0.0;
  }

  void pushInterleaved(const float* data, size_t frames) {
    for (size_t i = 0; i < frames; ++i) {
      std::memcpy(&buf_[(write_ % cap_) * ch_], data + i * ch_, sizeof(float) * ch_);
      ++write_;
    }
    // Overflow (consumer stalled): keep the newest audio near the target.
    if (static_cast<double>(write_) - readPos_ > static_cast<double>(cap_ - 8)) readPos_ = static_cast<double>(write_ - target_);
  }

  void pushSilence(size_t frames) {
    for (size_t i = 0; i < frames; ++i) {
      std::memset(&buf_[(write_ % cap_) * ch_], 0, sizeof(float) * ch_);
      ++write_;
    }
  }

  double fill() const { return static_cast<double>(write_) - readPos_; }

  // Produces `frames` output frames (interleaved). Returns false on underrun
  // (output is silence while re-priming).
  bool pull(float* out, int frames) {
    const double f = fill();
    if (!primed_) {
      if (f >= target_) primed_ = true;
      else {
        std::memset(out, 0, sizeof(float) * static_cast<size_t>(frames) * ch_);
        return false;
      }
    }
    // Clock-drift control: nudge the step (max ±0.5 %) to hold the fill level.
    const double err = (f - target_) / std::max(1, target_);
    integ_ = std::clamp(integ_ + err * 0.0005, -0.003, 0.003);
    const double step = baseStep_ * (1.0 + std::clamp(err * 0.002 + integ_, -0.005, 0.005));
    // Large excursions (e.g. after a stall): jump back to the target.
    if (f > target_ * 6.0 + 4096) readPos_ = static_cast<double>(write_) - target_;

    for (int i = 0; i < frames; ++i) {
      const double avail = static_cast<double>(write_) - readPos_;
      if (avail < 3.0) {
        std::memset(out + static_cast<size_t>(i) * ch_, 0, sizeof(float) * static_cast<size_t>(frames - i) * ch_);
        primed_ = false;
        return false;
      }
      const long long idx = static_cast<long long>(std::floor(readPos_));
      const float t = static_cast<float>(readPos_ - static_cast<double>(idx));
      const long long i0 = std::max<long long>(idx - 1, 0);
      for (int c = 0; c < ch_; ++c) {
        const float y0 = at(i0, c), y1 = at(idx, c), y2 = at(idx + 1, c), y3 = at(idx + 2, c);
        const float a = -0.5f * y0 + 1.5f * y1 - 1.5f * y2 + 0.5f * y3;
        const float b = y0 - 2.5f * y1 + 2.f * y2 - 0.5f * y3;
        const float cc = -0.5f * y0 + 0.5f * y2;
        out[static_cast<size_t>(i) * ch_ + c] = ((a * t + b) * t + cc) * t + y1;
      }
      readPos_ += step;
    }
    return true;
  }

 private:
  float at(long long frame, int c) const {
    if (frame < 0) frame = 0;
    return buf_[(static_cast<size_t>(frame) % cap_) * ch_ + c];
  }

  int ch_ = 2;
  size_t cap_ = 96000;
  std::vector<float> buf_;
  unsigned long long write_ = 0;
  double readPos_ = 0.0;
  double baseStep_ = 1.0;
  int target_ = 960;
  bool primed_ = false;
  double integ_ = 0.0;
};

// ---------------------------------------------------------------- notifications
class NotificationClient final : public IMMNotificationClient {
 public:
  std::atomic<bool> defaultChanged{false};
  std::atomic<bool> stateChanged{false};
  std::atomic<uint32_t> generation{0};
  std::mutex mutex;
  std::wstring lastDefault;

  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *ppv = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR id) override {
    if (flow == eRender && role == eConsole) {
      std::lock_guard<std::mutex> l(mutex);
      lastDefault = id ? id : L"";
      defaultChanged.store(true);
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override {
    ++generation;
    stateChanged.store(true);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override {
    ++generation;
    stateChanged.store(true);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override {
    ++generation;
    stateChanged.store(true);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  std::atomic<ULONG> ref_{1};
};

// ---------------------------------------------------------------- backend
class WinBackend final : public AudioBackend {
 public:
  explicit WinBackend(Engine& engine) : engine_(engine) {
    comInit_ = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                   enumerator_.putVoid()))) {
      notifier_ = new NotificationClient();
      enumerator_->RegisterEndpointNotificationCallback(notifier_);
    }
  }

  ~WinBackend() override {
    stop();
    if (enumerator_ && notifier_) enumerator_->UnregisterEndpointNotificationCallback(notifier_);
    if (notifier_) notifier_->Release();
    enumerator_.reset();
    if (comInit_) CoUninitialize();
  }

  PlatformInfo platformInfo() override {
    PlatformInfo info;
    info.platform = "win32";
    info.captureMethod = "WASAPI loopback of a virtual endpoint + event-driven shared-mode render";
    info.requiresVirtualDevice = true;
    info.supported = static_cast<bool>(enumerator_);
    if (!info.supported) info.reason = "Windows audio services (MMDevice API) are unavailable.";
    return info;
  }

  std::vector<DeviceInfo> listDevices() override {
    std::vector<DeviceInfo> out;
    if (!enumerator_) return out;
    const std::string def = defaultRenderId();
    ComPtr<IMMDeviceCollection> col;
    if (FAILED(enumerator_->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, col.put()))) return out;
    UINT count = 0;
    col->GetCount(&count);
    for (UINT i = 0; i < count; ++i) {
      ComPtr<IMMDevice> dev;
      if (FAILED(col->Item(i, dev.put()))) continue;
      DeviceInfo info = describe(dev.get());
      info.isDefault = info.id == def;
      out.push_back(std::move(info));
    }
    return out;
  }

  bool start(const StartOptions& opts, std::string& error) override {
    std::lock_guard<std::mutex> lock(mutex_);
    opts_ = opts;
    wantRunning_ = true;
    preferredOutput_ = opts.outputDeviceId;
    stopThread();  // idempotent restart
    return startLocked(error);
  }

  void stop() override {
    std::lock_guard<std::mutex> lock(mutex_);
    wantRunning_ = false;
    stopThread();
    restoreDefault();
    status_.state = "stopped";
    status_.message.clear();
  }

  void poll() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!notifier_) return;
    const bool defChanged = notifier_->defaultChanged.exchange(false);
    const bool stateChanged = notifier_->stateChanged.exchange(false);
    const bool streamFailed = streamFailed_.exchange(false);
    if (!wantRunning_) return;

    if (defChanged) {
      std::wstring id;
      {
        std::lock_guard<std::mutex> l(notifier_->mutex);
        id = notifier_->lastDefault;
      }
      const std::string nid = narrow(id.c_str());
      // The user (or Windows, on connect) picked a real device: process to it
      // and keep the virtual endpoint as the system default.
      if (!nid.empty() && nid != captureId_) {
        preferredOutput_ = nid;
        originalDefault_ = nid;
        restartLocked();
        return;
      }
    }
    if (stateChanged || streamFailed || (status_.state == "error" && pendingRetry_)) {
      const std::string desired = pickOutput();
      if (streamFailed || desired != outputId_ || status_.state != "running") restartLocked();
    }
  }

  BackendStatus status() override {
    std::lock_guard<std::mutex> lock(mutex_);
    status_.originalDefaultId = originalDefault_;
    return status_;
  }

  uint32_t devicesGeneration() override { return notifier_ ? notifier_->generation.load() : 0; }

  bool setSystemDefaultOutput(const std::string& id, std::string& error) override {
    ComPtr<IPolicyConfig> policy;
    HRESULT h = CoCreateInstance(kCLSID_PolicyConfigClient, nullptr, CLSCTX_ALL, __uuidof(IPolicyConfig),
                                 policy.putVoid());
    if (FAILED(h)) {
      error = "Could not access the audio policy service (" + hr(h) + ").";
      return false;
    }
    const std::wstring wid = widen(id);
    for (ERole role : {eConsole, eMultimedia, eCommunications}) {
      h = policy->SetDefaultEndpoint(wid.c_str(), role);
      if (FAILED(h)) {
        error = "Could not set the default output (" + hr(h) + ").";
        return false;
      }
    }
    return true;
  }

 private:
  std::string defaultRenderId() {
    ComPtr<IMMDevice> dev;
    if (!enumerator_ || FAILED(enumerator_->GetDefaultAudioEndpoint(eRender, eConsole, dev.put()))) return {};
    LPWSTR id = nullptr;
    std::string s;
    if (SUCCEEDED(dev->GetId(&id))) s = narrow(id);
    CoTaskMemFree(id);
    return s;
  }

  DeviceInfo describe(IMMDevice* dev) {
    DeviceInfo info;
    LPWSTR id = nullptr;
    if (SUCCEEDED(dev->GetId(&id))) info.id = narrow(id);
    CoTaskMemFree(id);
    ComPtr<IPropertyStore> store;
    if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, store.put()))) {
      info.name = readStringProp(store.get(), PKEY_Device_FriendlyName);
      info.modelId = readStringProp(store.get(), PKEY_DeviceInterface_FriendlyName);
      const std::string enumName = lower(readStringProp(store.get(), kPKEY_EnumeratorName));
      if (enumName.find("bth") != std::string::npos) info.transport = "bluetooth";
      else if (enumName.find("usb") != std::string::npos) info.transport = "usb";
      else if (enumName.find("hdaudio") != std::string::npos || enumName.find("intelaudio") != std::string::npos)
        info.transport = "builtin";
      else if (enumName.find("swd") != std::string::npos || enumName.find("root") != std::string::npos)
        info.transport = "virtual";
      else info.transport = enumName.empty() ? "unknown" : enumName;
      switch (readUIntProp(store.get(), PKEY_AudioEndpoint_FormFactor, 10)) {
        case 1: info.formFactor = "speakers"; break;
        case 2: info.formFactor = "line"; break;
        case 3: info.formFactor = "headphones"; break;
        case 5: info.formFactor = "headset"; break;
        case 8: info.formFactor = "spdif"; break;
        case 9: info.formFactor = "hdmi"; break;
        default: info.formFactor = "unknown"; break;
      }
      if (info.formFactor == "hdmi") info.transport = "hdmi";
    }
    info.isVirtual = looksVirtual(info.name, info.modelId);
    if (info.isVirtual) info.transport = "virtual";
    ComPtr<IAudioClient> client;
    if (SUCCEEDED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, client.putVoid()))) {
      WAVEFORMATEX* mix = nullptr;
      if (SUCCEEDED(client->GetMixFormat(&mix)) && mix) {
        info.channels = mix->nChannels;
        info.sampleRate = mix->nSamplesPerSec;
        CoTaskMemFree(mix);
      }
    }
    return info;
  }

  std::vector<DeviceInfo> activeDevices() {
    std::vector<DeviceInfo> v;
    ComPtr<IMMDeviceCollection> col;
    if (!enumerator_ || FAILED(enumerator_->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, col.put()))) return v;
    UINT count = 0;
    col->GetCount(&count);
    for (UINT i = 0; i < count; ++i) {
      ComPtr<IMMDevice> dev;
      if (SUCCEEDED(col->Item(i, dev.put()))) v.push_back(describe(dev.get()));
    }
    return v;
  }

  std::string findCaptureEndpoint(const std::vector<DeviceInfo>& devs) {
    if (!opts_.captureDeviceId.empty()) {
      for (auto& d : devs)
        if (d.id == opts_.captureDeviceId) return d.id;
    }
    for (auto& d : devs)
      if (d.isVirtual && lower(d.name).find("cable input") != std::string::npos) return d.id;
    for (auto& d : devs)
      if (d.isVirtual) return d.id;
    return {};
  }

  // Preferred real output if connected, else the previous default, else the
  // first active physical endpoint.
  std::string pickOutput() {
    const auto devs = activeDevices();
    auto active = [&](const std::string& id) {
      for (auto& d : devs)
        if (d.id == id && !d.isVirtual) return true;
      return false;
    };
    if (!preferredOutput_.empty() && active(preferredOutput_)) return preferredOutput_;
    if (!originalDefault_.empty() && active(originalDefault_)) return originalDefault_;
    for (auto& d : devs)
      if (!d.isVirtual) return d.id;
    return {};
  }

  bool startLocked(std::string& error) {
    pendingRetry_ = false;
    if (!enumerator_) {
      error = "Windows audio services are unavailable.";
      status_.state = "unsupported";
      status_.message = error;
      return false;
    }
    const auto devs = activeDevices();
    captureId_ = findCaptureEndpoint(devs);
    if (captureId_.empty()) {
      error =
          "No virtual audio endpoint found. Install a virtual cable (for example VB-Audio VB-CABLE), then press "
          "Start again. MinSoundFX routes system audio through it to process everything you hear.";
      status_.state = "needs-setup";
      status_.message = error;
      return false;
    }
    const std::string currentDefault = defaultRenderId();
    if (originalDefault_.empty() && !currentDefault.empty() && currentDefault != captureId_)
      originalDefault_ = currentDefault;
    outputId_ = pickOutput();
    if (outputId_.empty()) {
      error = "No physical output device is connected.";
      status_.state = "error";
      status_.message = error;
      pendingRetry_ = true;
      return false;
    }

    if (!startThread(error)) {
      status_.state = "error";
      status_.message = error;
      pendingRetry_ = true;
      return false;
    }
    // Route apps into the virtual endpoint only once processing is running.
    std::string perr;
    if (currentDefault != captureId_ && !setSystemDefaultOutput(captureId_, perr)) {
      stopThread();
      error = perr;
      status_.state = "error";
      status_.message = error;
      return false;
    }
    return true;
  }

  void restartLocked() {
    stopThread();
    ++status_.rebuilds;
    std::string err;
    if (!startLocked(err)) {
      pendingRetry_ = true;
      // Never leave the user without sound: if we cannot process, restore.
      restoreDefault();
    }
  }

  void restoreDefault() {
    if (originalDefault_.empty() || captureId_.empty()) return;
    // Only undo our own change; respect a default the user picked meanwhile.
    if (defaultRenderId() != captureId_) return;
    std::string err;
    setSystemDefaultOutput(originalDefault_, err);
  }

  bool startThread(std::string& error) {
    stopFlag_.store(false);
    ready_.store(0);
    threadError_.clear();
    thread_ = std::thread([this] { audioThread(); });
    // Wait for the stream to start (or fail).
    for (int i = 0; i < 300 && ready_.load() == 0; ++i) Sleep(10);
    if (ready_.load() != 1) {
      stopThread();
      std::lock_guard<std::mutex> l(threadMutex_);
      error = threadError_.empty() ? "Timed out starting the audio stream." : threadError_;
      return false;
    }
    std::lock_guard<std::mutex> l(mutex_status_);
    const uint32_t gen = status_.generation, rebuilds = status_.rebuilds;
    status_ = pendingStatus_;
    status_.generation = gen + 1;
    status_.rebuilds = rebuilds;
    return true;
  }

  void stopThread() {
    stopFlag_.store(true);
    if (thread_.joinable()) thread_.join();
    engine_.unprepare();
  }

  void fail(const std::string& msg) {
    std::lock_guard<std::mutex> l(threadMutex_);
    threadError_ = msg;
    ready_.store(2);
  }

  void audioThread() {
    const bool com = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    DWORD taskIndex = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    runStreams();
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    if (com) CoUninitialize();
  }

  void runStreams() {
    ComPtr<IMMDevice> outDev, capDev;
    if (FAILED(enumerator_->GetDevice(widen(outputId_).c_str(), outDev.put())))
      return fail("The output device is not available.");
    if (FAILED(enumerator_->GetDevice(widen(captureId_).c_str(), capDev.put())))
      return fail("The virtual endpoint is not available.");

    // ---- render client (real device)
    ComPtr<IAudioClient> render;
    HRESULT h = outDev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, render.putVoid());
    if (FAILED(h)) return fail("Could not open the output device (" + hr(h) + ").");
    WAVEFORMATEX* outMix = nullptr;
    if (FAILED(render->GetMixFormat(&outMix)) || !outMix) return fail("Could not read the output format.");
    const int outCh = std::min<int>(outMix->nChannels, kMaxChannels);
    const DWORD outRate = outMix->nSamplesPerSec;
    CoTaskMemFree(outMix);
    WAVEFORMATEXTENSIBLE outFmt = floatFormat(outCh, outRate);
    const int requested = std::max(64, std::min(2048, opts_.bufferFrames));
    REFERENCE_TIME bufDur = static_cast<REFERENCE_TIME>(10000000.0 * requested * 2 / outRate);
    bufDur = std::max<REFERENCE_TIME>(bufDur, 100000);  // >= 10 ms
    h = render->Initialize(AUDCLNT_SHAREMODE_SHARED,
                           AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                               AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                           bufDur, 0, reinterpret_cast<WAVEFORMATEX*>(&outFmt), nullptr);
    if (FAILED(h)) return fail("Could not initialise the output stream (" + hr(h) + ").");
    HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    render->SetEventHandle(event);
    UINT32 renderFrames = 0;
    render->GetBufferSize(&renderFrames);
    ComPtr<IAudioRenderClient> renderClient;
    if (FAILED(render->GetService(__uuidof(IAudioRenderClient), renderClient.putVoid()))) {
      CloseHandle(event);
      return fail("Could not get the render service.");
    }

    // ---- loopback capture (virtual endpoint), native mix format
    ComPtr<IAudioClient> capture;
    h = capDev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, capture.putVoid());
    if (FAILED(h)) {
      CloseHandle(event);
      return fail("Could not open the virtual endpoint (" + hr(h) + ").");
    }
    WAVEFORMATEX* capMix = nullptr;
    if (FAILED(capture->GetMixFormat(&capMix)) || !capMix) {
      CloseHandle(event);
      return fail("Could not read the virtual endpoint format.");
    }
    const int capChRaw = capMix->nChannels;
    const int capCh = std::min(capChRaw, kMaxChannels);
    const DWORD capRate = capMix->nSamplesPerSec;
    const SampleKind capKind = kindOf(capMix);
    const int capBytes = capMix->wBitsPerSample / 8;
    h = capture->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200000, 0, capMix, nullptr);
    CoTaskMemFree(capMix);
    if (FAILED(h) || capKind == SampleKind::Unknown) {
      CloseHandle(event);
      return fail("Could not start loopback capture (" + hr(h) + ").");
    }
    ComPtr<IAudioCaptureClient> captureClient;
    if (FAILED(capture->GetService(__uuidof(IAudioCaptureClient), captureClient.putVoid()))) {
      CloseHandle(event);
      return fail("Could not get the capture service.");
    }

    // ---- engine + buffers
    engine_.prepare(outRate, capCh, outCh);
    const int targetFill = std::max<int>(static_cast<int>(capRate * 0.012), requested);  // ~12 ms jitter buffer
    fifo_.prepare(capCh, capRate, outRate, targetFill);
    std::vector<float> conv(static_cast<size_t>(capRate) * capCh);  // 1 s scratch
    std::vector<float> inBlock(static_cast<size_t>(renderFrames) * capCh + 64);
    std::vector<float> outBlock(static_cast<size_t>(renderFrames) * outCh + 64);

    // Pre-fill the render buffer with silence, then start both streams.
    BYTE* rb = nullptr;
    if (SUCCEEDED(renderClient->GetBuffer(renderFrames, &rb)))
      renderClient->ReleaseBuffer(renderFrames, AUDCLNT_BUFFERFLAGS_SILENT);
    capture->Start();
    render->Start();

    {
      std::lock_guard<std::mutex> l(mutex_status_);
      pendingStatus_.state = "running";
      pendingStatus_.message.clear();
      pendingStatus_.deviceId = outputId_;
      pendingStatus_.captureDeviceId = captureId_;
      pendingStatus_.sampleRate = outRate;
      pendingStatus_.inChannels = capCh;
      pendingStatus_.outChannels = outCh;
      pendingStatus_.bufferFrames = static_cast<int>(renderFrames);
      pendingStatus_.latencyMs =
          1000.0 * (renderFrames + engine_.latencySamples()) / outRate + 1000.0 * targetFill / capRate;
    }
    ready_.store(1);

    while (!stopFlag_.load()) {
      const DWORD w = WaitForSingleObject(event, 200);
      if (stopFlag_.load()) break;

      // Drain the loopback capture.
      UINT32 packet = 0;
      while (SUCCEEDED(h = captureClient->GetNextPacketSize(&packet)) && packet > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        h = captureClient->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(h)) break;
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
          fifo_.pushSilence(frames);
        } else {
          const size_t n = std::min<size_t>(frames, conv.size() / capCh);
          for (size_t i = 0; i < n; ++i) {
            for (int c = 0; c < capCh; ++c) {
              const BYTE* p = data + (i * capChRaw + c) * capBytes;
              float v = 0.f;
              switch (capKind) {
                case SampleKind::Float32: std::memcpy(&v, p, 4); break;
                case SampleKind::Int16: {
                  int16_t s;
                  std::memcpy(&s, p, 2);
                  v = s / 32768.f;
                  break;
                }
                case SampleKind::Int24: {
                  int32_t s = (p[0] << 8) | (p[1] << 16) | (p[2] << 24);
                  v = (s >> 8) / 8388608.f;
                  break;
                }
                case SampleKind::Int32: {
                  int32_t s;
                  std::memcpy(&s, p, 4);
                  v = s / 2147483648.f;
                  break;
                }
                default: break;
              }
              conv[i * capCh + c] = v;
            }
          }
          fifo_.pushInterleaved(conv.data(), n);
        }
        captureClient->ReleaseBuffer(frames);
      }
      if (h == AUDCLNT_E_DEVICE_INVALIDATED) {
        streamFailed_.store(true);
        break;
      }
      if (w != WAIT_OBJECT_0) continue;

      // Render what the device asks for.
      UINT32 padding = 0;
      h = render->GetCurrentPadding(&padding);
      if (FAILED(h)) {
        streamFailed_.store(true);
        break;
      }
      const UINT32 avail = renderFrames - padding;
      if (avail == 0) continue;
      BYTE* out = nullptr;
      h = renderClient->GetBuffer(avail, &out);
      if (FAILED(h)) {
        streamFailed_.store(true);
        break;
      }
      fifo_.pull(inBlock.data(), static_cast<int>(avail));
      engine_.process(inBlock.data(), reinterpret_cast<float*>(out), static_cast<int>(avail));
      renderClient->ReleaseBuffer(avail, 0);
    }

    render->Stop();
    capture->Stop();
    CloseHandle(event);
  }

  Engine& engine_;
  bool comInit_ = false;
  ComPtr<IMMDeviceEnumerator> enumerator_;
  NotificationClient* notifier_ = nullptr;

  std::mutex mutex_;
  StartOptions opts_;
  bool wantRunning_ = false;
  bool pendingRetry_ = false;
  BackendStatus status_;
  std::string captureId_, outputId_, preferredOutput_, originalDefault_;

  std::thread thread_;
  std::atomic<bool> stopFlag_{false};
  std::atomic<int> ready_{0};
  std::atomic<bool> streamFailed_{false};
  std::mutex threadMutex_;
  std::string threadError_;
  std::mutex mutex_status_;
  BackendStatus pendingStatus_;
  ResamplingFifo fifo_;
};

}  // namespace

std::unique_ptr<AudioBackend> createBackend(Engine& engine) { return std::make_unique<WinBackend>(engine); }

}  // namespace msfx
