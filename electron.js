const { app, BrowserWindow, ipcMain, screen, dialog, shell, systemPreferences, safeStorage, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Native Windows AppBar interop (reserve desktop space). Loaded lazily/guarded
// so a non-Windows dev environment doesn't crash on the koffi/shell32 require.
let appbar = null;
try {
  if (process.platform === 'win32') appbar = require('./appbar');
} catch (e) {
  console.error('AppBar interop unavailable:', e.message);
}

let mainWindow;
let tray = null;
let quitting = false;
function showInbox(target) {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
  mainWindow.webContents.send('open-agent-inbox', target?.sessionKey ? { connectionId: target.connectionId, agentId: target.agentId, sessionKey: target.sessionKey } : null);
}
async function setupTray() {
  try {
    const iconPath = path.join(__dirname, 'public', 'icon.png');
    tray = new Tray(fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : await app.getFileIcon(process.execPath, { size: 'small' }));
    tray.setToolTip('FeedMe · réception des agents active');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Ouvrir les messages', click: () => showInbox() },
      { type: 'separator' },
      { label: 'Quitter FeedMe', click: () => app.quit() },
    ]));
    tray.on('double-click', () => showInbox());
  } catch { tray = null; }
}
let autoHide = false;
let isHidden = false;
let dockSide = 'right'; // 'left' or 'right'
let hiddenBounds = null; // saved bounds when visible
const PEEK_STRIP = 32; // pixels visible when hidden (hover zone + visual handle)
let mouseCheckInterval = null;
let boundsAnimation = null;

// --- Reserved-space (AppBar) mode ---
let reserveMode = false;      // true when FeedMe reserves an edge of the desktop
let appbarHwnd = null;        // HWND captured at enable (for safe removal)
let appbarRegistered = false; // whether ABM_NEW is currently active
let reserveWidthDip = 0;      // locked band width (DIP)
let lastDisplaySig = '';      // monitor bounds+scale signature (genuine-change detection)

