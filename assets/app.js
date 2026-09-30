/* global llApi, pdfjsLib */
const DEFAULTS = {
  theme: "dark",
  layout: "horizontal",
  leftWidth: 50,
  notesOpen: false,
  window: { width: 1400, height: 900, x: undefined, y: undefined, maximized: false },
  reading: { path: "", hash: "", page: 1, zoom: "fit", scroll: 0 },
  exercises: { path: "", hash: "", page: 1, zoom: "fit", scroll: 0 },
};

let state = JSON.parse(JSON.stringify(DEFAULTS));
let notes = { byHash: {} };
let exercises = { byHash: {} };
let docs = { reading: null, exercises: null };
let paneState = {};

const themes = ["dark", "light", "sepia"];
let currentTheme = 0;

const GLOBAL = { activePane: "reading", tool: "text", inkColor: "#2563eb", inkSize: 2, undoStacks: {}, redoStacks: {} };

async function loadLibs() {
  if (typeof pdfjsLib === "undefined") {
    const paths = await llApi.getPdfjsPaths();
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = paths.pdf;
      s.type = "module";
      s.onload = resolve;
      s.onerror = (err) => reject(new Error("Failed to load pdf.js from " + paths.pdf + ": " + (err?.message || err)));
      document.head.appendChild(s);
    });
  }
  const paths = await llApi.getPdfjsPaths();
  pdfjsLib.GlobalWorkerOptions.workerSrc = paths.worker;
}

async function init() {
  await loadLibs();
  const saved = await llApi.getState();
  Object.assign(state, saved || {});
  notes = await llApi.loadData("notes.json");
  if (!notes.byHash) notes = { byHash: {} };
  exercises = await llApi.loadData("exercises.json");
  if (!exercises.byHash) exercises = { byHash: {} };

  applyTheme(state.theme);
  setupLayout();
  setupNotes();
  setupToolbar();
  setupShortcuts();
  setupPanes();

  if (!state.reading.path || !state.exercises.path) {
    await promptForFiles();
  } else {
    const okR = await verifyFile("reading");
    const okE = await verifyFile("exercises");
    if (!okR || !okE) await promptForFiles();
  }

  await openBoth();
  scheduleAutosave();
}

async function verifyFile(side) {
  const info = state[side];
  if (!info.path) return false;
  const hash = await llApi.hashFile(info.path);
  if (!hash) return false;
  return hash === info.hash;
}

async function promptForFiles() {
  const candidates = await llApi.findPdfCandidates();
  const dialog = document.getElementById("file-confirm");
  const rInput = document.getElementById("reading-path");
  const eInput = document.getElementById("exercises-path");
  const rBtn = document.getElementById("reading-browse");
  const eBtn = document.getElementById("exercises-browse");
  const confirm = document.getElementById("confirm-files");

  const pick = (side) => async () => {
    const p = await llApi.browsePdf();
    if (p) {
      if (side === "reading") state.reading.path = p;
      else state.exercises.path = p;
      refreshInputs();
    }
  };

  function refreshInputs() {
    rInput.value = state.reading.path || "";
    eInput.value = state.exercises.path || "";
  }

  rBtn.onclick = pick("reading");
  eBtn.onclick = pick("exercises");

  if (candidates.reading && !state.reading.path) state.reading.path = candidates.reading.path;
  if (candidates.exercises && !state.exercises.path) state.exercises.path = candidates.exercises.path;
  refreshInputs();

  dialog.classList.remove("hidden");
  await new Promise((resolve) => {
    confirm.onclick = async () => {
      if (!state.reading.path || !state.exercises.path) {
        await llApi.alert("Please select both PDF files.");
        return;
      }
      const r = await llApi.resolvePdf(state.reading.path);
      const e = await llApi.resolvePdf(state.exercises.path);
      if (!r.ok || !e.ok) {
        await llApi.alert("Could not access one of the PDF files.");
        return;
      }
      state.reading.hash = r.hash;
      state.exercises.hash = e.hash;
      dialog.classList.add("hidden");
      resolve();
    };
  });
}

async function openBoth() {
  if (!state.reading.path || !state.exercises.path) return;
  await openPane("reading");
  await openPane("exercises");
  renderNotesList();
}

