// macOS backend: Core Audio process taps (macOS 14.2+).
//
// A private, muted tap captures everything other processes send to the chosen
// output device. The tap and that device are combined into a private aggregate
// device; our IOProc reads the tap, runs the Engine and writes the result to
// the device. Because the tap is muted, listeners hear only the processed
// signal. Destroying the tap (stop, quit or crash) instantly restores the
// original audio path: no drivers are installed and no system default is
// ever changed.
#import <CoreAudio/AudioHardware.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "../backend.hpp"

namespace msfx {
namespace {

constexpr const char* kAggregatePrefix = "com.minsoundfx.aggregate";
const AudioObjectPropertySelector kDeviceWatch[] = {kAudioDevicePropertyDeviceIsAlive,
                                                    kAudioDevicePropertyNominalSampleRate,
                                                    kAudioDevicePropertyStreamConfiguration};

std::string cfToString(CFStringRef s) {
  if (!s) return {};
  char buf[512];
  if (CFStringGetCString(s, buf, sizeof(buf), kCFStringEncodingUTF8)) return buf;
  return {};
}

std::string fourcc(UInt32 v) {
  char s[5] = {static_cast<char>((v >> 24) & 0xff), static_cast<char>((v >> 16) & 0xff),
               static_cast<char>((v >> 8) & 0xff), static_cast<char>(v & 0xff), 0};
  for (int i = 0; i < 4; ++i)
    if (s[i] < 32 || s[i] > 126) s[i] = '?';
  return s;
}

std::string osStatusMessage(OSStatus err) {
  if (err == 0) return "ok";
  UInt32 be = static_cast<UInt32>(err);
  std::string cc = fourcc(be);
  bool printable = true;
  for (char c : cc) printable = printable && c != '?';
  return printable ? ("'" + cc + "' (" + std::to_string(err) + ")") : std::to_string(err);
}

template <typename T>
bool getProp(AudioObjectID obj, AudioObjectPropertySelector sel, AudioObjectPropertyScope scope, T& out,
             AudioObjectPropertyElement elem = kAudioObjectPropertyElementMain) {
  AudioObjectPropertyAddress addr{sel, scope, elem};
  UInt32 size = sizeof(T);
  return AudioObjectGetPropertyData(obj, &addr, 0, nullptr, &size, &out) == noErr;
}

std::string getStringProp(AudioObjectID obj, AudioObjectPropertySelector sel,
                          AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  CFStringRef s = nullptr;
  AudioObjectPropertyAddress addr{sel, scope, kAudioObjectPropertyElementMain};
  UInt32 size = sizeof(s);
  if (AudioObjectGetPropertyData(obj, &addr, 0, nullptr, &size, &s) != noErr || !s) return {};
  std::string r = cfToString(s);
  CFRelease(s);
  return r;
}

int channelCount(AudioObjectID dev, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress addr{kAudioDevicePropertyStreamConfiguration, scope, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(dev, &addr, 0, nullptr, &size) != noErr || size == 0) return 0;
  std::vector<uint8_t> buf(size);
  auto* list = reinterpret_cast<AudioBufferList*>(buf.data());
  if (AudioObjectGetPropertyData(dev, &addr, 0, nullptr, &size, list) != noErr) return 0;
  int ch = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; ++i) ch += static_cast<int>(list->mBuffers[i].mNumberChannels);
  return ch;
}

std::vector<AudioObjectID> allDevices() {
  AudioObjectPropertyAddress addr{kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                  kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &size) != noErr) return {};
  std::vector<AudioObjectID> ids(size / sizeof(AudioObjectID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, ids.data()) != noErr) return {};
  return ids;
}

AudioObjectID defaultOutputDevice() {
  AudioObjectID dev = kAudioObjectUnknown;
  getProp(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, dev);
  return dev;
}

AudioObjectID deviceForUID(const std::string& uid) {
  for (AudioObjectID d : allDevices())
    if (getStringProp(d, kAudioDevicePropertyDeviceUID) == uid) return d;
  return kAudioObjectUnknown;
}

