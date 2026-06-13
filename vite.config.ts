import { defineConfig, type Plugin } from "vite";

function runtimeFixesPlugin(): Plugin {
  return {
    name: "runtime-fixes",
    enforce: "pre",
    transform(code, id) {
      if (id.endsWith("/src/main.ts")) {
        const bitmapTarget = "const bitmap = await createImageBitmap(blob);";
        const transparentField = `<div class="field">\n          <label><input id="transparent" type="checkbox" checked /> 完全透明ピクセルを除外</label>\n        </div>`;

        let next = code.replace(bitmapTarget, "const bitmap = await decodeSvgBlob(blob);");
        next = next.replace(
          transparentField,
          `${transparentField}\n\n        <div class="field">\n          <label><input id="denoise" type="checkbox" checked /> ノイズ除去を有効化</label>\n        </div>`
        );
        next = next.replace(
          'const transparent = must<HTMLInputElement>("#transparent");',
          'const transparent = must<HTMLInputElement>("#transparent");\nconst denoise = must<HTMLInputElement>("#denoise");'
        );
        next = next.replace(
          'ignoreTransparent: transparent.checked\n  }, [copy.buffer]);',
          'ignoreTransparent: transparent.checked,\n    enableDenoise: denoise.checked\n  }, [copy.buffer]);'
        );
        next = next.replace(
          'transparent.disabled = busy;',
          'transparent.disabled = busy;\n  denoise.disabled = busy;'
        );

        return {
          code: `import { decodeSvgBlob } from "./svgLoader";\n${next}`,
          map: null
        };
      }

      if (id.endsWith("/src/worker.ts")) {
        const target = `postProgress(0.34, "小さな孤立領域を除去中");\n  removeSmallRegions(keys, width, height, 6);`;
        if (!code.includes(target)) return null;

        const replacement = `if (enableDenoise) {
    postProgress(0.30, "局所多数決で点ノイズを除去中");
    majorityDespeckle(keys, width, height, 2);

    const minRegionArea = adaptiveMinimumArea(width, height, maxColors);
    postProgress(0.35, \`孤立領域を除去中（\${minRegionArea}px未満）\`);
    removeSmallRegions(keys, width, height, minRegionArea);
    majorityDespeckle(keys, width, height, 1);
    removeSmallRegions(keys, width, height, Math.max(8, Math.round(minRegionArea * 0.65)));
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
          'postProgress(0.03, enableDenoise ? "メディアンフィルタでノイズ除去中" : "前処理中");\n  const input = enableDenoise ? median3x3(data.pixels, width, height) : data.pixels;'
        );
        next = next.replace(target, replacement);
        next = next.replace(
          'if (loop.length < 4) continue;',
          'if (loop.length < (enableDenoise ? 6 : 4)) continue;'
        );
        next = next.replace(
          'const smoothed = simplify(chaikin(loop, 2), 0.18);',
          'const smoothed = enableDenoise\n        ? simplify(chaikin(loop, 2), 0.28)\n        : simplify(chaikin(loop, 1), 0.12);'
        );

        return {
          code: `import { adaptiveMinimumArea, majorityDespeckle } from "./despeckle";\n${next}`,
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
