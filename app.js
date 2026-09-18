/* Zarc — browser chrome. The sidebar, workflows and glance come from the
   demo; every page here is a real <webview> owned by Electron.            */

const api = window.zarc;
const $ = (sel) => document.querySelector(sel);
const START = new URL("start.html", location.href).href;

const ENGINES = {
  duckduckgo: { name: "DuckDuckGo", q: (s) => "https://duckduckgo.com/?q=" + encodeURIComponent(s) },
  google: { name: "Google", q: (s) => "https://www.google.com/search?q=" + encodeURIComponent(s) },
  bing: { name: "Bing", q: (s) => "https://www.bing.com/search?q=" + encodeURIComponent(s) },
  kagi: { name: "Kagi", q: (s) => "https://kagi.com/search?q=" + encodeURIComponent(s) },
};

const THEMES = {
  slate: { name: "Slate", c: ["#3d5568", "#6d8ba0"] },
  ember: { name: "Ember", c: ["#8c3f52", "#c2764f"] },
  moss: { name: "Moss", c: ["#4e6135", "#8a9a4e"] },
  walnut: { name: "Walnut", c: ["#5a4632", "#9a7b4f"] },
  ink: { name: "Ink", c: ["#2c2a2e", "#5d5a60"] },
  indigo: { name: "Indigo", c: ["#3f3d73", "#7a74b0"] },
};

const SLIDE = 460;
const EASE = "cubic-bezier(.32,.72,0,1)";

let S = null; // persisted state
let guestPreload = null;
const views = new Map(); // tab id -> { wrap, wv, ready }
const ui = { split: false, splitId: null, focus: "left", wfOpen: false, hover: null, drag: null };

let seq = Date.now() % 1e6;
const uid = (p) => p + ++seq;

const block = { engine: "none", total: 0, counts: {} };
const find = { open: false, term: "", matches: 0, active: 0 };
let partition = "persist:zarc-default";
let downloadList = [];
let updateReady = null;
let versions = { app: "1.0.0", chrome: "", electron: "", packaged: false, device: "this machine" };
let profileInfo = { active: "default", list: [] };

const anyTab = (id) => S.workflows.flatMap((w) => w.tabs).find((t) => t.id === id);
const touch = (id) => {
  const t = anyTab(id);
  if (t) t.lastUsed = Date.now();
};

function pushBlocking() {
  api.block.apply({ enabled: S.settings.blocking !== false, list: S.settings.allowlist || [] });
}

function activeHost() {
  const t = tabById(cur().activeId);
  return t && t.url !== START ? hostOf(t.url) : "";
}

function allowed(host) {
  return (S.settings.allowlist || []).some((d) => host === d || host.endsWith("." + d));
}

function toggleAllowlist(host) {
  if (!host) return toast("Open a page first.");
  const list = new Set(S.settings.allowlist || []);
  list.has(host) ? list.delete(host) : list.add(host);
  S.settings.allowlist = [...list];
  pushBlocking();
  save();
  render();
  toast(list.has(host) ? "Ads allowed on " + host : "Blocking on " + host);
  const v = views.get(cur().activeId);
  if (v) v.wv.reload();
}

function paintShield() {
  const el = $("#shield");
  const host = activeHost();
  const n = block.counts[host] || 0;
  const off = !host || allowed(host) || S.settings.blocking === false;
  el.classList.toggle("off", off);
  el.textContent = off ? "⛡ off" : "⛡ " + n;
  el.title = off
    ? "Blocking is off here — click to switch it back on"
    : n + " requests stopped on " + (host || "this page") + " — click to allow ads here";
}

/* ------------------------------------------------------------- state */

function blankState() {
  const wf = (name, glyph, theme, urls, pins) => ({
    id: uid("w"),
    name,
    glyph,
    theme,
    custom: ["#3d5568", "#6d8ba0"],
    pins: pins.map((u) => ({ url: u, title: hostOf(u), icon: null })),
    tabs: urls.map((u) => ({ id: uid("t"), url: u, title: hostOf(u), icon: null })),
    activeId: null,
  });

  const state = {
    version: 1,
    current: 0,
    settings: {
      mode: "auto",
      engine: "duckduckgo",
      home: START,
      pinnedSidebar: false,
      hoverGlance: false,
      extensions: [],
      blocking: true,
      allowlist: [],
      discardAfter: 15,
      sync: { mode: "off", folder: "", url: "", token: "" },
    },
    history: [],
    bookmarks: [],
    workflows: [
      wf("Work", "◈", "slate", ["https://developer.mozilla.org/en-US/"], [
        "https://github.com",
        "https://developer.mozilla.org/en-US/",
        "https://mail.proton.me",
      ]),
      wf("Personal", "❍", "ember", ["https://news.ycombinator.com"], [
        "https://news.ycombinator.com",
        "https://en.wikipedia.org",
        "https://bandcamp.com",
      ]),
      wf("Research", "◐", "moss", [START], [
        "https://en.wikipedia.org",
        "https://arxiv.org",
        "https://scholar.google.com",
      ]),
    ],
  };
  state.workflows.forEach((w) => (w.activeId = w.tabs[0].id));
  return state;
}

let saveTimer;
let syncTimer;
function save() {
  S.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveState(S), 400);
  if (S.settings.sync && S.settings.sync.mode !== "off") {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(true), 8000);
  }
}

const cur = () => S.workflows[S.current];
const tabById = (id) => cur().tabs.find((t) => t.id === id);
const engine = () => ENGINES[S.settings.engine] || ENGINES.duckduckgo;

