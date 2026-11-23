// Electron main process: windows, tray / menu-bar mini player, IPC, and the
// application lifecycle (making sure audio routing is always restored).
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AudioController, PersistedData } from './controller';
import { log } from './logger';
import { loadNative, NativeModule } from './native';
import { JsonStore } from './store';
import { DEFAULT_SETTINGS } from '../shared/records';
import { EXPERIENCES } from '../shared/sound';

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const args = process.argv.slice(1);
const startHidden = args.includes('--hidden');
const captureDir = argValue('--capture-screenshots');
const selfTestSeconds = Number(argValue('--self-test') ?? 0);

let controller: AudioController | null = null;
let native: NativeModule | null = null;
let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let analysisTimer: NodeJS.Timeout | null = null;

function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

// ---------------------------------------------------------------- single instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--restore-audio')) return;
    showMain();
  });
}

// Windows uninstaller hook: put the original default device back, then exit.
if (args.includes('--restore-audio')) {
  app.whenReady().then(() => {
    try {
      const n = loadNative();
      const store = new JsonStore<PersistedData>(path.join(app.getPath('userData'), 'minsoundfx.json'), emptyData());
      const pending = store.get().pendingRestore;
      if (pending) n.setSystemDefaultOutput(pending);
      n.shutdown();
    } catch {
      /* best effort */
    }
    app.exit(0);
  });
}

function emptyData(): PersistedData {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, records: {}, presets: [], pendingRestore: '' };
}

// ---------------------------------------------------------------- windows
function rendererUrl(hash: string) {
  if (DEV_URL) return `${DEV_URL}#${hash}`;
  return `file://${path.join(__dirname, '..', 'renderer', 'index.html')}#${hash}`;
}

function hardenWebContents(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
}

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f4f5f8';
}

function createMainWindow() {
  const mac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    title: 'MinSoundFX',
    backgroundColor: windowBackground(),
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    titleBarOverlay: mac ? undefined : { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e5e7eb' : '#111827', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  });
  hardenWebContents(mainWindow);
  mainWindow.loadURL(rendererUrl('/'));
  mainWindow.once('ready-to-show', () => {
    if (!(startHidden || controller?.currentSettings.startHidden) || captureDir) mainWindow?.show();
  });
  mainWindow.on('close', (e) => {
    // Keep processing in the tray / menu bar; quit from the tray menu.
    if (!quitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('show', ensureAnalysisLoop);
  mainWindow.on('hide', ensureAnalysisLoop);
}

function createMiniWindow() {
  miniWindow = new BrowserWindow({
    width: 360,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    roundedCorners: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  hardenWebContents(miniWindow);
  miniWindow.loadURL(rendererUrl('/mini'));
  miniWindow.on('blur', () => {
    if (!captureDir) miniWindow?.hide();
  });
  miniWindow.on('show', ensureAnalysisLoop);
  miniWindow.on('hide', ensureAnalysisLoop);
}

function showMain() {
  if (!mainWindow) createMainWindow();
  mainWindow!.show();
  mainWindow!.focus();
  if (process.platform === 'darwin') app.dock?.show();
}

function toggleMini() {
  if (!miniWindow) createMiniWindow();
  if (miniWindow!.isVisible()) {
    miniWindow!.hide();
    return;
  }
  positionMini();
  miniWindow!.show();
  miniWindow!.focus();
}

function positionMini() {
  if (!miniWindow || !tray) return;
  const t = tray.getBounds();
  const [w, h] = miniWindow.getSize();
  const display = screen.getDisplayNearestPoint({ x: t.x, y: t.y });
  const wa = display.workArea;
  let x = Math.round(t.x + t.width / 2 - w / 2);
  let y = process.platform === 'darwin' ? Math.round(t.y + t.height + 6) : Math.round(t.y - h - 8);
  if (t.width === 0 && t.height === 0) {
    x = wa.x + wa.width - w - 12;
    y = wa.y + wa.height - h - 12;
  }
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - h - 8));
  miniWindow.setPosition(x, y, false);
}

// ---------------------------------------------------------------- tray / menu bar
function trayIcon() {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'tray') : path.join(__dirname, '..', '..', 'build', 'tray');
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(dir, file));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('MinSoundFX');
  tray.on('click', toggleMini);
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()));
  if (process.platform !== 'darwin') tray.on('double-click', showMain);
}

