// Node-API bindings for the MinSoundFX native engine. Loaded by the Electron
// main process only; the renderer talks to it through IPC.
#include <napi.h>

#include <cmath>
#include <memory>
#include <mutex>
#include <vector>

#include "dsp/analyzer.hpp"
#include "dsp/engine.hpp"
#include "platform/backend.hpp"

using namespace msfx;

namespace {

struct State {
  Engine engine;
  std::unique_ptr<AudioBackend> backend;
  SpectrumAnalyzer analyzer{4096};
  std::vector<float> original, processed;
  std::vector<float> bandsIn, bandsOut;
  bool autoHeadroom = true;
};

State* g = nullptr;

State& state() {
  if (!g) {
    g = new State();
    g->backend = createBackend(g->engine);
  }
  return *g;
}

void cleanup(void*) {
  if (g) {
    if (g->backend) g->backend->stop();  // restores the original audio path
    g->backend.reset();
    delete g;
    g = nullptr;
  }
}

// ---------------------------------------------------------------- parsing
float num(const Napi::Object& o, const char* key, float def) {
  if (!o.Has(key)) return def;
  const Napi::Value v = o.Get(key);
  return v.IsNumber() ? v.As<Napi::Number>().FloatValue() : def;
}
bool flag(const Napi::Object& o, const char* key, bool def) {
  if (!o.Has(key)) return def;
  const Napi::Value v = o.Get(key);
  return v.IsBoolean() ? v.As<Napi::Boolean>().Value() : def;
}
std::string str(const Napi::Object& o, const char* key) {
  if (!o.Has(key)) return {};
  const Napi::Value v = o.Get(key);
  return v.IsString() ? v.As<Napi::String>().Utf8Value() : std::string();
}

EngineParams parseParams(const Napi::Object& o, bool& autoHeadroom) {
  EngineParams p;
  p.enabled = flag(o, "enabled", p.enabled);
  p.preampDb = num(o, "preampDb", p.preampDb);
  p.outputGainDb = num(o, "outputGainDb", p.outputGainDb);
  p.balance = num(o, "balance", p.balance);
  p.eqEnabled = flag(o, "eqEnabled", p.eqEnabled);
  if (o.Has("eqGainsDb") && o.Get("eqGainsDb").IsArray()) {
    Napi::Array a = o.Get("eqGainsDb").As<Napi::Array>();
    for (uint32_t i = 0; i < a.Length() && i < static_cast<uint32_t>(kEqBands); ++i) {
      const Napi::Value v = a.Get(i);
      p.eqGainsDb[i] = v.IsNumber() ? v.As<Napi::Number>().FloatValue() : 0.f;
    }
  }
  p.eqQ = num(o, "eqQ", p.eqQ);
  p.bassDb = num(o, "bassDb", p.bassDb);
  p.midDb = num(o, "midDb", p.midDb);
  p.trebleDb = num(o, "trebleDb", p.trebleDb);
  p.deviceEqEnabled = flag(o, "deviceEqEnabled", p.deviceEqEnabled);
  p.deviceEqPreampDb = num(o, "deviceEqPreampDb", p.deviceEqPreampDb);
  if (o.Has("deviceFilters") && o.Get("deviceFilters").IsArray()) {
    Napi::Array a = o.Get("deviceFilters").As<Napi::Array>();
    int n = 0;
    for (uint32_t i = 0; i < a.Length() && n < kMaxDeviceFilters; ++i) {
      if (!a.Get(i).IsObject()) continue;
      Napi::Object f = a.Get(i).As<Napi::Object>();
      DeviceFilter& d = p.deviceFilters[n++];
      d.type = static_cast<int>(num(f, "type", 0));
      d.freq = num(f, "freq", 1000.f);
      d.q = num(f, "q", 0.707f);
      d.gainDb = num(f, "gainDb", 0.f);
    }
    p.deviceFilterCount = n;
  }
  p.bassEnabled = flag(o, "bassEnabled", p.bassEnabled);
  p.bassAmount = num(o, "bassAmount", p.bassAmount);
  p.bassFreq = num(o, "bassFreq", p.bassFreq);
  p.dialogueEnabled = flag(o, "dialogueEnabled", p.dialogueEnabled);
  p.dialogueAmount = num(o, "dialogueAmount", p.dialogueAmount);
  p.widenEnabled = flag(o, "widenEnabled", p.widenEnabled);
  p.width = num(o, "width", p.width);
  p.surroundEnabled = flag(o, "surroundEnabled", p.surroundEnabled);
  p.surroundAmount = num(o, "surroundAmount", p.surroundAmount);
  p.surroundRoom = num(o, "surroundRoom", p.surroundRoom);
  p.surroundMode = static_cast<int>(num(o, "surroundMode", static_cast<float>(p.surroundMode)));
  p.compEnabled = flag(o, "compEnabled", p.compEnabled);
  p.compThresholdDb = num(o, "compThresholdDb", p.compThresholdDb);
  p.compRatio = num(o, "compRatio", p.compRatio);
  p.compAttackMs = num(o, "compAttackMs", p.compAttackMs);
  p.compReleaseMs = num(o, "compReleaseMs", p.compReleaseMs);
  p.compMakeupDb = num(o, "compMakeupDb", p.compMakeupDb);
  p.loudnessEnabled = flag(o, "loudnessEnabled", p.loudnessEnabled);
  p.loudnessTargetLufs = num(o, "loudnessTargetLufs", p.loudnessTargetLufs);
  p.loudnessMaxBoostDb = num(o, "loudnessMaxBoostDb", p.loudnessMaxBoostDb);
  p.upmixEnabled = flag(o, "upmixEnabled", p.upmixEnabled);
  p.limiterCeilingDb = num(o, "limiterCeilingDb", p.limiterCeilingDb);
  p.maxBoostDb = num(o, "maxBoostDb", p.maxBoostDb);
  autoHeadroom = flag(o, "autoHeadroom", true);
  p.sanitize();
  return p;
}

Napi::Object deviceToJs(Napi::Env env, const DeviceInfo& d) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("id", d.id);
  o.Set("name", d.name);
  o.Set("manufacturer", d.manufacturer);
  o.Set("modelId", d.modelId);
  o.Set("transport", d.transport);
  o.Set("formFactor", d.formFactor);
  o.Set("dataSource", d.dataSource);
  o.Set("channels", d.channels);
  o.Set("sampleRate", d.sampleRate);
  o.Set("isDefault", d.isDefault);
  o.Set("isVirtual", d.isVirtual);
  return o;
}