function hostOf(u) {
  try {
    if (u === START) return "New tab";
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

function looksLikeUrl(q) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return true;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(q)) return true;
  if (/\s/.test(q)) return false;
  return /^[^\s/]+\.[a-z]{2,}([/?#].*)?$/i.test(q);
}

function toUrl(input) {
  const q = input.trim();
  if (!q) return START;
  if (!looksLikeUrl(q)) return engine().q(q);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(q) ? q : "https://" + q;
}

/* -------------------------------------------------------------- views */

function view(tab) {
  if (views.has(tab.id)) return views.get(tab.id);

  const wrap = document.createElement("div");
  wrap.className = "wvwrap";

  const wv = document.createElement("webview");
  wv.setAttribute("src", tab.url);
  wv.setAttribute("partition", partition);
  wv.setAttribute("allowpopups", "");
  wv.setAttribute("webpreferences", "sandbox=no");
  if (guestPreload) wv.setAttribute("preload", guestPreload);

  wrap.appendChild(wv);
  $("#views").appendChild(wrap);

  const entry = { wrap, wv, ready: false };
  views.set(tab.id, entry);

  wv.addEventListener("dom-ready", () => {
    entry.ready = true;
    tab.discarded = false;
  });
  wv.addEventListener("found-in-page", (e) => {
    find.matches = e.result.matches;
    find.active = e.result.activeMatchOrdinal;
    paintFind();
  });
  wv.addEventListener("page-title-updated", (e) => {
    tab.title = e.title;
    render();
    save();
  });
  wv.addEventListener("page-favicon-updated", (e) => {
    tab.icon = e.favicons && e.favicons[0];
    render();
    save();
  });
  wv.addEventListener("did-start-loading", () => {
    tab.loading = true;
    render();
  });
  wv.addEventListener("did-stop-loading", () => {
    tab.loading = false;
    render();
  });
  const navigated = (e) => {
    if (e.isMainFrame === false) return;
    tab.url = e.url || wv.getURL();
    if (!tab.title || tab.title === "New tab") tab.title = hostOf(tab.url);
    remember(tab);
    render();
    save();
  };
  wv.addEventListener("did-navigate", navigated);
  wv.addEventListener("did-navigate-in-page", navigated);
  wv.addEventListener("did-fail-load", (e) => {
    if (e.errorCode === -3 || e.isMainFrame === false) return;
    tab.title = "Could not open " + hostOf(e.validatedURL || tab.url);
    render();
  });
  wv.addEventListener("ipc-message", (e) => {
    if (e.channel === "hover") {
      ui.hover = e.args[0];
      $("#hint").classList.toggle("show", !!ui.hover && !S.settings.hoverGlance && !document.querySelector(".veil"));
      clearTimeout(ui.hoverTimer);
      if (ui.hover && S.settings.hoverGlance) ui.hoverTimer = setTimeout(() => glance(ui.hover), 550);
    }
    if (e.channel === "glance" && e.args[0]) glance(e.args[0]);
    if (e.channel === "reader") {
      const r = e.args[0] || {};
      tab.reader = !!r.on;
      if (!r.ok) toast("No article to read on this page.");
      render();
    }
    if (e.channel === "pip") {
      const r = e.args[0] || {};
      if (!r.on && r.reason === "no-video") toast("No video on this page.");
      else if (!r.on && r.reason) toast("Picture in picture refused: " + r.reason);
    }
  });

  return entry;
}

function remember(tab) {
  if (!tab.url || tab.url === START) return;
  S.history = S.history.filter((h) => h.url !== tab.url);
  S.history.unshift({ url: tab.url, title: tab.title || hostOf(tab.url), at: Date.now() });
  if (S.history.length > 400) S.history.length = 400;
}

function layout() {
  const shown = new Set();
  const slots = [{ port: "#l-port", id: cur().activeId }];
  if (ui.split && ui.splitId) slots.push({ port: "#r-port", id: ui.splitId });

  for (const slot of slots) {
    const tab = tabById(slot.id);
    if (!tab) continue;
    const v = view(tab);
    const r = $(slot.port).getBoundingClientRect();
    Object.assign(v.wrap.style, {
      display: "block",
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
    shown.add(slot.id);
  }

  views.forEach((v, id) => {
    if (!shown.has(id)) v.wrap.style.display = "none";
  });
}

function activeView() {
  const id = ui.split && ui.focus === "right" ? ui.splitId : cur().activeId;
  const v = views.get(id);
  return v ? v.wv : null;
}

/* ------------------------------------------------------------ rendering */

function render() {
  const w = cur();
  const [a, b] = w.theme === "custom" ? w.custom : THEMES[w.theme].c;
  document.documentElement.style.setProperty("--accent", a);
  document.documentElement.style.setProperty("--accent-2", b);

  const wf = $("#wf");
  wf.classList.toggle("open", ui.wfOpen);
  wf.innerHTML =
    `<div class="wfhead" data-wftoggle role="button" tabindex="0"><span class="g">${w.glyph}</span>` +
    `<span class="n" data-wfname="${S.current}">${esc(w.name)}</span>` +
    `<span class="cnt">${w.tabs.length}</span><span class="c">▾</span></div>` +
    `<div class="wflist"><div>` +
    S.workflows
      .map((s, i) =>
        i === S.current
          ? ""
          : `<div class="wfrow" data-workflow="${i}" role="button" tabindex="0"><span class="g">${s.glyph}</span>` +
            `<span class="n" data-wfname="${i}">${esc(s.name)}</span><span class="cnt">${s.tabs.length}</span></div>`
      )
      .join("") +
    `<div class="wfrow wfnew" data-wfnew role="button" tabindex="0"><span class="g">＋</span><span class="n">New workflow</span></div>` +
    `</div></div>`;

  $("#pins").innerHTML =
    w.pins
      .map(
        (p, i) =>
          `<button class="pin" data-pin="${i}" title="${esc(p.title || hostOf(p.url))}">${icon(p, 18)}</button>`
      )
      .join("") + `<button class="pin" data-pinadd title="Pin the current tab">＋</button>`;

  $("#tabs").innerHTML =
    w.tabs
      .map((t) => {
        const cls = [
          t.id === w.activeId ? "on" : "",
          ui.split && t.id === ui.splitId ? "second" : "",
          t.loading ? "busy" : "",
          t.discarded && t.id !== w.activeId ? "sleeping" : "",
        ].join(" ");
        return (
          `<button class="tab ${cls}" data-tab="${t.id}">${icon(t, 15)}` +
          `<span class="t">${esc(t.title || hostOf(t.url))}</span>` +
          `<span class="x" data-close="${t.id}" title="Close tab">×</span></button>`
        );
      })
      .join("") + `<button class="newtabrow" data-newtab><span>＋</span>New tab</button>`;

  $("#dots").innerHTML = S.workflows
    .map((s, i) => `<button class="${i === S.current ? "on" : ""}" data-workflow="${i}" title="${esc(s.name)}"></button>`)
    .join("");

  head("l", tabById(w.activeId));
  head("r", ui.split ? tabById(ui.splitId) : null);
  $("#pane-r").hidden = !ui.split;
  $("#pane-l").classList.toggle("focus", ui.split && ui.focus === "left");
  $("#pane-r").classList.toggle("focus", ui.split && ui.focus === "right");

  touch(w.activeId);
  const act = tabById(w.activeId);
  $("#urlhost").textContent = act ? (act.url === START ? "Search or enter a site" : hostOf(act.url)) : "";

  paintShield();
  layout();
}

function head(side, tab) {
  const fav = $("#" + side + "-fav");
  if (tab && tab.icon) {
    fav.src = tab.icon;
    fav.hidden = false;
  } else {
    fav.hidden = true;
  }
  $("#" + side + "-title").textContent = tab ? tab.title || hostOf(tab.url) : "";
  $("#" + side + "-url").textContent = tab && tab.url !== START ? hostOf(tab.url) : "";
  $("#" + side + "-load").classList.toggle("on", !!(tab && tab.loading));
  if (side === "l") {
    const rb = document.querySelector('[data-act="reader"]');
    if (rb) rb.classList.toggle("on", !!(tab && tab.reader));
  }

  const v = tab && views.get(tab.id);
  const pane = $("#pane-" + side);
  const back = pane.querySelector('[data-nav="back"]');
  const fwd = pane.querySelector('[data-nav="forward"]');
  try {
    back.disabled = !(v && v.ready && v.wv.canGoBack());
    fwd.disabled = !(v && v.ready && v.wv.canGoForward());
  } catch {
    back.disabled = fwd.disabled = true;
  }
}

function icon(t, size) {
  return t.icon
    ? `<img class="fav" src="${esc(t.icon)}" alt="" style="width:${size}px;height:${size}px">`
    : `<span class="ico">◍</span>`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* --------------------------------------------------------------- tabs */

function newTab(href, { background = false } = {}) {
  const w = cur();
  const tab = { id: uid("t"), url: href || S.settings.home || START, title: "New tab", icon: null };
  w.tabs.push(tab);
  if (!background) {
    if (ui.split && ui.focus === "right") ui.splitId = tab.id;
    else w.activeId = tab.id;
  }
  render();
  save();
  return tab;
}

function focusTab(id) {
  touch(id);
  if (ui.split && ui.focus === "right") ui.splitId = id;
  else cur().activeId = id;
  render();
  save();
}

function closeTab(id) {
  const w = cur();
  const i = w.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const v = views.get(id);
  if (v) {
    v.wrap.remove();
    views.delete(id);
  }
  w.tabs.splice(i, 1);
  if (!w.tabs.length) newTab();
  if (w.activeId === id) w.activeId = (w.tabs[Math.max(0, i - 1)] || w.tabs[0]).id;
  if (ui.splitId === id) {
    const other = w.tabs.find((t) => t.id !== w.activeId);
    if (other) ui.splitId = other.id;
    else ui.split = false;
  }
  render();
  save();
}

function openOrFocus(href) {
  const hit = cur().tabs.find((t) => t.url === href);
  if (hit) return focusTab(hit.id);
  newTab(href);
}

function navigate(input) {
  const href = toUrl(input);
  const wv = activeView();
  if (!wv) return newTab(href);
  wv.loadURL(href);
}

function tidy() {
  const w = cur();
  const keep = new Set([w.activeId, ui.split ? ui.splitId : null]);
  const going = w.tabs.filter((t) => !keep.has(t.id));
  if (!going.length) return toast("Nothing to tidy — this workflow is already clear.");
  going.forEach((t) => {
    const v = views.get(t.id);
    if (v) {
      v.wrap.remove();
      views.delete(t.id);
    }
  });
  w.tabs = w.tabs.filter((t) => keep.has(t.id));
  render();
  save();
  toast(going.length + (going.length === 1 ? " tab closed — find it again in history" : " tabs closed — find them again in history"));
}

/* ------------------------------------------------------------ pinning */

function pinCurrent() {
  const tab = tabById(cur().activeId);
  if (!tab || tab.url === START) return toast("Open a page first.");
  if (cur().pins.some((p) => p.url === tab.url)) return toast("Already in essentials.");
  cur().pins.push({ url: tab.url, title: tab.title, icon: tab.icon });
  render();
  save();
  toast("Pinned to essentials");
}

/* -------------------------------------------------------------- split */

function toggleSplit() {
  const w = cur();
  if (ui.split) {
    ui.split = false;
    ui.focus = "left";
    render();
    return;
  }
  if (w.tabs.length < 2) return toast("Open a second tab first.");
  ui.split = true;
  ui.splitId = w.tabs.find((t) => t.id !== w.activeId).id;
  ui.focus = "right";
  render();
}

function swapSides() {
  const w = cur();
  const a = w.activeId;
  w.activeId = ui.splitId;
  ui.splitId = a;
  render();
}

/* ------------------------------------------------------------- glance */

function glance(href) {
  if (!href || document.querySelector(".veil")) return;
  $("#hint").classList.remove("show");

  const v = document.createElement("div");
  v.className = "veil";
  v.id = "glance";
  v.innerHTML = `<div class="glancebox">
    <header class="panehead"><span class="u">${esc(hostOf(href))}</span><span class="sp"></span>
      <button class="btn" data-keep>Keep as tab</button>
      <button class="iconbtn" data-x title="Close">✕</button></header>
    <div class="view" id="glanceview"></div></div>`;
  document.body.appendChild(v);

  const wv = document.createElement("webview");
  wv.setAttribute("src", href);
  wv.setAttribute("partition", partition);
  v.querySelector("#glanceview").appendChild(wv);

  v.addEventListener("click", (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();
    if (e.target.closest("[data-keep]")) {
      v.remove();
      newTab(href);
      toast("Kept as a tab");
    }
  });
}

/* -------------------------------------------------------- workflows */

async function setWorkflow(i, { animate = true } = {}) {
  if (i === S.current || !S.workflows[i]) {
    ui.wfOpen = false;
    return render();
  }
  const dir = i > S.current ? 1 : -1;
  const stage = $("#stage");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let ghost = null;

  stage.querySelectorAll(".ghost").forEach((g) => g.remove());

  if (animate && !reduce) {
    const shots = [];
    for (const slot of [cur().activeId, ui.split ? ui.splitId : null]) {
      if (!slot) continue;
      const v = views.get(slot);
      if (!v || !v.ready) continue;
      try {
        const img = await Promise.race([
          v.wv.capturePage(),
          new Promise((res) => setTimeout(() => res(null), 220)),
        ]);
        if (img) shots.push(img.toDataURL());
      } catch {
        /* a page that will not be captured just switches without the slide */
      }
    }
    if (shots.length) {
      ghost = document.createElement("div");
      ghost.className = "ghost";
      ghost.innerHTML = shots.map((src) => `<div class="shot"><img src="${src}" alt=""></div>`).join("");
      stage.appendChild(ghost);
    }
  }

  S.current = i;
  ui.split = false;
  ui.splitId = null;
  ui.wfOpen = false;
  render();
  save();

  if (ghost) slide(stage, ghost, dir);
  toast(cur().name);
}

function slide(stage, ghost, dir) {
  const w = stage.getBoundingClientRect().width + 12;
  const opts = { duration: SLIDE, easing: EASE };

  views.forEach((v) => {
    if (v.wrap.style.display === "none") return;
    v.wrap.animate([{ transform: `translateX(${dir * w}px)` }, { transform: "translateX(0)" }], opts);
  });
  stage.querySelectorAll(".pane:not([hidden])").forEach((p) =>
    p.animate([{ transform: `translateX(${dir * w}px)` }, { transform: "translateX(0)" }], opts)
  );

  const out = ghost.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-dir * w}px)` }], opts);
  const done = () => ghost.remove();
  out.onfinish = done;
  out.oncancel = done;

  ["#wf", "#pins", "#tabs"].forEach((sel, k) => {
    const el = $(sel);
    if (el)
      el.animate([{ transform: `translateX(${dir * 20}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], {
        duration: SLIDE * 0.75,
        delay: k * 24,
        easing: EASE,
        fill: "backwards",
      });
  });
}

