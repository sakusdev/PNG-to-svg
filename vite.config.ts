import { defineConfig, type Plugin } from "vite";

function svgDecodeFallbackPlugin(): Plugin {
  return {
    name: "svg-decode-fallback",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/src/main.ts")) return null;

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
  };
}

export default defineConfig({
  base: "./",
  plugins: [svgDecodeFallbackPlugin()]
});
