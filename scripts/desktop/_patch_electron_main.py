#!/usr/bin/env python3
"""One-shot patcher for omnigent/web/electron/src/main.js (bundled desktop)."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
path = ROOT / "omnigent" / "web" / "electron" / "src" / "main.js"
text = path.read_text(encoding="utf-8")
original = text

# 1) requires
old_req = 'const serverManager = require("./server_manager");'
new_req = """const serverManager = require("./server_manager");
const desktopMode = require("./desktop_mode");
const processSupervisor = require("./process_supervisor");"""
if "desktop_mode" not in text:
    if old_req not in text:
        raise SystemExit("require block not found")
    text = text.replace(old_req, new_req, 1)

# 2) BOOT_PAGE
if "BOOT_PAGE" not in text:
    old_setup = """/** Absolute path to the bundled setup page (the "connect to server" form). */
const SETUP_PAGE = path.join(__dirname, "..", "setup", "index.html");"""
    new_setup = """/** Absolute path to the bundled setup page (the "connect to server" form). */
const SETUP_PAGE = path.join(__dirname, "..", "setup", "index.html");

/** Absolute path to the zero-config boot splash (bundled desktop mode). */
const BOOT_PAGE = path.join(__dirname, "..", "boot", "index.html");"""
    if old_setup not in text:
        raise SystemExit("SETUP_PAGE block not found")
    text = text.replace(old_setup, new_setup, 1)

# 3) createWindow: bundled saved URL + forceBootSplash
if "forceBootSplash" not in text:
    old_saved = """  const explicit =
    typeof targetUrl === "string" && /^https?:\\/\\//i.test(targetUrl) ? targetUrl : undefined;
  const saved = loadSettings().server_url;"""
    new_saved = """  const explicit =
    typeof targetUrl === "string" && /^https?:\\/\\//i.test(targetUrl) ? targetUrl : undefined;
  // Bundled zero-config: never ask for a server URL; always boot the local stack.
  const saved = desktopMode.isBundledMode()
    ? desktopMode.stackEndpoints().serverUrl + "/"
    : loadSettings().server_url;
  const forceBootSplash = desktopMode.isBundledMode() && !explicit && !opts.skipBoot;"""
    if old_saved not in text:
        raise SystemExit("createWindow saved-url block not found")
    text = text.replace(old_saved, new_saved, 1)

if "bootPending" not in text:
    old_load = """  if (destination) {
    void win.loadURL(destination);
  } else {
    // ?ephemeral=1 only changes the setup page's copy (the window's
    // WindowState is the source of truth for persistence behavior).
    const search = new URLSearchParams();
    if (ephemeral) search.set("ephemeral", "1");
    if (candidate && !destinationOrigin) {
      // Fail loud on a corrupt hand-edited settings.json: show WHY the
      // window landed on setup instead of silently presenting a blank form.
      search.set("error", "saved server URL in settings.json is not a valid URL");
      search.set("url", candidate);
    }
    void win.loadFile(SETUP_PAGE, search.size > 0 ? { search: search.toString() } : undefined);
  }"""
    new_load = """  if (forceBootSplash) {
    // Show splash first; boot IPC starts the stack then navigates to the SPA.
    windows.set(win, {
      origin: null,
      serverUrl: null,
      ephemeral,
      badgeCount: 0,
      bootPending: true,
    });
    void win.loadFile(BOOT_PAGE);
  } else if (destination) {
    void win.loadURL(destination);
  } else {
    // ?ephemeral=1 only changes the setup page's copy (the window's
    // WindowState is the source of truth for persistence behavior).
    const search = new URLSearchParams();
    if (ephemeral) search.set("ephemeral", "1");
    if (candidate && !destinationOrigin) {
      // Fail loud on a corrupt hand-edited settings.json: show WHY the
      // window landed on setup instead of silently presenting a blank form.
      search.set("error", "saved server URL in settings.json is not a valid URL");
      search.set("url", candidate);
    }
    void win.loadFile(SETUP_PAGE, search.size > 0 ? { search: search.toString() } : undefined);
  }"""
    if old_load not in text:
        raise SystemExit("createWindow load block not found")
    text = text.replace(old_load, new_load, 1)

# 4) window title
text = text.replace(
    'title: "Omnigent",',
    'title: desktopMode.isBundledMode() ? "私募研究工作台" : "Omnigent",',
    1,
)

# 5) app name
text = text.replace(
    'app.setName("Omnigent");',
    'app.setName(desktopMode.isBundledMode() ? "私募研究工作台" : "Omnigent");',
    1,
)

# 6) quit cleanup
if "processSupervisor.shutdownStack" not in text:
    old_quit = """    serverManager
      .shutdown(resolvedCliPath())
      .catch(() => {})
      .finally(() => {
        quitCleanupDone = true;
        app.quit();
      });"""
    new_quit = """    Promise.all([
      serverManager.shutdown(resolvedCliPath()).catch(() => {}),
      processSupervisor.shutdownStack().catch(() => {}),
    ]).finally(() => {
      quitCleanupDone = true;
      app.quit();
    });"""
    if old_quit not in text:
        raise SystemExit("before-quit block not found")
    text = text.replace(old_quit, new_quit, 1)

# 7) Boot IPC — insert before closing of registerIpc if not present
boot_ipc = """
  // Bundled boot splash → start local stack, then navigate to the SPA.
  ipcMain.handle("omnigent:boot-start-stack", async (event) => {
    const senderUrl = event.sender.getURL() || "";
    if (!senderUrl.startsWith("file:") || !senderUrl.includes("/boot/")) {
      // Also allow boot/index.html path variants (Windows file URLs).
      if (!senderUrl.includes("boot") || !senderUrl.endsWith("index.html")) {
        console.warn("[omnigent] boot-start-stack from untrusted sender dropped");
        return { ok: false, error: "boot-start-stack is only available from the boot page" };
      }
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    processSupervisor.onStatus((msg) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("omnigent:boot-status", msg);
      }
    });
    const result = await processSupervisor.ensureStackRunning();
    if (result.ok && result.serverUrl && win && !win.isDestroyed()) {
      const url = result.serverUrl.endsWith("/") ? result.serverUrl : result.serverUrl + "/";
      setWindowServerUrl(win, url);
      const state = windows.get(win);
      if (state) {
        state.origin = originOf(url);
        state.bootPending = false;
      }
      // Persist so thin-mode tools still see a saved URL if user toggles.
      const settings = loadSettings();
      settings.server_url = url;
      rememberRecentServer(settings, url);
      saveSettings(settings);
      void win.loadURL(url);
    }
    return result;
  });
"""

if "omnigent:boot-start-stack" not in text:
    # Insert before serverManager.onChange(broadcastHostStatus);
    anchor = "  serverManager.onChange(broadcastHostStatus);\n}"
    if anchor not in text:
        raise SystemExit("registerIpc end anchor not found")
    text = text.replace(anchor, boot_ipc + "\n" + anchor, 1)

if text == original:
    print("No changes (already patched?)")
else:
    path.write_text(text, encoding="utf-8")
    print(f"Patched {path}")
