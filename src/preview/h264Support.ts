import { VideoSource } from "./videoSource";

let calibration: Promise<boolean> | undefined;

export function highH264DecodesCorrectly(): Promise<boolean> {
  calibration ??= checkPixels();
  return calibration;
}

async function checkPixels(): Promise<boolean> {
  if (typeof VideoDecoder === "undefined" || typeof OffscreenCanvas === "undefined") return false;
  const source = new VideoSource(new URL("./h264Calibration.mp4", import.meta.url).href);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("H.264 pixel calibration timed out")), 4000);
  });
  try {
    await Promise.race([source.whenReady(), deadline]);
    const frame = await Promise.race([source.frameAt(0), deadline]);
    if (!frame) return false;
    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(frame, 0, 0);
    const corners = [
      [0.25, 0.25, 224, 16, 16],
      [0.75, 0.25, 16, 224, 16],
      [0.25, 0.75, 16, 16, 224],
      [0.75, 0.75, 240, 240, 240],
    ];
    return corners.every(([x, y, red, green, blue]) => {
      const pixel = context.getImageData(
        Math.floor(x * canvas.width),
        Math.floor(y * canvas.height),
        1,
        1,
      ).data;
      return Math.hypot(pixel[0] - red, pixel[1] - green, pixel[2] - blue) < 80;
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    source.close();
  }
}