std::string transportName(UInt32 t) {
  switch (t) {
    case kAudioDeviceTransportTypeBuiltIn: return "builtin";
    case kAudioDeviceTransportTypeUSB: return "usb";
    case kAudioDeviceTransportTypeBluetooth:
    case kAudioDeviceTransportTypeBluetoothLE: return "bluetooth";
    case kAudioDeviceTransportTypeHDMI: return "hdmi";
    case kAudioDeviceTransportTypeDisplayPort: return "displayport";
    case kAudioDeviceTransportTypeAirPlay: return "airplay";
    case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt";
    case kAudioDeviceTransportTypePCI: return "pci";
    case kAudioDeviceTransportTypeFireWire: return "firewire";
    case kAudioDeviceTransportTypeAVB: return "avb";
    case kAudioDeviceTransportTypeVirtual: return "virtual";
    case kAudioDeviceTransportTypeAggregate:
    case kAudioDeviceTransportTypeAutoAggregate: return "aggregate";
    case kAudioDeviceTransportTypeContinuityCaptureWired:
    case kAudioDeviceTransportTypeContinuityCaptureWireless: return "continuity";
    default: return "unknown";
  }
}

class MacBackend final : public AudioBackend {
 public:
  explicit MacBackend(Engine& engine) : engine_(engine) {
    queue_ = dispatch_queue_create("com.minsoundfx.listeners", DISPATCH_QUEUE_SERIAL);
    systemListener_ = ^(UInt32 count, const AudioObjectPropertyAddress* addrs) {
      for (UInt32 i = 0; i < count; ++i) {
        if (addrs[i].mSelector == kAudioHardwarePropertyDefaultOutputDevice) defaultChanged_.store(true);
        if (addrs[i].mSelector == kAudioHardwarePropertyDevices) devicesGen_.fetch_add(1);
      }
    };
    deviceListener_ = ^(UInt32, const AudioObjectPropertyAddress*) { deviceChanged_.store(true); };
    for (AudioObjectPropertySelector sel : {kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices}) {
      AudioObjectPropertyAddress addr{sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
      AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &addr, queue_, systemListener_);
    }
  }

