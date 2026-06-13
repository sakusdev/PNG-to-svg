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

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app が見つかりません");

app.innerHTML = `
<div class="app">
  <header>
    <h1>Million Color Canvas Vectorizer</h1>
    <div class="sub">画像を解析し、最大1,000,000色のSVG図形へ再構成</div>
  </header>
  <main>
    <aside class="controls">
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
        <label><input id="transparent" type="checkbox" checked /> 完全透明ピクセルをSVGから除外</label>
      </div>

      <div class="actions">
        <button id="vectorize" class="primary" disabled>ベクター化</button>
        <button id="download" disabled>SVG保存</button>
      </div>

      <div class="progress"><div id="progressBar"></div></div>
      <div id="status" class="stats">画像を選択してください。</div>
      <p class="note">100万色は指定可能ですが、写真を完全保持するとSVGが非常に巨大になります。出力は同色の横一列を1個の矩形パスとして統合します。</p>
    </aside>

    <section class="viewer">
      <div class="toolbar"><span id="canvasInfo">Canvas preview</span></div>
      <div class="canvas-wrap"><canvas id="canvas"></canvas></div>
    </section>
  </main>
</div>`;

const fileInput = must<HTMLInputElement>("#file");
const colorRange = must<HTMLInputElement>("#colorRange");
const colorNumber = must<HTMLInputElement>("#colorNumber");
const transparent = must<HTMLInputElement>("#transparent");
const vectorizeButton = must<HTMLButtonElement>("#vectorize");
const downloadButton = must<HTMLButtonElement>("#download");
const status = must<HTMLDivElement>("#status");
const progressBar = must<HTMLDivElement>("#progressBar");
const canvasInfo = must<HTMLSpanElement>("#canvasInfo");
const canvas = must<HTMLCanvasElement>("#canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
if (!context) throw new Error("Canvas 2D context を取得できません");

let originalImageData: ImageData | null = null;
let currentFileName = "vectorized.svg";
let lastSvg = "";
let worker: Worker | null = null;

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

function setBusy(busy: boolean, message?: string): void {
  fileInput.disabled = busy;
  colorRange.disabled = busy;
  colorNumber.disabled = busy;
  transparent.disabled = busy;
  vectorizeButton.disabled = busy || !originalImageData;
  if (busy) downloadButton.disabled = true;
  if (message) status.textContent = message;
  if (!busy && progressBar.style.width !== "100%") progressBar.style.width = "0%";
}