function getWindowsAccentColor() {
  try {
    const raw = systemPreferences.getAccentColor();
    if (!raw) return null;
    const hex = String(raw).replace('#', '').trim();
    if (/^[0-9a-fA-F]{8}$/.test(hex)) return `#${hex.slice(0, 6)}`;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex}`;
  } catch (e) {
    return null;
  }
  return null;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function stopBoundsAnimation() {
  if (boundsAnimation) {
    clearInterval(boundsAnimation);
    boundsAnimation = null;
  }
}

function animateWindowBounds(targetBounds, onComplete) {
  if (!mainWindow) return;
  stopBoundsAnimation();

  const startBounds = mainWindow.getBounds();
  const duration = 280;
  const frameMs = 1000 / 60;
  const startedAt = Date.now();

  boundsAnimation = setInterval(() => {
    if (!mainWindow) {
      stopBoundsAnimation();
      return;
    }

    const elapsed = Date.now() - startedAt;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(progress);
    const nextBounds = {};

    for (const key of ['x', 'y', 'width', 'height']) {
      nextBounds[key] = Math.round(startBounds[key] + (targetBounds[key] - startBounds[key]) * eased);
    }

    mainWindow.setBounds(nextBounds);

    if (progress >= 1) {
      stopBoundsAnimation();
      mainWindow.setBounds(targetBounds);
      if (onComplete) onComplete();
    }
  }, frameMs);
}

// Get the display the window is currently on
function getCurrentDisplay() {
  if (!mainWindow) return screen.getPrimaryDisplay();
  const winBounds = mainWindow.getBounds();
  return screen.getDisplayNearestPoint({ x: winBounds.x + winBounds.width / 2, y: winBounds.y + winBounds.height / 2 });
}

function slideOut() {
  if (!mainWindow || isHidden || !autoHide) return;
  const bounds = mainWindow.getBounds();
  hiddenBounds = { ...bounds };
  const display = getCurrentDisplay();
  const wa = display.workArea;
  const targetBounds = dockSide === 'right'
    ? { x: wa.x + wa.width - PEEK_STRIP, y: bounds.y, width: bounds.width, height: bounds.height }
    : { x: wa.x - bounds.width + PEEK_STRIP, y: bounds.y, width: bounds.width, height: bounds.height };

  isHidden = true;
  mainWindow.webContents.send('dock-side-state', dockSide);
  animateWindowBounds(targetBounds, () => {
    if (!mainWindow || !autoHide || !isHidden) return;
    mainWindow.webContents.send('autohide-state', true);
  });
}

function slideIn() {
  if (!mainWindow || !isHidden || !hiddenBounds) return;
  const targetBounds = { ...hiddenBounds };
  isHidden = false;
  mainWindow.webContents.send('autohide-state', false);
  mainWindow.webContents.send('dock-side-state', dockSide);
  animateWindowBounds(targetBounds, () => {
    hiddenBounds = null;
  });
}

function startMouseTracking() {
  if (mouseCheckInterval) return;
  mouseCheckInterval = setInterval(() => {
    if (!mainWindow || !autoHide) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const display = getCurrentDisplay();
    const wa = display.workArea;

    if (isHidden) {
      // Check if mouse is near the edge where panel is docked
      let nearEdge = false;
      if (dockSide === 'right') {
        nearEdge = cursor.x >= wa.x + wa.width - 8 && cursor.y >= wa.y && cursor.y <= wa.y + wa.height;
      } else {
        nearEdge = cursor.x <= wa.x + 8 && cursor.y >= wa.y && cursor.y <= wa.y + wa.height;
      }
      if (nearEdge) slideIn();
    } else {
      // Check if mouse left the window area (with margin)
      const margin = 20;
      const outside = cursor.x < bounds.x - margin || cursor.x > bounds.x + bounds.width + margin ||
                      cursor.y < bounds.y - margin || cursor.y > bounds.y + bounds.height + margin;
      if (outside && !mainWindow.isFocused()) {
        slideOut();
      }
    }
  }, 150);
}

function stopMouseTracking() {
  if (mouseCheckInterval) {
    clearInterval(mouseCheckInterval);
    mouseCheckInterval = null;
  }
}

function displaySignature(d) {
  return `${d.id}:${d.bounds.width}x${d.bounds.height}:${d.scaleFactor}`;
}

// Position the window (DIP, via Electron) then reserve the equivalent physical
// band (Win32 ABM_SETPOS — reserves only, never moves the window).
//
// PRECONDITION: no active reservation. This matters because once *our own*
// reservation shrinks the monitor work area, Electron's DIP<->physical mapping
// shifts by the reserved width, so positioning is only correct on a clean work
// area. We therefore only ever reserve from clean (enableReserve); any layout
// change while anchored drops the anchor (disableReserve) rather than trying to
// reposition under an active reservation.
function reserveNow() {
  if (!mainWindow || !reserveMode || !appbar) return;
  const edge = dockSide === 'left' ? appbar.ABE_LEFT : appbar.ABE_RIGHT;
  const wa = getCurrentDisplay().workArea; // DIP, already excludes the taskbar
  const width = reserveWidthDip;

  const dipRect = {
    x: edge === appbar.ABE_LEFT ? wa.x : wa.x + wa.width - width,
    y: wa.y,
    width,
    height: wa.height,
  };
  mainWindow.setBounds(dipRect);

  const phys = screen.dipToScreenRect(mainWindow, dipRect);
  if (!appbarRegistered) {
    appbar.register(appbarHwnd);
    appbarRegistered = true;
  }
  appbar.setPos(appbarHwnd, edge, {
    left: phys.x,
    top: phys.y,
    right: phys.x + phys.width,
    bottom: phys.y + phys.height,
  });
  lastDisplaySig = displaySignature(getCurrentDisplay());
}

function enableReserve() {
  if (!mainWindow || reserveMode || !appbar) return false;
  // Auto-hide slides the window off-screen — incompatible with a reserved band.
  if (autoHide) {
    autoHide = false;
    isHidden = false;
    stopMouseTracking();
    stopBoundsAnimation();
    hiddenBounds = null;
    mainWindow.webContents.send('autohide-state', false);
  }
  mainWindow.unmaximize();
  reserveWidthDip = mainWindow.getBounds().width; // lock the band width
  appbarHwnd = appbar.hwndFromWindow(mainWindow);
  appbarRegistered = false;
  reserveMode = true;
  mainWindow.setAlwaysOnTop(true, 'floating');
  reserveNow(); // work area is clean here — safe to position directly
  mainWindow.webContents.send('reserve-state', true);
  return true;
}

function disableReserve() {
  if (!mainWindow || !appbar) return false;
  if (appbarRegistered) {
    appbar.remove(appbarHwnd);
    appbarRegistered = false;
  }
  appbarHwnd = null;
  reserveMode = false;
  mainWindow.setAlwaysOnTop(false);
  if (mainWindow.webContents) mainWindow.webContents.send('reserve-state', false);
  return false;
}

// Always release the reserved band on exit, or a dead zone stays on the desktop.
function cleanupAppbar() {
  if (appbar && appbarRegistered && appbarHwnd != null) {
    try { appbar.remove(appbarHwnd); } catch (e) { /* window already gone */ }
  }
  appbarRegistered = false;
  appbarHwnd = null;
}

function createWindow(port) {
  const actualPort = port || 3777;
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = Math.min(420, Math.round(screenW * 0.28));
  const winHeight = screenH;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: screenW - winWidth,
    y: 0,
    minWidth: 320,
    minHeight: 400,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    icon: fs.existsSync(path.join(__dirname, 'public', 'icon.png')) ? path.join(__dirname, 'public', 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${actualPort}`);
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('dock-side-state', dockSide);
    mainWindow.webContents.send('autohide-state', isHidden);
    mainWindow.webContents.send('reserve-state', reserveMode);
    mainWindow.webContents.send('accent-color-state', getWindowsAccentColor());
  });
  mainWindow.on('closed', () => {
    cleanupAppbar();
    mainWindow = null;
    stopMouseTracking();
  });
  mainWindow.on('close', event => {
    if (quitting || !tray) return;
    event.preventDefault();
    if (reserveMode) disableReserve(); else cleanupAppbar();
    stopMouseTracking(); stopBoundsAnimation();
    if (hiddenBounds) { mainWindow.setBounds(hiddenBounds); hiddenBounds = null; }
    autoHide = false; isHidden = false;
    mainWindow.webContents.send('autohide-state', false);
    mainWindow.hide();
  });

  // When window gets focus, make sure it's visible
  mainWindow.on('focus', () => {
    if (isHidden && autoHide) slideIn();
  });

  // Repositioning under an active reservation is unreliable (Electron's DIP
  // mapping shifts with the work area), so a GENUINE display change (resolution
  // / monitor / DPI) drops the anchor; the user re-enables it. Our own
  // reservation also fires display-metrics-changed — ignored via the bounds+
  // scale signature, which our reservation does not change.
  const reflow = () => {
    if (!reserveMode) return;
    if (displaySignature(getCurrentDisplay()) === lastDisplaySig) return;
    disableReserve();
  };
  screen.on('display-metrics-changed', reflow);
  screen.on('display-added', reflow);
  screen.on('display-removed', reflow);
}

