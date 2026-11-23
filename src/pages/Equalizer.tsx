import { api, run } from '../api';
import { Card, PageHeader, StatusBanner } from '../components/Common';
import { fmt, Knob, Slider, Toggle } from '../components/Controls';
import { EqGraph } from '../components/EqGraph';
import { Icon } from '../components/Icon';
import { EQ_FREQUENCIES, type AppState } from '../../shared/types';
import { Presets } from './Experiences';

const label = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

export function Equalizer({ state }: { state: AppState }) {
  const rec = state.record;
  if (!rec) return <PageHeader title="Equalizer" state={state} />;
  const s = rec.sound;
  const setBand = (i: number, g: number) => {
    const gains = [...s.eqGainsDb];
    gains[i] = g;
    run(api.editSound({ eqGainsDb: gains }));
  };
  const activeProfile = state.eqProfiles.find((p) => p.gains.every((g, i) => Math.abs(g - s.eqGainsDb[i]) < 0.01));
  const deviceCorrection = rec.profileMode !== 'none' && !!state.profile?.filters.length;

  return (
    <>
      <PageHeader title="Equalizer" subtitle="10-band graphic EQ with tone controls" state={state}>
        <div className="inline-toggle">
          <span>EQ</span>
          <Toggle checked={s.eqEnabled} onChange={(v) => run(api.editSound({ eqEnabled: v }))} label="Equalizer on/off" />
        </div>
      </PageHeader>
      <StatusBanner state={state} />
      <Card className={`eq-card ${s.eqEnabled ? '' : 'dimmed'}`}>
        <div className="eq-profiles">
          {state.eqProfiles.map((p) => (
            <button key={p.id} className={`pill ${activeProfile?.id === p.id ? 'active' : ''}`} onClick={() => run(api.applyEqProfile(p.id))}>
              {p.name}
            </button>
          ))}
          <div className="spacer" />
          <button className="btn ghost" onClick={() => run(api.resetSound('eqGainsDb'))} title="Reset all bands to 0 dB">
            <Icon name="reset" size={14} /> Reset bands
          </button>
        </div>
        <EqGraph sound={s} onBandChange={setBand} deviceCorrection={deviceCorrection} />
        <div className="band-sliders">
          {EQ_FREQUENCIES.map((f, i) => (
            <div key={f} className="band">
              <VerticalSlider value={s.eqGainsDb[i]} onChange={(v) => setBand(i, v)} />
              <div className="band-value">{s.eqGainsDb[i] > 0 ? '+' : ''}{s.eqGainsDb[i].toFixed(1)}</div>
              <div className="band-freq">{label(f)}</div>
            </div>
          ))}
        </div>
      </Card>
      <div className="eq-lower">
        <Card title="Tone" icon="sliders" actions={<button className="btn ghost" onClick={() => run(api.editSound({ bassDb: 0, midDb: 0, trebleDb: 0 }))}><Icon name="reset" size={14} /> Reset</button>}>
          <div className="knob-row">
            <Knob label="Bass" value={s.bassDb} min={-12} max={12} step={0.5} defaultValue={0} bipolar format={fmt.db} onChange={(v) => run(api.editSound({ bassDb: v }))} />
            <Knob label="Mid" value={s.midDb} min={-12} max={12} step={0.5} defaultValue={0} bipolar format={fmt.db} onChange={(v) => run(api.editSound({ midDb: v }))} />
            <Knob label="Treble" value={s.trebleDb} min={-12} max={12} step={0.5} defaultValue={0} bipolar format={fmt.db} onChange={(v) => run(api.editSound({ trebleDb: v }))} />
          </div>
        </Card>
        <Card title="Gain & bandwidth" icon="equalizer">
          <Slider label="Preamp" value={s.preampDb} min={-24} max={12} step={0.5} defaultValue={0} bipolar format={fmt.db} onChange={(v) => run(api.editSound({ preampDb: v }))} />
          <Slider label="Band width (Q)" value={s.eqQ} min={0.5} max={3} step={0.05} defaultValue={1.41} format={(v) => v.toFixed(2)} onChange={(v) => run(api.editSound({ eqQ: v }))} />
          <div className="note">
            <Icon name="shield" size={14} />
            {state.settings.autoHeadroom
              ? `Clipping prevention trims ${Math.abs(state.headroomDb).toFixed(1)} dB to offset EQ boosts.`
              : 'Automatic headroom is off; the output limiter still prevents clipping.'}
          </div>
        </Card>
      </div>
      <Presets state={state} />
    </>
  );
}

function VerticalSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="vslider">
      <Slider value={value} min={-12} max={12} step={0.5} defaultValue={0} bipolar onChange={onChange} />
    </div>
  );
}
