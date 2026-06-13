/// <reference lib="webworker" />

export {};

type VectorizeRequest = {
  type: "vectorize";
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  maxColors: number;
  ignoreTransparent: boolean;
};

type ProgressMessage = { type: "progress"; value: number; stage: string };

type ResultMessage = {
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

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function postProgress(value: number, stage: string): void {
  const msg: ProgressMessage = { type: "progress", value, stage };
  ctx.postMessage(msg);
}

function rgbaKey(r: number, g: number, b: number, a: number): number {
  return (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}

function keyToRgba(key: number): [number, number, number, number] {
  return [(key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255, key & 255];
}

function channelBitsForLimit(maxColors: number): [number, number, number, number] {
  const capped = Math.max(2, Math.min(1_000_000, Math.floor(maxColors)));
  const totalBits = Math.max(1, Math.floor(Math.log2(capped)));
  let r = Math.floor(totalBits / 3);
  let g = r;
  let b = r;
  let remainder = totalBits - r * 3;
  if (remainder-- > 0) g++;
  if (remainder-- > 0) r++;
  if (remainder-- > 0) b++;
  r = Math.min(8, r);
  g = Math.min(8, g);
  b = Math.min(8, b);
  return [r, g, b, 8];
}

function quantizeChannel(value: number, bits: number): number {
  if (bits >= 8) return value;
  const levels = (1 << bits) - 1;
  return Math.round(Math.round((value / 255) * levels) * (255 / levels));
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

ctx.onmessage = (event: MessageEvent<VectorizeRequest>) => {
  const data = event.data;
  if (data.type !== "vectorize") return;

  const { width, height, maxColors, ignoreTransparent } = data;
  const input = data.pixels;
  const pixelCount = width * height;

  postProgress(0.04, "入力色を解析中");
  const unique = new Set<number>();
  for (let i = 0; i < input.length; i += 4) {
    const a = input[i + 3];
    if (ignoreTransparent && a === 0) continue;
    unique.add(rgbaKey(input[i], input[i + 1], input[i + 2], a));
  }
  const uniqueInputColors = unique.size;
  const quantized = uniqueInputColors > maxColors;
  const [rb, gb, bb] = channelBitsForLimit(maxColors);

  postProgress(0.16, quantized ? "色を量子化中" : "元の色を保持中");
  const output = new Uint8ClampedArray(input.length);
  const keys = new Uint32Array(pixelCount);
  const counts = new Map<number, number>();

  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    const a = input[i + 3];
    let r = input[i];
    let g = input[i + 1];
    let b = input[i + 2];
    if (quantized) {
      r = quantizeChannel(r, rb);
      g = quantizeChannel(g, gb);
      b = quantizeChannel(b, bb);
    }
    output[i] = r;
    output[i + 1] = g;
    output[i + 2] = b;
    output[i + 3] = a;
    const key = rgbaKey(r, g, b, a);
    keys[p] = key;
    if (!(ignoreTransparent && a === 0)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  postProgress(0.34, "同色ピクセルを横方向に統合中");
  const paths = new Map<number, string[]>();
  let rectCount = 0;

  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const start = y * width + x;
      const key = keys[start];
      const alpha = key & 255;
      let x2 = x + 1;
      while (x2 < width && keys[y * width + x2] === key) x2++;

      if (!(ignoreTransparent && alpha === 0)) {
        const list = paths.get(key) ?? [];
        list.push(`M${x} ${y}h${x2 - x}v1H${x}z`);
        paths.set(key, list);
        rectCount++;
      }
      x = x2;
    }
    if ((y & 31) === 0) postProgress(0.34 + 0.42 * (y / Math.max(1, height)), "SVGパスを生成中");
  }

  postProgress(0.80, "SVGを書き出し中");
  const sorted = [...paths.entries()].sort((a, b) => (counts.get(b[0]) ?? 0) - (counts.get(a[0]) ?? 0));
  const chunks: string[] = [];
  chunks.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges">`);
  chunks.push(`<metadata>${xmlEscape(JSON.stringify({ generator: "Million Color Canvas Vectorizer", maxColors, uniqueInputColors, outputColors: paths.size, rectCount }))}</metadata>`);

  for (const [key, segments] of sorted) {
    const [r, g, b, a] = keyToRgba(key);
    const fill = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    const opacity = a === 255 ? "" : ` fill-opacity="${(a / 255).toFixed(4)}"`;
    chunks.push(`<path fill="${fill}"${opacity} d="${segments.join("")}"/>`);
  }
  chunks.push(`</svg>`);
  const svg = chunks.join("");

  postProgress(1, "完了");
  const result: ResultMessage = {
    type: "result",
    width,
    height,
    pixels: output,
    svg,
    uniqueInputColors,
    outputColors: paths.size,
    rectCount,
    quantized
  };
  ctx.postMessage(result, [output.buffer]);
};