if (systemPreferences.on) {
  systemPreferences.on('accent-color-changed', () => {
    if (mainWindow) mainWindow.webContents.send('accent-color-state', getWindowsAccentColor());
  });
}

// IPC handlers
ipcMain.handle('toggle-always-on-top', () => {
  if (!mainWindow) return false;
  const current = mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(!current, 'floating');
  return !current;
});

ipcMain.handle('get-always-on-top', () => {
  return mainWindow ? mainWindow.isAlwaysOnTop() : false;
});

ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  } else {
    mainWindow.maximize();
    return true;
  }
});

ipcMain.handle('dock-right', () => {
  if (!mainWindow) return;
  // Changing layout drops the anchor (re-positioning under a reservation is
  // unreliable); the user re-enables "Ancrer au bureau" on the new side.
  if (reserveMode) disableReserve();
  dockSide = 'right';
  isHidden = false;
  mainWindow.webContents.send('dock-side-state', dockSide);
  const display = getCurrentDisplay();
  const { x, y, width: screenW, height: screenH } = display.workArea;
  const winWidth = Math.min(420, Math.round(screenW * 0.28));
  mainWindow.unmaximize();
  mainWindow.setBounds({ x: x + screenW - winWidth, y, width: winWidth, height: screenH });
});

ipcMain.handle('dock-left', () => {
  if (!mainWindow) return;
  if (reserveMode) disableReserve();
  dockSide = 'left';
  isHidden = false;
  mainWindow.webContents.send('dock-side-state', dockSide);
  const display = getCurrentDisplay();
  const { x, y, width: screenW, height: screenH } = display.workArea;
  const winWidth = Math.min(420, Math.round(screenW * 0.28));
  mainWindow.unmaximize();
  mainWindow.setBounds({ x, y, width: winWidth, height: screenH });
});

ipcMain.handle('set-tablet-mode', () => {
  if (!mainWindow) return;
  // Tablet mode is a free-floating centered window — incompatible with both
  // auto-hide and the reserved band.
  if (reserveMode) disableReserve();
  autoHide = false;
  isHidden = false;
  stopMouseTracking();
  const display = getCurrentDisplay();
  const { x: dx, y: dy, width: screenW, height: screenH } = display.workArea;
  const w = Math.min(768, Math.round(screenW * 0.5));
  const h = Math.round(screenH * 0.85);
  mainWindow.unmaximize();
  mainWindow.setBounds({
    x: dx + Math.round((screenW - w) / 2),
    y: dy + Math.round((screenH - h) / 2),
    width: w,
    height: h,
  });
  return false; // auto-hide off
});

