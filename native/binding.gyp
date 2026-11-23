{
  "targets": [
    {
      "target_name": "minsoundfx_native",
      "sources": [
        "src/addon.cpp",
        "src/dsp/engine.cpp"
      ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "cflags_cc": ["-std=c++17", "-O3"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/platform/mac/mac_backend.mm"],
          "link_settings": {
            "libraries": [
              "-framework CoreAudio",
              "-framework AudioToolbox",
              "-framework Foundation"
            ]
          },
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "14.2",
            "GCC_OPTIMIZATION_LEVEL": "3",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fobjc-arc"],
            "OTHER_CFLAGS": ["-fobjc-arc"]
          }
        }],
        ["OS=='win'", {
          "sources": ["src/platform/win/win_backend.cpp"],
          "libraries": ["ole32.lib", "avrt.lib", "uuid.lib", "propsys.lib"],
          "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17", "/O2", "/utf-8"],
              "ExceptionHandling": 1
            }
          }
        }]
      ]
    }
  ]
}
