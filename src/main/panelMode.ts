import { app, BrowserWindow, shell } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Munder Panel: every `munder` command as a button (tools/munder/lib-panel.cjs
 * serves the page on 127.0.0.1). A process of its own, with its own userData
 * and single-instance lock, so it opens while Munder is closed, crashed or
 * running, and a second launch just brings the window forward.
 */
export function runPanel(): void {
  const tools = app.isPackaged ? join(process.resourcesPath, 'munder') : join(app.getAppPath(), 'tools', 'munder');
  // "Abrir Munder" relaunches THIS app without --panel. The AppImage path, not
  // the mounted binary, which disappears when the AppImage exits (and the
  // portable .exe's own path, not its temporary unpacked copy). A dev
  // checkout goes through `munder start` instead (MUNDER_PANEL_APP unset).
  if (app.isPackaged) process.env.MUNDER_PANEL_APP = process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setName('Munder Panel');
  app.setPath('userData', join(app.getPath('appData'), 'munder-panel'));

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let win: BrowserWindow | null = null;
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(() => {
    const P = createRequire(__filename)(join(tools, 'lib-panel.cjs'));
    const { server, url } = P.createPanelServer();
    server.listen(0, '127.0.0.1', () => {
      win = new BrowserWindow({
        width: 820, height: 920, minWidth: 420, minHeight: 500,
        title: 'Munder Panel', autoHideMenuBar: true, backgroundColor: '#FFFDF5',
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
      });
      // The page never leaves the panel: links open in the real browser.
      win.webContents.setWindowOpenHandler(({ url: u }) => { void shell.openExternal(u); return { action: 'deny' }; });
      win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(`http://127.0.0.1:${server.address().port}/`)) e.preventDefault(); });
      void win.loadURL(url());
      win.on('closed', () => { win = null; server.close(); });
    });
  });
}