// Toggle auto-hide (slide in/out like taskbar)
ipcMain.handle('toggle-autohide', () => {
  autoHide = !autoHide;
  if (autoHide) {
    // Reserved band and auto-hide are mutually exclusive.
    if (reserveMode) disableReserve();
    // Need always-on-top for auto-hide to work well
    mainWindow.setAlwaysOnTop(true, 'floating');
    startMouseTracking();
  } else {
    isHidden = false;
    stopMouseTracking();
    stopBoundsAnimation();
    // Restore to visible position if hidden
    if (hiddenBounds) {
      mainWindow.setBounds(hiddenBounds);
      hiddenBounds = null;
    }
  }
  return autoHide;
});

ipcMain.handle('get-autohide', () => {
  return autoHide;
});

// Toggle reserved-space (AppBar) mode — desktop anchoring.
ipcMain.handle('toggle-reserve-space', () => {
  if (!appbar) return false; // interop unavailable (non-Windows)
  return reserveMode ? disableReserve() : enableReserve();
});

ipcMain.handle('get-reserve-space', () => {
  return reserveMode;
});

ipcMain.handle('get-accent-color', () => {
  return getWindowsAccentColor();
});

// Opens the Spotify consent / track pages in the default browser. Allow-listed
// so a compromised renderer can't turn this into a generic "launch anything".
// Liste blanche des domaines que l'application accepte d'ouvrir dans le
// navigateur. Tout le reste est refusé silencieusement : une URL qui viendrait
// d'un flux RSS ne doit pas pouvoir déclencher une ouverture arbitraire.
// Conséquence à ne pas oublier : ajouter un lien dans l'interface impose
// d'ajouter son hôte ici, sinon le clic ne fait rien.
const EXTERNAL_HOSTS = new Set([
  // Spotify
  'accounts.spotify.com', 'open.spotify.com', 'developer.spotify.com',
  // Moteurs de résumé — pages de création de clé API
  'console.anthropic.com', 'platform.claude.com',
  'console.groq.com',
  'aistudio.google.com',
  'openrouter.ai',
  'cloud.cerebras.ai',
  'console.mistral.ai',
  'ollama.com',
]);

function openAllowedUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (e) {
    return false;
  }
  if (url.protocol !== 'https:' || !EXTERNAL_HOSTS.has(url.hostname)) return false;
  shell.openExternal(url.href);
  return true;
}

ipcMain.handle('open-external', (_event, rawUrl) => openAllowedUrl(rawUrl));

// Launches the Spotify desktop app via its URI scheme, falling back to the web
// player when the protocol isn't registered (Spotify not installed).
ipcMain.handle('open-spotify', async (_event, uri, fallbackUrl) => {
  if (/^spotify:[A-Za-z0-9:._-]*$/.test(String(uri))) {
    try {
      await shell.openExternal(String(uri));
      return true;
    } catch (e) {
      // Protocole absent : on bascule sur le lecteur web ci-dessous.
    }
  }
  return openAllowedUrl(fallbackUrl);
});

app.whenReady().then(async () => {
  try {
    const isPackaged = app.isPackaged;
    let dataDir;
    if (isPackaged) {
      dataDir = path.join(app.getPath('userData'), 'FeedMe-data');
    } else {
      dataDir = __dirname;
    }
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    process.env.FEEDME_DATA_DIR = dataDir;
    app.setAppUserModelId('com.feedme.widget');
    await setupTray();
    global.feedmeAgentNotify = item => {
      if (!Notification.isSupported() || (mainWindow?.isVisible() && mainWindow.isFocused())) return;
      const notification = new Notification({
        title: `FeedMe · ${item.displayName || item.agentId}${item.count > 1 ? ' · ' + item.count + ' messages' : ''}`,
        body: item.content.slice(0, 200),
      });
      notification.on('click', () => showInbox(item));
      notification.show();
    };

    if (safeStorage.isEncryptionAvailable()) {
      global.feedmeAgentSecretStorage = {
        encrypt: value => safeStorage.encryptString(value).toString('base64'),
        decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
      };
    }

    // Start Express server and open the window on the real port it acquired.
    const server = require('./server.js');
    const port = await server.ready;
    createWindow(port);
  } catch (err) {
    dialog.showErrorBox('FeedMe - Erreur', err.message + '\n\n' + err.stack);
    app.quit();
  }
});

// Release any reserved desktop band before exit (prevents a dead zone).
app.on('before-quit', () => { quitting = true; cleanupAppbar(); });
app.on('will-quit', cleanupAppbar);

app.on('window-all-closed', () => app.quit());
