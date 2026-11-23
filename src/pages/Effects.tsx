import { ReactNode } from 'react';
import { api, run, useMetersTick } from '../api';
import { PageHeader, StatusBanner } from '../components/Common';
import { fmt, Knob, Segmented, Slider, Toggle } from '../components/Controls';
import { Icon } from '../components/Icon';
import type { AppState, DeepPartial, SoundSettings } from '../../shared/types';

function FxCard({
  title,
  icon,
  description,
  enabled,
  onToggle,
  children,
  readout,
  onReset,
}: {
  title: string;
  icon: string;
  description: string;
  enabled?: boolean;
  onToggle?: (v: boolean) => void;
  children: ReactNode;
  readout?: ReactNode;
  onReset?: () => void;
}) {
  const active = enabled ?? true;
  return (
    <section className={`card fx-card ${active ? 'on' : 'off'}`}>
      <div className="fx-head">
        <span className="fx-icon">
          <Icon name={icon} size={18} />
        </span>
        <div className="fx-title">
          <div>{title}</div>
          <div className="fx-desc">{description}</div>
        </div>
        {onReset && (
          <button className="icon-btn" title="Reset to defaults" onClick={onReset}>
            <Icon name="reset" size={14} />
          </button>
        )}
        {onToggle && <Toggle checked={!!enabled} onChange={onToggle} label={`${title} on/off`} />}
      </div>
      <div className="fx-body">{children}</div>
      {readout && <div className="fx-readout">{readout}</div>}
    </section>
  );
}