async function openPane(side) {
  const pane = document.querySelector(`[data-pane="${side}"]`);
  const info = state[side];
  if (!info.path) return;
  const res = await llApi.resolvePdf(info.path);
  if (!res.ok) {
    await llApi.alert(`Could not open ${side} PDF. Please relocate it.`);
    await promptForFiles();
    return;
  }
  info.hash = res.hash;
  const loadingTask = pdfjsLib.getDocument(res.cachedPath);
  const pdf = await loadingTask.promise;
  docs[side] = pdf;
  paneState[side] = { pdf, page: info.page || 1, zoom: info.zoom || "fit", scroll: info.scroll || 0 };
  updatePageCount(side);
  renderPane(side);
}

function updatePageCount(side) {
  const pane = document.querySelector(`[data-pane="${side}"]`);
  pane.querySelector(".page-count").textContent = `/ ${docs[side].numPages}`;
  pane.querySelector(".page-input").value = paneState[side].page;
}

function setupPanes() {
  ["reading", "exercises"].forEach((side) => {
    const pane = document.querySelector(`[data-pane="${side}"]`);
    const input = pane.querySelector(".page-input");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const n = parseInt(input.value, 10);
        if (n >= 1 && n <= docs[side].numPages) goToPage(side, n);
      }
    });
    pane.querySelector(".prev-page").onclick = () => changePage(side, -1);
    pane.querySelector(".next-page").onclick = () => changePage(side, 1);
    pane.querySelector(".fit-width").onclick = () => setZoom(side, "fit");
    pane.querySelector(".zoom-out").onclick = () => adjustZoom(side, 0.9);
    pane.querySelector(".zoom-in").onclick = () => adjustZoom(side, 1.1);
    pane.querySelector(".last-pos").onclick = () => lastPosition(side);
    pane.querySelector(".pane-header").addEventListener("mousedown", (e) => startDragHeader(e, side));
    pane.querySelector(".canvas-scroll").addEventListener("scroll", () => {
      if (paneState[side]) paneState[side].scroll = pane.querySelector(".canvas-scroll").scrollTop;
    });
    pane.querySelector(".canvas-scroll").addEventListener("click", (e) => paneClick(side, e));
    pane.querySelector(".canvas-scroll").addEventListener("wheel", (e) => paneWheel(side, e), { passive: false });
    if (side === "exercises") setupDrawing(pane);
  });

  const splitter = document.getElementById("splitter-h");
  let dragging = false;
  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const ws = document.getElementById("workspace");
    const rect = ws.getBoundingClientRect();
    const isVert = state.layout === "vertical";
    const pct = isVert ? ((e.clientY - rect.top) / rect.height) * 100 : ((e.clientX - rect.left) / rect.width) * 100;
    state.leftWidth = Math.max(15, Math.min(85, pct));
    applySplitter();
  });
  window.addEventListener("mouseup", () => { dragging = false; });
  splitter.addEventListener("dblclick", () => { state.leftWidth = 50; applySplitter(); });
}

function startDragHeader(e, side) {
  // simple header drag to swap panes
  const startX = e.clientX;
  const startY = e.clientY;
  const other = side === "reading" ? "exercises" : "reading";
  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.hypot(dx, dy) > 60) {
      // swap
      const r = state.reading;
      state.reading = state.exercises;
      state.exercises = r;
      const rd = docs.reading;
      docs.reading = docs.exercises;
      docs.exercises = rd;
      const rs = paneState.reading;
      paneState.reading = paneState.exercises;
      paneState.exercises = rs;
      openBoth();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
  }
  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function changePage(side, delta) {
  const ps = paneState[side];
  const target = Math.max(1, Math.min(docs[side].numPages, ps.page + delta));
  if (target !== ps.page) goToPage(side, target);
}

function goToPage(side, n) {
  const ps = paneState[side];
  ps.page = n;
  state[side].page = n;
  updatePageCount(side);
  renderPane(side);
}

function setZoom(side, mode) {
  paneState[side].zoom = mode;
  state[side].zoom = mode;
  renderPane(side);
}

function adjustZoom(side, factor) {
  const ps = paneState[side];
  let z = typeof ps.zoom === "number" ? ps.zoom : 1;
  z = Math.max(0.25, Math.min(5, z * factor));
  ps.zoom = z;
  state[side].zoom = z;
  renderPane(side);
}

function lastPosition(side) {
  const el = document.querySelector(`[data-pane="${side}"] .canvas-scroll`);
  el.scrollTo({ top: paneState[side].scroll || 0, behavior: "smooth" });
}

