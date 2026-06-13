export {};

declare global {
  interface HTMLCanvasElement {
    getContext(
      contextId: "2d",
      options?: CanvasRenderingContext2DSettings
    ): CanvasRenderingContext2D;
  }
}
