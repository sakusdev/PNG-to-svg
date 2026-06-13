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

type Point = { x: number; y: number };
type Edge = { a: Point; b: Point };

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

function channelBitsForLimit(maxColors: number): [number, number, number] {
  const capped = Math.max(2, Math.min(1_000_000, Math.floor(maxColors)));
  const totalBits = Math.max(1, Math.floor(Math.log2(capped)));
  let r = Math.floor(totalBits / 3);
  let g = r;
  let b = r;
  let remainder = totalBits - r * 3;
  if (remainder-- > 0) g++;
  if (remainder-- > 0) r++;
  if (remainder-- > 0) b++;
  return [Math.min(8, r), Math.min(8, g), Math.min(8, b)];
}

function quantizeChannel(value: number, bits: number): number {
  if (bits >= 8) return value;
  const levels = (1 << bits) - 1;
  return Math.round(Math.round((value / 255) * levels) * (255 / levels));
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

function median3x3(input: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(input.length);
  const values = new Array<number>(9);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let count = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const sy = Math.max(0, Math.min(height - 1, y + oy));
          for (let ox = -1; ox <= 1; ox++) {
            const sx = Math.max(0, Math.min(width - 1, x + ox));
            values[count++] = input[(sy * width + sx) * 4 + channel];
          }
        }
        values.sort((a, b) => a - b);
        output[dst + channel] = values[4];
      }
      output[dst + 3] = input[dst + 3];
    }
  }
  return output;
}

function removeSmallRegions(keys: Uint32Array, width: number, height: number, minArea: number): void {
  const visited = new Uint8Array(keys.length);
  const queue = new Int32Array(keys.length);
  const component: number[] = [];
  const neighbours = new Map<number, number>();
  const directions = [-1, 1, -width, width];

  for (let start = 0; start < keys.length; start++) {
    if (visited[start]) continue;
    const color = keys[start];
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    component.length = 0;
    neighbours.clear();

    while (head < tail) {
      const index = queue[head++];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);

      for (const delta of directions) {
        const next = index + delta;
        if (next < 0 || next >= keys.length) continue;
        if (delta === -1 && x === 0) continue;
        if (delta === 1 && x === width - 1) continue;
        if (delta === -width && y === 0) continue;
        if (delta === width && y === height - 1) continue;

        if (keys[next] === color) {
          if (!visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        } else {
          neighbours.set(keys[next], (neighbours.get(keys[next]) ?? 0) + 1);
        }
      }
    }

    if (component.length >= minArea || neighbours.size === 0) continue;
    let replacement = color;
    let best = -1;
    for (const [candidate, count] of neighbours) {
      if (count > best) {
        best = count;
        replacement = candidate;
      }
    }
    for (const index of component) keys[index] = replacement;
  }
}

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function buildEdgesForColor(keys: Uint32Array, width: number, height: number, color: number): Edge[] {
  const edges: Edge[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (keys[index] !== color) continue;
      if (y === 0 || keys[index - width] !== color) edges.push({ a: { x, y }, b: { x: x + 1, y } });
      if (x === width - 1 || keys[index + 1] !== color) edges.push({ a: { x: x + 1, y }, b: { x: x + 1, y: y + 1 } });
      if (y === height - 1 || keys[index + width] !== color) edges.push({ a: { x: x + 1, y: y + 1 }, b: { x, y: y + 1 } });
      if (x === 0 || keys[index - 1] !== color) edges.push({ a: { x, y: y + 1 }, b: { x, y } });
    }
  }
  return edges;
}

function traceLoops(edges: Edge[]): Point[][] {
  const byStart = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = pointKey(edge.a);
    const list = byStart.get(key) ?? [];
    list.push(edge);
    byStart.set(key, list);
  }

  const loops: Point[][] = [];
  let remaining = edges.length;
  while (remaining > 0) {
    let first: Edge | undefined;
    for (const list of byStart.values()) {
      if (list.length) {
        first = list.pop();
        break;
      }
    }
    if (!first) break;
    remaining--;

    const loop: Point[] = [first.a, first.b];
    const startKey = pointKey(first.a);
    let current = first.b;
    let guard = 0;

    while (pointKey(current) !== startKey && guard++ < edges.length + 4) {
      const list = byStart.get(pointKey(current));
      const next = list?.pop();
      if (!next) break;
      remaining--;
      current = next.b;
      loop.push(current);
    }

    if (loop.length >= 4 && pointKey(loop[loop.length - 1]) === startKey) {
      loop.pop();
      loops.push(loop);
    }
  }
  return loops;
}

