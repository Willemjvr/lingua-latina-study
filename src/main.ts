import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

const IS_DEV = !app.isPackaged;
const DATA_DIR = IS_DEV
  ? path.join(__dirname, "..", "LatinData")
  : path.join(path.dirname(process.execPath), "LatinData");

let mainWindow: BrowserWindow | null = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const backups = path.join(DATA_DIR, "backups");
  if (!fs.existsSync(backups)) fs.mkdirSync(backups, { recursive: true });
}

function atomicWrite(filePath: string, data: string) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, filePath);
}

function dataPath(name: string) {
  return path.join(DATA_DIR, name);
}

function hashFile(filePath: string): string {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 24);
  } catch {
    return "";
  }
}

async function findCandidatePdfs() {
  const downloads = path.join(app.getPath("home"), "Downloads");
  if (!fs.existsSync(downloads)) return [];
  const entries = fs.readdirSync(downloads, { withFileTypes: true });
  const pdfs: { name: string; path: string }[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) {
      pdfs.push({ name: e.name, path: path.join(downloads, e.name) });
    }
  }
  return pdfs;
}

function scoreCandidate(name: string, kind: "reading" | "exercises"): number {
  const n = name.toLowerCase();
  let s = 0;
  if (kind === "reading") {
    if (n.includes("familia") || n.includes("romana")) s += 10;
    if (n.includes("lingua") && n.includes("latina")) s += 6;
    if (n.includes("reader") || n.includes("reading")) s += 4;
    if (n.includes("exercitia")) s -= 8;
    if (n.includes("answer")) s -= 5;
  } else {
    if (n.includes("exercitia") || n.includes("exercita")) s += 10;
    if (n.includes("lingua") && n.includes("latina")) s += 6;
    if (n.includes("exercise")) s += 4;
    if (n.includes("familia") && !n.includes("exercitia")) s -= 6;
    if (n.includes("answer")) s -= 3;
  }
  return s;
}

function createWindow() {
  ensureDataDir();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Lingua Latina Study",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (IS_DEV) {
    mainWindow.loadFile(path.join(__dirname, "..", "assets", "index.html"));
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "assets", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

ipcMain.handle("get-state", () => {
  try {
    const p = dataPath("state.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}
  return {};
});

ipcMain.handle("save-state", (_e, state: any) => {
  atomicWrite(dataPath("state.json"), JSON.stringify(state, null, 2));
});

ipcMain.handle("load-data", (_e, file: string) => {
  try {
    const p = dataPath(file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}
  return {};
});

ipcMain.handle("save-data", (_e, file: string, payload: any) => {
  atomicWrite(dataPath(file), JSON.stringify(payload, null, 2));
  // rolling daily backup
  try {
    const backups = path.join(DATA_DIR, "backups");
    const today = new Date().toISOString().slice(0, 10);
    const backupName = `${file.replace(/\.json$/, "")}-${today}.json`;
    fs.copyFileSync(dataPath(file), path.join(backups, backupName));
    const list = fs.readdirSync(backups).filter((x) => x.startsWith(file.replace(/\.json$/, ""))).sort();
    while (list.length > 10) {
      fs.unlinkSync(path.join(backups, list.shift()!));
    }
  } catch {}
});

ipcMain.handle("find-pdf-candidates", async () => {
  const pdfs = await findCandidatePdfs();
  return {
    reading: pdfs
      .slice()
      .sort((a, b) => scoreCandidate(b.name, "reading") - scoreCandidate(a.name, "reading"))[0] || null,
    exercises: pdfs
      .slice()
      .sort((a, b) => scoreCandidate(b.name, "exercises") - scoreCandidate(a.name, "exercises"))[0] || null,
    all: pdfs,
  };
});

ipcMain.handle("browse-pdf", async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    properties: ["openFile"],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("resolve-pdf", async (_e, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: "missing" };
    const buf = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 24);
    const ext = path.extname(filePath);
    const safeName = hash + ext;
    const cacheDir = path.join(DATA_DIR, "pdfcache");
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, safeName);
    if (!fs.existsSync(cached)) fs.copyFileSync(filePath, cached);
    return { ok: true, hash, cachedPath: cached, size: buf.length };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("hash-file", (_e, filePath: string) => hashFile(filePath));

ipcMain.handle("export-file", async (_e, data: { defaultName: string; content: string; filters?: any[] }) => {
  if (!mainWindow) return false;
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: data.defaultName,
    filters: data.filters || [{ name: "All Files", extensions: ["*"] }],
  });
  if (res.canceled || !res.filePath) return false;
  fs.writeFileSync(res.filePath, data.content, "utf-8");
  return true;
});

ipcMain.handle("export-buffer", async (_e, data: { defaultName: string; bufferBase64: string; filters?: any[] }) => {
  if (!mainWindow) return false;
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: data.defaultName,
    filters: data.filters || [{ name: "All Files", extensions: ["*"] }],
  });
  if (res.canceled || !res.filePath) return false;
  fs.writeFileSync(res.filePath, Buffer.from(data.bufferBase64, "base64"));
  return true;
});

ipcMain.handle("import-file", async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return { path: res.filePaths[0], content: fs.readFileSync(res.filePaths[0], "utf-8") };
});

ipcMain.handle("get-app-paths", () => ({
  dataDir: DATA_DIR,
  isDev: IS_DEV,
}));

ipcMain.handle("show-pdf", (_e, filePath: string) => {
  shell.openPath(filePath);
});

ipcMain.handle("alert", async (_e, msg: string) => {
  if (!mainWindow) return;
  await dialog.showMessageBox(mainWindow, { message: msg, buttons: ["OK"] });
});
