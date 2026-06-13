export type SvgPngExportOptions = {
  width: number;
  height: number;
  fileName: string;
  background?: string | null;
};

function waitForImage(image: HTMLImageElement): Promise<void> {
  if (typeof image.decode === "function") return image.decode();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("SVG画像を読み込めませんでした"));
  });
}

export async function exportSvgBlobToPng(
  svgBlob: Blob,
  options: SvgPngExportOptions
): Promise<void> {
  const width = Math.max(1, Math.min(32768, Math.floor(options.width)));
  const height = Math.max(1, Math.min(32768, Math.floor(options.height)));
  const pixelCount = width * height;

  if (pixelCount > 268_435_456) {
    throw new Error("出力解像度が大きすぎます。総画素数を約2.68億以下にしてください");
  }

  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await waitForImage(image);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas 2D contextを取得できませんでした");

    if (options.background) {
      context.fillStyle = options.background;
      context.fillRect(0, 0, width, height);
    } else {
      context.clearRect(0, 0, width, height);
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("PNGの生成に失敗しました"));
      }, "image/png");
    });

    const downloadUrl = URL.createObjectURL(pngBlob);
    try {
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = options.fileName.replace(/\.svg$/i, "") + `-${width}x${height}.png`;
      anchor.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