function stepWorkflow(dir) {
  setWorkflow((S.current + dir + S.workflows.length) % S.workflows.length);
}

function newWorkflow() {
  const glyphs = ["✦", "▲", "✿", "⬟", "❖", "✚"];
  const keys = Object.keys(THEMES);
  const i = S.workflows.length;
  S.workflows.push({
    id: uid("w"),
    name: "New workflow",
    glyph: glyphs[i % glyphs.length],
    theme: keys[i % keys.length],
    custom: ["#3d5568", "#6d8ba0"],
    pins: [],
    tabs: [{ id: uid("t"), url: START, title: "New tab", icon: null }],
    activeId: null,
  });
  const w = S.workflows[i];
  w.activeId = w.tabs[0].id;
  S.current = i;
  ui.split = false;
  ui.splitId = null;
  ui.wfOpen = true;
  render();
  save();
  const el = document.querySelector('[data-wfname="' + i + '"]');
  if (el) editName(el);
  toast("Workflow added — type a name");
}

function editName(el) {
  el.contentEditable = "true";
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------------------------------------------------------- command bar */

function commandBar(prefill) {
  if (document.querySelector("#cmd")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "cmd";
  v.innerHTML = `<div class="cmdbox"><input placeholder="Search, enter a site, or switch to a tab" spellcheck="false"><ul class="cmdlist"></ul></div>`;
  document.body.appendChild(v);

  const input = v.querySelector("input");
  const list = v.querySelector(".cmdlist");
  let items = [];
  let sel = 0;

  function build(q) {
    const query = q.trim().toLowerCase();
    items = [];

    if (query) {
      const url = looksLikeUrl(q.trim());
      items.push({
        label: (url ? "→  Go to " : "⌕  Search " + engine().name + " for ") + q.trim(),
        sub: "Enter",
        run: () => navigate(q),
      });
    }

    cur().tabs.forEach((t) => {
      const hay = (t.title + " " + t.url).toLowerCase();
      if (!query || hay.includes(query))
        items.push({ label: "▤  " + (t.title || hostOf(t.url)), sub: "Switch to tab", run: () => focusTab(t.id) });
    });

    if (query)
      S.history
        .filter((h) => (h.title + " " + h.url).toLowerCase().includes(query))
        .slice(0, 6)
        .forEach((h) => items.push({ label: "↻  " + (h.title || hostOf(h.url)), sub: hostOf(h.url), run: () => openOrFocus(h.url) }));

    if (query)
      (S.bookmarks || [])
        .filter((b) => (b.title + " " + b.url).toLowerCase().includes(query))
        .slice(0, 6)
        .forEach((b) => items.push({ label: "★  " + b.title, sub: hostOf(b.url), run: () => openOrFocus(b.url) }));

    S.workflows.forEach((w, i) => {
      if (query && w.name.toLowerCase().includes(query))
        items.push({ label: w.glyph + "  " + w.name, sub: "Switch workflow", run: () => setWorkflow(i) });
    });

    if (!query) {
      items.push({ label: "◫  Split the view", sub: "⌘\\", run: toggleSplit });
      items.push({ label: "⚙  Settings", sub: "⌘,", run: prefs });
      items.push({ label: "⌕  Find in page", sub: "⌘F", run: () => openFind() });
      items.push({ label: "¶  Reader view", sub: "⌘⇧R", run: () => sendToPage("zarc-reader") });
      items.push({ label: "⤓  Downloads", sub: "⌘⇧J", run: downloadsPanel });
      items.push({ label: "★  Bookmarks", sub: "⌘⇧O", run: bookmarksPanel });
      items.push({ label: "◈  Profiles", sub: "", run: profilesPanel });
      items.push({ label: "⛡  Blocking", sub: "⌘⇧B", run: blocking });
      items.push({ label: "⇄  Import and export", sub: "⌘⇧I", run: dataSheet });
      items.push({ label: "⟳  Sync now", sub: "⌘⇧S", run: () => syncNow(false) });
      items.push({ label: "⧉  Extensions", sub: "", run: extensions });
      items.push({ label: "⌫  Tidy this workflow", sub: "", run: tidy });
    }

    sel = 0;
    draw();
  }

  function draw() {
    list.innerHTML = items
      .map((it, i) => `<li class="${i === sel ? "sel" : ""}" data-i="${i}">${esc(it.label)}<span class="sub">${esc(it.sub)}</span></li>`)
      .join("");
  }

  function go(i) {
    const it = items[i];
    if (!it) return;
    v.remove();
    it.run();
  }

  input.addEventListener("input", () => build(input.value));
  v.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(items.length - 1, sel + 1);
      draw();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
      draw();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      go(sel);
    }
    if (e.key === "Escape") v.remove();
  });
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (li) go(+li.dataset.i);
  });
  v.addEventListener("click", (e) => {
    if (e.target === v) v.remove();
  });

  build(prefill || "");
  input.value = prefill || "";
  setTimeout(() => input.focus(), 30);
}

/* ------------------------------------------------------------ settings */

function themeMode() {
  return S.settings.mode || "auto";
}