  ~MacBackend() override {
    stop();
    for (AudioObjectPropertySelector sel : {kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices}) {
      AudioObjectPropertyAddress addr{sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
      AudioObjectRemovePropertyListenerBlock(kAudioObjectSystemObject, &addr, queue_, systemListener_);
    }
  }

  PlatformInfo platformInfo() override {
    PlatformInfo info;
    info.platform = "darwin";
    info.captureMethod = "Core Audio process tap (muted) + private aggregate device";
    if (@available(macOS 14.2, *)) {
      info.supported = true;
    } else {
      info.supported = false;
      info.reason = "System-wide processing needs macOS 14.2 or later (Core Audio process taps).";
    }
    return info;
  }

  std::vector<DeviceInfo> listDevices() override {
    std::vector<DeviceInfo> out;
    const AudioObjectID def = defaultOutputDevice();
    for (AudioObjectID d : allDevices()) {
      const int ch = channelCount(d, kAudioObjectPropertyScopeOutput);
      if (ch <= 0) continue;
      DeviceInfo info;
      info.id = getStringProp(d, kAudioDevicePropertyDeviceUID);
      if (info.id.rfind(kAggregatePrefix, 0) == 0) continue;  // our own private aggregate
      info.name = getStringProp(d, kAudioObjectPropertyName);
      info.manufacturer = getStringProp(d, kAudioObjectPropertyManufacturer);
      info.modelId = getStringProp(d, kAudioDevicePropertyModelUID);
      UInt32 transport = 0;
      getProp(d, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, transport);
      info.transport = transportName(transport);
      info.isVirtual = transport == kAudioDeviceTransportTypeVirtual;
      UInt32 source = 0;
      if (getProp(d, kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput, source) && source)
        info.dataSource = fourcc(source);
      if (info.dataSource == "hdpn") info.formFactor = "headphones";
      else if (info.dataSource == "ispk") info.formFactor = "speakers";
      else if (transport == kAudioDeviceTransportTypeHDMI || transport == kAudioDeviceTransportTypeDisplayPort)
        info.formFactor = "hdmi";
      else info.formFactor = "unknown";
      Float64 rate = 0;
      getProp(d, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, rate);
      info.sampleRate = rate;
      info.channels = ch;
      info.isDefault = d == def;
      out.push_back(std::move(info));
    }
    return out;
  }

  bool start(const StartOptions& opts, std::string& error) override {
    std::lock_guard<std::mutex> lock(mutex_);
    opts_ = opts;
    wantRunning_ = true;
    teardown();  // idempotent: never stack a second tap on top of a running one
    const bool ok = build(error);
    if (!ok) {
      retryGen_ = devicesGen_.load();
      if (status_.state != "unsupported") status_.state = "error";
      status_.message = error;
    }
    return ok;
  }

  void stop() override {
    std::lock_guard<std::mutex> lock(mutex_);
    wantRunning_ = false;
    teardown();
    status_.state = "stopped";
    status_.message.clear();
  }

  void poll() override {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool defChanged = defaultChanged_.exchange(false);
    const bool devChanged = deviceChanged_.exchange(false);
    if (!wantRunning_) return;
    bool rebuild = false;
    if (devChanged && listenDevice_ != kAudioObjectUnknown) {
      // Only rebuild for real changes (creating the aggregate itself can fire
      // notifications on the device).
      UInt32 alive = 1;
      getProp(listenDevice_, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal, alive);
      const double rate = getNominalRate(listenDevice_);
      const int ch = channelCount(listenDevice_, kAudioObjectPropertyScopeOutput);
      rebuild = !alive || rate != builtRate_ || ch != builtDevChannels_;
    }
    if (defChanged && opts_.outputDeviceId.empty()) rebuild = true;
    // A pinned device that disappeared: retry whenever the device list changes.
    if (pendingRetry_ && status_.state == "error" && devicesGen_.load() != retryGen_) {
      retryGen_ = devicesGen_.load();
      rebuild = true;
    }
    if (!rebuild) return;
    std::string err;
    teardown();
    ++status_.rebuilds;
    if (!build(err)) {
      status_.state = "error";
      status_.message = err;
      pendingRetry_ = true;  // retry on the next device change
      retryGen_ = devicesGen_.load();
    }
  }

  BackendStatus status() override {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
  }

  uint32_t devicesGeneration() override { return devicesGen_.load(); }

 private:
  bool build(std::string& error) {
    pendingRetry_ = false;
    if (@available(macOS 14.2, *)) return buildTap(error);
    error = "macOS 14.2 or later is required for system-wide processing.";
    status_.state = "unsupported";
    return false;
  }

  bool buildTap(std::string& error) API_AVAILABLE(macos(14.2)) {

    // 1. Output device: pinned UID or the current system default.
    AudioObjectID dev = opts_.outputDeviceId.empty() ? defaultOutputDevice() : deviceForUID(opts_.outputDeviceId);
    if (dev == kAudioObjectUnknown && !opts_.outputDeviceId.empty()) {
      error = "The selected output device is not connected.";
      pendingRetry_ = true;
      return false;
    }
    if (dev == kAudioObjectUnknown) {
      error = "No audio output device is available.";
      pendingRetry_ = true;
      return false;
    }
    const std::string uid = getStringProp(dev, kAudioDevicePropertyDeviceUID);
    if (uid.rfind(kAggregatePrefix, 0) == 0) {
      error = "Refusing to process our own aggregate device.";
      return false;
    }
    const int devOutCh = channelCount(dev, kAudioObjectPropertyScopeOutput);
    if (uid.empty() || devOutCh <= 0) {
      error = "The output device has no output channels.";
      return false;
    }

    // 2. Our own process object, which must be excluded from the tap so the
    //    processed signal is never captured again (no feedback).
    AudioObjectID self = kAudioObjectUnknown;
    {
      pid_t pid = getpid();
      AudioObjectPropertyAddress addr{kAudioHardwarePropertyTranslatePIDToProcessObject,
                                      kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
      UInt32 size = sizeof(self);
      AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, sizeof(pid), &pid, &size, &self);
    }
    if (self == kAudioObjectUnknown) {
      error = "Could not identify this app's audio process; refusing to start to avoid feedback.";
      return false;
    }

    // 3. Muted, private tap of everything else going to that device.
    NSString* nsUid = [NSString stringWithUTF8String:uid.c_str()];
    CATapDescription* desc = [[CATapDescription alloc] initExcludingProcesses:@[ @(self) ]
                                                                 andDeviceUID:nsUid
                                                                   withStream:0];
    desc.name = @"MinSoundFX";
    desc.privateTap = YES;
    desc.muteBehavior = CATapMuted;
    AudioObjectID tap = kAudioObjectUnknown;
    OSStatus err = AudioHardwareCreateProcessTap(desc, &tap);
    if (err != noErr || tap == kAudioObjectUnknown) {
      error = "Could not create the system audio tap (" + osStatusMessage(err) +
              "). Check System Settings ▸ Privacy & Security ▸ Screen & System Audio Recording.";
      return false;
    }
    tap_ = tap;
    const std::string tapUid = cfToString((__bridge CFStringRef)desc.UUID.UUIDString);

    AudioStreamBasicDescription tapFormat{};
    getProp(tap_, kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, tapFormat);

    // 4. Private aggregate: the real device (clock master) + the tap as input.
    NSString* aggUid = [NSString stringWithFormat:@"%s.%@", kAggregatePrefix, [[NSUUID UUID] UUIDString]];
    NSDictionary* aggDesc = @{
      @kAudioAggregateDeviceNameKey : @"MinSoundFX Processing",
      @kAudioAggregateDeviceUIDKey : aggUid,
      @kAudioAggregateDeviceMainSubDeviceKey : nsUid,
      @kAudioAggregateDeviceClockDeviceKey : nsUid,
      @kAudioAggregateDeviceIsPrivateKey : @YES,
      @kAudioAggregateDeviceIsStackedKey : @NO,
      @kAudioAggregateDeviceTapAutoStartKey : @YES,
      @kAudioAggregateDeviceSubDeviceListKey : @[ @{@kAudioSubDeviceUIDKey : nsUid} ],
      @kAudioAggregateDeviceTapListKey : @[ @{
        @kAudioSubTapUIDKey : [NSString stringWithUTF8String:tapUid.c_str()],
        @kAudioSubTapDriftCompensationKey : @YES,
      } ],
    };
    AudioObjectID agg = kAudioObjectUnknown;
    err = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggDesc, &agg);
    if (err != noErr || agg == kAudioObjectUnknown) {
      error = "Could not create the processing device (" + osStatusMessage(err) + ").";
      teardown();
      return false;
    }
    agg_ = agg;

    // 5. Buffer size (latency vs. CPU).
    UInt32 frames = static_cast<UInt32>(std::max(32, std::min(2048, opts_.bufferFrames)));
    {
      AudioObjectPropertyAddress addr{kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal,
                                      kAudioObjectPropertyElementMain};
      AudioObjectSetPropertyData(agg_, &addr, 0, nullptr, sizeof(frames), &frames);
      getProp(agg_, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, frames);
    }

    Float64 rate = 0;
    getProp(agg_, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, rate);
    if (rate <= 0) rate = tapFormat.mSampleRate > 0 ? tapFormat.mSampleRate : 48000.0;
    int inCh = channelCount(agg_, kAudioObjectPropertyScopeInput);
    if (inCh <= 0) inCh = tapFormat.mChannelsPerFrame > 0 ? static_cast<int>(tapFormat.mChannelsPerFrame) : 2;
    int outCh = channelCount(agg_, kAudioObjectPropertyScopeOutput);
    if (outCh <= 0) outCh = devOutCh;
    inCh = std::min(inCh, kMaxChannels);
    const int engineOut = std::min(outCh, kMaxChannels);

    engine_.prepare(rate, inCh, engineOut);
    const size_t maxFrames = 8192;
    inScratch_.assign(maxFrames * inCh, 0.f);
    outScratch_.assign(maxFrames * engineOut, 0.f);
    ioInCh_ = inCh;
    ioOutCh_ = engineOut;

    err = AudioDeviceCreateIOProcID(agg_, &MacBackend::ioProc, this, &proc_);
    if (err != noErr || !proc_) {
      error = "Could not attach the audio callback (" + osStatusMessage(err) + ").";
      teardown();
      return false;
    }
    err = AudioDeviceStart(agg_, proc_);
    if (err != noErr) {
      error = "Could not start audio processing (" + osStatusMessage(err) + ").";
      teardown();
      return false;
    }

    // 6. Watch the real device for disconnects and format changes.
    listenDevice_ = dev;
    for (AudioObjectPropertySelector sel : kDeviceWatch) {
      AudioObjectPropertyAddress addr{sel, kAudioObjectPropertyScopeWildcard, kAudioObjectPropertyElementWildcard};
      AudioObjectAddPropertyListenerBlock(listenDevice_, &addr, queue_, deviceListener_);
    }

    UInt32 devLatency = 0, safety = 0;
    getProp(dev, kAudioDevicePropertyLatency, kAudioObjectPropertyScopeOutput, devLatency);
    getProp(dev, kAudioDevicePropertySafetyOffset, kAudioObjectPropertyScopeOutput, safety);

    builtDeviceAlive_ = true;
    builtRate_ = getNominalRate(dev);
    builtDevChannels_ = devOutCh;
    status_.state = "running";
    status_.message.clear();
    status_.deviceId = uid;
    status_.deviceName = getStringProp(dev, kAudioObjectPropertyName);
    status_.sampleRate = rate;
    status_.inChannels = inCh;
    status_.outChannels = engineOut;
    status_.bufferFrames = static_cast<int>(frames);
    status_.latencyMs =
        1000.0 * (2.0 * frames + devLatency + safety + engine_.latencySamples()) / rate;
    ++status_.generation;
    return true;
  }

