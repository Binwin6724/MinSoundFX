// Compact tray / menu-bar player for quick adjustments.
import { api, run } from '../api';
import { fmt, Slider, Toggle } from '../components/Controls';
import { categoryIcon, Icon } from '../components/Icon';
import { SpectrumView } from '../components/Visualizer';
import type { AppState } from '../../shared/types';

export function Mini({ state }: { state: AppState | null }) {
  if (!state) return <div className="mini boot">Starting…</div>;
  const rec = state.record;
  const s = rec?.sound;
  const running = state.status.state === 'running';
  const d = state.activeDevice;
  return (
    <div className="mini">
      <div className="mini-head">
        <div className="mini-device">
          <Icon name={categoryIcon(d?.classification.category ?? 'speakers')} size={18} />
          <div>
            <div className="name">{d?.name ?? 'No output'}</div>
            <div className="sub">{running ? (state.bypass ? 'Original sound' : 'Enhanced') : state.status.state === 'stopped' ? 'Enhancement off' : state.status.message || state.status.state}</div>
          </div>
        </div>
        <Toggle checked={state.settings.processing} onChange={(v) => run(api.setProcessing(v))} label="System-wide enhancement" />
      </div>
      <div className="mini-viz">
        <SpectrumView height={92} compact showOriginal={false} />
      </div>
      <div className="mini-exp">
        {state.experiences.map((e) => (
          <button
            key={e.id}
            className={`mini-exp-btn ${rec?.experienceId === e.id ? 'active' : ''}`}
            style={{ ['--a' as string]: e.accent[0], ['--b' as string]: e.accent[1] }}
            onClick={() => run(api.selectExperience(e.id))}
            title={e.tagline}
          >
            <Icon name={e.icon} size={16} />
            <span>{e.name}</span>
          </button>
        ))}
      </div>
      {s && (
        <div className="mini-controls">
          <Slider label="Bass" value={s.bassDb} min={-12} max={12} step={0.5} defaultValue={0} bipolar format={fmt.db} onChange={(v) => run(api.editSound({ bassDb: v }))} />
          <Slider label="Treble" value={s.trebleDb} min={-12} max={12} step={0.5} defaultValue={0} bipolar format={fmt.db} onChange={(v) => run(api.editSound({ trebleDb: v }))} />
          <Slider label="Surround" value={s.surround.enabled ? s.surround.amount : 0} min={0} max={1} step={0.01} defaultValue={0} format={fmt.pct} onChange={(v) => run(api.editSound({ surround: { enabled: v > 0.01, amount: Math.max(0.01, v) } }))} />
        </div>
      )}
      <div className="mini-foot">
        <button className={`compare ${state.bypass ? 'active' : ''}`} disabled={!running} onClick={() => run(api.setBypass(!state.bypass))}>
          <Icon name="compare" size={15} /> {state.bypass ? 'Original' : 'Enhanced'}
        </button>
        <button className="btn ghost" onClick={() => run(api.showMain())}>
          <Icon name="expand" size={14} /> Open
        </button>
        <button className="icon-btn" title="Quit MinSoundFX" onClick={() => run(api.quit())}>
          <Icon name="power" size={15} />
        </button>
      </div>
    </div>
  );
}
