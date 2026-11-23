import { useState } from 'react';
import { api, run, toast } from '../api';
import { Card, Modal, PageHeader, StatusBanner } from '../components/Common';
import { Icon } from '../components/Icon';
import { mergeSound, defaultSound } from '../../shared/sound';
import type { AppState, Experience, UserPreset } from '../../shared/types';

function features(e: Experience, custom?: AppState['record']): string[] {
  const s = e.id === 'custom' && custom ? custom.customSound : mergeSound(defaultSound(), e.sound);
  const out: string[] = [];
  if (s.eqGainsDb.some((g) => Math.abs(g) > 0.1)) out.push('Tuned EQ');
  if (s.bass.enabled) out.push('Dynamic bass');
  if (s.dialogue.enabled) out.push('Dialogue');
  if (s.surround.enabled) out.push('Virtual surround');
  if (s.widen.enabled) out.push(s.widen.width < 1 ? 'Focused stereo' : 'Wide stereo');
  if (s.comp.enabled) out.push('Compression');
  if (s.loudness.enabled) out.push('Loudness');
  if (s.upmix) out.push('Multichannel up-mix');
  if (!out.length) out.push(e.id === 'custom' ? 'Your settings' : 'Uncoloured, reference');
  return out;
}

export function Experiences({ state }: { state: AppState }) {
  const active = state.record?.experienceId;
  return (
    <>
      <PageHeader title="Experiences" subtitle="Professionally voiced starting points — tweak anything afterwards" state={state} />
      <StatusBanner state={state} />
      <div className="exp-grid">
        {state.experiences.map((e, i) => (
          <button
            key={e.id}
            className={`exp-card ${active === e.id ? 'active' : ''}`}
            style={{ ['--a' as string]: e.accent[0], ['--b' as string]: e.accent[1], animationDelay: `${i * 25}ms` }}
            onClick={() => run(api.selectExperience(e.id))}
          >
            <div className="exp-glow" />
            <div className="exp-top">
              <span className="exp-icon">
                <Icon name={e.icon} size={24} strokeWidth={1.8} />
              </span>
              {active === e.id && (
                <span className="exp-active">
                  <Icon name="check" size={12} strokeWidth={3} /> Active
                </span>
              )}
            </div>
            <div className="exp-name">{e.name}</div>
            <div className="exp-tagline">{e.tagline}</div>
            <div className="exp-features">
              {features(e, state.record).map((f) => (
                <span key={f}>{f}</span>
              ))}
            </div>
          </button>
        ))}
      </div>
      <Presets state={state} />
    </>
  );
}

export function Presets({ state }: { state: AppState }) {
  const [editing, setEditing] = useState<UserPreset | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const submit = async () => {
    try {
      if (editing) await api.renamePreset(editing.id, name);
      else await api.savePreset(name);
      toast('info', editing ? 'Preset renamed.' : `Saved “${name.trim()}”.`);
      setEditing(null);
      setCreating(false);
      setName('');
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };
  return (
    <Card
      title="My presets"
      icon="save"
      className="presets-card"
      actions={
        <button className="btn primary" onClick={() => { setCreating(true); setName(''); }}>
          <Icon name="plus" size={14} /> Save current sound
        </button>
      }
    >
      {state.userPresets.length === 0 ? (
        <div className="empty">Save the current settings as a preset to reuse them on any device.</div>
      ) : (
        <div className="preset-list">
          {state.userPresets.map((p) => (
            <div key={p.id} className="preset-row">
              <button className="preset-apply" onClick={() => run(api.applyPreset(p.id))}>
                <Icon name="wand" size={16} />
                <span className="preset-name">{p.name}</span>
                <span className="preset-date">{new Date(p.updatedAt).toLocaleDateString()}</span>
              </button>
              <button className="icon-btn" title="Update with current settings" onClick={() => run(api.overwritePreset(p.id).then(() => toast('info', `Updated “${p.name}”.`)))}>
                <Icon name="save" size={15} />
              </button>
              <button className="icon-btn" title="Rename" onClick={() => { setEditing(p); setName(p.name); }}>
                <Icon name="edit" size={15} />
              </button>
              <button className="icon-btn danger" title="Delete" onClick={() => confirm(`Delete preset “${p.name}”?`) && run(api.deletePreset(p.id))}>
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      {(creating || editing) && (
        <Modal title={editing ? 'Rename preset' : 'Save preset'} onClose={() => { setEditing(null); setCreating(false); }}>
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <input className="text-input" autoFocus maxLength={40} placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => { setEditing(null); setCreating(false); }}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!name.trim()}>{editing ? 'Rename' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}
