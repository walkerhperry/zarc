const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const url = require("node:url");
const crypto = require("node:crypto");

const GUEST_PRELOAD = url.pathToFileURL(path.join(__dirname, "guest.js")).toString();
const DEVICE = os.hostname().replace(/\.local$/, "");

let win = null;
let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  /* running unpackaged, or the dependency is absent */
}

/* ============================================================== profiles */

let profiles = { active: "default", list: [{ id: "default", name: "Personal", glyph: "◈" }] };

const profilesPath = () => path.join(app.getPath("userData"), "profiles.json");
const statePath = (id = profiles.active) => path.join(app.getPath("userData"), `state-${id}.json`);
const partitionFor = (id = profiles.active) => `persist:zarc-${id}`;
const ses = () => session.fromPartition(partitionFor());

async function loadProfiles() {
  try {
    const saved = JSON.parse(await fs.readFile(profilesPath(), "utf8"));
    if (saved && saved.list && saved.list.length) profiles = saved;
  } catch {
    /* first run */
  }
  // One-time move from the single-profile layout.
  const legacy = path.join(app.getPath("userData"), "state.json");
  if (fsSync.existsSync(legacy) && !fsSync.existsSync(statePath("default"))) {
    try {
      await fs.copyFile(legacy, statePath("default"));
    } catch {}
  }
  if (!profiles.list.some((p) => p.id === profiles.active)) profiles.active = profiles.list[0].id;
}

const saveProfiles = () => fs.writeFile(profilesPath(), JSON.stringify(profiles, null, 2), "utf8").catch(() => {});

/* ============================================================== blocking */

let blocker = null;
let engineKind = "none"; // ghostery | builtin | none
let blockingOn = true;
let allowlist = new Set();
let appliedExceptions = [];
const blockedSessions = new Set();
const counts = new Map();
let total = 0;
let flushTimer = null;

const BUILTIN_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
  "googletagservices.com", "googletagmanager.com", "adservice.google.com", "adnxs.com",
  "criteo.com", "criteo.net", "taboola.com", "outbrain.com", "scorecardresearch.com",
  "quantserve.com", "moatads.com", "rubiconproject.com", "pubmatic.com", "openx.net",
  "casalemedia.com", "smartadserver.com", "advertising.com", "adsrvr.org", "3lift.com",
  "sharethrough.com", "teads.tv", "amazon-adsystem.com", "connect.facebook.net", "hotjar.com",
  "mixpanel.com", "segment.io", "segment.com", "branch.io", "appsflyer.com", "adjust.com",
  "fullstory.com", "mouseflow.com", "crazyegg.com", "chartbeat.com", "nr-data.net", "clarity.ms",
];

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

function bump(request) {
  const host = (request && (request.sourceHostname || request.hostname)) || "unknown";
  counts.set(host, (counts.get(host) || 0) + 1);
  total++;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (win) win.webContents.send("blocked", { total, counts: Object.fromEntries(counts) });
  }, 400);
}

const isAllowed = (host) => {
  if (!host) return false;
  for (const d of allowlist) if (host === d || host.endsWith("." + d)) return true;
  return false;
};

function applyAllowlist() {
  if (engineKind !== "ghostery" || !blocker) return;
  const wanted = [...allowlist].flatMap((d) => [`@@||${d}^$document`, `@@||${d}^$ghide`]);
  const removed = appliedExceptions.filter((f) => !wanted.includes(f));
  const added = wanted.filter((f) => !appliedExceptions.includes(f));
  if (!added.length && !removed.length) return;
  try {
    blocker.updateFromDiff({ added, removed });
    appliedExceptions = wanted;
  } catch (err) {
    console.warn("Could not update the allowlist:", err.message);
  }
}

