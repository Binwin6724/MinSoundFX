// Platform audio backend interface. A backend captures the system mix,
// silences the original path, runs the Engine, and renders to the real
// output device. All methods are called from the control (JS) thread.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "../dsp/engine.hpp"

namespace msfx {

struct DeviceInfo {
  std::string id;            // stable identifier (Core Audio UID / MMDevice endpoint id)
  std::string name;
  std::string manufacturer;
  std::string modelId;
  std::string transport;     // builtin, usb, bluetooth, hdmi, displayport, airplay, thunderbolt, pci, virtual, aggregate, unknown
  std::string formFactor;    // headphones, headset, speakers, line, spdif, hdmi, unknown (OS-provided hint)
  std::string dataSource;    // macOS built-in data source (e.g. "hdpn", "ispk")
  int channels = 0;
  double sampleRate = 0.0;
  bool isDefault = false;
  bool isVirtual = false;    // virtual/loopback endpoint (e.g. a virtual cable)
};

struct StartOptions {
  std::string outputDeviceId;   // empty = follow the system default output
  std::string captureDeviceId;  // Windows: virtual endpoint to capture from (empty = auto-detect)
  int bufferFrames = 256;
};

struct BackendStatus {
  std::string state = "stopped";  // stopped, running, error, unsupported, needs-setup
  std::string message;
  std::string deviceId;
  std::string deviceName;
  std::string captureDeviceId;
  double sampleRate = 0.0;
  int inChannels = 0;
  int outChannels = 0;
  int bufferFrames = 0;
  double latencyMs = 0.0;
  uint32_t generation = 0;  // increments whenever the processed device/format changes
  uint32_t rebuilds = 0;
  std::string originalDefaultId;  // Windows: default endpoint to restore
};

struct PlatformInfo {
  std::string platform;        // darwin, win32
  std::string captureMethod;   // human-readable
  bool supported = false;
  std::string reason;          // why not supported (if any)
  bool requiresVirtualDevice = false;
};

class AudioBackend {
 public:
  virtual ~AudioBackend() = default;
  virtual PlatformInfo platformInfo() = 0;
  virtual std::vector<DeviceInfo> listDevices() = 0;
  virtual bool start(const StartOptions& opts, std::string& error) = 0;
  virtual void stop() = 0;
  // Handles device/format changes signalled by OS notifications.
  virtual void poll() = 0;
  virtual BackendStatus status() = 0;
  virtual uint32_t devicesGeneration() = 0;  // changes when the device list changes
  // Windows: make `id` the system default output (used to restore routing).
  virtual bool setSystemDefaultOutput(const std::string& id, std::string& error) {
    (void)id;
    error = "not supported on this platform";
    return false;
  }
};

std::unique_ptr<AudioBackend> createBackend(Engine& engine);

}  // namespace msfx