function applyMode() {
  const m = themeMode();
  if (m === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", m);
}

function prefs() {
  if (document.querySelector("#prefs")) return;
  const w = cur();
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "prefs";
  v.innerHTML = `<div class="sheetbox">
    <h2>Settings</h2>
    <p class="lede">Colour belongs to the workflow you are in. Everything else is browser-wide.</p>

    <h3>Paper</h3>
    <div class="segs">
      ${["light", "dark", "auto"]
        .map(
          (m) =>
            `<button class="seg ${themeMode() === m ? "on" : ""}" data-mode="${m}">${
              m === "light" ? "Cream" : m === "dark" ? "Espresso" : "Match system"
            }</button>`
        )
        .join("")}
    </div>

    <h3>Colour for ${esc(w.name)}</h3>
    <div class="swatches">
      ${Object.entries(THEMES)
        .map(
          ([k, t]) =>
            `<button class="sw ${w.theme === k ? "on" : ""}" data-theme="${k}"><i style="background:linear-gradient(120deg,${t.c[0]},${t.c[1]})"></i>${t.name}</button>`
        )
        .join("")}
    </div>
    <div class="custom ${w.theme === "custom" ? "on" : ""}" id="customrow">
      <input type="color" class="cin" data-c1 value="${w.custom[0]}" title="Base colour">
      <input type="color" class="cin" data-c2 value="${w.custom[1]}" title="Where the gradient lands">
      <span class="m">Any colour you like<span>Pick a base and the blend follows, or set both by hand.</span></span>
    </div>

    <h3>Browsing</h3>
    <div class="field">
      <span class="m">Search engine<span>Used whenever what you type is not a web address.</span></span>
      <select data-engine>
        ${Object.entries(ENGINES)
          .map(([k, e]) => `<option value="${k}" ${S.settings.engine === k ? "selected" : ""}>${e.name}</option>`)
          .join("")}
      </select>
    </div>
    <div class="field">
      <span class="m">New tabs open<span>A web address, or leave it for the start page.</span></span>
      <input type="text" data-home value="${esc(S.settings.home === START ? "" : S.settings.home)}" placeholder="Start page">
    </div>
    <div class="field">
      <span class="m">Keep the sidebar open<span>Off, it hides and returns when you reach for the left edge.</span></span>
      <button class="sw-toggle ${S.settings.pinnedSidebar ? "on" : ""}" data-pin-toggle></button>
    </div>
    <div class="field">
      <span class="m">Hover glance<span>Preview a link by resting on it instead of pressing G.</span></span>
      <button class="sw-toggle ${S.settings.hoverGlance ? "on" : ""}" data-hover-toggle></button>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn" data-system>Sync and memory</button>
      <button class="btn" data-blocking>Blocking</button>
      <button class="btn" data-data>Import and export</button>
      <button class="btn" data-exts>Extensions</button>
      <button class="btn primary" data-x>Done</button>
    </div></div>`;
  document.body.appendChild(v);

  v.addEventListener("click", (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();
    if (e.target.closest("[data-exts]")) { v.remove(); return extensions(); }
    if (e.target.closest("[data-blocking]")) { v.remove(); return blocking(); }
    if (e.target.closest("[data-system]")) { v.remove(); return systemPanel(); }
    if (e.target.closest("[data-data]")) { v.remove(); return dataSheet(); }
    const mode = e.target.closest("[data-mode]");
    if (mode) {
      S.settings.mode = mode.dataset.mode;
      applyMode();
      save();
      v.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b === mode));
      return;
    }
    const th = e.target.closest("[data-theme]");
    if (th) {
      cur().theme = th.dataset.theme;
      v.querySelectorAll("[data-theme]").forEach((b) => b.classList.toggle("on", b === th));
      v.querySelector("#customrow").classList.remove("on");
      render();
      save();
      return;
    }
    if (e.target.closest("[data-pin-toggle]")) {
      S.settings.pinnedSidebar = !S.settings.pinnedSidebar;
      document.body.classList.toggle("pinned", S.settings.pinnedSidebar);
      e.target.closest("[data-pin-toggle]").classList.toggle("on", S.settings.pinnedSidebar);
      $("#side").classList.remove("peek");
      layout();
      save();
      return;
    }
    if (e.target.closest("[data-hover-toggle]")) {
      S.settings.hoverGlance = !S.settings.hoverGlance;
      e.target.closest("[data-hover-toggle]").classList.toggle("on", S.settings.hoverGlance);
      save();
    }
  });

  v.addEventListener("input", (e) => {
    const c1 = v.querySelector("[data-c1]");
    const c2 = v.querySelector("[data-c2]");
    if (e.target === c1 || e.target === c2) {
      if (e.target === c1) c2.value = blendOf(c1.value);
      cur().theme = "custom";
      cur().custom = [c1.value, c2.value];
      v.querySelectorAll("[data-theme]").forEach((b) => b.classList.remove("on"));
      v.querySelector("#customrow").classList.add("on");
      render();
      save();
      return;
    }
    if (e.target.matches("[data-engine]")) {
      S.settings.engine = e.target.value;
      save();
    }
    if (e.target.matches("[data-home]")) {
      const val = e.target.value.trim();
      S.settings.home = val ? toUrl(val) : START;
      save();
    }
  });
}

async function extensions() {
  if (document.querySelector("#exts")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "exts";
  v.innerHTML = `<div class="sheetbox">
    <h2>Extensions</h2>
    <p class="lede">Zarc loads unpacked Chrome extensions — the folder with the manifest in it. Electron supports a subset of the extension APIs, so content-script and storage extensions usually work while ones that lean on Chrome's own UI may not.</p>
    <div class="extlist" id="extlist"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn" data-add-file>Install .crx or .zip…</button>
      <button class="btn" data-add>Load unpacked…</button>
      <button class="btn primary" data-x>Done</button>
    </div></div>`;
  document.body.appendChild(v);

  const draw = () => {
    const list = S.settings.extensions;
    $("#extlist").innerHTML = list.length
      ? list
          .map(
            (x) => `<div class="ext"><span class="g">⧉</span>
        <span class="m">${esc(x.name)} <span>${esc(x.path)}</span></span>
        <button class="btn" data-rm="${esc(x.id)}">Remove</button></div>`
          )
          .join("")
      : `<p class="empty">Nothing loaded yet.</p>`;
  };
  draw();

  v.addEventListener("click", async (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();
    if (e.target.closest("[data-add]") || e.target.closest("[data-add-file]")) {
      const ext = await api.ext.add(e.target.closest("[data-add-file]") ? "file" : "folder");
      if (!ext) return;
      if (ext.error) return toast(ext.error);
      S.settings.extensions = S.settings.extensions.filter((x) => x.id !== ext.id).concat(ext);
      save();
      draw();
      toast(ext.name + " loaded — reload a page to see it work");
      return;
    }
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      await api.ext.remove(rm.dataset.rm);
      S.settings.extensions = S.settings.extensions.filter((x) => x.id !== rm.dataset.rm);
      save();
      draw();
    }
  });
}

/* ------------------------------------------------------------ the mark */

const ORIGINS = [
  ["arc", "Workflows with their own colour", "Each one tints the whole window, so you can see which life you are in."],
  ["both", "Vertical tabs in a sidebar", "Here the sidebar is gone until you reach for the left edge."],
  ["zen", "One workflow switcher, folded shut", "The list stays closed until you ask for it, and the dots say where you are."],
  ["arc", "Essentials above the line", "Pinned sites stay put; loose tabs come and go."],
  ["arc", "The command bar", "One field for addresses, searches, tabs and history. No permanent address bar."],
  ["zen", "Glance", "Hover a link, press G, read it in a floating window. It only becomes a tab if you say so."],
  ["both", "Split view", "Two live pages side by side, filled from the same tab list."],
  ["both", "Themes and extensions", "Zen calls them mods, Arc calls them boosts. Both live behind the mark."],
];

function sheet() {
  if (document.querySelector("#sheet")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "sheet";
  v.innerHTML = `<div class="sheetbox">
    <h2>What came from where</h2>
    <p class="lede">Zarc is a real browser built on Electron's Chromium. The ideas are borrowed; the rendering is not.</p>
    <dl class="origin">${ORIGINS.map(
      ([k, t, d]) =>
        `<dt class="${k}">${k === "both" ? "Both" : k === "zen" ? "Zen" : "Arc"}</dt><dd><b>${t}</b><span>${d}</span></dd>`
    ).join("")}</dl>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn primary" data-x>Close</button></div></div>`;
  document.body.appendChild(v);
  v.addEventListener("click", (e) => {
    if (e.target === v || e.target.closest("[data-x]")) v.remove();
  });
}

function markMenu() {
  if (closeMenu()) return;
  const m = document.createElement("div");
  m.className = "menu";
  m.id = "menu";
  m.innerHTML = [
    ["prefs", "◐", "Appearance and colour", "⌘,"],
    ["exts", "⧉", "Extensions", ""],
    ["blocking", "⛡", "Blocking", "⌘⇧B"],
    ["bookmarks", "★", "Bookmarks", "⌘⇧O"],
    ["downloads", "⤓", "Downloads", "⌘⇧J"],
    ["profiles", "◈", "Profiles", ""],
    ["data", "⇄", "Import and export", "⌘⇧I"],
    ["hr"],
    ["split", "◫", ui.split ? "Close split" : "Split the view", "⌘\\"],
    ["pin", "✧", "Pin this tab", "⌘D"],
    ["tidy", "⌫", "Tidy loose tabs", ""],
    ["hr"],
    ["about", "?", "What came from where", ""],
  ]
    .map((r) =>
      r[0] === "hr"
        ? "<hr>"
        : `<button data-menu="${r[0]}"><span class="g">${r[1]}</span>${r[2]}<span class="k">${r[3]}</span></button>`
    )
    .join("");
  $("#side").appendChild(m);
  $("#mark").classList.add("open");

  m.addEventListener("click", (e) => {
    const b = e.target.closest("[data-menu]");
    if (!b) return;
    closeMenu();
    ({
      prefs,
      exts: extensions,
      blocking,
      bookmarks: bookmarksPanel,
      downloads: downloadsPanel,
      profiles: profilesPanel,
      data: dataSheet,
      split: toggleSplit,
      pin: pinCurrent,
      tidy,
      about: sheet,
    })[b.dataset.menu]();
  });
  document.addEventListener("mousedown", onDoc);
}

function onDoc(e) {
  if (e.target.closest("#menu") || e.target.closest("#mark")) return;
  closeMenu();
}

function closeMenu() {
  const m = document.querySelector("#menu");
  if (!m) return false;
  m.remove();
  $("#mark").classList.remove("open");
  document.removeEventListener("mousedown", onDoc);
  return true;
}

/* -------------------------------------------------------------- misc */

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1900);
}

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255,
    g = ((n >> 8) & 255) / 255,
    b = (n & 255) / 255;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    l = (mx + mn) / 2;
  let h = 0,
    s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const f = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + f(r) + f(g) + f(b);
}

const blendOf = (hex) => {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h + 16, Math.max(18, s - 8), Math.min(72, l + 16));
};

/* ------------------------------------------------------------- events */