Napi::Object statusToJs(Napi::Env env, const BackendStatus& s) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("state", s.state);
  o.Set("message", s.message);
  o.Set("deviceId", s.deviceId);
  o.Set("deviceName", s.deviceName);
  o.Set("captureDeviceId", s.captureDeviceId);
  o.Set("sampleRate", s.sampleRate);
  o.Set("inChannels", s.inChannels);
  o.Set("outChannels", s.outChannels);
  o.Set("bufferFrames", s.bufferFrames);
  o.Set("latencyMs", s.latencyMs);
  o.Set("generation", s.generation);
  o.Set("rebuilds", s.rebuilds);
  o.Set("originalDefaultId", s.originalDefaultId);
  return o;
}

double currentRate() {
  const double r = state().engine.sampleRate();
  return r > 1000.0 ? r : 48000.0;
}

// ---------------------------------------------------------------- exports
Napi::Value PlatformInfoJs(const Napi::CallbackInfo& info) {
  const PlatformInfo p = state().backend->platformInfo();
  Napi::Object o = Napi::Object::New(info.Env());
  o.Set("platform", p.platform);
  o.Set("captureMethod", p.captureMethod);
  o.Set("supported", p.supported);
  o.Set("reason", p.reason);
  o.Set("requiresVirtualDevice", p.requiresVirtualDevice);
  return o;
}

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  const auto devs = state().backend->listDevices();
  Napi::Array a = Napi::Array::New(info.Env(), devs.size());
  for (size_t i = 0; i < devs.size(); ++i) a.Set(static_cast<uint32_t>(i), deviceToJs(info.Env(), devs[i]));
  return a;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  StartOptions opts;
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object o = info[0].As<Napi::Object>();
    opts.outputDeviceId = str(o, "outputDeviceId");
    opts.captureDeviceId = str(o, "captureDeviceId");
    opts.bufferFrames = static_cast<int>(num(o, "bufferFrames", 256));
  }
  std::string err;
  const bool ok = state().backend->start(opts, err);
  Napi::Object r = Napi::Object::New(info.Env());
  r.Set("ok", ok);
  r.Set("error", err);
  r.Set("status", statusToJs(info.Env(), state().backend->status()));
  return r;
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  state().backend->stop();
  return statusToJs(info.Env(), state().backend->status());
}

