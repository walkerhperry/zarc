# Zarc

A browser with Zen's disappearing sidebar, Arc's coloured workflows, blocking that is on
before you open the first page, and every piece of your data in one portable file.

Pages are rendered by Chromium through Electron. Real browser, small feature set — the
last section says exactly where it stops.

---

## Installing it without touching a terminal

A browser has to be compiled on the operating system it runs on, so an installer has to be
built somewhere. Pick whichever of these suits you; neither needs you to type a command.

### Option A — let GitHub build it (nothing installed locally)

1. Sign in at **github.com** and click **New repository**. Name it `zarc`, leave it public,
   and create it.
2. On the empty repository page click **uploading an existing file**, then drag this whole
   folder in. Wait for the upload to finish and click **Commit changes**.
3. Open the **Actions** tab. Click **Build Zarc installers** on the left, then
   **Run workflow → Run workflow**.
4. Wait about ten minutes. When the three ticks appear, scroll to **Artifacts** at the
   bottom of the run and download the one for your system:
   - `Zarc-macOS` → a `.dmg`
   - `Zarc-Windows` → a `.exe` installer
   - `Zarc-Linux` → an `.AppImage` and a `.deb`
5. Open the downloaded file and install it like anything else.

Tagging a commit `v1.0.0` instead publishes the installers to a Releases page, which is
the easy way to put it on other machines later.

### Option B — build on your own machine (double-click, no typing)

