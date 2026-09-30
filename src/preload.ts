import { contextBridge, ipcRenderer } from "electron";

const api = {
  getState: () => ipcRenderer.invoke("get-state"),
  saveState: (state: any) => ipcRenderer.invoke("save-state", state),
  loadData: (file: string) => ipcRenderer.invoke("load-data", file),
  saveData: (file: string, payload: any) => ipcRenderer.invoke("save-data", file, payload),
  findPdfCandidates: () => ipcRenderer.invoke("find-pdf-candidates"),
  browsePdf: () => ipcRenderer.invoke("browse-pdf"),
  resolvePdf: (filePath: string) => ipcRenderer.invoke("resolve-pdf", filePath),
  hashFile: (filePath: string) => ipcRenderer.invoke("hash-file", filePath),
  exportFile: (data: { defaultName: string; content: string; filters?: any[] }) => ipcRenderer.invoke("export-file", data),
  exportBuffer: (data: { defaultName: string; bufferBase64: string; filters?: any[] }) => ipcRenderer.invoke("export-buffer", data),
  importFile: () => ipcRenderer.invoke("import-file"),
  getAppPaths: () => ipcRenderer.invoke("get-app-paths"),
  getPdfjsPaths: () => ipcRenderer.invoke("get-pdfjs-paths"),
  showPdf: (filePath: string) => ipcRenderer.invoke("show-pdf", filePath),
  alert: (msg: string) => ipcRenderer.invoke("alert", msg),
};

contextBridge.exposeInMainWorld("llApi", api);
export type LlApi = typeof api;