document.addEventListener("click", (e) => {
  if (e.target.isContentEditable) return;

  const pane = e.target.closest(".pane");
  if (pane && ui.split) {
    ui.focus = pane.dataset.side;
    render();
  }

  const nav = e.target.closest("[data-nav]");
  if (nav) {
    const side = nav.closest(".pane").dataset.side;
    const id = side === "right" ? ui.splitId : cur().activeId;
    const v = views.get(id);
    if (!v) return;
    if (nav.dataset.nav === "back" && v.wv.canGoBack()) v.wv.goBack();
    if (nav.dataset.nav === "forward" && v.wv.canGoForward()) v.wv.goForward();
    if (nav.dataset.nav === "reload") v.wv.reload();
    return;
  }

  const act = e.target.closest("[data-act]");
  if (act) {
    if (act.dataset.act === "split" || act.dataset.act === "unsplit") return toggleSplit();
    if (act.dataset.act === "swap") return swapSides();
    if (act.dataset.act === "reader") return sendToPage("zarc-reader");
    if (act.dataset.act === "pip") return sendToPage("zarc-pip");
  }

  const close = e.target.closest("[data-close]");
  if (close) {
    e.stopPropagation();
    return closeTab(close.dataset.close);
  }
  if (e.target.closest("[data-newtab]")) return newTab();
  if (e.target.closest("[data-wftoggle]")) {
    ui.wfOpen = !ui.wfOpen;
    return render();
  }
  if (e.target.closest("[data-wfnew]")) return newWorkflow();

  const wfRow = e.target.closest("[data-workflow]");
  if (wfRow) return setWorkflow(+wfRow.dataset.workflow);

  const tab = e.target.closest("[data-tab]");
  if (tab) return focusTab(tab.dataset.tab);

  const pin = e.target.closest("[data-pin]");
  if (pin) return openOrFocus(cur().pins[+pin.dataset.pin].url);
  if (e.target.closest("[data-pinadd]")) return pinCurrent();
});

$("#pins").addEventListener("contextmenu", (e) => {
  const pin = e.target.closest("[data-pin]");
  if (!pin) return;
  e.preventDefault();
  cur().pins.splice(+pin.dataset.pin, 1);
  render();
  save();
  toast("Unpinned");
});

$("#urlbar").addEventListener("click", () => {
  const t = tabById(cur().activeId);
  commandBar(t && t.url !== START ? t.url : "");
});
$("#shield").addEventListener("click", () => {
  if (S.settings.blocking === false) {
    S.settings.blocking = true;
    pushBlocking();
    save();
    render();
    return toast("Blocking on");
  }
  toggleAllowlist(activeHost());
});
$("#profilebtn").addEventListener("click", profilesPanel);
$("#dlbtn").addEventListener("click", downloadsPanel);
$("#mark").addEventListener("click", (e) => {
  e.stopPropagation();
  markMenu();
});
$("#w-close").addEventListener("click", () => api.win.close());
$("#w-min").addEventListener("click", () => api.win.minimize());
$("#w-max").addEventListener("click", () => api.win.maximize());

/* workflow renaming */
const wfEl = $("#wf");
wfEl.addEventListener("dblclick", (e) => {
  const nm = e.target.closest("[data-wfname]");
  if (nm) editName(nm);
});
wfEl.addEventListener(
  "blur",
  (e) => {
    const nm = e.target.closest ? e.target.closest("[data-wfname]") : null;
    if (!nm || !nm.isContentEditable) return;
    const w = S.workflows[+nm.dataset.wfname];
    if (w) w.name = (nm.textContent.trim() || "Workflow").slice(0, 24);
    nm.contentEditable = "false";
    render();
    save();
  },
  true
);
wfEl.addEventListener("keydown", (e) => {
  const nm = e.target.closest && e.target.closest("[data-wfname]");
  if (!nm || !nm.isContentEditable) return;
  if (e.key === "Enter" || e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    nm.blur();
  }
});

/* the sidebar hides until you reach for it */
$("#peekstrip").addEventListener("mouseenter", () => $("#side").classList.add("peek"));
$("#side").addEventListener("mouseleave", () => {
  if (!document.body.classList.contains("pinned")) $("#side").classList.remove("peek");
});

/* two fingers across the sidebar moves between workflows */
let swipeAcc = 0,
  swipeLock = 0,
  swipeIdle;
$("#side").addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const now = Date.now();
    if (now < swipeLock) return;
    swipeAcc += e.deltaX;
    clearTimeout(swipeIdle);
    swipeIdle = setTimeout(() => (swipeAcc = 0), 220);
    if (Math.abs(swipeAcc) > 48) {
      const dir = swipeAcc > 0 ? 1 : -1;
      swipeAcc = 0;
      swipeLock = now + SLIDE * 0.8;
      stepWorkflow(dir);
    }
  },
  { passive: false }
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (find.open && document.activeElement === $("#findinput")) return closeFind();
    if (closeMenu()) return;
    const v = document.querySelector(".veil");
    if (v) v.remove();
  }
});

window.addEventListener("resize", layout);

/* ---------------------------------------------------------- menu bridge */

api.onMenu((cmd, arg) => {
  const v = activeView();
  switch (cmd) {
    case "new-tab":
      return newTab();
    case "command-bar": {
      const t = tabById(cur().activeId);
      return commandBar(t && t.url !== START ? t.url : "");
    }
    case "close-tab":
      return closeTab(ui.split && ui.focus === "right" ? ui.splitId : cur().activeId);
    case "new-workflow":
      return newWorkflow();
    case "pin":
      return pinCurrent();
    case "reload":
      return v && v.reload();
    case "back":
      return v && v.canGoBack() && v.goBack();
    case "forward":
      return v && v.canGoForward() && v.goForward();
    case "split":
      return toggleSplit();
    case "pin-sidebar": {
      S.settings.pinnedSidebar = !S.settings.pinnedSidebar;
      document.body.classList.toggle("pinned", S.settings.pinnedSidebar);
      $("#side").classList.remove("peek");
      layout();
      save();
      return toast(S.settings.pinnedSidebar ? "Sidebar stays open" : "Sidebar hides — reach for the left edge");
    }
    case "glance":
      return ui.hover ? glance(ui.hover) : toast("Rest the pointer on a link first.");
    case "zoom": {
      if (!v) return;
      const lvl = arg === 0 ? 0 : v.getZoomLevel() + arg * 0.5;
      return v.setZoomLevel(lvl);
    }
    case "prefs":
      return prefs();
    case "blocking":
      return blocking();
    case "find":
      return openFind();
    case "find-next":
      return stepFind(arg);
    case "reader":
      return sendToPage("zarc-reader");
    case "pip":
      return sendToPage("zarc-pip");
    case "downloads":
      return downloadsPanel();
    case "bookmarks":
      return bookmarksPanel();
    case "bookmark":
      return addBookmark();
    case "profiles":
      return profilesPanel();
    case "sync-now":
      return syncNow(false);
    case "update-check":
      return checkUpdate(false);
    case "data":
      return dataSheet();
    case "about":
      return sheet();
    case "devtools":
      return v && v.openDevTools();
    case "workflow":
      return setWorkflow(arg);
    case "workflow-step":
      return stepWorkflow(arg);
  }
});

api.onOpenTab((href) => newTab(href));
api.onDownload((name) => toast(name ? "Downloaded " + name : "Download failed"));
api.onBlocked((st) => {
  block.total = st.total;
  block.counts = st.counts || {};
  paintShield();
});
api.onDownloads((list) => {
  downloadList = list;
  paintDownloads();
});
api.onDownloadDone((meta) => toast(meta.state === "completed" ? "Downloaded " + meta.name : "Download " + meta.state));
api.onUpdateReady((version) => {
  updateReady = version;
  toast("Version " + version + " is ready — restart to install");
});
api.onBlockingReady((info) => {
  block.engine = info.engine;
  if (info.engine === "builtin") toast("Filter lists unreachable — using the short built-in list");
});

/* ---------------------------------------------------------------- boot */

(async function start() {
  guestPreload = await api.guestPreload();
  partition = await api.partition();
  versions = await api.versions();
  profileInfo = await api.profile.list();
  S = (await api.loadState()) || blankState();

  // A saved file from an older build might be missing newer fields.
  S.settings = Object.assign(blankState().settings, S.settings || {});
  S.history = S.history || [];
  S.bookmarks = S.bookmarks || [];
  S.workflows.forEach((w) => {
    w.pins = w.pins || [];
    w.custom = w.custom || ["#3d5568", "#6d8ba0"];
    if (!w.tabs.length) w.tabs.push({ id: uid("t"), url: START, title: "New tab", icon: null });
    if (!w.tabs.some((t) => t.id === w.activeId)) w.activeId = w.tabs[0].id;
  });
  if (!S.workflows[S.current]) S.current = 0;

  applyMode();
  document.body.classList.toggle("pinned", !!S.settings.pinnedSidebar);
  if (!/Mac|iPhone|iPad/i.test(navigator.platform)) $("#mod").textContent = "Ctrl L";

  if (S.settings.extensions.length) {
    const loaded = await api.ext.loadSaved(S.settings.extensions.map((x) => x.path));
    S.settings.extensions = loaded;
  }

  const me = profileInfo.list.find((p) => p.id === profileInfo.active);
  if (me) {
    $("#profilebtn").textContent = me.glyph;
    $("#profilebtn").title = me.name + " — switch profile";
  }

  api.downloads.list().then((list) => {
    downloadList = list;
    paintDownloads();
  });

  pushBlocking();
  api.block.stats().then((st) => {
    block.engine = st.engine;
    block.total = st.total;
    block.counts = st.counts || {};
    paintShield();
  });

  render();
  window.addEventListener("beforeunload", () => api.saveState(S));

  // Sleep tabs nobody has looked at for a while; they reload on click.
  setInterval(() => {
    const mins = S.settings.discardAfter;
    if (!mins) return;
    const cutoff = Date.now() - mins * 60000;
    const awake = new Set([cur().activeId, ui.split ? ui.splitId : null]);
    let slept = 0;
    views.forEach((v, id) => {
      if (awake.has(id)) return;
      const t = anyTab(id);
      if (!t || (t.lastUsed || 0) > cutoff) return;
      v.wrap.remove();
      views.delete(id);
      t.discarded = true;
      slept++;
    });
    if (slept) render();
  }, 60000);

  if (S.settings.sync && S.settings.sync.mode !== "off") {
    syncNow(true);
    setInterval(() => syncNow(true), 5 * 60000);
  }
})();