Napi::Value Poll(const Napi::CallbackInfo& info) {
  state().backend->poll();
  return statusToJs(info.Env(), state().backend->status());
}

Napi::Value Status(const Napi::CallbackInfo& info) {
  return statusToJs(info.Env(), state().backend->status());
}

Napi::Value DevicesGeneration(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), state().backend->devicesGeneration());
}

Napi::Value SetParams(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(info.Env(), "setParams(object) expected").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  State& s = state();
  bool autoHeadroom = true;
  EngineParams p = parseParams(info[0].As<Napi::Object>(), autoHeadroom);
  s.autoHeadroom = autoHeadroom;
  p.headroomDb = autoHeadroom ? Engine::computeHeadroomDb(p, currentRate()) : 0.f;
  s.engine.setParams(p);
  Napi::Object r = Napi::Object::New(info.Env());
  r.Set("headroomDb", p.headroomDb);
  return r;
}

// getResponse(freqs: Float32Array, params?: object, opts?: {includeDevice, includeGain})
Napi::Value GetResponse(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "getResponse(Float32Array, params?) expected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Float32Array freqs = info[0].As<Napi::Float32Array>();
  EngineParams p = state().engine.params();
  bool includeDevice = true, includeGain = false, autoHeadroom = state().autoHeadroom;
  if (info.Length() > 1 && info[1].IsObject()) {
    p = parseParams(info[1].As<Napi::Object>(), autoHeadroom);
    p.headroomDb = autoHeadroom ? Engine::computeHeadroomDb(p, currentRate()) : 0.f;
  }
  if (info.Length() > 2 && info[2].IsObject()) {
    Napi::Object o = info[2].As<Napi::Object>();
    includeDevice = flag(o, "includeDevice", includeDevice);
    includeGain = flag(o, "includeGain", includeGain);
  }
  Napi::Float32Array out = Napi::Float32Array::New(env, freqs.ElementLength());
  Engine::computeResponseDb(p, currentRate(), freqs.Data(), out.Data(), static_cast<int>(freqs.ElementLength()),
                            includeDevice, includeGain);
  return out;
}

