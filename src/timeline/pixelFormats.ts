// Pixel formats by what they carry. Pure (no imports), so the render builder and the source-facts reader can both use it without pulling each other in.
const NO_ALPHA =
  /^(yuvj?4(20|22|44)p(9|10|12|14|16)?(le|be)?|nv12|nv21|p010(le|be)?|gray(8|9|10|12|16)?(le|be)?|gbrp(9|10|12|14|16)?(le|be)?|rgb24|bgr24|rgb48(le|be)|bgr48(le|be)|rgb0|bgr0|0rgb|0bgr|uyvy422|yuyv422|yvyu422)$/;
const ALPHA =
  /^(yuva4(20|22|44)p(9|10|12|16)?(le|be)?|ya8|ya16(le|be)|gbrap(10|12|16)?(le|be)?|rgba(64)?(le|be)?|bgra(64)?(le|be)?|argb|abgr|ayuv(64)?(le)?)$/;

/** Whether a pixel format carries an alpha plane: true or false for a format this table knows, null for any other (palette formats among them: a palette may or may
 *  not hold transparency, so it is unknown, not "no"). */
export function pixFmtHasAlpha(pixFmt: unknown): boolean | null {
  if (typeof pixFmt !== "string") return null;
  if (ALPHA.test(pixFmt)) return true;
  if (NO_ALPHA.test(pixFmt)) return false;
  return null;
}