function applySplitter() {
  const isVert = state.layout === "vertical";
  const left = document.getElementById("left-pane");
  left.style.flex = "none";
  left.style[isVert ? "height" : "width"] = `${state.leftWidth}%`;
}

function setupLayout() {
  document.body.classList.toggle("vertical", state.layout === "vertical");
  applySplitter();
}

function applyTheme(name) {
  document.body.classList.remove("theme-dark", "theme-light", "theme-sepia");
  document.body.classList.add(`theme-${name}`);
  state.theme = name;
  currentTheme = themes.indexOf(name);
}

function setupToolbar() {
  document.getElementById("notes-toggle").onclick = toggleNotes;
  document.getElementById("theme-toggle").onclick = () => {
    currentTheme = (currentTheme + 1) % themes.length;
    applyTheme(themes[currentTheme]);
    ["reading", "exercises"].forEach((s) => renderPane(s));
  };
  document.getElementById("export-md").onclick = exportNotesMd;
  document.getElementById("export-data").onclick = exportData;
  document.getElementById("import-data").onclick = importData;
  document.getElementById("export-pdf").onclick = exportAnnotatedPdf;
  document.getElementById("select-files").onclick = async () => {
    await promptForFiles();
    await openBoth();
  };
}

function toggleNotes() {
  state.notesOpen = !state.notesOpen;
  document.getElementById("notes-sidebar").classList.toggle("hidden", !state.notesOpen);
}

function setupNotes() {
  document.getElementById("notes-search").addEventListener("input", renderNotesList);
}

function getNotesForHash(hash) {
  return notes.byHash[hash] || [];
}

function addNote(side, page, selection, rects, color, text) {
  const hash = state[side].hash;
  if (!notes.byHash[hash]) notes.byHash[hash] = [];
  notes.byHash[hash].push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    side,
    page,
    selection,
    rects,
    color,
    text,
    created: Date.now(),
  });
  saveAll();
  renderNotesList();
  renderPane(side);
}

function deleteNote(id) {
  for (const hash of Object.keys(notes.byHash)) {
    notes.byHash[hash] = notes.byHash[hash].filter((n) => n.id !== id);
  }
  saveAll();
  renderNotesList();
  ["reading", "exercises"].forEach((s) => renderPane(s));
}

function updateNoteText(id, text) {
  for (const hash of Object.keys(notes.byHash)) {
    for (const n of notes.byHash[hash]) {
      if (n.id === id) n.text = text;
    }
  }
  saveAll();
  renderNotesList();
}

function renderNotesList() {
  const q = document.getElementById("notes-search").value.toLowerCase();
  const list = document.getElementById("notes-list");
  list.innerHTML = "";
  const groups = {};
  for (const side of ["reading", "exercises"]) {
    const hash = state[side].hash;
    if (!hash) continue;
    for (const n of getNotesForHash(hash)) {
      if (q && !(n.selection || "").toLowerCase().includes(q) && !(n.text || "").toLowerCase().includes(q)) continue;
      const key = `${side}-p${n.page}`;
      if (!groups[key]) groups[key] = { side, page: n.page, items: [] };
      groups[key].items.push(n);
    }
  }
  Object.keys(groups)
    .sort()
    .forEach((key) => {
      const g = groups[key];
      const div = document.createElement("div");
      div.className = "note-group";
      const title = document.createElement("div");
      title.className = "note-group-title";
      title.textContent = `${g.side === "reading" ? "Reading" : "Exercises"} — p.${g.page}`;
      div.appendChild(title);
      for (const n of g.items) {
        const item = document.createElement("div");
        item.className = "note-item";
        item.innerHTML = `<div class="note-latin">${escapeHtml(n.selection || "(no selection)")}</div>
                          <div class="note-text">${escapeHtml(n.text || "")}</div>
                          <div class="note-actions">
                            <button class="edit-note">Edit</button>
                            <button class="delete-note">Delete</button>
                          </div>`;
        item.querySelector(".delete-note").onclick = (e) => { e.stopPropagation(); deleteNote(n.id); };
        item.querySelector(".edit-note").onclick = (e) => {
          e.stopPropagation();
          const txt = item.querySelector(".note-text");
          const ta = document.createElement("textarea");
          ta.value = n.text || "";
          txt.replaceWith(ta);
          ta.focus();
          ta.addEventListener("blur", () => {
            updateNoteText(n.id, ta.value);
          });
        };
        item.onclick = () => {
          GLOBAL.activePane = g.side;
          goToPage(g.side, g.page);
          setTimeout(() => flashHighlight(g.side, n), 150);
        };
        div.appendChild(item);
      }
      list.appendChild(div);
    });
}