function buildTrayMenu() {
  const state = controller?.getState();
  const running = state?.status.state === 'running';
  return Menu.buildFromTemplate([
    { label: running ? `Processing: ${state?.status.deviceName}` : 'Processing is off', enabled: false },
    {
      label: 'System-wide enhancement',
      type: 'checkbox',
      checked: !!state?.settings.processing,
      click: (item) => controller?.setProcessing(item.checked),
    },
    {
      label: 'Compare original (bypass)',
      type: 'checkbox',
      checked: !!state?.bypass,
      click: (item) => controller?.setBypass(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Experience',
      submenu: EXPERIENCES.map((e) => ({
        label: e.name,
        type: 'radio' as const,
        checked: state?.record?.experienceId === e.id,
        click: () => controller?.selectExperience(e.id),
      })),
    },
    { type: 'separator' },
    { label: 'Open MinSoundFX', click: showMain },
    { label: 'Quit MinSoundFX', click: () => app.quit() },
  ]);
}

// ---------------------------------------------------------------- IPC
type Handler = (...a: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

function handle(channel: string, fn: Handler) {
  ipcMain.handle(channel, async (_e, ...a) => {
    try {
      return { ok: true, value: await fn(...a) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`IPC ${channel} failed`, message);
      return { ok: false, error: message };
    }
  });
}

function registerIpc(c: AudioController) {
  handle('state:get', () => c.getState());
  handle('engine:setProcessing', (on: boolean) => c.setProcessing(!!on));
  handle('engine:setBypass', (on: boolean) => c.setBypass(!!on));
  handle('sound:experience', (id: string) => c.selectExperience(String(id)));
  handle('sound:edit', (patch: object) => c.editSound(patch ?? {}));
  handle('sound:reset', (section?: string) => c.resetSound(section as never));
  handle('sound:eqProfile', (id: string) => c.applyEqProfile(String(id)));
  handle('device:profile', (id: string | null, mode: 'auto' | 'manual' | 'none') => c.setDeviceProfile(id, mode));
  handle('device:channels', (cfg: 'auto' | '2.0' | '2.1' | '5.1' | '7.1') => c.setChannelConfig(cfg));
  handle('device:forget', (id: string) => c.forgetDevice(String(id)));
  handle('preset:save', (name: string) => c.savePreset(String(name ?? '')));
  handle('preset:rename', (id: string, name: string) => c.renamePreset(String(id), String(name ?? '')));
  handle('preset:overwrite', (id: string) => c.overwritePreset(String(id)));
  handle('preset:delete', (id: string) => c.deletePreset(String(id)));
  handle('preset:apply', (id: string) => c.applyPreset(String(id)));
  handle('settings:set', (patch: object) => c.setSettings(patch ?? {}));
  handle('eq:response', (freqs: number[], patch?: object, includeDevice?: boolean) =>
    c.getResponse(Array.isArray(freqs) ? freqs.slice(0, 1024).map(Number) : [], patch as never, includeDevice !== false),
  );
  handle('app:openPrivacy', () => {
    const url =
      process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture'
        : 'ms-settings:sound';
    return shell.openExternal(url);
  });
  handle('app:openSoundSettings', () =>
    process.platform === 'darwin'
      ? shell.openExternal('x-apple.systempreferences:com.apple.Sound-Settings.extension')
      : shell.openExternal('ms-settings:sound'),
  );
  handle('app:openLogs', () => (log.path ? shell.showItemInFolder(log.path) : undefined));
  handle('app:openExternal', (url: string) => {
    const allowed = ['https://github.com/', 'https://vb-audio.com/'];
    if (typeof url === 'string' && allowed.some((p) => url.startsWith(p))) return shell.openExternal(url);
    throw new Error('Blocked URL');
  });
  handle('app:showMain', () => {
    miniWindow?.hide();
    showMain();
  });
  handle('mini:hide', () => miniWindow?.hide());
  handle('app:quit', () => app.quit());
}

function broadcast(channel: string, payload: unknown) {
  for (const w of [mainWindow, miniWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function ensureAnalysisLoop() {
  const visible = [mainWindow, miniWindow].some((w) => w && !w.isDestroyed() && w.isVisible());
  const fps = controller?.currentSettings.visualizerFps ?? 60;
  if (analysisTimer) {
    clearInterval(analysisTimer);
    analysisTimer = null;
  }
  if (!visible || !controller) return;
  analysisTimer = setInterval(() => {
    if (!controller) return;
    try {
      const a = controller.getAnalysis(72);
      broadcast('analysis', { ...a, bands: 72 });
    } catch (err) {
      log.error('analysis failed', err);
    }
  }, Math.round(1000 / fps));
}

function applyLoginItem() {
  if (!controller || isDev) return;
  const s = controller.currentSettings;
  if (app.getLoginItemSettings().openAtLogin === s.launchAtLogin) return;
  app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] });
}

// ---------------------------------------------------------------- screenshots (README)
async function captureScreenshots(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  controller?.setProcessing(true);
  await wait(3500);
  const routes: Array<[string, string, 'dark' | 'light']> = [
    ['/', 'dashboard', 'dark'],
    ['/experiences', 'experiences', 'dark'],
    ['/equalizer', 'equalizer', 'dark'],
    ['/effects', 'effects', 'dark'],
    ['/devices', 'devices', 'dark'],
    ['/settings', 'settings', 'dark'],
    ['/', 'dashboard-light', 'light'],
    ['/equalizer', 'equalizer-light', 'light'],
  ];
  for (const [route, name, theme] of routes) {
    nativeTheme.themeSource = theme;
    mainWindow?.webContents.send('nav', route);
    await wait(1800);
    const img = await mainWindow!.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
    log.info(`captured ${name}`);
  }
  nativeTheme.themeSource = 'dark';
  if (!miniWindow) createMiniWindow();
  miniWindow!.setPosition(100, 100);
  miniWindow!.showInactive();
  await wait(2000);
  const mini = await miniWindow!.webContents.capturePage();
  fs.writeFileSync(path.join(dir, 'mini-player.png'), mini.toPNG());
  log.info('captured mini-player');
  controller?.setProcessing(false);
  app.quit();
}

// ---------------------------------------------------------------- self test
// Starts real system-wide processing, logs measured levels once per second and
// stops again. Used to verify an installation:  MinSoundFX --self-test 10
function runSelfTest(c: AudioController, seconds: number) {
  const r = c.setProcessing(true);
  log.info('SELFTEST start', { ok: r.ok, error: r.error, status: c.getState().status });
  let n = 0;
  const t = setInterval(() => {
    const a = c.getAnalysis(16);
    const st = c.getState().status;
    log.info('SELFTEST', {
      state: st.state,
      device: st.deviceName,
      fmt: `${st.inChannels}->${st.outChannels}ch@${st.sampleRate}`,
      latencyMs: +st.latencyMs.toFixed(1),
      inPeakDb: +(20 * Math.log10(a.meters.inPeak + 1e-9)).toFixed(1),
      outPeakDb: +(20 * Math.log10(Math.max(...a.meters.peaks, 1e-9))).toFixed(1),
      lufs: +a.meters.loudnessLufs.toFixed(1),
      cpu: +(a.meters.cpuLoad * 100).toFixed(2),
      frames: a.meters.framesProcessed,
    });
    if (++n >= seconds) {
      clearInterval(t);
      c.setProcessing(false);
      log.info('SELFTEST done');
      app.quit();
    }
  }, 1000);
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  if (args.includes('--restore-audio')) return;
  log.init(path.join(app.getPath('userData'), 'logs'));
  log.info(`MinSoundFX ${app.getVersion()} starting`, { platform: process.platform, arch: process.arch, electron: process.versions.electron });

  const store = new JsonStore<PersistedData>(path.join(app.getPath('userData'), 'minsoundfx.json'), emptyData(), (err) =>
    log.error('Settings store error', err),
  );
  try {
    native = loadNative();
  } catch (err) {
    log.error('Failed to load the native engine', err);
    throw err;
  }
  controller = new AudioController(native, store, app.getVersion());
  controller.on('state', (s) => broadcast('state', s));
  controller.on('settings-changed', (s) => {
    nativeTheme.themeSource = s.theme;
    applyLoginItem();
    ensureAnalysisLoop();
  });
  controller.on('device-switched', ({ name }) => {
    broadcast('toast', { kind: 'info', text: `Switched to ${name} — its saved sound profile is active.` });
    if (!mainWindow?.isVisible() && Notification.isSupported())
      new Notification({ title: 'MinSoundFX', body: `Now enhancing ${name}`, silent: true }).show();
  });
  registerIpc(controller);
  controller.init();
  nativeTheme.themeSource = controller.currentSettings.theme;
  nativeTheme.on('updated', () => broadcast('state', controller?.getState()));
  applyLoginItem();

  createTray();
  createMainWindow();
  if (captureDir) mainWindow?.webContents.once('did-finish-load', () => captureScreenshots(path.resolve(captureDir)));
  if (selfTestSeconds > 0) runSelfTest(controller, selfTestSeconds);
  if (process.platform === 'darwin' && (startHidden || controller.currentSettings.startHidden) && !captureDir) app.dock?.hide();
});

app.on('activate', () => showMain());

app.on('before-quit', () => {
  quitting = true;
  if (analysisTimer) clearInterval(analysisTimer);
  controller?.shutdown();
});

app.on('window-all-closed', () => {
  // Stay alive in the tray / menu bar.
});

// Make sure routing is restored on signals and unexpected errors too.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    controller?.shutdown();
    app.exit(0);
  });
}
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
  controller?.shutdown();
  app.exit(1);
});
