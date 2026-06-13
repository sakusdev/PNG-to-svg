function colorKey(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

function keyToRgb(key: number): [number, number, number] {
  return [(key >>> 16) & 255, (key >>> 8) & 255, key & 255];
}

function inferBorderBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): [number, number, number] {
  const counts = new Map<number, number>();

  function sample(x: number, y: number): void {
    const index = (y * width + x) * 4;
    const alpha = pixels[index + 3];
    if (alpha < 32) return;

    const r = Math.round(pixels[index] / 16) * 16;
    const g = Math.round(pixels[index + 1] / 16) * 16;
    const b = Math.round(pixels[index + 2] / 16) * 16;
    const key = colorKey(Math.min(255, r), Math.min(255, g), Math.min(255, b));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (let x = 0; x < width; x++) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }

  for (let y = 1; y < height - 1; y++) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }

  let winner = colorKey(255, 255, 255);
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      winner = key;
      bestCount = count;
    }
  }

  return keyToRgb(winner);
}

export function flattenTransparency(
  source: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const [backgroundR, backgroundG, backgroundB] = inferBorderBackground(source, width, height);

  for (let index = 0; index < source.length; index += 4) {
    const alpha = source[index + 3] / 255;
    const inverseAlpha = 1 - alpha;

    output[index] = Math.round(source[index] * alpha + backgroundR * inverseAlpha);
    output[index + 1] = Math.round(source[index + 1] * alpha + backgroundG * inverseAlpha);
    output[index + 2] = Math.round(source[index + 2] * alpha + backgroundB * inverseAlpha);
    output[index + 3] = 255;
  }

  return output;
}