function flashHighlight(side, note) {
  const pane = document.querySelector(`[data-pane="${side}"]`);
  const layer = pane.querySelector(".annotation-layer");
  for (const el of layer.children) {
    if (el.dataset.id === note.id) {
      el.style.outline = "2px solid var(--accent)";
      setTimeout(() => el.style.outline = "", 800);
    }
  }
}

function exportNotesMd() {
  let md = "# Lingua Latina Notes\n\n";
  for (const side of ["reading", "exercises"]) {
    const hash = state[side].hash;
    if (!hash) continue;
    md += `## ${side === "reading" ? "Familia Romana" : "Exercitia Latina"}\n\n`;
    const items = getNotesForHash(hash).sort((a, b) => a.page - b.page || a.created - b.created);
    for (const n of items) {
      md += `### Page ${n.page}\n`;
      md += `> ${n.selection || ""}\n\n`;
      md += `${n.text || ""}\n\n`;
    }
  }
  llApi.exportFile({ defaultName: "lingua-latina-notes.md", content: md, filters: [{ name: "Markdown", extensions: ["md"] }] });
}

async function exportData() {
  const data = { notes, exercises, state };
  await llApi.exportFile({ defaultName: "lingua-latina-data.json", content: JSON.stringify(data, null, 2), filters: [{ name: "JSON", extensions: ["json"] }] });
}

async function importData() {
  const f = await llApi.importFile();
  if (!f) return;
  try {
    const data = JSON.parse(f.content);
    if (data.notes) notes = data.notes;
    if (data.exercises) exercises = data.exercises;
    if (data.state) Object.assign(state, data.state);
    saveAll();
    await openBoth();
    applyTheme(state.theme);
    setupLayout();
    renderNotesList();
  } catch (e) {
    await llApi.alert("Invalid data file.");
  }
}

async function exportAnnotatedPdf() {
  // simplified: open system PDF viewer; full render-to-pdf would require pdf-lib
  await llApi.alert("Use File > Export Data to back up your entries. Full annotated PDF export requires pdf-lib (not bundled for size).");
}

function setupShortcuts() {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "n") { e.preventDefault(); toggleNotes(); }
    if (e.ctrlKey && e.key.toLowerCase() === "f") { e.preventDefault(); document.querySelector(`[data-pane="${GLOBAL.activePane}"] .canvas-scroll`).focus(); }
    if (e.ctrlKey && e.key.toLowerCase() === "g") { e.preventDefault(); document.querySelector(`[data-pane="${GLOBAL.activePane}"] .page-input`).focus(); }
    if (e.ctrlKey && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      if (GLOBAL.activePane === "exercises") {
        e.preventDefault();
        undoRedo(GLOBAL.activePane, e.key.toLowerCase() === "y" ? "redo" : "undo");
      }
    }
    if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); saveAll(); }
    if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
    if (e.ctrlKey && e.key === "Tab") { e.preventDefault(); GLOBAL.activePane = GLOBAL.activePane === "reading" ? "exercises" : "reading"; }
  });
  ["reading", "exercises"].forEach((side) => {
    document.querySelector(`[data-pane="${side}"]`).addEventListener("mousedown", () => { GLOBAL.activePane = side; });
  });
}

