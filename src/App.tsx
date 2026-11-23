import { useEffect, useState } from 'react';
import { api, onToast, run, useAppState } from './api';
import { categoryIcon, Icon } from './components/Icon';
import { Dashboard } from './pages/Dashboard';
import { Devices } from './pages/Devices';
import { Effects } from './pages/Effects';
import { Equalizer } from './pages/Equalizer';
import { Experiences } from './pages/Experiences';
import { Mini } from './pages/Mini';
import { Settings } from './pages/Settings';
import type { AppState } from '../shared/types';

const NAV = [
  { route: '/', label: 'Dashboard', icon: 'dashboard' },
  { route: '/experiences', label: 'Experiences', icon: 'sparkles' },
  { route: '/equalizer', label: 'Equalizer', icon: 'equalizer' },
  { route: '/effects', label: 'Effects', icon: 'sliders' },
  { route: '/devices', label: 'Devices', icon: 'devices' },
  { route: '/settings', label: 'Settings', icon: 'settings' },
];

function useRoute() {
  const [route, setRoute] = useState(() => location.hash.replace(/^#/, '') || '/');
  useEffect(() => {
    const on = () => setRoute(location.hash.replace(/^#/, '') || '/');
    window.addEventListener('hashchange', on);
    const off = api.onNav((r) => (location.hash = r));
    return () => {
      window.removeEventListener('hashchange', on);
      off();
    };
  }, []);
  return route;
}

function useTheme(state: AppState | null) {
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const pref = state?.settings.theme ?? 'system';
      const dark = pref === 'dark' || (pref === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [state?.settings.theme]);
}

export function App() {
  const state = useAppState();
  const route = useRoute();
  useTheme(state);
  document.documentElement.dataset.platform = api.platform;

  if (route === '/mini') return <Mini state={state} />;
  if (!state) return <div className="boot">Starting audio engine…</div>;

  const page = (() => {
    switch (route) {
      case '/experiences': return <Experiences state={state} />;
      case '/equalizer': return <Equalizer state={state} />;
      case '/effects': return <Effects state={state} />;
      case '/devices': return <Devices state={state} />;
      case '/settings': return <Settings state={state} />;
      default: return <Dashboard state={state} />;
    }
  })();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="drag-region" />
        <div className="brand">
          <div className="brand-mark">
            <Icon name="waveform" size={20} strokeWidth={2.2} />
          </div>
          <div>
            <div className="brand-name">MinSoundFX</div>
            <div className="brand-sub">Audio enhancer</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.route} href={`#${n.route}`} className={route === n.route ? 'active' : ''}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <SidebarStatus state={state} />
      </aside>
      <main className="content">
        <div className="drag-region top" />
        <div key={route} className="page">
          {page}
        </div>
      </main>
      <Toasts />
    </div>
  );
}

function SidebarStatus({ state }: { state: AppState }) {
  const running = state.status.state === 'running';
  const d = state.activeDevice;
  return (
    <div className={`side-status ${running ? 'running' : ''}`}>
      <div className="side-status-row">
        <Icon name={categoryIcon(d?.classification.category ?? 'speakers')} />
        <div className="side-status-text">
          <div className="name">{d?.name ?? 'No output device'}</div>
          <div className="sub">{running ? (state.bypass ? 'Bypassed (original)' : 'Enhancing system audio') : 'Enhancement off'}</div>
        </div>
      </div>
      <button className={`side-power ${running ? 'on' : ''}`} onClick={() => run(api.setProcessing(!state.settings.processing))} aria-label="Toggle processing">
        <Icon name="power" size={16} />
      </button>
    </div>
  );
}

function Toasts() {
  const [items, setItems] = useState<Array<{ id: number; kind: string; text: string }>>([]);
  useEffect(
    () =>
      onToast((t) => {
        setItems((x) => [...x.slice(-3), t]);
        setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 4500);
      }),
    [],
  );
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'warning' : 'info'} size={16} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