/* ============================================================== blocking */

function blocking() {
  if (document.querySelector("#blocking")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "blocking";

  const engineName =
    block.engine === "ghostery"
      ? "EasyList, EasyPrivacy and the Ghostery tracker lists"
      : block.engine === "builtin"
      ? "the short built-in list (filter lists could not be fetched)"
      : "starting up";

  const top = Object.entries(block.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  v.innerHTML = `<div class="sheetbox">
    <h2>Blocking</h2>
    <p class="lede">Ads and trackers are stopped before they are requested, using ${engineName}. Blocking happens in the network layer, so it covers every page, every workflow and every glance.</p>

    <div class="bignum">${block.total.toLocaleString()}<small>requests stopped since Zarc opened</small></div>

    <h3>How it behaves</h3>
    <div class="field">
      <span class="m">Block ads and trackers<span>Off means every request goes through, everywhere.</span></span>
      <button class="sw-toggle ${S.settings.blocking !== false ? "on" : ""}" data-master></button>
    </div>
    <div class="field">
      <span class="m">Allow ads on ${activeHost() || "this page"}<span>Some sites only work with their scripts intact.</span></span>
      <button class="sw-toggle ${allowed(activeHost()) ? "on" : ""}" data-site></button>
    </div>

    <h3>Busiest pages</h3>
    ${
      top.length
        ? `<div class="sitelist">${top
            .map(
              ([host, n]) =>
                `<div class="ext"><span class="g">⛡</span><span class="m">${esc(host)}<span>${n} stopped</span></span>
                 <button class="btn" data-allow="${esc(host)}">${allowed(host) ? "Block again" : "Allow"}</button></div>`
            )
            .join("")}</div>`
        : `<p class="empty">Nothing stopped yet. Open a news site.</p>`
    }

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn" data-refresh>Update filter lists</button>
      <button class="btn primary" data-x>Done</button>
    </div></div>`;
  document.body.appendChild(v);

  v.addEventListener("click", async (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();

    if (e.target.closest("[data-master]")) {
      S.settings.blocking = S.settings.blocking === false;
      e.target.closest("[data-master]").classList.toggle("on", S.settings.blocking !== false);
      pushBlocking();
      save();
      render();
      return;
    }
    if (e.target.closest("[data-site]")) {
      toggleAllowlist(activeHost());
      e.target.closest("[data-site]").classList.toggle("on", allowed(activeHost()));
      return;
    }
    const allow = e.target.closest("[data-allow]");
    if (allow) {
      const host = allow.dataset.allow;
      const list = new Set(S.settings.allowlist || []);
      list.has(host) ? list.delete(host) : list.add(host);
      S.settings.allowlist = [...list];
      allow.textContent = list.has(host) ? "Block again" : "Allow";
      pushBlocking();
      save();
      render();
      return;
    }
    if (e.target.closest("[data-refresh]")) {
      const btn = e.target.closest("[data-refresh]");
      btn.textContent = "Updating…";
      const res = await api.block.refresh();
      btn.textContent = "Update filter lists";
      toast(res.updated ? "Filter lists updated" : "Could not reach the lists — the cached ones are still in use");
    }
  });
}

/* ========================================================= import, export */

function freshIds(data) {
  (data.workflows || []).forEach((w) => {
    w.id = uid("w");
    const map = new Map();
    (w.tabs || []).forEach((t) => {
      const was = t.id;
      t.id = uid("t");
      map.set(was, t.id);
    });
    w.activeId = map.get(w.activeId) || (w.tabs[0] && w.tabs[0].id);
  });
  return data;
}

function dropViews() {
  views.forEach((v) => v.wrap.remove());
  views.clear();
}

function dataSheet() {
  if (document.querySelector("#data")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "data";
  v.innerHTML = `<div class="sheetbox">
    <h2>Import and export</h2>
    <p class="lede">Everything Zarc knows lives in one file: workflows, tabs, essentials, bookmarks, history, colours and settings. Export it, carry it to another machine, import it there.</p>

    <h3>This browser</h3>
    <div class="field">
      <span class="m">Export everything<span>One JSON file you can keep or move.</span></span>
      <button class="btn" data-export>Export…</button>
    </div>
    <div class="field">
      <span class="m">Import an export<span>Replace what is here, or add its workflows alongside yours.</span></span>
      <button class="btn" data-import>Import…</button>
    </div>
    <div id="importchoice"></div>

    <h3>Bookmarks</h3>
    <p class="lede" style="margin-bottom:10px">Imported bookmarks turn up in the command bar under ★, and you can pin any of them to essentials. Zarc holds ${(S.bookmarks || []).length} of them.</p>
    <div id="browsers"><p class="empty">Looking for other browsers…</p></div>
    <div class="field">
      <span class="m">From a file<span>A bookmarks HTML export from any browser, including Safari and Firefox.</span></span>
      <button class="btn" data-bm-file>Choose…</button>
    </div>
    <div class="field">
      <span class="m">Export bookmarks<span>Standard HTML, readable by every other browser.</span></span>
      <button class="btn" data-bm-out>Export…</button>
    </div>

    <h3>Stored data</h3>
    <div class="field">
      <span class="m">Clear cookies and logins<span>Signs you out everywhere.</span></span>
      <button class="btn" data-clear="cookies">Clear</button>
    </div>
    <div class="field">
      <span class="m">Clear the cache<span>Keeps you signed in.</span></span>
      <button class="btn" data-clear="cache">Clear</button>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn primary" data-x>Done</button>
    </div></div>`;
  document.body.appendChild(v);

  api.data.browsers().then((list) => {
    const box = v.querySelector("#browsers");
    if (!box) return;
    box.innerHTML = list.length
      ? list
          .map(
            (b) =>
              `<div class="field"><span class="m">Bookmarks from ${esc(b.name)}<span>${esc(b.file)}</span></span>
               <button class="btn" data-bm="${esc(b.file)}">Import</button></div>`
          )
          .join("")
      : `<p class="empty">No other Chrome-family browser found. Use a bookmarks HTML file instead.</p>`;
  });

  const addBookmarks = (items, from) => {
    const seen = new Set((S.bookmarks || []).map((b) => b.url));
    const fresh = items.filter((b) => b.url && !seen.has(b.url));
    S.bookmarks = (S.bookmarks || []).concat(fresh);
    save();
    toast(fresh.length ? `${fresh.length} bookmarks imported from ${from}` : "Those were already here");
  };

  v.addEventListener("click", async (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();

    if (e.target.closest("[data-export]")) {
      const where = await api.data.export(S);
      return toast(where ? "Exported to " + where.split(/[\\/]/).pop() : "Export cancelled");
    }

    if (e.target.closest("[data-import]")) {
      const res = await api.data.import();
      if (!res) return;
      if (res.error) return toast("That file could not be read");
      const n = (res.data.workflows || []).length;
      v.querySelector("#importchoice").innerHTML = `<div class="field">
        <span class="m">${n} workflows in that file<span>Replacing clears what is here now.</span></span>
        <button class="btn" data-merge>Add them</button>
        <button class="btn primary" data-replace>Replace</button></div>`;
      v.dataset.pending = "1";
      window.__zarcPending = res.data;
      return;
    }

    if (e.target.closest("[data-merge]") || e.target.closest("[data-replace]")) {
      const incoming = window.__zarcPending;
      if (!incoming) return;
      const replace = !!e.target.closest("[data-replace]");
      dropViews();
      if (replace) {
        S = Object.assign(blankState(), freshIds(incoming));
        S.current = 0;
      } else {
        const add = freshIds(incoming);
        S.workflows.push(...(add.workflows || []));
        S.bookmarks = (S.bookmarks || []).concat(add.bookmarks || []);
        S.history = (S.history || []).concat(add.history || []).slice(0, 400);
      }
      window.__zarcPending = null;
      ui.split = false;
      ui.splitId = null;
      pushBlocking();
      applyMode();
      render();
      save();
      v.remove();
      return toast(replace ? "Imported — this is that browser now" : "Workflows added");
    }

    const bm = e.target.closest("[data-bm]");
    if (bm) {
      const res = await api.data.importBookmarks(bm.dataset.bm);
      if (res && res.items) addBookmarks(res.items, res.from);
      return;
    }
    if (e.target.closest("[data-bm-file]")) {
      const res = await api.data.importBookmarks(null);
      if (res && res.items) addBookmarks(res.items, res.from);
      return;
    }
    if (e.target.closest("[data-bm-out]")) {
      const list = (S.bookmarks || []).concat(
        S.workflows.flatMap((w) => w.pins.map((p) => ({ title: p.title || hostOf(p.url), url: p.url })))
      );
      const where = await api.data.exportBookmarks(list);
      return toast(where ? "Bookmarks exported" : "Export cancelled");
    }

    const clear = e.target.closest("[data-clear]");
    if (clear) {
      await api.data.clear(clear.dataset.clear);
      toast(clear.dataset.clear === "cookies" ? "Cookies cleared" : "Cache cleared");
    }
  });
}

/* ============================================================ page talk */

function sendToPage(channel, arg) {
  const wv = activeView();
  if (!wv) return;
  try {
    wv.send(channel, arg);
  } catch {
    toast("The page is still loading.");
  }
}

/* =========================================================== find in page */

function openFind() {
  const bar = $("#findbar");
  bar.hidden = false;
  find.open = true;
  const input = $("#findinput");
  input.select();
  input.focus();
  if (find.term) runFind(find.term, false);
}

function closeFind() {
  const wv = activeView();
  if (wv) {
    try {
      wv.stopFindInPage("clearSelection");
    } catch {}
  }
  $("#findbar").hidden = true;
  find.open = false;
  find.matches = 0;
  find.active = 0;
}

function runFind(term, next, forward = true) {
  const wv = activeView();
  if (!wv) return;
  find.term = term;
  if (!term) {
    try {
      wv.stopFindInPage("clearSelection");
    } catch {}
    find.matches = 0;
    find.active = 0;
    return paintFind();
  }
  try {
    wv.findInPage(term, { findNext: next, forward });
  } catch {}
}

function stepFind(dir) {
  if (!find.term) return openFind();
  if (!find.open) openFind();
  runFind(find.term, true, dir >= 0);
}

function paintFind() {
  $("#findcount").textContent = find.matches ? `${find.active}/${find.matches}` : find.term ? "none" : "0/0";
}

$("#findinput").addEventListener("input", (e) => runFind(e.target.value, false));
$("#findinput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runFind(find.term, true, !e.shiftKey);
  }
  if (e.key === "Escape") closeFind();
});
$("#findbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-find]");
  if (!b) return;
  if (b.dataset.find === "close") return closeFind();
  runFind(find.term, true, b.dataset.find === "next");
});