function chaikin(points: Point[], iterations: number): Point[] {
  let current = points;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next: Point[] = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    current = next;
  }
  return current;
}

function perpendicularDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 4) return points;
  const open = [...points, points[0]];

  function recurse(start: number, end: number, output: Point[]): void {
    let maxDistance = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const distance = perpendicularDistance(open[i], open[start], open[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index >= 0 && maxDistance > epsilon) {
      recurse(start, index, output);
      output.pop();
      recurse(index, end, output);
    } else {
      output.push(open[start], open[end]);
    }
  }

  const result: Point[] = [];
  recurse(0, open.length - 1, result);
  result.pop();
  return result.length >= 3 ? result : points;
}

function loopToPath(points: Point[]): string {
  if (points.length < 3) return "";
  const first = points[0];
  const last = points[points.length - 1];
  const startX = (last.x + first.x) / 2;
  const startY = (last.y + first.y) / 2;
  let path = `M${startX.toFixed(2)} ${startY.toFixed(2)}`;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    path += `Q${current.x.toFixed(2)} ${current.y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`;
  }
  return `${path}Z`;
}

ctx.onmessage = (event: MessageEvent<VectorizeRequest>) => {
  const data = event.data;
  if (data.type !== "vectorize") return;

  const { width, height, maxColors, ignoreTransparent } = data;
  const pixelCount = width * height;

  postProgress(0.03, "メディアンフィルタでノイズ除去中");
  const input = median3x3(data.pixels, width, height);

  postProgress(0.12, "入力色を解析中");
  const unique = new Set<number>();
  for (let i = 0; i < input.length; i += 4) {
    const a = input[i + 3];
    if (ignoreTransparent && a === 0) continue;
    unique.add(rgbaKey(input[i], input[i + 1], input[i + 2], a));
  }
  const uniqueInputColors = unique.size;
  const quantized = uniqueInputColors > maxColors;
  const [rb, gb, bb] = channelBitsForLimit(maxColors);

  postProgress(0.20, quantized ? "色を量子化中" : "元の色を保持中");
  const output = new Uint8ClampedArray(input.length);
  const keys = new Uint32Array(pixelCount);

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
    keys[p] = rgbaKey(r, g, b, a);
  }

  postProgress(0.34, "小さな孤立領域を除去中");
  removeSmallRegions(keys, width, height, 6);

  const counts = new Map<number, number>();
  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    const key = keys[p];
    const [r, g, b, a] = keyToRgba(key);
    output[i] = r;
    output[i + 1] = g;
    output[i + 2] = b;
    output[i + 3] = a;
    if (!(ignoreTransparent && a === 0)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const colors = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const chunks: string[] = [];
  let pathCount = 0;

  chunks.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="geometricPrecision">`);
  chunks.push(`<metadata>${xmlEscape(JSON.stringify({ generator: "Million Color Smooth Vectorizer", maxColors, uniqueInputColors, outputColors: colors.length, denoise: "median-3x3", minRegionArea: 6, contourSmoothing: "chaikin-2" }))}</metadata>`);

  for (let colorIndex = 0; colorIndex < colors.length; colorIndex++) {
    const color = colors[colorIndex];
    const [r, g, b, a] = keyToRgba(color);
    if (ignoreTransparent && a === 0) continue;

    const edges = buildEdgesForColor(keys, width, height, color);
    const loops = traceLoops(edges);
    const paths: string[] = [];

    for (const loop of loops) {
      if (loop.length < 4) continue;
      const smoothed = simplify(chaikin(loop, 2), 0.18);
      const path = loopToPath(smoothed);
      if (path) {
        paths.push(path);
        pathCount++;
      }
    }

    if (paths.length) {
      const fill = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      const opacity = a === 255 ? "" : ` fill-opacity="${(a / 255).toFixed(4)}"`;
      chunks.push(`<path fill="${fill}"${opacity} fill-rule="evenodd" d="${paths.join("")}"/>`);
    }

    if ((colorIndex & 7) === 0) {
      postProgress(0.40 + 0.55 * (colorIndex / Math.max(1, colors.length)), "輪郭を抽出して曲線化中");
    }
  }

  chunks.push("</svg>");
  const svg = chunks.join("");

  postProgress(1, "完了");
  const result: ResultMessage = {
    type: "result",
    width,
    height,
    pixels: output,
    svg,
    uniqueInputColors,
    outputColors: colors.length,
    rectCount: pathCount,
    quantized
  };
  ctx.postMessage(result, [output.buffer]);
};
