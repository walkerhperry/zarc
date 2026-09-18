/* Runs inside every page: cosmetic filtering, the hovered link that feeds
   Glance, reader view, and picture in picture.                          */

const { ipcRenderer } = require("electron");

try {
  require("@ghostery/adblocker-electron-preload");
} catch (err) {
  /* network blocking still applies; a few empty boxes may remain */
}

/* ------------------------------------------------------- hovered links */

let last = null;

addEventListener(
  "mouseover",
  (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    const href = a && /^https?:/.test(a.href) ? a.href : null;
    if (href === last) return;
    last = href;
    ipcRenderer.sendToHost("hover", href);
  },
  true
);

addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "g" && e.key !== "G") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    if (el && (el.isContentEditable || /input|textarea|select/i.test(el.tagName))) return;
    if (!last) return;
    e.preventDefault();
    ipcRenderer.sendToHost("glance", last);
  },
  true
);

/* ------------------------------------------------------------- reader */

let readerOn = false;
let saved = null;

const READER_CSS = `
  html,body{background:#f3ecde !important;color:#231a10 !important;margin:0 !important;padding:0 !important}
  @media (prefers-color-scheme: dark){html,body{background:#191108 !important;color:#f2e8d6 !important}}
  #zarc-reader{max-width:38em;margin:0 auto;padding:6vh 24px 14vh;
    font:18px/1.72 Iowan Old Style,Palatino,Georgia,"Times New Roman",serif}
  #zarc-reader h1{font-size:2em;line-height:1.15;font-weight:400;margin:0 0 .1em}
  #zarc-reader .byline{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;opacity:.6;margin:0 0 2em}
  #zarc-reader p{margin:0 0 1.15em}
  #zarc-reader img,#zarc-reader figure{max-width:100%;height:auto;border-radius:8px;margin:1.6em 0}
  #zarc-reader a{color:inherit;text-decoration:underline;text-underline-offset:3px}
  #zarc-reader pre,#zarc-reader blockquote{border-left:3px solid currentColor;padding-left:1em;opacity:.85;margin:1.4em 0}
  #zarc-reader h2,#zarc-reader h3{font-weight:600;font-size:1.15em;margin:2em 0 .5em;
    font-family:ui-sans-serif,system-ui,sans-serif}
`;

// A small readability: score blocks by how much of their text sits in paragraphs.
function findArticle() {
  const candidates = [...document.querySelectorAll("article, main, [role=main], .post, .article, .content, #content, body div")];
  let best = null;
  let bestScore = 0;
  for (const el of candidates) {
    const ps = el.querySelectorAll("p");
    if (ps.length < 3) continue;
    let text = 0;
    ps.forEach((p) => (text += p.textContent.trim().length));
    if (text < 400) continue;
    const links = el.querySelectorAll("a").length;
    const score = text / (1 + links * 40) + ps.length * 12 - el.querySelectorAll("nav, aside, form").length * 200;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function enterReader() {
  const article = findArticle();
  if (!article) {
    ipcRenderer.sendToHost("reader", { ok: false, reason: "no-article" });
    return;
  }
  saved = { html: document.body.innerHTML, scroll: scrollY, title: document.title };

  const title =
    (document.querySelector("h1") && document.querySelector("h1").textContent.trim()) || document.title || "";
  const byline =
    (document.querySelector('[rel=author], .byline, .author, [itemprop=author]') || {}).textContent || "";

  const clean = article.cloneNode(true);
  clean
    .querySelectorAll("script, style, nav, aside, form, iframe, noscript, button, .ad, [class*=share], [class*=related], [id*=comment]")
    .forEach((n) => n.remove());
  clean.querySelectorAll("h1").forEach((h) => h.remove());

  const style = document.createElement("style");
  style.id = "zarc-reader-style";
  style.textContent = READER_CSS;

  document.body.innerHTML = "";
  document.head.appendChild(style);
  const wrap = document.createElement("div");
  wrap.id = "zarc-reader";
  wrap.innerHTML =
    `<h1></h1>` + (byline.trim() ? `<p class="byline"></p>` : "") + `<div class="zarc-body"></div>`;
  wrap.querySelector("h1").textContent = title;
  if (byline.trim()) wrap.querySelector(".byline").textContent = byline.trim().slice(0, 120);
  wrap.querySelector(".zarc-body").appendChild(clean);
  document.body.appendChild(wrap);
  scrollTo(0, 0);

  readerOn = true;
  ipcRenderer.sendToHost("reader", { ok: true, on: true });
}

function leaveReader() {
  if (!saved) return;
  const style = document.getElementById("zarc-reader-style");
  if (style) style.remove();
  document.body.innerHTML = saved.html;
  document.title = saved.title;
  scrollTo(0, saved.scroll);
  saved = null;
  readerOn = false;
  ipcRenderer.sendToHost("reader", { ok: true, on: false });
}

ipcRenderer.on("zarc-reader", () => (readerOn ? leaveReader() : enterReader()));

/* --------------------------------------------------- picture in picture */

ipcRenderer.on("zarc-pip", async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return ipcRenderer.sendToHost("pip", { on: false });
    }
    const videos = [...document.querySelectorAll("video")].filter((v) => v.readyState > 0);
    const video =
      videos.find((v) => !v.paused) ||
      videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!video) return ipcRenderer.sendToHost("pip", { on: false, reason: "no-video" });
    video.disablePictureInPicture = false;
    await video.requestPictureInPicture();
    ipcRenderer.sendToHost("pip", { on: true });
  } catch (err) {
    ipcRenderer.sendToHost("pip", { on: false, reason: err.message });
  }
});

addEventListener("beforeunload", () => {
  saved = null;
  readerOn = false;
});