function builtinBlocking(target) {
  engineKind = "builtin";
  target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, done) => {
    if (!blockingOn) return done({ cancel: false });
    const from = hostOf(details.referrer || "");
    if (isAllowed(from)) return done({ cancel: false });
    const hit = BUILTIN_HOSTS.some((h) => details.url.includes(h));
    if (hit) bump({ sourceHostname: from, hostname: hostOf(details.url) });
    done({ cancel: hit });
  });
}

function blockIn(target) {
  if (blockedSessions.has(target)) return;
  blockedSessions.add(target);
  if (engineKind === "ghostery" && blocker && blockingOn) blocker.enableBlockingInSession(target);
  else if (engineKind === "builtin") builtinBlocking(target);
}

async function initBlocker(target) {
  try {
    const { ElectronBlocker } = require("@ghostery/adblocker-electron");
    const cache = path.join(app.getPath("userData"), "adblock-engine.bin");
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
      read: fs.readFile,
      write: fs.writeFile,
    });
    engineKind = "ghostery";
    blocker.on("request-blocked", bump);
    blocker.on("request-redirected", bump);
    blockedSessions.clear();
    blockIn(target);
    applyAllowlist();
  } catch (err) {
    console.warn("Filter lists unavailable, using the built-in list:", err.message);
    builtinBlocking(target);
    blockedSessions.add(target);
  }
  if (win) win.webContents.send("blocking-ready", { engine: engineKind });
}

async function refreshLists() {
  if (engineKind !== "ghostery") return { engine: engineKind, updated: false };
  try {
    const { ElectronBlocker } = require("@ghostery/adblocker-electron");
    const target = ses();
    blocker.disableBlockingInSession(target);
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
    blocker.on("request-blocked", bump);
    blocker.on("request-redirected", bump);
    appliedExceptions = [];
    blockedSessions.clear();
    blockIn(target);
    applyAllowlist();
    return { engine: engineKind, updated: true };
  } catch (err) {
    return { engine: engineKind, updated: false, error: err.message };
  }
}

/* ============================================================= downloads */

const downloads = new Map(); // id -> { meta, item }
let dlFlush = null;

function pushDownloads() {
  if (dlFlush) return;
  dlFlush = setTimeout(() => {
    dlFlush = null;
    if (win) win.webContents.send("downloads", [...downloads.values()].map((d) => d.meta));
  }, 250);
}

function watchDownloads(target) {
  target.on("will-download", (_e, item) => {
    const id = crypto.randomUUID();
    const meta = {
      id,
      name: item.getFilename(),
      url: item.getURL(),
      path: path.join(app.getPath("downloads"), item.getFilename()),
      total: item.getTotalBytes(),
      received: 0,
      state: "progressing",
      startedAt: Date.now(),
    };
    item.setSavePath(meta.path);
    downloads.set(id, { meta, item });
    pushDownloads();

    item.on("updated", (__e, st) => {
      meta.received = item.getReceivedBytes();
      meta.total = item.getTotalBytes();
      meta.state = st === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing";
      pushDownloads();
    });
    item.once("done", (__e, st) => {
      meta.state = st;
      meta.received = item.getReceivedBytes();
      meta.path = item.getSavePath();
      pushDownloads();
      if (win) win.webContents.send("download-done", meta);
    });
  });
}

/* --------------------------------------------------------------- session */

function setupSession() {
  const target = ses();
  const allowedPermissions = new Set([
    "fullscreen",
    "clipboard-sanitized-write",
    "media",
    "pointerLock",
    "display-capture",
  ]);
  target.setPermissionRequestHandler((_c, permission, done) => done(allowedPermissions.has(permission)));
  watchDownloads(target);
  return target;
}

/* -------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    frame: false,
    show: false,
    backgroundColor: "#efe6d4",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send("window-state", true));
  win.on("unmaximize", () => win.webContents.send("window-state", false));
  win.on("closed", () => (win = null));
}

/* ---------------------------------------------------------- extensions */

const extensionsDir = () => path.join(app.getPath("userData"), "extensions");

