import { api, run } from '../api';
import { Card, PageHeader } from '../components/Common';
import { Segmented, Toggle } from '../components/Controls';
import { Icon } from '../components/Icon';
import type { AppState } from '../../shared/types';

function Row({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-title">{title}</div>
        {sub && <div className="setting-sub">{sub}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function Settings({ state }: { state: AppState }) {
  const s = state.settings;
  const set = (patch: Partial<typeof s>) => run(api.setSettings(patch));
  const mac = state.platform.platform === 'darwin';
  const latency = { 128: 'Low latency', 256: 'Balanced', 512: 'Efficient', 1024: 'Power saver' } as const;
  return (
    <>
      <PageHeader title="Settings" subtitle={`MinSoundFX ${state.version}`} state={state} />
      <div className="settings-grid">
        <Card title="Appearance" icon="sparkles">
          <Row title="Theme">
            <Segmented value={s.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
          </Row>
          <Row title="Visualizer frame rate" sub="Lower uses less power">
            <Segmented value={s.visualizerFps} onChange={(v) => set({ visualizerFps: v })} options={[{ value: 30, label: '30 fps' }, { value: 60, label: '60 fps' }]} />
          </Row>
        </Card>

        <Card title="Audio engine" icon="waveform">
          <Row title="Buffer size" sub={`${latency[s.bufferFrames]} · ${s.bufferFrames} frames${state.status.state === 'running' ? ` · ${state.status.latencyMs.toFixed(1)} ms total` : ''}`}>
            <Segmented value={s.bufferFrames} onChange={(v) => set({ bufferFrames: v })} options={[128, 256, 512, 1024].map((v) => ({ value: v as 128, label: String(v) }))} small />
          </Row>
          <Row title="Switch profiles with the device" sub="Load each device’s saved sound when it becomes the output">
            <Toggle checked={s.autoSwitchProfiles} onChange={(v) => set({ autoSwitchProfiles: v })} />
          </Row>
          <Row title="Automatic headroom" sub="Offsets EQ boosts so the signal never clips">
            <Toggle checked={s.autoHeadroom} onChange={(v) => set({ autoHeadroom: v })} />
          </Row>
          <Row title="Hearing protection" sub="Lower ceiling on headphones and a 12 dB cap on combined boosts">
            <Toggle checked={s.hearingProtection} onChange={(v) => set({ hearingProtection: v })} />
          </Row>
          <div className="engine-info">
            <div><span>Capture</span><b>{state.platform.captureMethod}</b></div>
            <div><span>Status</span><b>{state.status.state}{state.status.message ? ` — ${state.status.message}` : ''}</b></div>
            {state.status.state === 'running' && (
              <div><span>Format</span><b>{state.status.inChannels} → {state.status.outChannels} ch · {state.status.sampleRate} Hz · 32-bit float</b></div>
            )}
          </div>
        </Card>

        <Card title="Startup" icon="power">
          <Row title="Launch at login" sub="Starts in the background with your last settings">
            <Toggle checked={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} />
          </Row>
          <Row title={`Start hidden in the ${mac ? 'menu bar' : 'system tray'}`}>
            <Toggle checked={s.startHidden} onChange={(v) => set({ startHidden: v })} />
          </Row>
        </Card>

        <Card title="Privacy & safety" icon="shield">
          <ul className="assurances">
            <li><Icon name="check" size={14} /> Audio is processed in memory on this computer. Nothing is recorded, stored or uploaded.</li>
            <li><Icon name="check" size={14} /> No accounts, analytics or network connections.</li>
            <li><Icon name="check" size={14} /> {mac ? 'No drivers or system files are installed. Uses Apple’s Core Audio process taps, which macOS removes automatically if the app quits or crashes.' : 'No drivers are installed by MinSoundFX. The original default output is restored when you stop, quit or uninstall.'}</li>
            <li><Icon name="check" size={14} /> Output is limited to a safe ceiling; NaN/overload protection on every block.</li>
            <li><Icon name="info" size={14} /> MinSoundFX uses its own processing. It does not implement Dolby Atmos, DTS:X or other licensed formats.</li>
          </ul>
          <div className="btn-row">
            <button className="btn" onClick={() => run(api.openPrivacy())}><Icon name="shield" size={14} /> {mac ? 'Audio capture permission' : 'Sound settings'}</button>
            <button className="btn" onClick={() => run(api.openLogs())}><Icon name="logs" size={14} /> Show logs</button>
          </div>
        </Card>
      </div>
    </>
  );
}