// getAnalysis(bands = 72) -> { original, processed, waveform, meters } | { meters }
Napi::Value GetAnalysis(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  State& s = state();
  int bands = 72;
  if (info.Length() > 0 && info[0].IsNumber()) bands = std::max(8, std::min(256, info[0].As<Napi::Number>().Int32Value()));
  const int n = s.analyzer.size();
  s.original.resize(n);
  s.processed.resize(n);
  Napi::Object r = Napi::Object::New(env);
  if (s.engine.readAnalysis(s.original.data(), s.processed.data(), n)) {
    s.bandsIn.resize(bands);
    s.bandsOut.resize(bands);
    const double fs = currentRate();
    s.analyzer.analyze(s.original.data(), fs, s.bandsIn.data(), bands);
    s.analyzer.analyze(s.processed.data(), fs, s.bandsOut.data(), bands);
    Napi::Float32Array a = Napi::Float32Array::New(env, bands);
    Napi::Float32Array b = Napi::Float32Array::New(env, bands);
    std::copy(s.bandsIn.begin(), s.bandsIn.end(), a.Data());
    std::copy(s.bandsOut.begin(), s.bandsOut.end(), b.Data());
    r.Set("original", a);
    r.Set("processed", b);
    // Waveform: the newest 1024 processed samples, decimated to 512 points.
    const int wn = 512;
    Napi::Float32Array w = Napi::Float32Array::New(env, wn);
    Napi::Float32Array wo = Napi::Float32Array::New(env, wn);
    const int start = n - wn * 2;
    for (int i = 0; i < wn; ++i) {
      w.Data()[i] = 0.5f * (s.processed[start + i * 2] + s.processed[start + i * 2 + 1]);
      wo.Data()[i] = 0.5f * (s.original[start + i * 2] + s.original[start + i * 2 + 1]);
    }
    r.Set("waveform", w);
    r.Set("waveformOriginal", wo);
  }
  const EngineMeters m = s.engine.readMeters();
  Napi::Object mo = Napi::Object::New(env);
  Napi::Array peaks = Napi::Array::New(env, m.channels), rms = Napi::Array::New(env, m.channels);
  for (int c = 0; c < m.channels; ++c) {
    peaks.Set(static_cast<uint32_t>(c), m.outPeak[c]);
    rms.Set(static_cast<uint32_t>(c), m.outRms[c]);
  }
  mo.Set("peaks", peaks);
  mo.Set("rms", rms);
  mo.Set("inPeak", m.inPeak);
  mo.Set("limiterGrDb", m.limiterGrDb);
  mo.Set("compGrDb", m.compGrDb);
  mo.Set("agcGainDb", m.agcGainDb);
  mo.Set("bassBoostDb", m.bassBoostDb);
  mo.Set("loudnessLufs", m.loudnessLufs);
  mo.Set("cpuLoad", m.cpuLoad);
  mo.Set("wetMix", m.wetMix);
  mo.Set("framesProcessed", static_cast<double>(m.framesProcessed));
  mo.Set("nonFiniteEvents", m.nonFiniteEvents);
  r.Set("meters", mo);
  return r;
}

Napi::Value SetSystemDefaultOutput(const Napi::CallbackInfo& info) {
  std::string err;
  bool ok = false;
  if (info.Length() > 0 && info[0].IsString())
    ok = state().backend->setSystemDefaultOutput(info[0].As<Napi::String>().Utf8Value(), err);
  else err = "device id expected";
  Napi::Object r = Napi::Object::New(info.Env());
  r.Set("ok", ok);
  r.Set("error", err);
  return r;
}

Napi::Value Shutdown(const Napi::CallbackInfo& info) {
  cleanup(nullptr);
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  state();
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  exports.Set("platformInfo", Napi::Function::New(env, PlatformInfoJs));
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("poll", Napi::Function::New(env, Poll));
  exports.Set("status", Napi::Function::New(env, Status));
  exports.Set("devicesGeneration", Napi::Function::New(env, DevicesGeneration));
  exports.Set("setParams", Napi::Function::New(env, SetParams));
  exports.Set("getResponse", Napi::Function::New(env, GetResponse));
  exports.Set("getAnalysis", Napi::Function::New(env, GetAnalysis));
  exports.Set("setSystemDefaultOutput", Napi::Function::New(env, SetSystemDefaultOutput));
  exports.Set("shutdown", Napi::Function::New(env, Shutdown));
  return exports;
}

}  // namespace

NODE_API_MODULE(minsoundfx_native, Init)
