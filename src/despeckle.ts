export function majorityDespeckle(
  keys: Uint32Array,
  width: number,
  height: number,
  passes = 2
): void {
  const next = new Uint32Array(keys.length);

  for (let pass = 0; pass < passes; pass++) {
    next.set(keys);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const index = y * width + x;
        const center = keys[index];
        const counts = new Map<number, number>();

        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const key = keys[(y + oy) * width + x + ox];
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }

        let winner = center;
        let winnerCount = counts.get(center) ?? 0;
        for (const [key, count] of counts) {
          if (count > winnerCount) {
            winner = key;
            winnerCount = count;
          }
        }

        if (winner !== center && winnerCount >= 5) next[index] = winner;
      }
    }

    keys.set(next);
  }
}

export function adaptiveMinimumArea(
  width: number,
  height: number,
  maxColors: number
): number {
  const megapixelScale = Math.sqrt((width * height) / 1_000_000);
  const colorPressure = Math.max(1, Math.log10(Math.max(10, maxColors)) / 3);
  return Math.max(12, Math.min(96, Math.round(18 * megapixelScale * colorPressure)));
}
