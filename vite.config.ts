import { defineConfig, type Plugin } from "vite";

function runtimeFixesPlugin(): Plugin {
  return {
    name: "runtime-fixes",
    enforce: "pre",
    transform(code, id) {
      if (id.endsWith("/src/main.ts")) {
        const target = "const bitmap = await createImageBitmap(blob);";
        if (!code.includes(target)) return null;

        return {
          code: `import { decodeSvgBlob } from "./svgLoader";\n${code.replace(
            target,
            "const bitmap = await decodeSvgBlob(blob);"
          )}`,
          map: null
        };
      }

      if (id.endsWith("/src/worker.ts")) {
        const target = `postProgress(0.34, "小さな孤立領域を除去中");\n  removeSmallRegions(keys, width, height, 6);`;
        if (!code.includes(target)) return null;

        const replacement = `postProgress(0.30, "局所多数決で点ノイズを除去中");
  majorityDespeckle(keys, width, height, 2);

  const minRegionArea = adaptiveMinimumArea(width, height, maxColors);
  postProgress(0.35, \`孤立領域を除去中（\${minRegionArea}px未満）\`);
  removeSmallRegions(keys, width, height, minRegionArea);
  majorityDespeckle(keys, width, height, 1);
  removeSmallRegions(keys, width, height, Math.max(8, Math.round(minRegionArea * 0.65)));`;

        return {
          code: `import { adaptiveMinimumArea, majorityDespeckle } from "./despeckle";\n${code.replace(
            target,
            replacement
          ).replace(
            'if (loop.length < 4) continue;',
            'if (loop.length < 6) continue;'
          ).replace(
            'simplify(chaikin(loop, 2), 0.18)',
            'simplify(chaikin(loop, 2), 0.28)'
          )}`,
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
