import { ReactNode, useEffect, useState } from 'react';
import { analysis, api, run } from '../api';
import type { AppState, DeviceProfile } from '../../shared/types';
import { Icon } from './Icon';

export function PageHeader({ title, subtitle, state, children }: { title: string; subtitle?: string; state: AppState; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      <div className="header-actions">
        {children}
        <CompareButton state={state} />
        <PowerButton state={state} />
      </div>
    </header>
  );
}

export function PowerButton({ state, large }: { state: AppState; large?: boolean }) {
  const on = state.settings.processing;
  const running = state.status.state === 'running';
  return (
    <button
      className={`power ${on ? 'on' : ''} ${running ? 'running' : ''} ${large ? 'large' : ''}`}
      onClick={() => run(api.setProcessing(!on))}
      title={on ? 'Turn system-wide enhancement off' : 'Turn system-wide enhancement on'}
    >
      <Icon name="power" size={large ? 26 : 16} strokeWidth={2.2} />
      {!large && <span>{on ? (running ? 'On' : 'Starting') : 'Off'}</span>}
    </button>
  );
}

export function CompareButton({ state }: { state: AppState }) {
  const disabled = state.status.state !== 'running';
  return (
    <button
      className={`compare ${state.bypass ? 'active' : ''}`}
      disabled={disabled}
      onPointerDown={(e) => {
        // Hold to compare, or click to toggle.
        if (e.altKey) run(api.setBypass(true));
      }}
      onClick={() => run(api.setBypass(!state.bypass))}
      title="Switch between the original and the enhanced sound (seamless crossfade)"
    >
      <Icon name="compare" size={16} />
      <span>{state.bypass ? 'Original' : 'Enhanced'}</span>
    </button>
  );
}

export function Card({ title, icon, actions, children, className }: { title?: string; icon?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <div className="card-title">
            {icon && <Icon name={icon} size={16} />}
            <span>{title}</span>
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function VerificationBadge({ profile }: { profile: DeviceProfile | null }) {
  if (!profile) return <span className="badge none">No correction</span>;
  const label = profile.verification === 'measured' ? 'Measured' : profile.verification === 'estimated' ? 'Estimated' : 'Generic';
  const title =
    profile.verification === 'measured'
      ? `Derived from a published measurement: ${profile.source}`
      : profile.verification === 'estimated'
        ? 'Estimated from the product type and specifications — not measured.'
        : 'Category default — a starting point for this kind of device.';
  return (
    <span className={`badge ${profile.verification}`} title={title}>
      {profile.verification === 'measured' && <Icon name="check" size={12} strokeWidth={2.6} />}
      {label}
    </span>
  );
}

/** Explains why processing isn't running and how to fix it. */
export function StatusBanner({ state }: { state: AppState }) {
  const [silent, setSilent] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setSilent(!!analysis.silentSince && performance.now() - analysis.silentSince > 15000), 1000);
    return () => clearInterval(t);
  }, []);
  const s = state.status;
  if (!state.platform.supported) {
    return (
      <div className="banner error">
        <Icon name="warning" />
        <div>
          <b>System-wide processing isn’t available.</b> {state.platform.reason}
        </div>
      </div>
    );
  }
  if (s.state === 'needs-setup') {
    return (
      <div className="banner warn">
        <Icon name="info" />
        <div>
          <b>One-time setup needed.</b> {s.message}
        </div>
        <button className="btn" onClick={() => run(api.openExternal('https://vb-audio.com/Cable/'))}>
          Get VB-CABLE <Icon name="external" size={14} />
        </button>
      </div>
    );
  }
  if (s.state === 'error' && state.settings.processing) {
    return (
      <div className="banner error">
        <Icon name="warning" />
        <div>
          <b>Processing paused.</b> {s.message} Your original audio is playing normally.
        </div>
        <button className="btn" onClick={() => run(api.setProcessing(true))}>
          Retry
        </button>
      </div>
    );
  }
  if (s.state === 'running' && silent && state.platform.platform === 'darwin') {
    return (
      <div className="banner info">
        <Icon name="info" />
        <div>
          <b>No audio reaching MinSoundFX yet.</b> Play something. If you can hear sound but the visualiser stays flat, allow
          MinSoundFX under <i>Privacy &amp; Security ▸ Screen &amp; System Audio Recording</i>.
        </div>
        <button className="btn" onClick={() => run(api.openPrivacy())}>
          Open Privacy Settings
        </button>
      </div>
    );
  }
  if (state.safety.warning && s.state === 'running') {
    return (
      <div className="banner warn">
        <Icon name="shield" />
        <div>{state.safety.warning}</div>
      </div>
    );
  }
  return null;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
