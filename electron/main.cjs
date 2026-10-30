/**
 * DiskLens 桌面版主进程
 * - 以 Node 模式拉起内置 HTTP 服务（复用原 server.mjs，零改动）
 * - 用原生窗口加载界面，不依赖浏览器
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const isDev = !app.isPackaged;
const APP_ROOT = isDev ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'app');
const SERVER_ENTRY = path.join(APP_ROOT, 'server.mjs');
const PORT = Number(process.env.DISKLENS_PORT || 7788);

let serverProc = null;
let mainWindow = null;
let quitting = false;

/* ---------- 等待端口就绪 ---------- */
function waitForServer(port, timeoutMs = 40000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.setTimeout(800);
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) return reject(new Error('本地服务启动超时'));
        setTimeout(attempt, 180);
      });
      sock.once('timeout', () => { sock.destroy(); });
    };
    attempt();
  });
}

/* ---------- 启动内置服务 ---------- */
async function startServer() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`找不到服务入口：${SERVER_ENTRY}`);
  }
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DISKLENS_PORT: String(PORT),
    // 数据放到用户目录，程序目录保持只读（装到 Program Files 也能跑）
    DISKLENS_DATA: path.join(app.getPath('userData'), 'data'),
    UV_THREADPOOL_SIZE: '16',
  };
  delete env.ELECTRON_RUN_AS_NODE_SAFE;

  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });

  serverProc.on('error', (e) => {
    if (!quitting) dialog.showErrorBox('无法启动本地服务', String(e));
  });

  serverProc.on('exit', (code) => {
    if (quitting) return;
    if (code !== 0) {
      dialog.showErrorBox('本地服务已退出', `退出码 ${code}\n如果端口 ${PORT} 已被占用，请关闭其他 DiskLens 实例后重试。`);
      app.quit();
    }
  });

  await waitForServer(PORT);
}

/* ---------- 主窗口 ---------- */
function createWindow() {
  const iconPath = path.join(APP_ROOT, 'build', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0a0d13',
    title: 'DiskLens · 磁盘空间分析器',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 窗口内不允许开新窗口；外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 禁止拖入文件导致导航到 file://
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`)) e.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------- 生命周期 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      await startServer();
      createWindow();
    } catch (e) {
      dialog.showErrorBox('DiskLens 启动失败', String(e?.message || e));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill(); } catch { /* ignore */ }
    }
  });

  app.on('will-quit', () => {
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill(); } catch { /* ignore */ }
    }
  });
}
