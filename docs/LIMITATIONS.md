# Known limitations

* **macOS 14.2 or later** is required (Core Audio process taps). Older versions can only run the app without system-wide processing.
* **Windows needs a virtual audio endpoint** such as VB-Audio VB-CABLE (free). Windows has no public API for an app to process the system mix without a driver; MinSoundFX does not ship one. A signed APO driver is on the roadmap.
* **Protected content:** apps that use exclusive-mode output (some pro-audio and games on Windows) or DRM-protected audio paths bypass the shared mix and won't be processed.
* **Device profiles:** *Measured* corrections exist for headphones/earbuds with public lab measurements (AutoEq). Speakers and soundbars depend on room and placement and are labelled *Estimated* or *Generic*.
* **Multichannel:** discrete 5.1/7.1 processing requires the OS output to be configured for that layout. HDMI devices exposing stereo get stereo processing (optionally virtual surround).
* **Signing:** release builds are ad-hoc signed (macOS) and unsigned (Windows), so the OS shows a warning on first launch. See the README.
* **Latency:** typically 10–20 ms on macOS (256-frame buffer), plus the virtual endpoint's buffering on Windows. Use the *Low latency* buffer size for games.
