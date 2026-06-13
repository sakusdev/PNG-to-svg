import "./style.css";

type WorkerResult = {
  type: "result";
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  svg: string;
  uniqueInputColors: number;
  outputColors: number;
  rectCount: number;
  quantized: boolean;
};

type WorkerProgress = { type: "progress"; value: number; stage: string };

type ViewMode = "vectorizer" | "svgViewer";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app が見つかりません");

app.innerHTML = `
<div class="app">
  <header>
    <div>
      <h1>Million Color Canvas Vectorizer</h1>
      <div class="sub">画像を最大1,000,000色のSVGへ変換 / 巨大SVGをCanvasで高速表示</div>
    </div>
    <div class="mode-tabs" role="tablist">
      <button id="vectorizerTab" class="tab active" type="button">ベクター化</button>
      <button id="viewerTab" class="tab" type="button">高速SVG Viewer</button>
    </div>
  </header>

  <main>
    <aside class="controls">
      <section id="vectorizerControls">
        <div class="field">
          <label for="file">画像ファイル</label>
          <input id="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" />
        </div>

        <div class="field">
          <label for="colorRange">色数上限</label>
          <div class="range-row">
            <input id="colorRange" type="range" min="0" max="1000" value="767" />
            <input id="colorNumber" type="number" min="2" max="1000000" step="1" value="100000" />
          </div>
        </div>

        <div class="field">
          <label><input id="transparent" type="checkbox" checked /> 完全透明ピクセルを除外</label>
        </div>

        <div class="actions">
          <button id="vectorize" class="primary" disabled>ベクター化</button>
          <button id="download" disabled>SVG保存</button>
        </div>

        <button id="previewGenerated" class="wide" disabled>生成SVGを高速表示</button>

        <div class="progress"><div id="progressBar"></div></div>
        <div id="status" class="stats">画像を選択してください。</div>
        <p class="note">100万色ではSVGが非常に巨大になることがあります。ViewerはSVGを一度ラスタライズし、Canvas上で軽快にズーム・移動します。</p>
      </section>

      <section id="viewerControls" hidden>
        <div class="field">
          <label for="svgFile">SVGファイル</label>
          <input id="svgFile" type="file" accept=".svg,image/svg+xml" />
        </div>

        <div class="actions viewer-actions">
          <button id="fitView" class="primary" disabled>全体表示</button>
          <button id="actualSize" disabled>100%</button>
        </div>

        <div class="zoom-row">
          <button id="zoomOut" disabled>−</button>
          <span id="zoomLabel">100%</span>
          <button id="zoomIn" disabled>＋</button>
        </div>

        <div id="viewerStatus" class="stats">SVGを選択してください。\nドラッグ: 移動\nホイール / ピンチ: ズーム</div>
      </section>
    </aside>

    <section class="viewer">
      <div class="toolbar">
        <span id="canvasInfo">Canvas preview</span>
        <span id="viewerHint" hidden>ドラッグで移動・ホイール/ピンチでズーム</span>
      </div>
      <div id="canvasWrap" class="canvas-wrap">
        <canvas id="canvas"></canvas>
        <canvas id="viewerCanvas" hidden></canvas>
      </div>
    </section>
  </main>
</div>`;

const fileInput = must<HTMLInputElement>("#file");
const svgFileInput = must<HTMLInputElement>("#svgFile");
const colorRange = must<HTMLInputElement>("#colorRange");
const colorNumber = must<HTMLInputElement>("#colorNumber");
const transparent = must<HTMLInputElement>("#transparent");
const vectorizeButton = must<HTMLButtonElement>("#vectorize");
const downloadButton = must<HTMLButtonElement>("#download");
const previewGeneratedButton = must<HTMLButtonElement>("#previewGenerated");
const status = must<HTMLDivElement>("#status");
const viewerStatus = must<HTMLDivElement>("#viewerStatus");
const progressBar = must<HTMLDivElement>("#progressBar");
const canvasInfo = must<HTMLSpanElement>("#canvasInfo");
const viewerHint = must<HTMLSpanElement>("#viewerHint");
const canvasWrap = must<HTMLDivElement>("#canvasWrap");
const canvas = must<HTMLCanvasElement>("#canvas");
const viewerCanvas = must<HTMLCanvasElement>("#viewerCanvas");
const vectorizerTab = must<HTMLButtonElement>("#vectorizerTab");
const viewerTab = must<HTMLButtonElement>("#viewerTab");
const vectorizerControls = must<HTMLElement>("#vectorizerControls");
const viewerControls = must<HTMLElement>("#viewerControls");
const fitViewButton = must<HTMLButtonElement>("#fitView");
const actualSizeButton = must<HTMLButtonElement>("#actualSize");
const zoomOutButton = must<HTMLButtonElement>("#zoomOut");
const zoomInButton = must<HTMLButtonElement>("#zoomIn");
const zoomLabel = must<HTMLSpanElement>("#zoomLabel");