  void teardown() {
    if (listenDevice_ != kAudioObjectUnknown) {
      for (AudioObjectPropertySelector sel : kDeviceWatch) {
        AudioObjectPropertyAddress addr{sel, kAudioObjectPropertyScopeWildcard, kAudioObjectPropertyElementWildcard};
        AudioObjectRemovePropertyListenerBlock(listenDevice_, &addr, queue_, deviceListener_);
      }
      listenDevice_ = kAudioObjectUnknown;
    }
    if (agg_ != kAudioObjectUnknown) {
      if (proc_) {
        AudioDeviceStop(agg_, proc_);
        AudioDeviceDestroyIOProcID(agg_, proc_);
        proc_ = nullptr;
      }
      AudioHardwareDestroyAggregateDevice(agg_);
      agg_ = kAudioObjectUnknown;
    }
    if (tap_ != kAudioObjectUnknown) {
      if (@available(macOS 14.2, *)) AudioHardwareDestroyProcessTap(tap_);
      tap_ = kAudioObjectUnknown;
    }
    engine_.unprepare();
  }

  static OSStatus ioProc(AudioObjectID, const AudioTimeStamp*, const AudioBufferList* inData, const AudioTimeStamp*,
                         AudioBufferList* outData, const AudioTimeStamp*, void* ctx) {
    auto* self = static_cast<MacBackend*>(ctx);
    if (!outData || outData->mNumberBuffers == 0) return noErr;

    // Frames come from the first output buffer.
    const AudioBuffer& ob0 = outData->mBuffers[0];
    const UInt32 och0 = ob0.mNumberChannels ? ob0.mNumberChannels : 1;
    const int frames = static_cast<int>(ob0.mDataByteSize / (sizeof(float) * och0));
    const int inCh = self->ioInCh_, outCh = self->ioOutCh_;
    if (frames <= 0 || static_cast<size_t>(frames) * outCh > self->outScratch_.size()) {
      for (UInt32 b = 0; b < outData->mNumberBuffers; ++b)
        if (outData->mBuffers[b].mData) std::memset(outData->mBuffers[b].mData, 0, outData->mBuffers[b].mDataByteSize);
      return noErr;
    }

    // Gather the tap input into one interleaved buffer.
    const float* in = nullptr;
    if (inData && inData->mNumberBuffers == 1 && static_cast<int>(inData->mBuffers[0].mNumberChannels) == inCh &&
        inData->mBuffers[0].mData &&
        inData->mBuffers[0].mDataByteSize >= static_cast<UInt32>(frames * inCh * sizeof(float))) {
      in = static_cast<const float*>(inData->mBuffers[0].mData);
    } else {
      float* dst = self->inScratch_.data();
      std::memset(dst, 0, sizeof(float) * static_cast<size_t>(frames) * inCh);
      if (inData) {
        int chBase = 0;
        for (UInt32 b = 0; b < inData->mNumberBuffers && chBase < inCh; ++b) {
          const AudioBuffer& ib = inData->mBuffers[b];
          const int bch = static_cast<int>(ib.mNumberChannels ? ib.mNumberChannels : 1);
          const auto* src = static_cast<const float*>(ib.mData);
          const int bframes = src ? static_cast<int>(ib.mDataByteSize / (sizeof(float) * bch)) : 0;
          for (int i = 0; i < std::min(frames, bframes); ++i)
            for (int c = 0; c < bch && chBase + c < inCh; ++c) dst[i * inCh + chBase + c] = src[i * bch + c];
          chBase += bch;
        }
      }
      in = dst;
    }

    // Process, writing straight into the device buffer when the layout matches.
    if (outData->mNumberBuffers == 1 && static_cast<int>(och0) == outCh) {
      self->engine_.process(in, static_cast<float*>(ob0.mData), frames);
      return noErr;
    }
    float* tmp = self->outScratch_.data();
    self->engine_.process(in, tmp, frames);
    int chBase = 0;
    for (UInt32 b = 0; b < outData->mNumberBuffers; ++b) {
      AudioBuffer& buf = outData->mBuffers[b];
      if (!buf.mData) continue;
      const int bch = static_cast<int>(buf.mNumberChannels ? buf.mNumberChannels : 1);
      auto* dst = static_cast<float*>(buf.mData);
      const int bframes = static_cast<int>(buf.mDataByteSize / (sizeof(float) * bch));
      for (int i = 0; i < std::min(frames, bframes); ++i)
        for (int c = 0; c < bch; ++c) {
          const int src = chBase + c;
          dst[i * bch + c] = src < outCh ? tmp[i * outCh + src] : 0.f;
        }
      chBase += bch;
    }
    return noErr;
  }

