import { useEffect, useMemo, useState } from 'react';
import { api, run } from '../api';
import { Card, PageHeader, StatusBanner, VerificationBadge } from '../components/Common';
import { Segmented } from '../components/Controls';
import { categoryIcon, Icon } from '../components/Icon';
import type { AppState, DeviceProfile } from '../../shared/types';

const FREQS = Array.from({ length: 120 }, (_, i) => 20 * Math.pow(1000, i / 119));

function CorrectionPreview({ state }: { state: AppState }) {
  const [curve, setCurve] = useState<number[] | null>(null);
  const key = `${state.profile?.id}-${state.record?.profileMode}`;
  useEffect(() => {
    if (!state.profile?.filters.length) return setCurve(null);
    api.getResponse(FREQS, { eqEnabled: false }, true).then(setCurve).catch(() => setCurve(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!curve) return <div className="empty small">This profile applies no frequency correction.</div>;
  const w = 520, h = 120, db = 12;
  const x = (i: number) => (i / (FREQS.length - 1)) * w;
  const y = (v: number) => h / 2 - (Math.max(-db, Math.min(db, v)) / db) * (h / 2 - 6);
  const d = curve.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className="correction" viewBox={`0 0 ${w} ${h}`}>
      <line x1={0} x2={w} y1={h / 2} y2={h / 2} className="eq-zero" />
      {[100, 1000, 10000].map((f) => {
        const xi = (Math.log(f / 20) / Math.log(1000)) * w;
        return (
          <g key={f}>
            <line x1={xi} x2={xi} y1={0} y2={h} className="eq-grid" />
            <text x={xi + 3} y={h - 4} className="eq-axis">{f >= 1000 ? `${f / 1000}k` : f}</text>
          </g>
        );
      })}
      <path d={d} className="eq-curve" stroke="url(#corrGrad)" />
      <defs>
        <linearGradient id="corrGrad" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--accent-a)" />
          <stop offset="100%" stopColor="var(--accent-b)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Devices({ state }: { state: AppState }) {
  const d = state.activeDevice;
  const rec = state.record;
  const [query, setQuery] = useState('');
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = state.profiles.filter((p) => !q || `${p.brand} ${p.model}`.toLowerCase().includes(q));
    const by = new Map<string, DeviceProfile[]>();
    for (const p of list) by.set(p.brand, [...(by.get(p.brand) ?? []), p]);
    return [...by.entries()].sort(([a], [b]) => (a === 'Generic' ? 1 : b === 'Generic' ? -1 : a.localeCompare(b)));
  }, [state.profiles, query]);
  const suggested = state.profiles.find((p) => p.id === state.suggestedProfileId) ?? null;
  const running = state.status.state === 'running';
  const realDevices = state.devices.filter((x) => !x.isVirtual);
  const virtualDevices = state.devices.filter((x) => x.isVirtual);

  return (
    <>
      <PageHeader title="Devices" subtitle="Per-device profiles that follow your hardware" state={state} />
      <StatusBanner state={state} />
      <div className="devices-grid">
        <Card className="device-detail">
          {d && rec ? (
            <>
              <div className="device-hero small">
                <div className={`device-icon ${running ? 'live' : ''}`}>
                  <Icon name={categoryIcon(d.classification.category)} size={28} strokeWidth={1.5} />
                </div>
                <div className="device-meta">
                  <div className="eyebrow">{running ? 'Active output' : 'Default output'}</div>
                  <div className="device-name">{d.name}</div>
                  <div className="chips">
                    <span className="chip">{d.classification.label}</span>
                    {d.classification.brand && <span className="chip">{d.classification.brand}</span>}
                    <span className="chip">{d.channels} ch · {(d.sampleRate / 1000).toFixed(1)} kHz</span>
                  </div>
                </div>
              </div>

              <h4>Sound profile for this device</h4>
              <Segmented
                value={rec.profileMode}
                onChange={(mode) => run(api.setDeviceProfile(mode === 'manual' ? (rec.profileId ?? state.suggestedProfileId) : null, mode))}
                options={[
                  { value: 'auto', label: 'Automatic', title: 'Match the device by name' },
                  { value: 'manual', label: 'Choose model' },
                  { value: 'none', label: 'Off' },
                ]}
              />
              <div className="profile-box">
                <div className="row-between">
                  <div>
                    <div className="profile-name">{state.profile ? `${state.profile.brand} ${state.profile.model}` : 'No device correction'}</div>
                    <div className="profile-source">
                      {state.profile?.source}
                      {state.profile?.sourceUrl && (
                        <>
                          {' · '}
                          <a href={state.profile.sourceUrl} target="_blank" rel="noreferrer">source</a>
                        </>
                      )}
                    </div>
                  </div>
                  <VerificationBadge profile={state.profile} />
                </div>
                {rec.profileMode === 'auto' && suggested && (
                  <div className="note"><Icon name="info" size={14} /> Matched automatically from the device name “{d.name}”.</div>
                )}
                <CorrectionPreview state={state} />
              </div>

              <h4>Speaker configuration</h4>
              <Segmented
                value={rec.channelConfig}
                onChange={(v) => run(api.setChannelConfig(v))}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: '2.0', label: 'Stereo' },
                  { value: '2.1', label: '2.1' },
                  { value: '5.1', label: '5.1' },
                  { value: '7.1', label: '7.1' },
                ]}
              />
              <div className="note">
                <Icon name="info" size={14} />
                {d.channels <= 2 && rec.channelConfig !== 'auto' && rec.channelConfig !== '2.0'
                  ? `This output currently exposes ${d.channels} channels. Configure ${rec.channelConfig} in your system sound settings to get discrete channels.`
                  : `The device exposes ${d.channels} channel${d.channels > 1 ? 's' : ''}. Settings are remembered for “${d.name}” and restored automatically when it reconnects.`}
                {d.channels <= 2 && rec.channelConfig !== 'auto' && rec.channelConfig !== '2.0' && (
                  <button className="link" onClick={() => run(api.openSoundSettings())}> Open sound settings</button>
                )}
              </div>
            </>
          ) : (
            <div className="empty">No audio output device found.</div>
          )}
        </Card>

        <Card className="model-picker" title="Choose your model" icon="devices">
          <input className="text-input" placeholder="Search Sony, Bose, JBL, Samsung, LG, Sonos, Apple…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="tier-legend">
            <span className="t"><span className="badge measured"><Icon name="check" size={12} strokeWidth={2.6} />Measured</span> lab measurement</span>
            <span className="t"><span className="badge estimated">Estimated</span> from specs</span>
            <span className="t"><span className="badge generic">Generic</span> category default</span>
          </div>
          <div className="model-list">
            {grouped.map(([brand, list]) => (
              <div key={brand} className="model-group">
                <div className="model-brand">{brand}</div>
                {list.map((p) => (
                  <button
                    key={p.id}
                    className={`model-row ${state.profile?.id === p.id && rec?.profileMode !== 'none' ? 'active' : ''}`}
                    onClick={() => run(api.setDeviceProfile(p.id, 'manual'))}
                  >
                    <Icon name={categoryIcon(p.category)} size={16} />
                    <span className="model-name">{p.model}</span>
                    <span className="model-ch">{p.channels}</span>
                    <VerificationBadge profile={p} />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Card>

        <Card title="Output routing" icon="speaker">
          <div className="radio-list">
            <label className={`radio ${!state.settings.pinnedOutputId ? 'active' : ''}`}>
              <input type="radio" checked={!state.settings.pinnedOutputId} onChange={() => run(api.setSettings({ pinnedOutputId: '' }))} />
              <div>
                <div>Follow the system output</div>
                <div className="sub">Switches automatically when you connect headphones or speakers</div>
              </div>
            </label>
            {realDevices.map((x) => (
              <label key={x.id} className={`radio ${state.settings.pinnedOutputId === x.id ? 'active' : ''}`}>
                <input type="radio" checked={state.settings.pinnedOutputId === x.id} onChange={() => run(api.setSettings({ pinnedOutputId: x.id }))} />
                <Icon name={categoryIcon(x.classification.category)} size={16} />
                <div>
                  <div>{x.name}{x.isDefault ? ' · system default' : ''}</div>
                  <div className="sub">{x.classification.label} · {x.channels} ch</div>
                </div>
              </label>
            ))}
          </div>
          {state.platform.requiresVirtualDevice && (
            <>
              <h4>Virtual endpoint (Windows)</h4>
              <select className="text-input" value={state.settings.captureDeviceId} onChange={(e) => run(api.setSettings({ captureDeviceId: e.target.value }))}>
                <option value="">Detect automatically</option>
                {virtualDevices.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <div className="note"><Icon name="info" size={14} /> Apps play into this endpoint; MinSoundFX processes it and plays the result on your real device. The original default is restored when you stop or quit.</div>
            </>
          )}
        </Card>

        <Card title="Remembered devices" icon="save">
          {state.remembered.length === 0 ? (
            <div className="empty small">Devices appear here once used.</div>
          ) : (
            <div className="remembered">
              {state.remembered.map((r) => (
                <div key={r.id} className="remembered-row">
                  <Icon name={categoryIcon(r.category)} size={16} />
                  <div className="grow">
                    <div>{r.name}</div>
                    <div className="sub">
                      {state.experiences.find((e) => e.id === r.experienceId)?.name ?? 'Custom'} · {r.connected ? 'connected' : `last used ${new Date(r.lastSeen).toLocaleDateString()}`}
                    </div>
                  </div>
                  <i className={`dot ${r.connected ? 'on' : ''}`} />
                  {r.id !== d?.id && (
                    <button className="icon-btn danger" title="Forget this device" onClick={() => run(api.forgetDevice(r.id))}>
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