1. Install **Node.js LTS** from nodejs.org if you do not have it — a normal installer.
2. Double-click the script for your system:
   - **Windows** — `build-windows.bat`
   - **macOS** — `build-macos.command` (first time: right-click → Open. If macOS refuses
     to run it, open Get Info on the file and it will offer to allow it.)
   - **Linux** — `build-linux.sh` (mark it executable in your file manager's Properties)
3. A window shows the build. When it finishes, the `dist` folder opens with your installer.

### First launch

The app is not code-signed, so the operating system will be suspicious once:

- **macOS** — right-click the app → **Open** → **Open**. Only needed the first time.
- **Windows** — SmartScreen shows "Windows protected your PC" → **More info** → **Run anyway**.

Signing costs money and an identity check with Apple and Microsoft. If you want it signed,
add the certificates as repository secrets and electron-builder will use them.

---

## Blocking

On by default, nothing to configure. Ads and trackers are stopped at the network layer
before the request leaves, so it covers every page, every workflow and the Glance panel too.

- **Lists** — EasyList, EasyPrivacy and Ghostery's tracker lists, through
  `@ghostery/adblocker-electron`, cached to disk so later launches do not wait on the
  network. If the lists cannot be fetched on a first run with no cache, a short built-in
  host list takes over and the browser tells you so.
- **Cosmetic filtering** — the leftover empty boxes get hidden as well, by a script
  injected into each page.
- **The shield** in the page header counts what was stopped on the page you are reading.
  Click it to allow ads on that site; click again to switch blocking back on.
- **⌘⇧B** opens the blocking panel: a running total, the busiest pages, per-site allow
  switches and a button to refresh the lists.

Allowlisting uses uBlock-style exception filters, so allowing a site turns off both the
request blocking and the cosmetic hiding for it — the way sites that break under a blocker
expect to be treated.

## Moving your data

**⌘⇧I**, or Import and export behind the mark.

- **Export everything** writes one JSON file: workflows, tabs, essentials, bookmarks,
  history, colours, allowlist and settings. Carry it to another machine and import it there
  — either replacing what is on that machine or adding its workflows alongside.
- **Import bookmarks** finds Chrome, Brave, Edge, Vivaldi, Opera and Arc profiles on your
  machine and reads their bookmarks directly. For Safari and Firefox, export a bookmarks
  HTML file from them and choose it from the same panel.
- **Export bookmarks** writes standard Netscape HTML, which every other browser imports.
- Imported bookmarks appear in the command bar under ★ as you type.
- Cookies and cache can be cleared from the same panel. They are deliberately left out of
  the export file: a JSON file full of session tokens is not something to email yourself.

## Using it

| | |
|---|---|
| ⌘L | Command bar — address, search, open tabs, history, bookmarks |
| ⌘T / ⌘W | New tab / close tab |
| ⌘D | Pin the current tab to essentials |
| ⌘\ | Split view |
| ⌘E | Keep the sidebar open instead of hiding it |
| ⌘1…9 | Jump to a workflow |
| ⌘⌥← / ⌘⌥→ | Previous / next workflow |
| G | Glance at the link under the pointer |
| ⌘F | Find in page (⌘G next, ⌘⇧G previous) |
| ⌘⇧R / ⌘⇧P | Reader view / picture in picture |
| ⌘⇧D / ⌘⇧O | Bookmark this page / bookmarks manager |
| ⌘⇧J | Downloads |
| ⌘⌥1…9 | Switch profile |
| ⌘⇧S | Sync now |
| ⌘⇧B / ⌘⇧I / ⌘, | Blocking / import and export / settings |

Two fingers sideways on the sidebar also moves between workflows. Right-click an essential
to unpin it. Double-click a workflow name to rename it.

## How it is put together

| File | What it does |
|---|---|
| `main.js` | Windows, profiles and their sessions, the blocking engine, downloads, sync, updates, extension unpacking, the application menu (every shortcut lives here, because a focused page swallows key events), import and export, and per-profile state files |
| `preload.js` | The only bridge between the chrome and Node, on `window.zarc` |
| `guest.js` | Runs inside every page: cosmetic filtering, reader view, picture in picture, and the hovered link that feeds Glance |
| `renderer/app.js` | Tabs, workflows, layout, command bar, all the panels |
| `renderer/app.css` | The chrome |
| `renderer/start.html` | The new-tab page |
| `.github/workflows/build.yml` | The cloud build that produces the installers |

Each tab owns a `<webview>` in one flat container; the chrome measures the pane and
positions the view over it. Nothing is ever reparented, because moving a `<webview>` in the
DOM reloads the page inside it. The workflow slide animates a `capturePage()` snapshot
rather than the live view, which is what keeps it smooth.

## Everything else it now does

**Profiles.** Separate browsers inside one app: own workflows, cookies, logins, extensions,
history, each in its own folder on disk. The glyph beside the mark switches them, ⌘⌥1…9
jumps, and the Profile menu lists them. Switching reloads the window into that profile.

**Sync.** Zarc runs no server. Point it at a folder that already syncs between your
machines — iCloud Drive, Dropbox, Syncthing — and it keeps one `zarc-sync.json` there,
pushing a few seconds after any change and pulling on launch and every five minutes. If a
remote copy is newer than yours, it is applied and the browser says which machine it came
from. There is also a URL mode for anything that answers GET and PUT, with an optional
bearer token. Cookies are deliberately never synced.

**Bookmarks manager.** ⌘⇧O. Search, rename in place, file into folders, pin to essentials,
delete. ⌘⇧D bookmarks the page you are on, and everything shows up under ★ in the command
bar as you type.

**Downloads.** A real panel at ⌘⇧J with live progress bars, cancel, open, show in folder
and clear. The arrow beside the mark carries a badge while anything is running.

**Find in page.** ⌘F opens a bar in the corner with a live match count; Enter and ⌘G walk
forward, Shift for back, Escape clears the highlights.

**Reader view.** ⌘⇧R strips the page to its article — scored by paragraph density rather
than a fixed list of sites — and sets it in a single serif column on the same cream paper
as the browser. Press it again to put the page back exactly as it was, scroll position
included.

**Picture in picture.** ⌘⇧P pops the playing video out into a floating window that stays
above everything, using Chromium's own PiP rather than a copy of it.

**Sleeping tabs.** Background tabs let go of their page after fifteen minutes by default —
adjustable, or off — keeping their place in the sidebar in italic and reloading when
clicked. Settings shows how many are still holding memory and can put the rest to sleep now.

**Updates.** Installed copies check for a new release on launch and every six hours,
download it quietly and install it when you quit; the browser tells you when one is ready.
That is also how Chromium security fixes arrive, which was the honest gap before. Set your
GitHub username in `package.json` — the two `YOUR-GITHUB-USERNAME` placeholders — and the
release workflow feeds it.

**Extensions from a file.** Drop in a `.crx` or `.zip` and Zarc strips the signature
header, unpacks it and loads it; unpacked folders still work too. The one thing outside my
reach: Electron implements a subset of the Chrome extension APIs, so content-script,
storage and request extensions run while ones built on Chrome's own toolbar UI do not.
That is Electron's limit, not a setting — and with blocking built in, the extension most
people want is already here.

## Untested

Written without a machine to run it on: no `npm install`, no launch. Every file parses and
the APIs are used as documented, but a build this size will have a rough edge or two on
first run — most likely the cosmetic-filtering preload, reader view on an unusual layout,
or `<webview>` stacking. Failures are contained: the reader restores the page, the blocker
falls back to a built-in list, sync reports the error rather than destroying local state.