  static double getNominalRate(AudioObjectID dev) {
    Float64 r = 0;
    getProp(dev, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, r);
    return r;
  }

  Engine& engine_;
  std::mutex mutex_;
  bool builtDeviceAlive_ = false;
  double builtRate_ = 0;
  int builtDevChannels_ = 0;
  uint32_t retryGen_ = 0;
  StartOptions opts_;
  bool wantRunning_ = false;
  bool pendingRetry_ = false;
  BackendStatus status_;

  AudioObjectID tap_ = kAudioObjectUnknown;
  AudioObjectID agg_ = kAudioObjectUnknown;
  AudioDeviceIOProcID proc_ = nullptr;
  AudioObjectID listenDevice_ = kAudioObjectUnknown;
  std::vector<float> inScratch_, outScratch_;
  int ioInCh_ = 2, ioOutCh_ = 2;

  dispatch_queue_t queue_;
  AudioObjectPropertyListenerBlock systemListener_;
  AudioObjectPropertyListenerBlock deviceListener_;
  std::atomic<bool> defaultChanged_{false};
  std::atomic<bool> deviceChanged_{false};
  std::atomic<uint32_t> devicesGen_{0};
};

}  // namespace

std::unique_ptr<AudioBackend> createBackend(Engine& engine) { return std::make_unique<MacBackend>(engine); }

}  // namespace msfx
