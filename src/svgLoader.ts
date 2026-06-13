export async function decodeSvgBlob(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, image.naturalWidth);
      canvas.height = Math.max(1, image.naturalHeight);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable");
      context.drawImage(image, 0, 0);
      return await createImageBitmap(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