const context = canvas.getContext("2d", { willReadFrequently: true });
const viewerContext = viewerCanvas.getContext("2d", { alpha: true, desynchronized: true });
if (!context || !viewerContext) throw new Error("Canvas 2D context を取得できません");

let mode: ViewMode = "vectorizer";
let originalImageData: ImageData | null = null;
let currentFileName = "vectorized.svg";
let lastSvg = "";
let worker: Worker | null = null;

let viewerBitmap: ImageBitmap | null = null;
let viewerScale = 1;
let viewerOffsetX = 0;
let viewerOffsetY = 0;
let dragging = false;
let dragX = 0;
let dragY = 0;
let pinchDistance = 0;
const activePointers = new Map<number, PointerEvent>();

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`${selector} が見つかりません`);
  return el;
}

function sliderToColors(value: number): number {
  const t = value / 1000;
  return Math.max(2, Math.round(10 ** (Math.log10(2) + t * (6 - Math.log10(2)))));
}

function colorsToSlider(colors: number): number {
  const c = Math.max(2, Math.min(1_000_000, colors));
  return Math.round(1000 * ((Math.log10(c) - Math.log10(2)) / (6 - Math.log10(2))));
}

function setMode(nextMode: ViewMode): void {
  mode = nextMode;
  const isViewer = mode === "svgViewer";
  vectorizerControls.hidden = isViewer;
  viewerControls.hidden = !isViewer;
  canvas.hidden = isViewer;
  viewerCanvas.hidden = !isViewer;
  viewerHint.hidden = !isViewer;
  vectorizerTab.classList.toggle("active", !isViewer);
  viewerTab.classList.toggle("active", isViewer);
  canvasWrap.classList.toggle("interactive", isViewer);

  if (isViewer) {
    resizeViewerCanvas();
    renderViewer();
  }
}

vectorizerTab.addEventListener("click", () => setMode("vectorizer"));
viewerTab.addEventListener("click", () => setMode("svgViewer"));

colorRange.addEventListener("input", () => {
  colorNumber.value = String(sliderToColors(Number(colorRange.value)));
});