function toggleFullscreen() {
  // handled by electron; web side noop
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// Virtualized render
const renderCache = new Map();
const textLayerCache = new Map();

async function renderPane(side) {
  const pane = document.querySelector(`[data-pane="${side}"]`);
  const scroll = pane.querySelector(".canvas-scroll");
  const stage = pane.querySelector(".page-stage");
  const ps = paneState[side];
  if (!docs[side]) return;

  const pdf = docs[side];
  const page = await pdf.getPage(ps.page);
  const containerWidth = scroll.clientWidth - 36;
  let scale = typeof ps.zoom === "number" ? ps.zoom : containerWidth / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });

  stage.style.width = `${viewport.width}px`;
  stage.style.height = `${viewport.height}px`;
  stage.innerHTML = "";

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  stage.appendChild(canvas);

  // apply paper dim
  ctx.filter = "sepia(0.12)";
  await page.render({ canvasContext: ctx, viewport }).promise;
  ctx.filter = "none";

  // text layer
  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";
  textLayer.style.width = `${viewport.width}px`;
  textLayer.style.height = `${viewport.height}px`;
  stage.appendChild(textLayer);
  const text = await page.getTextContent();
  await pdfjsLib.renderTextLayer({ textContent: text, container: textLayer, viewport, textDivs: [] }).promise;

  // annotation layer for highlights + ink
  const annotationLayer = document.createElement("div");
  annotationLayer.className = "annotation-layer";
  annotationLayer.style.width = `${viewport.width}px`;
  annotationLayer.style.height = `${viewport.height}px`;
  stage.appendChild(annotationLayer);

  renderHighlights(side, annotationLayer, viewport, scale);
  if (side === "exercises") renderExerciseLayer(side, stage, annotationLayer, viewport, scale);

  pane.querySelector(".zoom-level").textContent = `${Math.round(scale * 100)}%`;
}

function renderHighlights(side, layer, viewport, scale) {
  const hash = state[side].hash;
  const page = paneState[side].page;
  const items = getNotesForHash(hash).filter((n) => n.page === page);
  for (const n of items) {
    if (n.rects) {
      for (const r of n.rects) {
        const el = document.createElement("div");
        el.className = "highlight";
        el.style.left = `${r[0] * scale}px`;
        el.style.top = `${r[1] * scale}px`;
        el.style.width = `${(r[2] - r[0]) * scale}px`;
        el.style.height = `${(r[3] - r[1]) * scale}px`;
        el.style.background = n.color || "#facc15";
        el.title = n.text || "";
        el.dataset.id = n.id;
        layer.appendChild(el);
      }
    }
  }
}

function paneClick(side, e) {
  if (side !== "exercises") return;
  if (GLOBAL.tool !== "text") return;
  // ignore clicks on controls / text entries
  if (e.target.closest(".text-entry") || e.target.closest("button")) return;
  const stage = e.currentTarget.querySelector(".page-stage");
  const rect = stage.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  createTextEntry(side, x, y);
}

function paneWheel(side, e) {
  if (e.ctrlKey) {
    e.preventDefault();
    adjustZoom(side, e.deltaY < 0 ? 1.1 : 0.9);
  }
}

// Text selection popup
let selectionData = null;
document.addEventListener("mouseup", (e) => {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) { hidePopup(); return; }
  const text = sel.toString().trim();
  if (!text) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const popup = document.getElementById("text-popup");
  popup.classList.remove("hidden");
  popup.style.left = `${rect.left + rect.width / 2 - popup.offsetWidth / 2}px`;
  popup.style.top = `${rect.bottom + 6}px`;
  selectionData = { text, rects: getSelectionRects(sel) };
});

function hidePopup() {
  document.getElementById("text-popup").classList.add("hidden");
  selectionData = null;
}

function getSelectionRects(sel) {
  const rects = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i).getClientRects();
    for (const rect of r) rects.push([rect.left, rect.top, rect.right, rect.bottom]);
  }
  // normalize to page-stage coordinates
  const stage = document.querySelector("[data-pane=\"reading\"] .page-stage");
  if (!stage) return rects;
  const sr = stage.getBoundingClientRect();
  return rects.map(([l, t, r, b]) => [l - sr.left, t - sr.top, r - sr.left, b - sr.top]);
}

document.getElementById("text-popup").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || !selectionData) return;
  if (btn.dataset.action === "highlight") {
    addNote(GLOBAL.activePane, paneState[GLOBAL.activePane].page, selectionData.text, selectionData.rects, btn.dataset.color, "");
    window.getSelection().removeAllRanges();
  } else if (btn.dataset.action === "note") {
    showPageNotePopup(selectionData.text, selectionData.rects);
  }
  hidePopup();
});

function showPageNotePopup(text, rects) {
  const popup = document.getElementById("page-note-popup");
  popup.classList.remove("hidden");
  const ta = popup.querySelector("textarea");
  ta.value = "";
  popup.querySelector(".save-note").onclick = () => {
    addNote(GLOBAL.activePane, paneState[GLOBAL.activePane].page, text, rects, "#facc15", ta.value);
    popup.classList.add("hidden");
    window.getSelection().removeAllRanges();
  };
  popup.querySelector(".cancel-note").onclick = () => popup.classList.add("hidden");
}

