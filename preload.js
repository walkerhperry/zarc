const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zarc", {
  loadState: () => ipcRenderer.invoke("state:load"),
  saveState: (state) => ipcRenderer.invoke("state:save", state),
  guestPreload: () => ipcRenderer.invoke("app:guest-preload"),
  partition: () => ipcRenderer.invoke("app:partition"),
  versions: () => ipcRenderer.invoke("app:versions"),

  win: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
  },

  profile: {
    list: () => ipcRenderer.invoke("profile:list"),
    add: (name) => ipcRenderer.invoke("profile:add", name),
    rename: (id, name) => ipcRenderer.invoke("profile:rename", { id, name }),
    remove: (id) => ipcRenderer.invoke("profile:remove", id),
    switch: (id) => ipcRenderer.invoke("profile:switch", id),
  },

  ext: {
    add: (kind) => ipcRenderer.invoke("ext:add", kind),
    remove: (id) => ipcRenderer.invoke("ext:remove", id),
    loadSaved: (paths) => ipcRenderer.invoke("ext:load-saved", paths),
  },

  block: {
    apply: (opts) => ipcRenderer.invoke("block:apply", opts),
    stats: () => ipcRenderer.invoke("block:stats"),
    refresh: () => ipcRenderer.invoke("block:refresh"),
  },

  downloads: {
    list: () => ipcRenderer.invoke("download:list"),
    open: (id) => ipcRenderer.invoke("download:open", id),
    show: (id) => ipcRenderer.invoke("download:show", id),
    cancel: (id) => ipcRenderer.invoke("download:cancel", id),
    clear: () => ipcRenderer.invoke("download:clear"),
    folder: () => ipcRenderer.invoke("download:folder"),
  },

  data: {
    export: (payload) => ipcRenderer.invoke("data:export", payload),
    import: () => ipcRenderer.invoke("data:import"),
    browsers: () => ipcRenderer.invoke("data:browsers"),
    importBookmarks: (file) => ipcRenderer.invoke("data:import-bookmarks", file),
    exportBookmarks: (list) => ipcRenderer.invoke("data:export-bookmarks", list),
    clear: (what) => ipcRenderer.invoke("data:clear", what),
  },

  sync: {
    pickFolder: () => ipcRenderer.invoke("sync:pick-folder"),
    push: (cfg, payload) => ipcRenderer.invoke("sync:push", { cfg, payload }),
    pull: (cfg) => ipcRenderer.invoke("sync:pull", cfg),
  },

  update: {
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
  },

  openExternal: (href) => ipcRenderer.invoke("open-external", href),

  onMenu: (cb) => ipcRenderer.on("menu", (_e, cmd, arg) => cb(cmd, arg)),
  onOpenTab: (cb) => ipcRenderer.on("open-tab", (_e, href) => cb(href)),
  onWindowState: (cb) => ipcRenderer.on("window-state", (_e, max) => cb(max)),
  onDownloads: (cb) => ipcRenderer.on("downloads", (_e, list) => cb(list)),
  onDownloadDone: (cb) => ipcRenderer.on("download-done", (_e, meta) => cb(meta)),
  onBlocked: (cb) => ipcRenderer.on("blocked", (_e, stats) => cb(stats)),
  onBlockingReady: (cb) => ipcRenderer.on("blocking-ready", (_e, info) => cb(info)),
  onUpdateReady: (cb) => ipcRenderer.on("update-ready", (_e, version) => cb(version)),
});