colorNumber.addEventListener("input", () => {
  const value = Math.max(2, Math.min(1_000_000, Number(colorNumber.value) || 2));
  colorRange.value = String(colorsToSlider(value));
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    setBusy(true, "画像を読み込み中");
    const bitmap = await createImageBitmap(file);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    originalImageData = context.getImageData(0, 0, canvas.width, canvas.height);
    currentFileName = `${file.name.replace(/\.[^.]+$/, "") || "image"}.svg`;
    canvasInfo.textContent = `${canvas.width} × ${canvas.height}px`;
    vectorizeButton.disabled = false;
    lastSvg = "";
    downloadButton.disabled = true;
    previewGeneratedButton.disabled = true;
    status.textContent = `読込完了\n${file.name}\n${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} px\n${(file.size / 1024 / 1024).toFixed(2)} MB`;
  } catch (error) {
    status.textContent = `読込エラー: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    setBusy(false);
  }
});

vectorizeButton.addEventListener("click", () => {
  if (!originalImageData) return;
  worker?.terminate();
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  setBusy(true, "処理を開始中");
  const copy = new Uint8ClampedArray(originalImageData.data);
  const started = performance.now();

  worker.onmessage = (event: MessageEvent<WorkerProgress | WorkerResult>) => {
    const msg = event.data;
    if (msg.type === "progress") {
      progressBar.style.width = `${Math.round(msg.value * 100)}%`;
      status.textContent = `${msg.stage}\n${Math.round(msg.value * 100)}%`;
      return;
    }

    lastSvg = msg.svg;
    const imageData = new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);
    context.putImageData(imageData, 0, 0);
    const elapsed = (performance.now() - started) / 1000;
    const svgMB = new Blob([msg.svg]).size / 1024 / 1024;
    status.textContent = [
      "完了",
      `入力ユニーク色: ${msg.uniqueInputColors.toLocaleString()}`,
      `出力色: ${msg.outputColors.toLocaleString()}`,
      `矩形ラン数: ${msg.rectCount.toLocaleString()}`,
      `量子化: ${msg.quantized ? "あり" : "なし（元色保持）"}`,
      `SVGサイズ: ${svgMB.toFixed(2)} MB`,
      `処理時間: ${elapsed.toFixed(2)} 秒`
    ].join("\n");
    downloadButton.disabled = false;
    previewGeneratedButton.disabled = false;
    setBusy(false);
    worker?.terminate();
    worker = null;
  };

  worker.onerror = event => {
    status.textContent = `Workerエラー: ${event.message}`;
    setBusy(false);
    worker?.terminate();
    worker = null;
  };

  worker.postMessage({
    type: "vectorize",
    width: originalImageData.width,
    height: originalImageData.height,
    pixels: copy,
    maxColors: Math.max(2, Math.min(1_000_000, Number(colorNumber.value))),
    ignoreTransparent: transparent.checked
  }, [copy.buffer]);
});

downloadButton.addEventListener("click", () => {
  if (!lastSvg) return;
  const blob = new Blob([lastSvg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = currentFileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

previewGeneratedButton.addEventListener("click", async () => {
  if (!lastSvg) return;
  setMode("svgViewer");
  await loadSvgBlob(new Blob([lastSvg], { type: "image/svg+xml;charset=utf-8" }), currentFileName);
});

svgFileInput.addEventListener("change", async () => {
  const file = svgFileInput.files?.[0];
  if (!file) return;
  await loadSvgBlob(file, file.name);
});

async function loadSvgBlob(blob: Blob, name: string): Promise<void> {
  viewerStatus.textContent = "SVGを読み込み中…";
  setViewerButtons(false);
  try {
    const started = performance.now();
    const bitmap = await createImageBitmap(blob);
    viewerBitmap?.close();
    viewerBitmap = bitmap;
    resizeViewerCanvas();
    fitViewer();
    const elapsed = performance.now() - started;
    viewerStatus.textContent = [
      "読込完了",
      name,
      `${bitmap.width.toLocaleString()} × ${bitmap.height.toLocaleString()} px`,
      `${(blob.size / 1024 / 1024).toFixed(2)} MB`,
      `初回描画: ${elapsed.toFixed(0)} ms`
    ].join("\n");
    canvasInfo.textContent = `${name} — ${bitmap.width} × ${bitmap.height}px`;
    setViewerButtons(true);
  } catch (error) {
    viewerStatus.textContent = `SVG読込エラー: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function resizeViewerCanvas(): void {
  const rect = canvasWrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (viewerCanvas.width !== width || viewerCanvas.height !== height) {
    viewerCanvas.width = width;
    viewerCanvas.height = height;
    viewerCanvas.style.width = `${rect.width}px`;
    viewerCanvas.style.height = `${rect.height}px`;
  }
}

function fitViewer(): void {
  if (!viewerBitmap) return;
  const rect = canvasWrap.getBoundingClientRect();
  viewerScale = Math.min(rect.width / viewerBitmap.width, rect.height / viewerBitmap.height) * 0.94;
  viewerScale = Math.max(0.0001, viewerScale);
  viewerOffsetX = (rect.width - viewerBitmap.width * viewerScale) / 2;
  viewerOffsetY = (rect.height - viewerBitmap.height * viewerScale) / 2;
  renderViewer();
}

function setActualSize(): void {
  if (!viewerBitmap) return;
  const rect = canvasWrap.getBoundingClientRect();
  viewerScale = 1;
  viewerOffsetX = (rect.width - viewerBitmap.width) / 2;
  viewerOffsetY = (rect.height - viewerBitmap.height) / 2;
  renderViewer();
}

function zoomAt(clientX: number, clientY: number, factor: number): void {
  if (!viewerBitmap) return;
  const rect = viewerCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const worldX = (x - viewerOffsetX) / viewerScale;
  const worldY = (y - viewerOffsetY) / viewerScale;
  const next = Math.max(0.0001, Math.min(128, viewerScale * factor));
  viewerOffsetX = x - worldX * next;
  viewerOffsetY = y - worldY * next;
  viewerScale = next;
  renderViewer();
}

function renderViewer(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewerContext.setTransform(1, 0, 0, 1, 0, 0);
  viewerContext.clearRect(0, 0, viewerCanvas.width, viewerCanvas.height);
  if (!viewerBitmap) return;
  viewerContext.setTransform(
    viewerScale * dpr,
    0,
    0,
    viewerScale * dpr,
    viewerOffsetX * dpr,
    viewerOffsetY * dpr
  );
  viewerContext.imageSmoothingEnabled = true;
  viewerContext.imageSmoothingQuality = "high";
  viewerContext.drawImage(viewerBitmap, 0, 0);
  zoomLabel.textContent = `${formatZoom(viewerScale)}%`;
}

function formatZoom(scale: number): string {
  const percent = scale * 100;
  if (percent >= 100) return Math.round(percent).toLocaleString();
  if (percent >= 10) return percent.toFixed(1);
  return percent.toFixed(2);
}

fitViewButton.addEventListener("click", fitViewer);
actualSizeButton.addEventListener("click", setActualSize);
zoomInButton.addEventListener("click", () => {
  const rect = viewerCanvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.25);
});
zoomOutButton.addEventListener("click", () => {
  const rect = viewerCanvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 0.8);
});