/* ============================================================= downloads */

function bytes(n) {
  if (!n) return "";
  const u = ["B", "kB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}

function paintDownloads() {
  const busy = downloadList.filter((d) => d.state === "progressing").length;
  const badge = $("#dlbadge");
  badge.hidden = !busy;
  badge.textContent = busy;
  const panel = document.querySelector("#downloads .list");
  if (panel) panel.innerHTML = downloadRows();
}

function downloadRows() {
  if (!downloadList.length) return `<p class="empty">Nothing downloaded yet.</p>`;
  return downloadList
    .slice()
    .reverse()
    .map((d) => {
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
      const line =
        d.state === "progressing"
          ? `${bytes(d.received)} of ${bytes(d.total) || "unknown size"}`
          : d.state === "completed"
          ? bytes(d.received) + " — " + hostOf(d.url)
          : d.state;
      return `<div class="dl"><span class="g">${d.state === "completed" ? "⤓" : d.state === "progressing" ? "↓" : "✕"}</span>
        <span class="m">${esc(d.name)}<span>${esc(line)}</span>
        ${d.state === "progressing" ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ""}</span>
        ${
          d.state === "completed"
            ? `<button class="btn" data-dl-open="${d.id}">Open</button><button class="btn" data-dl-show="${d.id}">Show</button>`
            : d.state === "progressing"
            ? `<button class="btn" data-dl-cancel="${d.id}">Cancel</button>`
            : ""
        }</div>`;
    })
    .join("");
}

function downloadsPanel() {
  if (document.querySelector("#downloads")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "downloads";
  v.innerHTML = `<div class="sheetbox">
    <h2>Downloads</h2>
    <p class="lede">Everything lands in your Downloads folder. Progress here, files there.</p>
    <div class="list scroller">${downloadRows()}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn" data-dl-folder>Open folder</button>
      <button class="btn" data-dl-clear>Clear finished</button>
      <button class="btn primary" data-x>Done</button>
    </div></div>`;
  document.body.appendChild(v);

  v.addEventListener("click", async (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();
    const open = e.target.closest("[data-dl-open]");
    if (open) return api.downloads.open(open.dataset.dlOpen);
    const show = e.target.closest("[data-dl-show]");
    if (show) return api.downloads.show(show.dataset.dlShow);
    const cancel = e.target.closest("[data-dl-cancel]");
    if (cancel) return api.downloads.cancel(cancel.dataset.dlCancel);
    if (e.target.closest("[data-dl-folder]")) return api.downloads.folder();
    if (e.target.closest("[data-dl-clear]")) {
      await api.downloads.clear();
      downloadList = await api.downloads.list();
      paintDownloads();
    }
  });
}

/* ============================================================= bookmarks */

function addBookmark() {
  const t = tabById(cur().activeId);
  if (!t || t.url === START) return toast("Open a page first.");
  if ((S.bookmarks || []).some((b) => b.url === t.url)) return toast("Already bookmarked.");
  S.bookmarks = (S.bookmarks || []).concat({ title: t.title || hostOf(t.url), url: t.url, folder: "", at: Date.now() });
  save();
  toast("Bookmarked");
}

function bookmarksPanel() {
  if (document.querySelector("#bookmarks")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "bookmarks";
  let query = "";
  let folderFilter = "";

  const folders = () => [...new Set((S.bookmarks || []).map((b) => b.folder).filter(Boolean))].sort();

  const rows = () => {
    const list = (S.bookmarks || [])
      .map((b, i) => ({ ...b, i }))
      .filter((b) => !folderFilter || (b.folder || "") === folderFilter)
      .filter((b) => !query || (b.title + " " + b.url).toLowerCase().includes(query));
    if (!list.length) return `<p class="empty">${query ? "Nothing matches." : "No bookmarks yet — ⌘⇧D saves the page you are on."}</p>`;

    const groups = new Map();
    list.forEach((b) => groups.set(b.folder || "Unfiled", (groups.get(b.folder || "Unfiled") || []).concat(b)));

    return [...groups.entries()]
      .map(
        ([name, items]) =>
          `<h3>${esc(name)}</h3>` +
          items
            .map(
              (b) => `<div class="bmrow" data-i="${b.i}">
          <span class="n" contenteditable="true" spellcheck="false" data-bmname="${b.i}">${esc(b.title)}</span>
          <span class="h">${esc(hostOf(b.url))}</span>
          <select data-bmfolder="${b.i}">
            <option value="">Unfiled</option>
            ${folders().map((f) => `<option value="${esc(f)}" ${f === b.folder ? "selected" : ""}>${esc(f)}</option>`).join("")}
            <option value="__new">New folder…</option>
          </select>
          <button class="iconbtn" data-bmopen="${b.i}" title="Open">↗</button>
          <button class="iconbtn" data-bmpin="${b.i}" title="Pin to essentials">✧</button>
          <button class="iconbtn" data-bmdel="${b.i}" title="Delete">×</button>
        </div>`
            )
            .join("")
      )
      .join("");
  };

  const draw = () => {
    v.querySelector(".list").innerHTML = rows();
    v.querySelector(".chips").innerHTML =
      `<button class="pill ${!folderFilter ? "on" : ""}" data-folder="">All</button>` +
      folders().map((f) => `<button class="pill ${folderFilter === f ? "on" : ""}" data-folder="${esc(f)}">${esc(f)}</button>`).join("");
  };

  v.innerHTML = `<div class="sheetbox">
    <h2>Bookmarks</h2>
    <p class="lede">Rename in place, file them into folders, pin the ones you want in essentials. They all answer to ★ in the command bar.</p>
    <div class="searchfield"><span>⌕</span><input placeholder="Search bookmarks" spellcheck="false"></div>
    <div class="chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
    <div class="list scroller"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn" data-bmadd>Bookmark this page</button>
      <button class="btn primary" data-x>Done</button>
    </div></div>`;
  document.body.appendChild(v);
  draw();

  v.querySelector(".searchfield input").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    draw();
  });

  v.addEventListener("click", (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();
    const chip = e.target.closest("[data-folder]");
    if (chip) {
      folderFilter = chip.dataset.folder;
      return draw();
    }
    if (e.target.closest("[data-bmadd]")) {
      addBookmark();
      return draw();
    }
    const open = e.target.closest("[data-bmopen]");
    if (open) {
      v.remove();
      return openOrFocus(S.bookmarks[+open.dataset.bmopen].url);
    }
    const pin = e.target.closest("[data-bmpin]");
    if (pin) {
      const b = S.bookmarks[+pin.dataset.bmpin];
      if (cur().pins.some((p) => p.url === b.url)) return toast("Already in essentials.");
      cur().pins.push({ url: b.url, title: b.title, icon: null });
      render();
      save();
      return toast("Pinned to essentials");
    }
    const del = e.target.closest("[data-bmdel]");
    if (del) {
      S.bookmarks.splice(+del.dataset.bmdel, 1);
      save();
      return draw();
    }
  });

  v.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-bmfolder]");
    if (!sel) return;
    const b = S.bookmarks[+sel.dataset.bmfolder];
    if (sel.value === "__new") {
      const name = prompt("Folder name");
      b.folder = (name || "").trim();
    } else {
      b.folder = sel.value;
    }
    save();
    draw();
  });

  v.addEventListener(
    "blur",
    (e) => {
      const nm = e.target.closest ? e.target.closest("[data-bmname]") : null;
      if (!nm) return;
      const b = S.bookmarks[+nm.dataset.bmname];
      if (b) b.title = nm.textContent.trim().slice(0, 120) || hostOf(b.url);
      save();
    },
    true
  );
}