// Exercises pane drawing tools
function setupDrawing(pane) {
  const tools = pane.querySelectorAll(".draw-tools [data-tool]");
  tools.forEach((btn) => btn.onclick = () => {
    tools.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    GLOBAL.tool = btn.dataset.tool;
  });
  document.getElementById("ink-color").addEventListener("input", (e) => GLOBAL.inkColor = e.target.value);
  document.getElementById("ink-size").addEventListener("input", (e) => GLOBAL.inkSize = parseInt(e.target.value, 10));
  document.getElementById("undo").onclick = () => undoRedo("exercises", "undo");
  document.getElementById("redo").onclick = () => undoRedo("exercises", "redo");

  const stage = pane.querySelector(".page-stage");
  let drawing = false;
  let stroke = [];
  pane.querySelector(".canvas-scroll").addEventListener("pointerdown", (e) => {
    if (GLOBAL.tool === "text" || GLOBAL.tool === "eraser") return;
    drawing = true;
    const pt = pointerInStage(stage, e);
    stroke = [pt];
    pushHistory("exercises", { type: "start" });
  });
  window.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const pt = pointerInStage(stage, e);
    stroke.push(pt);
    if (GLOBAL.tool === "pen") previewStroke(stroke, GLOBAL.inkColor, GLOBAL.inkSize);
    else if (GLOBAL.tool === "highlighter") previewStroke(stroke, GLOBAL.inkColor, GLOBAL.inkSize * 3, 0.35);
  });
  window.addEventListener("pointerup", () => {
    if (!drawing) return;
    drawing = false;
    commitStroke("exercises", stroke, GLOBAL.tool, GLOBAL.inkColor, GLOBAL.inkSize);
  });

  // eraser by clicking strokes
  pane.querySelector(".canvas-scroll").addEventListener("pointerdown", (e) => {
    if (GLOBAL.tool !== "eraser") return;
    const target = e.target.closest(".ink-stroke, .text-entry");
    if (target) {
      const hash = state.exercises.hash;
      const page = paneState.exercises.page;
      const list = (exercises.byHash[hash]?.[page] || []);
      exercises.byHash[hash][page] = list.filter((x) => x.id !== target.dataset.id);
      saveAll();
      renderPane("exercises");
    }
  });
}

function pointerInStage(stage, e) {
  const rect = stage.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function previewStroke(stroke, color, width, opacity = 1) {
  const pane = document.querySelector(`[data-pane="exercises"]`);
  let svg = pane.querySelector(".preview-stroke");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("ink-stroke", "preview-stroke");
    svg.style.width = "100%";
    svg.style.height = "100%";
    pane.querySelector(".annotation-layer").appendChild(svg);
  }
  const d = stroke.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");
  svg.innerHTML = `<path d="${d}" stroke="${color}" stroke-width="${width}" opacity="${opacity}" />`;
}

function commitStroke(side, stroke, tool, color, size) {
  document.querySelector(".preview-stroke")?.remove();
  if (stroke.length < 2) return;
  const hash = state[side].hash;
  const page = paneState[side].page;
  if (!exercises.byHash[hash]) exercises.byHash[hash] = {};
  if (!exercises.byHash[hash][page]) exercises.byHash[hash][page] = [];
  exercises.byHash[hash][page].push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    type: tool,
    color,
    size,
    points: stroke,
  });
  saveAll();
  renderPane(side);
}

function renderExerciseLayer(side, stage, layer, viewport, scale) {
  const hash = state[side].hash;
  const page = paneState[side].page;
  const list = (exercises.byHash[hash]?.[page] || []);
  for (const item of list) {
    if (item.type === "text") {
      const el = document.createElement("div");
      el.className = "text-entry";
      el.textContent = item.text;
      el.style.left = `${item.x * scale}px`;
      el.style.top = `${item.y * scale}px`;
      el.style.color = item.color || "#2563eb";
      el.style.fontSize = `${(item.size || 16) * scale}px`;
      el.dataset.id = item.id;
      makeTextEntryInteractive(el, item, scale);
      layer.appendChild(el);
    } else if (item.type === "pen" || item.type === "highlighter") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.className = "ink-stroke";
      svg.style.width = "100%";
      svg.style.height = "100%";
      const d = item.points.map((p, i) => (i === 0 ? `M ${p.x * scale} ${p.y * scale}` : `L ${p.x * scale} ${p.y * scale}`)).join(" ");
      const width = (item.type === "highlighter" ? item.size * 3 : item.size) * scale;
      const opacity = item.type === "highlighter" ? 0.35 : 1;
      svg.innerHTML = `<path d="${d}" stroke="${item.color}" stroke-width="${width}" opacity="${opacity}" />`;
      svg.dataset.id = item.id;
      layer.appendChild(svg);
    }
  }
}