async function loadExtensions(paths) {
  const loaded = [];
  for (const p of paths) {
    try {
      const ext = await ses().loadExtension(p, { allowFileAccess: true });
      loaded.push({ id: ext.id, name: ext.name, version: ext.version, path: p });
    } catch (err) {
      console.warn("Could not load extension at", p, err.message);
    }
  }
  return loaded;
}

// .crx files are a zip with a signature header bolted on the front.
function stripCrx(buf) {
  if (buf.slice(0, 4).toString() !== "Cr24") return buf;
  const version = buf.readUInt32LE(4);
  if (version === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  const pub = buf.readUInt32LE(8);
  const sig = buf.readUInt32LE(12);
  return buf.subarray(16 + pub + sig);
}

async function unpackExtension(file) {
  const AdmZip = require("adm-zip");
  const raw = await fs.readFile(file);
  const zip = new AdmZip(stripCrx(raw));
  const name = path.basename(file).replace(/\.(crx|zip)$/i, "");
  const dest = path.join(extensionsDir(), `${name}-${crypto.randomBytes(3).toString("hex")}`);
  await fs.mkdir(dest, { recursive: true });
  zip.extractAllTo(dest, true);

  // Some packages wrap everything in one folder; find the manifest.
  if (!fsSync.existsSync(path.join(dest, "manifest.json"))) {
    const inner = (await fs.readdir(dest, { withFileTypes: true })).find((d) => d.isDirectory());
    if (inner && fsSync.existsSync(path.join(dest, inner.name, "manifest.json"))) return path.join(dest, inner.name);
  }
  return dest;
}

/* ---------------------------------------------------------- bookmark io */

function chromeProfiles() {
  const home = os.homedir();
  const mac = process.platform === "darwin";
  const win32 = process.platform === "win32";
  const localApp = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const appSupport = path.join(home, "Library", "Application Support");

  const candidates = [
    ["Chrome", mac ? [appSupport, "Google/Chrome"] : win32 ? [localApp, "Google/Chrome/User Data"] : [home, ".config/google-chrome"]],
    ["Brave", mac ? [appSupport, "BraveSoftware/Brave-Browser"] : win32 ? [localApp, "BraveSoftware/Brave-Browser/User Data"] : [home, ".config/BraveSoftware/Brave-Browser"]],
    ["Edge", mac ? [appSupport, "Microsoft Edge"] : win32 ? [localApp, "Microsoft/Edge/User Data"] : [home, ".config/microsoft-edge"]],
    ["Vivaldi", mac ? [appSupport, "Vivaldi"] : win32 ? [localApp, "Vivaldi/User Data"] : [home, ".config/vivaldi"]],
    ["Opera", mac ? [appSupport, "com.operasoftware.Opera"] : win32 ? [process.env.APPDATA || "", "Opera Software/Opera Stable"] : [home, ".config/opera"]],
    ["Arc", mac ? [appSupport, "Arc/User Data"] : null],
  ];

  const found = [];
  for (const [name, base] of candidates) {
    if (!base || !base[0]) continue;
    for (const profile of ["Default", "."]) {
      const file = path.join(base[0], base[1], profile, "Bookmarks");
      if (fsSync.existsSync(file)) {
        found.push({ name, file });
        break;
      }
    }
  }
  return found;
}

function parseChromeBookmarks(json) {
  const out = [];
  const walk = (node, folder) => {
    if (!node) return;
    if (node.type === "url" && node.url) out.push({ title: node.name || node.url, url: node.url, folder });
    (node.children || []).forEach((c) => walk(c, node.type === "folder" && node.name ? node.name : folder));
  };
  Object.values(json.roots || {}).forEach((r) => walk(r, ""));
  return out;
}

function parseNetscape(html) {
  const out = [];
  const re = /<(h3|a)\s?([^>]*)>([\s\S]*?)<\/\1>/gi;
  let folder = "";
  let m;
  while ((m = re.exec(html))) {
    const text = m[3].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    if (m[1].toLowerCase() === "h3") {
      folder = text;
      continue;
    }
    const href = (m[2].match(/href="([^"]+)"/i) || [])[1];
    if (href && /^https?:/i.test(href)) out.push({ title: text || href, url: href, folder });
  }
  return out;
}

async function readBookmarkFile(file) {
  const text = await fs.readFile(file, "utf8");
  if (/^\s*\{/.test(text)) {
    try {
      return parseChromeBookmarks(JSON.parse(text));
    } catch {
      return [];
    }
  }
  return parseNetscape(text);
}

function toNetscape(list) {
  const groups = new Map();
  (list || []).forEach((b) => {
    const k = b.folder || "Zarc";
    groups.set(k, (groups.get(k) || []).concat(b));
  });
  const body = [...groups.entries()]
    .map(
      ([folder, items]) =>
        `  <DT><H3>${String(folder).replace(/</g, "&lt;")}</H3>\n  <DL><p>\n` +
        items
          .map(
            (b) =>
              `    <DT><A HREF="${String(b.url).replace(/"/g, "&quot;")}">${String(b.title || b.url).replace(/</g, "&lt;")}</A>`
          )
          .join("\n") +
        `\n  </DL><p>`
    )
    .join("\n");
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${body}
</DL><p>
`;
}

/* ------------------------------------------------------------------ sync */

const syncFile = (folder) => path.join(folder, "zarc-sync.json");

async function syncPush(cfg, payload) {
  const body = { device: DEVICE, updatedAt: Date.now(), profile: profiles.active, data: payload };
  try {
    if (cfg.mode === "folder" && cfg.folder) {
      await fs.mkdir(cfg.folder, { recursive: true });
      await fs.writeFile(syncFile(cfg.folder), JSON.stringify(body, null, 2), "utf8");
      return { ok: true, at: body.updatedAt };
    }
    if (cfg.mode === "http" && cfg.url) {
      const res = await fetch(cfg.url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(cfg.token ? { authorization: "Bearer " + cfg.token } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      return { ok: true, at: body.updatedAt };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: "Sync is off" };
}

async function syncPull(cfg) {
  try {
    if (cfg.mode === "folder" && cfg.folder) {
      const text = await fs.readFile(syncFile(cfg.folder), "utf8");
      return { ok: true, body: JSON.parse(text) };
    }
    if (cfg.mode === "http" && cfg.url) {
      const res = await fetch(cfg.url, {
        headers: cfg.token ? { authorization: "Bearer " + cfg.token } : {},
      });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      return { ok: true, body: await res.json() };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: "Sync is off" };
}

/* ------------------------------------------------------------------ menu */

function buildMenu() {
  const send = (cmd, arg) => () => win && win.webContents.send("menu", cmd, arg);
  const mac = process.platform === "darwin";

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          { label: "New Tab", accelerator: "CmdOrCtrl+T", click: send("new-tab") },
          { label: "Open Location…", accelerator: "CmdOrCtrl+L", click: send("command-bar") },
          { label: "New Workflow", accelerator: "CmdOrCtrl+Shift+N", click: send("new-workflow") },
          { type: "separator" },
          { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: send("close-tab") },
          { label: "Pin Current Tab", accelerator: "CmdOrCtrl+D", click: send("pin") },
          { label: "Bookmark This Page", accelerator: "CmdOrCtrl+Shift+D", click: send("bookmark") },
          { type: "separator" },
          { label: "Downloads", accelerator: "CmdOrCtrl+Shift+J", click: send("downloads") },
          { label: "Bookmarks", accelerator: "CmdOrCtrl+Shift+O", click: send("bookmarks") },
          { label: "Import and Export…", accelerator: "CmdOrCtrl+Shift+I", click: send("data") },
          { type: "separator" },
          mac ? { role: "close" } : { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" }, { role: "redo" }, { type: "separator" },
          { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
          { type: "separator" },
          { label: "Find in Page…", accelerator: "CmdOrCtrl+F", click: send("find") },
          { label: "Find Next", accelerator: "CmdOrCtrl+G", click: send("find-next", 1) },
          { label: "Find Previous", accelerator: "CmdOrCtrl+Shift+G", click: send("find-next", -1) },
        ],
      },
      {
        label: "View",
        submenu: [
          { label: "Reload", accelerator: "CmdOrCtrl+R", click: send("reload") },
          { label: "Back", accelerator: mac ? "Cmd+[" : "Alt+Left", click: send("back") },
          { label: "Forward", accelerator: mac ? "Cmd+]" : "Alt+Right", click: send("forward") },
          { type: "separator" },
          { label: "Reader View", accelerator: "CmdOrCtrl+Shift+R", click: send("reader") },
          { label: "Picture in Picture", accelerator: "CmdOrCtrl+Shift+P", click: send("pip") },
          { label: "Glance at Hovered Link", accelerator: "CmdOrCtrl+Alt+G", click: send("glance") },
          { type: "separator" },
          { label: "Split View", accelerator: "CmdOrCtrl+\\", click: send("split") },
          { label: "Keep Sidebar Open", accelerator: "CmdOrCtrl+E", click: send("pin-sidebar") },
          { type: "separator" },
          { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: send("zoom", 1) },
          { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: send("zoom", -1) },
          { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: send("zoom", 0) },
          { type: "separator" },
          { label: "Blocking…", accelerator: "CmdOrCtrl+Shift+B", click: send("blocking") },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: send("prefs") },
          { label: "Developer Tools for Page", accelerator: "CmdOrCtrl+Alt+I", click: send("devtools") },
        ],
      },
      {
        label: "Workflow",
        submenu: [
          { label: "Next Workflow", accelerator: "CmdOrCtrl+Alt+Right", click: send("workflow-step", 1) },
          { label: "Previous Workflow", accelerator: "CmdOrCtrl+Alt+Left", click: send("workflow-step", -1) },
          { type: "separator" },
          ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
            label: `Workflow ${n}`,
            accelerator: `CmdOrCtrl+${n}`,
            click: send("workflow", n - 1),
          })),
        ],
      },
      {
        label: "Profile",
        submenu: [
          ...profiles.list.map((p, i) => ({
            label: p.name,
            type: "radio",
            checked: p.id === profiles.active,
            accelerator: i < 9 ? `CmdOrCtrl+Alt+${i + 1}` : undefined,
            click: () => switchProfile(p.id),
          })),
          { type: "separator" },
          { label: "Manage Profiles…", click: send("profiles") },
          { label: "Sync Now", accelerator: "CmdOrCtrl+Shift+S", click: send("sync-now") },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          { label: "What Came From Where", click: send("about") },
          { label: "Check for Updates…", click: send("update-check") },
          { label: "Zen Browser", click: () => shell.openExternal("https://zen-browser.app") },
        ],
      },
    ])
  );
}

async function switchProfile(id) {
  if (!profiles.list.some((p) => p.id === id) || id === profiles.active) return;
  profiles.active = id;
  await saveProfiles();
  setupSession();
  blockIn(ses());
  buildMenu();
  if (win) win.webContents.reload();
}

/* ------------------------------------------------------------------- ipc */

ipcMain.handle("state:load", async () => {
  try {
    return JSON.parse(await fs.readFile(statePath(), "utf8"));
  } catch {
    return null;
  }
});
ipcMain.handle("state:save", async (_e, state) => {
  try {
    await fs.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch (err) {
    console.warn("Could not save state:", err.message);
    return false;
  }
});

ipcMain.handle("app:guest-preload", () => GUEST_PRELOAD);
ipcMain.handle("app:partition", () => partitionFor());
ipcMain.handle("app:versions", () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  packaged: app.isPackaged,
  device: DEVICE,
}));

ipcMain.handle("window:minimize", () => win && win.minimize());
ipcMain.handle("window:maximize", () => {
  if (!win) return false;
  win.isMaximized() ? win.unmaximize() : win.maximize();
  return win.isMaximized();
});
ipcMain.handle("window:close", () => win && win.close());

/* profiles */
ipcMain.handle("profile:list", () => ({ active: profiles.active, list: profiles.list }));
ipcMain.handle("profile:add", async (_e, name) => {
  const id = "p" + crypto.randomBytes(4).toString("hex");
  const glyphs = ["◈", "❍", "◐", "✦", "▲", "✿", "⬟"];
  profiles.list.push({ id, name: name || "New profile", glyph: glyphs[profiles.list.length % glyphs.length] });
  await saveProfiles();
  buildMenu();
  return profiles;
});
ipcMain.handle("profile:rename", async (_e, { id, name }) => {
  const p = profiles.list.find((x) => x.id === id);
  if (p) p.name = name;
  await saveProfiles();
  buildMenu();
  return profiles;
});
ipcMain.handle("profile:remove", async (_e, id) => {
  if (profiles.list.length < 2) return { error: "The last profile cannot be removed." };
  profiles.list = profiles.list.filter((p) => p.id !== id);
  try {
    await fs.rm(statePath(id), { force: true });
    await session.fromPartition(partitionFor(id)).clearStorageData();
  } catch {}
  if (profiles.active === id) return switchProfile(profiles.list[0].id).then(() => profiles);
  await saveProfiles();
  buildMenu();
  return profiles;
});
ipcMain.handle("profile:switch", (_e, id) => switchProfile(id));

/* extensions */
ipcMain.handle("ext:add", async (_e, kind) => {
  const res = await dialog.showOpenDialog(win, {
    title: kind === "file" ? "Choose a packaged extension" : "Choose an unpacked extension folder",
    properties: [kind === "file" ? "openFile" : "openDirectory"],
    filters: kind === "file" ? [{ name: "Extension", extensions: ["crx", "zip"] }] : undefined,
  });
  if (res.canceled || !res.filePaths[0]) return null;
  let dir = res.filePaths[0];
  if (kind === "file") {
    try {
      dir = await unpackExtension(dir);
    } catch (err) {
      return { error: "Could not unpack that file: " + err.message };
    }
  }
  const [ext] = await loadExtensions([dir]);
  return ext || { error: "Electron would not load that extension." };
});
ipcMain.handle("ext:remove", (_e, id) => {
  try {
    ses().removeExtension(id);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle("ext:load-saved", async (_e, paths) => loadExtensions(paths || []));
ipcMain.handle("open-external", (_e, href) => shell.openExternal(href));

/* blocking */
ipcMain.handle("block:apply", (_e, { enabled, list }) => {
  allowlist = new Set(list || []);
  const was = blockingOn;
  blockingOn = enabled !== false;
  const target = ses();
  if (engineKind === "ghostery" && blocker) {
    if (blockingOn && !was) blocker.enableBlockingInSession(target);
    if (!blockingOn && was) blocker.disableBlockingInSession(target);
    applyAllowlist();
  }
  return { engine: engineKind, enabled: blockingOn, total };
});
ipcMain.handle("block:stats", () => ({ engine: engineKind, enabled: blockingOn, total, counts: Object.fromEntries(counts) }));
ipcMain.handle("block:refresh", () => refreshLists());

/* downloads */
ipcMain.handle("download:list", () => [...downloads.values()].map((d) => d.meta));
ipcMain.handle("download:open", (_e, id) => {
  const d = downloads.get(id);
  if (d && d.meta.state === "completed") shell.openPath(d.meta.path);
});
ipcMain.handle("download:show", (_e, id) => {
  const d = downloads.get(id);
  if (d) shell.showItemInFolder(d.meta.path);
});
ipcMain.handle("download:cancel", (_e, id) => {
  const d = downloads.get(id);
  if (d && d.item && d.meta.state === "progressing") d.item.cancel();
});
ipcMain.handle("download:clear", () => {
  [...downloads.entries()].forEach(([id, d]) => {
    if (d.meta.state !== "progressing") downloads.delete(id);
  });
  pushDownloads();
});
ipcMain.handle("download:folder", () => shell.openPath(app.getPath("downloads")));

/* data transfer */
ipcMain.handle("data:export", async (_e, payload) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: "Export everything",
    defaultPath: path.join(app.getPath("downloads"), `zarc-${stamp}.json`),
    filters: [{ name: "Zarc data", extensions: ["json"] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, JSON.stringify(payload, null, 2), "utf8");
  return res.filePath;
});
ipcMain.handle("data:import", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Open a Zarc export",
    properties: ["openFile"],
    filters: [{ name: "Zarc data", extensions: ["json"] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  try {
    return { path: res.filePaths[0], data: JSON.parse(await fs.readFile(res.filePaths[0], "utf8")) };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle("data:browsers", () => chromeProfiles());
ipcMain.handle("data:import-bookmarks", async (_e, file) => {
  let target = file;
  if (!target) {
    const res = await dialog.showOpenDialog(win, {
      title: "Import bookmarks",
      message: "A bookmarks HTML export, or a Chrome-family Bookmarks file",
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    target = res.filePaths[0];
  }
  try {
    return { from: path.basename(target), items: await readBookmarkFile(target) };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle("data:export-bookmarks", async (_e, list) => {
  const res = await dialog.showSaveDialog(win, {
    title: "Export bookmarks",
    defaultPath: path.join(app.getPath("downloads"), "zarc-bookmarks.html"),
    filters: [{ name: "Bookmarks", extensions: ["html"] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, toNetscape(list), "utf8");
  return res.filePath;
});
ipcMain.handle("data:clear", async (_e, what) => {
  const target = ses();
  if (what === "cookies") await target.clearStorageData({ storages: ["cookies"] });
  if (what === "cache") await target.clearCache();
  if (what === "everything") {
    await target.clearStorageData();
    await target.clearCache();
  }
  return true;
});

/* sync */
ipcMain.handle("sync:pick-folder", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Choose a sync folder",
    message: "Pick a folder that already syncs between your machines — iCloud Drive, Dropbox, Syncthing, anything",
    properties: ["openDirectory", "createDirectory"],
  });
  return res.canceled ? null : res.filePaths[0];
});
ipcMain.handle("sync:push", (_e, { cfg, payload }) => syncPush(cfg, payload));
ipcMain.handle("sync:pull", (_e, cfg) => syncPull(cfg));

/* updates */
ipcMain.handle("update:check", async () => {
  if (!autoUpdater || !app.isPackaged) return { supported: false, version: app.getVersion() };
  try {
    const res = await autoUpdater.checkForUpdates();
    return {
      supported: true,
      version: app.getVersion(),
      available: !!res && res.updateInfo.version !== app.getVersion(),
      latest: res && res.updateInfo.version,
    };
  } catch (err) {
    return { supported: true, error: err.message, version: app.getVersion() };
  }
});
ipcMain.handle("update:install", () => autoUpdater && autoUpdater.quitAndInstall());

/* ------------------------------------------------------------------ boot */

app.whenReady().then(async () => {
  await loadProfiles();
  const target = setupSession();
  buildMenu();
  createWindow();
  initBlocker(target);

  if (autoUpdater && app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", (info) => win && win.webContents.send("update-ready", info.version));
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  }

  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() !== "webview") return;
    contents.setWindowOpenHandler(({ url: href }) => {
      if (win && /^https?:/.test(href)) win.webContents.send("open-tab", href);
      return { action: "deny" };
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
