# Safety, privacy and reliability

## Hearing and equipment protection
* **Look-ahead brick-wall limiter, always on.** The gain is fully reduced before a peak leaves the 1.5 ms look-ahead delay, and a final clamp makes the ceiling a hard guarantee. Tested with random input up to +18 dBFS.
* **Configurable ceiling** (default −1 dBFS). With *Hearing protection* on, headphones get a −3 dBFS ceiling and the combined boost of all gain stages is capped at 12 dB (18 dB otherwise).
* **Automatic headroom.** The engine computes the peak of the equaliser + device-correction response and trims the input by that amount, so EQ boosts cannot clip.
* **Parameter sanitising in native code.** Every value is clamped (e.g. preamp ≤ +12 dB, EQ ±12 dB) whatever the UI sends; NaN/Inf parameters fall back to defaults.
* **Signal guards.** Non-finite samples are replaced and the processing chain is reset; output is clamped to ±1.0.
* **Warnings** appear when combined boosts get high.

## System integrity
* No kernel extensions, audio drivers or protected system files are installed or modified.
* macOS: only the *System Audio Recording* permission is requested (`NSAudioCaptureUsageDescription`). No microphone, accessibility, or admin rights.
* Windows: only the default output device is changed while processing runs, and it is restored on stop, quit, crash (next launch) and uninstall.

## Privacy
* Audio is processed in memory in real time. It is never recorded, written to disk or transmitted.
* The app makes no network connections. The log file contains app events (start/stop, device names, errors) only.

## Device changes
* Bluetooth disconnects, headphones plugging in, default-device changes, sample-rate and channel-layout changes are detected via OS notifications and the pipeline is rebuilt automatically, then the saved profile for the new device is applied.
* If processing can't continue, MinSoundFX stops cleanly so normal audio plays, and shows why.

## Licensed formats
MinSoundFX's surround virtualisation, up-mix and spatial effects are its own DSP. It does **not** implement or claim Dolby Atmos, Dolby Audio, DTS:X, DTS Sound Unbound, THX Spatial Audio or any other licensed technology.