export function Effects({ state }: { state: AppState }) {
  const meters = useMetersTick(200);
  const rec = state.record;
  if (!rec) return <PageHeader title="Effects" state={state} />;
  const s = rec.sound;
  const edit = (patch: DeepPartial<SoundSettings>) => run(api.editSound(patch));
  const running = state.status.state === 'running';
  const outCh = running ? state.status.outChannels : (state.activeDevice?.channels ?? 2);
  const headphones = state.activeDevice?.classification.headphoneLike;

  return (
    <>
      <PageHeader title="Effects" subtitle="Every enhancement is independent and works in real time" state={state} />
      <StatusBanner state={state} />
      <div className="fx-grid">
        <FxCard
          title="Virtual Surround"
          icon="orbit"
          description={outCh > 2 ? 'For stereo outputs — your device is multichannel, use up-mix instead' : 'Externalised, room-like soundstage'}
          enabled={s.surround.enabled}
          onToggle={(v) => edit({ surround: { enabled: v } })}
          onReset={() => run(api.resetSound('surround'))}
        >
          <div className="knob-row">
            <Knob label="Amount" value={s.surround.amount} min={0} max={1} defaultValue={0.5} format={fmt.pct} onChange={(v) => edit({ surround: { amount: v } })} disabled={!s.surround.enabled} />
            <Knob label="Room size" value={s.surround.room} min={0} max={1} defaultValue={0.5} format={fmt.pct} onChange={(v) => edit({ surround: { room: v } })} disabled={!s.surround.enabled} />
          </div>
          <Segmented
            small
            value={s.surround.mode}
            onChange={(v) => edit({ surround: { mode: v } })}
            options={[
              { value: 'auto', label: `Auto (${headphones ? 'headphones' : 'speakers'})` },
              { value: 'headphones', label: 'Headphones' },
              { value: 'speakers', label: 'Speakers' },
            ]}
          />
        </FxCard>

        <FxCard
          title="Stereo Widening"
          icon="stereo"
          description="Mid/side width; bass stays centred and mono-safe"
          enabled={s.widen.enabled}
          onToggle={(v) => edit({ widen: { enabled: v } })}
          onReset={() => run(api.resetSound('widen'))}
        >
          <div className="knob-row">
            <Knob label="Width" value={s.widen.width} min={0} max={2} defaultValue={1.3} format={fmt.width} onChange={(v) => edit({ widen: { width: v } })} disabled={!s.widen.enabled} />
          </div>
        </FxCard>

        <FxCard
          title="Dynamic Bass"
          icon="speaker"
          description="Level-aware bass lift plus harmonics for small drivers"
          enabled={s.bass.enabled}
          onToggle={(v) => edit({ bass: { enabled: v } })}
          onReset={() => run(api.resetSound('bass'))}
          readout={s.bass.enabled && running && meters ? <>Current lift <b>{fmt.db(meters.bassBoostDb)}</b></> : null}
        >
          <div className="knob-row">
            <Knob label="Amount" value={s.bass.amount} min={0} max={1} defaultValue={0.5} format={fmt.pct} onChange={(v) => edit({ bass: { amount: v } })} disabled={!s.bass.enabled} />
            <Knob label="Frequency" value={s.bass.freq} min={40} max={160} step={1} defaultValue={90} format={fmt.hz} onChange={(v) => edit({ bass: { freq: v } })} disabled={!s.bass.enabled} />
          </div>
        </FxCard>

        <FxCard
          title="Dialogue Enhancement"
          icon="voice"
          description={outCh >= 6 ? 'Lifts the centre channel' : 'Brings centred voices forward'}
          enabled={s.dialogue.enabled}
          onToggle={(v) => edit({ dialogue: { enabled: v } })}
          onReset={() => run(api.resetSound('dialogue'))}
        >
          <div className="knob-row">
            <Knob label="Amount" value={s.dialogue.amount} min={0} max={1} defaultValue={0.5} format={fmt.pct} onChange={(v) => edit({ dialogue: { amount: v } })} disabled={!s.dialogue.enabled} />
          </div>
        </FxCard>

        <FxCard
          title="Dynamic Range Compression"
          icon="moon"
          description="Tames loud peaks, lifts quiet detail (night listening)"
          enabled={s.comp.enabled}
          onToggle={(v) => edit({ comp: { enabled: v } })}
          onReset={() => run(api.resetSound('comp'))}
          readout={s.comp.enabled && running && meters ? <>Gain reduction <b>{meters.compGrDb.toFixed(1)} dB</b></> : null}
        >
          <div className="knob-row five">
            <Knob size={64} label="Threshold" value={s.comp.thresholdDb} min={-60} max={0} step={0.5} defaultValue={-24} format={fmt.db} onChange={(v) => edit({ comp: { thresholdDb: v } })} disabled={!s.comp.enabled} />
            <Knob size={64} label="Ratio" value={s.comp.ratio} min={1} max={20} step={0.1} defaultValue={3} format={fmt.ratio} onChange={(v) => edit({ comp: { ratio: v } })} disabled={!s.comp.enabled} />
            <Knob size={64} label="Attack" value={s.comp.attackMs} min={0.5} max={200} step={0.5} defaultValue={10} format={fmt.ms} onChange={(v) => edit({ comp: { attackMs: v } })} disabled={!s.comp.enabled} />
            <Knob size={64} label="Release" value={s.comp.releaseMs} min={10} max={2000} step={5} defaultValue={180} format={fmt.ms} onChange={(v) => edit({ comp: { releaseMs: v } })} disabled={!s.comp.enabled} />
            <Knob size={64} label="Makeup" value={s.comp.makeupDb} min={0} max={18} step={0.5} defaultValue={0} format={fmt.db} onChange={(v) => edit({ comp: { makeupDb: v } })} disabled={!s.comp.enabled} />
          </div>
        </FxCard>

        <FxCard
          title="Loudness Normalization"
          icon="waveform"
          description="Keeps different apps and videos at a steady loudness"
          enabled={s.loudness.enabled}
          onToggle={(v) => edit({ loudness: { enabled: v } })}
          onReset={() => run(api.resetSound('loudness'))}
          readout={
            s.loudness.enabled && running && meters ? (
              <>
                Measured <b>{meters.loudnessLufs > -69 ? `${meters.loudnessLufs.toFixed(0)} LUFS` : '—'}</b> · gain <b>{fmt.db(meters.agcGainDb)}</b>
              </>
            ) : null
          }
        >
          <div className="knob-row">
            <Knob label="Target" value={s.loudness.targetLufs} min={-30} max={-10} step={0.5} defaultValue={-16} format={fmt.lufs} onChange={(v) => edit({ loudness: { targetLufs: v } })} disabled={!s.loudness.enabled} />
            <Knob label="Max boost" value={s.loudness.maxBoostDb} min={0} max={12} step={0.5} defaultValue={9} format={fmt.db} onChange={(v) => edit({ loudness: { maxBoostDb: v } })} disabled={!s.loudness.enabled} />
          </div>
        </FxCard>

        <FxCard title="Balance & Gain" icon="sliders" description="Left/right balance, preamp and output trim" onReset={() => edit({ balance: 0, preampDb: 0, outputGainDb: 0 })}>
          <Slider label="Balance" value={s.balance} min={-1} max={1} step={0.01} defaultValue={0} bipolar format={fmt.balance} onChange={(v) => edit({ balance: v })} />
          <Slider label="Preamp" value={s.preampDb} min={-24} max={12} step={0.5} defaultValue={0} bipolar format={fmt.db} onChange={(v) => edit({ preampDb: v })} />
          <Slider label="Output" value={s.outputGainDb} min={-24} max={6} step={0.5} defaultValue={0} bipolar format={fmt.db} onChange={(v) => edit({ outputGainDb: v })} />
        </FxCard>

        <FxCard
          title="Clipping Protection"
          icon="shield"
          description="Look-ahead peak limiter — always on"
          readout={running && meters ? <>Limiter <b>{meters.limiterGrDb > 0.05 ? `−${meters.limiterGrDb.toFixed(1)} dB` : 'idle'}</b> · ceiling <b>{state.safety.ceilingDb.toFixed(1)} dBFS</b></> : null}
        >
          <Slider
            label="Output ceiling"
            value={state.settings.limiterCeilingDb}
            min={-12}
            max={-0.1}
            step={0.1}
            defaultValue={-1}
            format={(v) => `${v.toFixed(1)} dBFS`}
            onChange={(v) => run(api.setSettings({ limiterCeilingDb: v }))}
          />
          <div className="row-between">
            <span>Automatic headroom</span>
            <Toggle checked={state.settings.autoHeadroom} onChange={(v) => run(api.setSettings({ autoHeadroom: v }))} label="Automatic headroom" />
          </div>
          <div className="row-between">
            <span>Hearing protection {headphones ? '(headphones: ceiling −3 dBFS, boosts ≤ 12 dB)' : '(boosts ≤ 12 dB)'}</span>
            <Toggle checked={state.settings.hearingProtection} onChange={(v) => run(api.setSettings({ hearingProtection: v }))} label="Hearing protection" />
          </div>
        </FxCard>

        <FxCard
          title="Multichannel Up-mix"
          icon="home"
          description={outCh > 2 ? `Spreads stereo across your ${outCh}-channel system (centre, LFE, surrounds)` : 'Available when the output has more than two channels'}
          enabled={s.upmix}
          onToggle={(v) => edit({ upmix: v })}
        >
          <div className="note">
            <Icon name="info" size={14} />
            {outCh > 2
              ? 'Multichannel sources (games, films) already arrive as discrete channels and are processed channel by channel.'
              : 'Set your system to 5.1 or 7.1 in the OS sound settings to enable discrete channels.'}
          </div>
        </FxCard>
      </div>
    </>
  );
}
