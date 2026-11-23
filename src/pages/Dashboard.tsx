import { api, run, useMetersTick } from '../api';
import { Card, PageHeader, PowerButton, Stat, StatusBanner, VerificationBadge } from '../components/Common';
import { categoryIcon, Icon } from '../components/Icon';
import { LevelMeters, SpectrumView, WaveformView } from '../components/Visualizer';
import type { AppState, DeepPartial, SoundSettings } from '../../shared/types';

const TRANSPORT: Record<string, string> = {
  builtin: 'Built-in',
  usb: 'USB',
  bluetooth: 'Bluetooth',
  hdmi: 'HDMI',
  displayport: 'DisplayPort',
  airplay: 'AirPlay',
  thunderbolt: 'Thunderbolt',
  virtual: 'Virtual',
  pci: 'PCI',
};

function channelLabel(n: number) {
  return ({ 1: 'Mono', 2: 'Stereo', 3: '2.1', 4: 'Quad', 6: '5.1', 8: '7.1' } as Record<number, string>)[n] ?? `${n} ch`;
}

export function Dashboard({ state }: { state: AppState }) {
  const d = state.activeDevice;
  const s = state.status;
  const running = s.state === 'running';
  const sound = state.record?.sound;
  const meters = useMetersTick(250);

  const quick: Array<{ key: string; label: string; icon: string; on: boolean; patch: (v: boolean) => DeepPartial<SoundSettings> }> = sound
    ? [
        { key: 'bass', label: 'Dynamic Bass', icon: 'speaker', on: sound.bass.enabled, patch: (v) => ({ bass: { enabled: v } }) },
        { key: 'dialogue', label: 'Dialogue', icon: 'voice', on: sound.dialogue.enabled, patch: (v) => ({ dialogue: { enabled: v } }) },
        { key: 'surround', label: 'Virtual Surround', icon: 'orbit', on: sound.surround.enabled, patch: (v) => ({ surround: { enabled: v } }) },
        { key: 'widen', label: 'Stereo Widening', icon: 'stereo', on: sound.widen.enabled, patch: (v) => ({ widen: { enabled: v } }) },
        { key: 'comp', label: 'Night / DRC', icon: 'moon', on: sound.comp.enabled, patch: (v) => ({ comp: { enabled: v } }) },
        { key: 'loudness', label: 'Loudness', icon: 'waveform', on: sound.loudness.enabled, patch: (v) => ({ loudness: { enabled: v } }) },
      ]
    : [];

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Real-time view of everything you hear" state={state} />
      <StatusBanner state={state} />
      <div className="dash-grid">
        <Card className="device-card">
          <div className="device-hero">
            <div className={`device-icon ${running ? 'live' : ''}`}>
              <Icon name={categoryIcon(d?.classification.category ?? 'speakers')} size={34} strokeWidth={1.5} />
            </div>
            <div className="device-meta">
              <div className="eyebrow">{running ? 'Now enhancing' : 'Output device'}</div>
              <div className="device-name">{d?.name ?? 'No output device'}</div>
              <div className="chips">
                {d && <span className="chip">{d.classification.label}</span>}
                {d && <span className="chip">{TRANSPORT[d.transport] ?? d.transport}</span>}
                {d && <span className="chip">{channelLabel(running ? s.outChannels : d.channels)}</span>}
                {d && <span className="chip">{((running ? s.sampleRate : d.sampleRate) / 1000).toFixed(1)} kHz</span>}
              </div>
            </div>
            <PowerButton state={state} large />
          </div>
          <div className="device-profile">
            <div>
              <div className="eyebrow">Device profile</div>
              <div className="profile-name">{state.profile ? `${state.profile.brand === 'Generic' ? '' : state.profile.brand + ' '}${state.profile.model}` : 'None'}</div>
            </div>
            <VerificationBadge profile={state.profile} />
          </div>
          <div className="stats">
            <Stat label="Latency" value={running ? `${s.latencyMs.toFixed(1)} ms` : '—'} hint="Capture + processing + output buffering" />
            <Stat label="DSP load" value={meters && running ? `${(meters.cpuLoad * 100).toFixed(1)}%` : '—'} hint="Share of the real-time budget used by the engine" />
            <Stat label="Limiter" value={meters && running ? `${meters.limiterGrDb > 0.05 ? '−' + meters.limiterGrDb.toFixed(1) : '0.0'} dB` : '—'} hint="Gain reduction applied to prevent clipping" />
            <Stat label="Loudness" value={meters && running && meters.loudnessLufs > -69 ? `${meters.loudnessLufs.toFixed(0)} LUFS` : '—'} hint="Short-term loudness (ITU-R BS.1770 K-weighting)" />
          </div>
        </Card>

        <Card className="viz-card" title="Live spectrum" icon="waveform" actions={<span className="legend"><i className="sw user" /> Enhanced <i className="sw orig" /> Original</span>}>
          <SpectrumView height={238} />
          <WaveformView height={64} />
        </Card>

        <Card className="meters-card" title="Output levels" icon="equalizer">
          <LevelMeters height={196} />
        </Card>

        <Card className="quick-card" title="Experience" icon="sparkles" actions={<a href="#/experiences" className="link">All experiences <Icon name="chevron" size={14} /></a>}>
          <div className="exp-strip">
            {state.experiences.map((e) => (
              <button
                key={e.id}
                className={`exp-chip ${state.record?.experienceId === e.id ? 'active' : ''}`}
                style={{ ['--a' as string]: e.accent[0], ['--b' as string]: e.accent[1] }}
                onClick={() => run(api.selectExperience(e.id))}
              >
                <span className="exp-chip-icon">
                  <Icon name={e.icon} size={18} />
                </span>
                <span>{e.name}</span>
              </button>
            ))}
          </div>
          <div className="quick-toggles">
            {quick.map((q) => (
              <button key={q.key} className={`qt ${q.on ? 'on' : ''}`} onClick={() => run(api.editSound(q.patch(!q.on)))}>
                <Icon name={q.icon} size={16} />
                <span>{q.label}</span>
                <i className="qt-dot" />
              </button>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