function createTextEntry(side, x, y) {
  const hash = state[side].hash;
  const page = paneState[side].page;
  if (!exercises.byHash[hash]) exercises.byHash[hash] = {};
  if (!exercises.byHash[hash][page]) exercises.byHash[hash][page] = [];
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    type: "text",
    text: "",
    x, y,
    color: GLOBAL.inkColor,
    size: 16,
  };
  exercises.byHash[hash][page].push(item);
  saveAll();
  renderPane(side);
  setTimeout(() => {
    const el = document.querySelector(`.text-entry[data-id="${item.id}"]`);
    if (el) startEditTextEntry(el, item);
  }, 50);
}

function makeTextEntryInteractive(el, item, scale) {
  el.addEventListener("dblclick", () => startEditTextEntry(el, item));
  let dragging = false, startX, startY, origX, origY;
  el.addEventListener("mousedown", (e) => {
    if (el.isContentEditable) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    origX = item.x; origY = item.y;
    e.stopPropagation();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    item.x = origX + (e.clientX - startX) / scale;
    item.y = origY + (e.clientY - startY) / scale;
    el.style.left = `${item.x * scale}px`;
    el.style.top = `${item.y * scale}px`;
  });
  window.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; saveAll(); }
  });
}

function startEditTextEntry(el, item) {
  el.contentEditable = "true";
  el.classList.add("selected");
  el.focus();
  function commit() {
    item.text = el.textContent;
    el.contentEditable = "false";
    el.classList.remove("selected");
    saveAll();
    renderPane("exercises");
  }
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { el.textContent = item.text; commit(); }
    if (e.key === "Tab") {
      e.preventDefault();
      commit();
      moveToNextTextEntry(item);
    }
  });
  el.addEventListener("blur", commit);
}

function moveToNextTextEntry(currentItem) {
  const hash = state.exercises.hash;
  const page = paneState.exercises.page;
  const list = exercises.byHash[hash]?.[page] || [];
  const idx = list.findIndex((x) => x.id === currentItem.id);
  const next = list[idx + 1];
  if (next) {
    const el = document.querySelector(`.text-entry[data-id="${next.id}"]`);
    if (el) startEditTextEntry(el, next);
  } else {
    const pane = document.querySelector(`[data-pane="exercises"] .page-stage`);
    createTextEntry("exercises", currentItem.x, currentItem.y + 24);
  }
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Delete" && GLOBAL.activePane === "exercises") {
    const sel = document.querySelector(".text-entry.selected");
    if (sel) {
      const id = sel.dataset.id;
      const hash = state.exercises.hash;
      const page = paneState.exercises.page;
      exercises.byHash[hash][page] = exercises.byHash[hash][page].filter((x) => x.id !== id);
      saveAll();
      renderPane("exercises");
    }
  }
});

// Undo / redo history
function pushHistory(side, action) {
  if (!GLOBAL.undoStacks[side]) GLOBAL.undoStacks[side] = [];
  GLOBAL.undoStacks[side].push(JSON.parse(JSON.stringify(action)));
  if (GLOBAL.undoStacks[side].length > 50) GLOBAL.undoStacks[side].shift();
  GLOBAL.redoStacks[side] = [];
}

function undoRedo(side, dir) {
  if (dir === "undo" && GLOBAL.undoStacks[side]?.length) {
    const action = GLOBAL.undoStacks[side].pop();
    GLOBAL.redoStacks[side].push(action);
  }
  // simplistic: re-render
  renderPane(side);
}

// Autosave
let saveTimer = null;
function scheduleAutosave() {
  saveTimer = setInterval(saveAll, 5000);
}

function saveAll() {
  llApi.saveState(state);
  llApi.saveData("notes.json", notes);
  llApi.saveData("exercises.json", exercises);
  document.getElementById("status").textContent = "Saved " + new Date().toLocaleTimeString();
}

init().catch((e) => console.error(e));