viewerCanvas.addEventListener("wheel", event => {
  event.preventDefault();
  zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
}, { passive: false });

viewerCanvas.addEventListener("pointerdown", event => {
  activePointers.set(event.pointerId, event);
  viewerCanvas.setPointerCapture(event.pointerId);
  dragging = activePointers.size === 1;
  dragX = event.clientX;
  dragY = event.clientY;
  if (activePointers.size === 2) pinchDistance = pointerDistance();
});

viewerCanvas.addEventListener("pointermove", event => {
  if (!activePointers.has(event.pointerId)) return;
  activePointers.set(event.pointerId, event);

  if (activePointers.size === 2) {
    const distance = pointerDistance();
    if (pinchDistance > 0 && distance > 0) {
      const center = pointerCenter();
      zoomAt(center.x, center.y, distance / pinchDistance);
    }
    pinchDistance = distance;
    return;
  }

  if (!dragging) return;
  viewerOffsetX += event.clientX - dragX;
  viewerOffsetY += event.clientY - dragY;
  dragX = event.clientX;
  dragY = event.clientY;
  renderViewer();
});

function endPointer(event: PointerEvent): void {
  activePointers.delete(event.pointerId);
  dragging = false;
  pinchDistance = 0;
  if (viewerCanvas.hasPointerCapture(event.pointerId)) viewerCanvas.releasePointerCapture(event.pointerId);
}

viewerCanvas.addEventListener("pointerup", endPointer);
viewerCanvas.addEventListener("pointercancel", endPointer);

function pointerDistance(): number {
  const [a, b] = [...activePointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function pointerCenter(): { x: number; y: number } {
  const [a, b] = [...activePointers.values()];
  if (!a || !b) return { x: 0, y: 0 };
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

function setViewerButtons(enabled: boolean): void {
  fitViewButton.disabled = !enabled;
  actualSizeButton.disabled = !enabled;
  zoomOutButton.disabled = !enabled;
  zoomInButton.disabled = !enabled;
}

function setBusy(busy: boolean, message?: string): void {
  fileInput.disabled = busy;
  colorRange.disabled = busy;
  colorNumber.disabled = busy;
  transparent.disabled = busy;
  vectorizeButton.disabled = busy || !originalImageData;
  if (busy) {
    downloadButton.disabled = true;
    previewGeneratedButton.disabled = true;
  } else if (lastSvg) {
    downloadButton.disabled = false;
    previewGeneratedButton.disabled = false;
  }
  if (message) status.textContent = message;
  if (!busy && progressBar.style.width !== "100%") progressBar.style.width = "0%";
}

window.addEventListener("resize", () => {
  if (mode !== "svgViewer") return;
  resizeViewerCanvas();
  renderViewer();
});
