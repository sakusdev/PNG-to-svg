import { defineConfig, type Plugin } from "vite";

function runtimeFixesPlugin(): Plugin {
  return {
    name: "runtime-fixes",
    enforce: "pre",
    transform(code, id) {
      if (id.endsWith("/src/main.ts")) {
        const bitmapTarget = "const bitmap = await createImageBitmap(blob);";
        const transparentField = `<div class="field">\n          <label><input id="transparent" type="checkbox" checked /> 完全透明ピクセルを除外</label>\n        </div>`;
        const zoomRow = `<div class="zoom-row">\n          <button id="zoomOut" disabled>−</button>\n          <span id="zoomLabel">100%</span>\n          <button id="zoomIn" disabled>＋</button>\n        </div>`;

        let next = code.replace(bitmapTarget, "const bitmap = await decodeSvgBlob(blob);");
        next = next.replace(
          transparentField,
          `<div class="field">\n          <label><input id="transparent" type="checkbox" checked disabled /> 透明部分を背景色で塗りつぶす</label>\n        </div>\n\n        <div class="field">\n          <label><input id="denoise" type="checkbox" checked /> ノイズ除去を有効化</label>\n        </div>`
        );
        next = next.replace(
          zoomRow,
          `${zoomRow}\n\n        <div class="field">\n          <label>PNG出力解像度</label>\n          <div class="range-row">\n            <input id="pngWidth" type="number" min="1" max="32768" step="1" value="1920" aria-label="PNG幅" />\n            <input id="pngHeight" type="number" min="1" max="32768" step="1" value="1080" aria-label="PNG高さ" />\n          </div>\n        </div>\n\n        <div class="field">\n          <label><input id="pngKeepAspect" type="checkbox" checked /> 縦横比を維持</label>\n        </div>\n\n        <button id="exportPng" class="wide" disabled>指定解像度でPNG保存</button>`
        );
        next = next.replace(
          'const transparent = must<HTMLInputElement>("#transparent");',
          'const transparent = must<HTMLInputElement>("#transparent");\nconst denoise = must<HTMLInputElement>("#denoise");'
        );
        next = next.replace(
          'const zoomLabel = must<HTMLSpanElement>("#zoomLabel");',
          'const zoomLabel = must<HTMLSpanElement>("#zoomLabel");\nconst pngWidth = must<HTMLInputElement>("#pngWidth");\nconst pngHeight = must<HTMLInputElement>("#pngHeight");\nconst pngKeepAspect = must<HTMLInputElement>("#pngKeepAspect");\nconst exportPngButton = must<HTMLButtonElement>("#exportPng");'
        );
        next = next.replace(
          'let viewerBitmap: ImageBitmap | null = null;',
          'let viewerBitmap: ImageBitmap | null = null;\nlet viewerSvgBlob: Blob | null = null;\nlet viewerSvgName = "vectorized.svg";\nlet viewerAspectRatio = 1;\nlet syncingPngSize = false;'
        );
        next = next.replace(
          'ignoreTransparent: transparent.checked\n  }, [copy.buffer]);',
          'ignoreTransparent: false,\n    enableDenoise: denoise.checked\n  }, [copy.buffer]);'
        );
        next = next.replace(
          'transparent.disabled = busy;',
          'transparent.disabled = true;\n  denoise.disabled = busy;'
        );
        next = next.replace(
          `svgFileInput.addEventListener("change", async () => {\n  const file = svgFileInput.files?.[0];\n  if (!file) return;\n  await loadSvgBlob(file, file.name);\n});`,
          `svgFileInput.addEventListener("change", async () => {\n  const file = svgFileInput.files?.[0];\n  if (!file) return;\n  await loadSvgBlob(file, file.name);\n});\n\nfunction clampPngDimension(value: number): number {\n  return Math.max(1, Math.min(32768, Math.round(value || 1)));\n}\n\npngWidth.addEventListener("input", () => {\n  if (syncingPngSize || !pngKeepAspect.checked) return;\n  syncingPngSize = true;\n  pngHeight.value = String(clampPngDimension(Number(pngWidth.value) / viewerAspectRatio));\n  syncingPngSize = false;\n});\n\npngHeight.addEventListener("input", () => {\n  if (syncingPngSize || !pngKeepAspect.checked) return;\n  syncingPngSize = true;\n  pngWidth.value = String(clampPngDimension(Number(pngHeight.value) * viewerAspectRatio));\n  syncingPngSize = false;\n});\n\nexportPngButton.addEventListener("click", async () => {\n  if (!viewerSvgBlob) return;\n  const width = clampPngDimension(Number(pngWidth.value));\n  const height = clampPngDimension(Number(pngHeight.value));\n  pngWidth.value = String(width);\n  pngHeight.value = String(height);\n  exportPngButton.disabled = true;\n  viewerStatus.textContent = \`PNGを書き出し中…\\n\${width.toLocaleString()} × \${height.toLocaleString()} px\`;\n  try {\n    await exportSvgBlobToPng(viewerSvgBlob, { width, height, fileName: viewerSvgName });\n    viewerStatus.textContent = \`PNG保存完了\\n\${width.toLocaleString()} × \${height.toLocaleString()} px\`;\n  } catch (error) {\n    viewerStatus.textContent = \`PNG保存エラー: \${error instanceof Error ? error.message : String(error)}\`;\n  } finally {\n    exportPngButton.disabled = !viewerSvgBlob;\n  }\n});`
        );
        next = next.replace(
          'viewerBitmap = bitmap;\n    resizeViewerCanvas();',
          'viewerBitmap = bitmap;\n    viewerSvgBlob = blob;\n    viewerSvgName = name;\n    viewerAspectRatio = bitmap.width / Math.max(1, bitmap.height);\n    pngWidth.value = String(bitmap.width);\n    pngHeight.value = String(bitmap.height);\n    exportPngButton.disabled = false;\n    resizeViewerCanvas();'
        );

        return {
          code: `import { decodeSvgBlob } from "./svgLoader";\nimport { exportSvgBlobToPng } from "./pngExport";\n${next}`,
          map: null
        };
      }

      if (id.endsWith("/src/worker.ts")) {
        const target = `postProgress(0.34, "小さな孤立領域を除去中");\n  removeSmallRegions(keys, width, height, 6);`;
        if (!code.includes(target)) return null;

        const replacement = `const lowRes = pixelCount <= 256 * 256;
  const veryLowRes = pixelCount <= 96 * 96;

  if (enableDenoise) {
    postProgress(0.30, "局所多数決で点ノイズを除去中");
    majorityDespeckle(keys, width, height, lowRes ? 1 : 2);

    const minRegionArea = adaptiveMinimumArea(width, height, maxColors);
    postProgress(0.35, \`孤立領域を除去中（\${minRegionArea}px未満）\`);
    removeSmallRegions(keys, width, height, minRegionArea);

    if (!lowRes) {
      majorityDespeckle(keys, width, height, 1);
      removeSmallRegions(keys, width, height, Math.max(2, Math.round(minRegionArea * 0.65)));
    }
  } else {
    postProgress(0.35, "ノイズ除去をスキップ");
  }`;

        let next = code.replace(
          'ignoreTransparent: boolean;\n};',
          'ignoreTransparent: boolean;\n  enableDenoise: boolean;\n};'
        );
        next = next.replace(
          'const { width, height, maxColors, ignoreTransparent } = data;',
          'const { width, height, maxColors, ignoreTransparent, enableDenoise } = data;'
        );
        next = next.replace(
          'postProgress(0.03, "メディアンフィルタでノイズ除去中");\n  const input = median3x3(data.pixels, width, height);',
          'const lowResInput = width * height <= 256 * 256;\n  const veryLowResInput = width * height <= 96 * 96;\n  const opaqueInput = flattenTransparency(data.pixels, width, height);\n  postProgress(0.03, enableDenoise && !veryLowResInput ? "背景合成とノイズ除去中" : "透明部分を背景色で塗りつぶし中");\n  const input = enableDenoise && !veryLowResInput ? median3x3(opaqueInput, width, height) : opaqueInput;'
        );
        next = next.replace(target, replacement);
        next = next.replace(
          'if (loop.length < 4) continue;',
          'if (loop.length < (lowRes ? 4 : enableDenoise ? 6 : 4)) continue;'
        );
        next = next.replace(
          'const smoothed = simplify(chaikin(loop, 2), 0.18);',
          'const smoothed = enableDenoise\n        ? lowRes\n          ? simplify(chaikin(loop, 1), 0.10)\n          : simplify(chaikin(loop, 2), 0.28)\n        : lowRes\n          ? simplify(loop, 0.06)\n          : simplify(chaikin(loop, 1), 0.12);'
        );

        return {
          code: `import { adaptiveMinimumArea, majorityDespeckle } from "./despeckle";\nimport { flattenTransparency } from "./opaqueBackground";\n${next}`,
          map: null
        };
      }

      return null;
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [runtimeFixesPlugin()]
});