/* ============================================================== profiles */

function profilesPanel() {
  if (document.querySelector("#profiles")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "profiles";

  const draw = () => {
    v.querySelector(".list").innerHTML = profileInfo.list
      .map(
        (p) => `<div class="profrow ${p.id === profileInfo.active ? "on" : ""}">
      <span class="g">${p.glyph}</span>
      <span class="n" contenteditable="true" spellcheck="false" data-pname="${p.id}">${esc(p.name)}</span>
      ${p.id === profileInfo.active ? `<span class="pill on">In use</span>` : `<button class="btn" data-pswitch="${p.id}">Switch</button>`}
      ${profileInfo.list.length > 1 ? `<button class="iconbtn" data-pdel="${p.id}" title="Delete profile">×</button>` : ""}
    </div>`
      )
      .join("");
  };

  v.innerHTML = `<div class="sheetbox">
    <h2>Profiles</h2>
    <p class="lede">Each profile is a separate browser: its own workflows, cookies, logins, extensions and history, in its own folder on disk. Switching reloads the window. ⌘⌥1…9 jumps between them.</p>
    <div class="list profiles"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn" data-padd>New profile</button>
      <button class="btn primary" data-x>Done</button>
    </div></div>`;
  document.body.appendChild(v);
  draw();

  v.addEventListener("click", async (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();
    if (e.target.closest("[data-padd]")) {
      profileInfo = await api.profile.add("New profile");
      return draw();
    }
    const sw = e.target.closest("[data-pswitch]");
    if (sw) {
      await api.saveState(S);
      return api.profile.switch(sw.dataset.pswitch);
    }
    const del = e.target.closest("[data-pdel]");
    if (del) {
      const res = await api.profile.remove(del.dataset.pdel);
      if (res && res.error) return toast(res.error);
      profileInfo = await api.profile.list();
      return draw();
    }
  });

  v.addEventListener(
    "blur",
    async (e) => {
      const nm = e.target.closest ? e.target.closest("[data-pname]") : null;
      if (!nm) return;
      profileInfo = await api.profile.rename(nm.dataset.pname, nm.textContent.trim() || "Profile");
    },
    true
  );
}

/* ================================================================== sync */

function applyRemote(body) {
  const incoming = body.data || {};
  dropViews();
  const keep = S.settings.sync;
  S = Object.assign(blankState(), incoming);
  S.settings.sync = keep; // where this machine syncs is this machine's business
  S.syncedAt = body.updatedAt;
  ui.split = false;
  ui.splitId = null;
  pushBlocking();
  applyMode();
  document.body.classList.toggle("pinned", !!S.settings.pinnedSidebar);
  render();
  api.saveState(S);
}

async function syncNow(quiet) {
  const cfg = (S.settings && S.settings.sync) || { mode: "off" };
  if (cfg.mode === "off") return quiet ? null : toast("Sync is off — set it up in Settings");

  const pulled = await api.sync.pull(cfg);
  if (pulled.ok && pulled.body && pulled.body.updatedAt > (S.updatedAt || 0) && pulled.body.device !== versions.device) {
    applyRemote(pulled.body);
    return toast("Synced from " + pulled.body.device);
  }

  const res = await api.sync.push(cfg, S);
  if (res.ok) {
    S.syncedAt = res.at;
    if (!quiet) toast("Synced");
  } else if (!quiet) {
    toast("Sync failed: " + res.error);
  }
}

/* =============================================================== updates */

async function checkUpdate(quiet) {
  const res = await api.update.check();
  if (!res.supported) return quiet ? null : toast("Updates arrive with installed builds — this one is running from source");
  if (res.error) return quiet ? null : toast("Could not check: " + res.error);
  if (res.available) return toast("Version " + res.latest + " is downloading");
  if (!quiet) toast("Version " + res.version + " is the latest");
}

/* ================================================== the rest of settings */

function systemPanel() {
  if (document.querySelector("#system")) return;
  const v = document.createElement("div");
  v.className = "veil";
  v.id = "system";
  const cfg = S.settings.sync || { mode: "off" };

  v.innerHTML = `<div class="sheetbox">
    <h2>Sync, memory and updates</h2>
    <p class="lede">Sync writes one file to a folder that already syncs between your machines, or to any endpoint that answers GET and PUT. Zarc never runs a server of its own, and cookies stay on the machine they were made on.</p>

    <h3>Sync</h3>
    <div class="segs">
      ${["off", "folder", "http"]
        .map(
          (m) =>
            `<button class="seg ${cfg.mode === m ? "on" : ""}" data-syncmode="${m}">${
              m === "off" ? "Off" : m === "folder" ? "A folder" : "A URL"
            }</button>`
        )
        .join("")}
    </div>
    <div class="field" ${cfg.mode === "folder" ? "" : "hidden"} data-when="folder">
      <span class="m">Sync folder<span>${esc(cfg.folder || "iCloud Drive, Dropbox, Syncthing — anything that already syncs")}</span></span>
      <button class="btn" data-pickfolder>Choose…</button>
    </div>
    <div class="field" ${cfg.mode === "http" ? "" : "hidden"} data-when="http">
      <span class="m">Endpoint<span>GET returns the last state, PUT stores it.</span></span>
      <input type="text" data-syncurl value="${esc(cfg.url || "")}" placeholder="https://…">
    </div>
    <div class="field" ${cfg.mode === "http" ? "" : "hidden"} data-when="http">
      <span class="m">Bearer token<span>Optional, sent as an Authorization header.</span></span>
      <input type="text" data-synctoken value="${esc(cfg.token || "")}" placeholder="optional">
    </div>
    <div class="field">
      <span class="m">This machine<span>${esc(versions.device)} — the name other machines see.</span></span>
      <button class="btn" data-syncnow>Sync now</button>
    </div>

    <h3>Memory</h3>
    <div class="field">
      <span class="m">Sleep tabs after<span>A sleeping tab keeps its place in the list and reloads when you click it.</span></span>
      <select data-discard>
        ${[
          [0, "Never"],
          [5, "5 minutes"],
          [15, "15 minutes"],
          [30, "30 minutes"],
          [60, "an hour"],
        ]
          .map(([n, label]) => `<option value="${n}" ${S.settings.discardAfter === n ? "selected" : ""}>${label}</option>`)
          .join("")}
      </select>
    </div>
    <div class="field">
      <span class="m">Awake now<span>${views.size} of ${S.workflows.reduce((n, w) => n + w.tabs.length, 0)} tabs are holding a page in memory.</span></span>
      <button class="btn" data-sleepnow>Sleep the rest</button>
    </div>

    <h3>Updates</h3>
    <div class="field">
      <span class="m">Zarc ${esc(versions.app)}<span>Chromium ${esc(versions.chrome)} · Electron ${esc(versions.electron)}${
    versions.packaged ? "" : " · running from source"
  }</span></span>
      <button class="btn" data-update>${updateReady ? "Restart to install " + updateReady : "Check for updates"}</button>
    </div>
    <p class="lede" style="margin-top:8px">Installed copies check for a new release on launch and every six hours, download it in the background, and install it when you next quit. That is also how Chromium security fixes reach you.</p>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
      <button class="btn primary" data-x>Done</button>
    </div></div>`;
  document.body.appendChild(v);

  const setMode = (mode) => {
    S.settings.sync = Object.assign({ mode: "off", folder: "", url: "", token: "" }, S.settings.sync, { mode });
    v.querySelectorAll("[data-syncmode]").forEach((b) => b.classList.toggle("on", b.dataset.syncmode === mode));
    v.querySelectorAll("[data-when]").forEach((f) => (f.hidden = f.dataset.when !== mode));
    save();
  };

  v.addEventListener("click", async (e) => {
    if (e.target === v || e.target.closest("[data-x]")) return v.remove();
    const mode = e.target.closest("[data-syncmode]");
    if (mode) return setMode(mode.dataset.syncmode);
    if (e.target.closest("[data-pickfolder]")) {
      const folder = await api.sync.pickFolder();
      if (!folder) return;
      S.settings.sync.folder = folder;
      save();
      toast("Syncing through " + folder.split(/[\\/]/).pop());
      return;
    }
    if (e.target.closest("[data-syncnow]")) return syncNow(false);
    if (e.target.closest("[data-sleepnow]")) {
      const awake = new Set([cur().activeId, ui.split ? ui.splitId : null]);
      views.forEach((view_, id) => {
        if (awake.has(id)) return;
        view_.wrap.remove();
        views.delete(id);
        const t = anyTab(id);
        if (t) t.discarded = true;
      });
      render();
      return toast("Background tabs asleep");
    }
    if (e.target.closest("[data-update]")) {
      if (updateReady) return api.update.install();
      return checkUpdate(false);
    }
  });

  v.addEventListener("input", (e) => {
    if (e.target.matches("[data-syncurl]")) {
      S.settings.sync.url = e.target.value.trim();
      save();
    }
    if (e.target.matches("[data-synctoken]")) {
      S.settings.sync.token = e.target.value.trim();
      save();
    }
  });

  v.addEventListener("change", (e) => {
    if (e.target.matches("[data-discard]")) {
      S.settings.discardAfter = +e.target.value;
      save();
      toast(S.settings.discardAfter ? "Tabs sleep after " + S.settings.discardAfter + " minutes" : "Tabs stay awake");
    }
  });
}
