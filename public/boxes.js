// Single rule for button boxes (mirrors boxes.py — keep the two in sync).
// The guide's `box` is 0-1000 proportional: x/1000 * image width, y/1000 * image height.
export function boxToFrac(box) {
  return { x: box.x / 1000, y: box.y / 1000, w: box.w / 1000, h: box.h / 1000 };
}
export function boxToPx(box, imgW, imgH) {
  const f = boxToFrac(box);
  return { x: f.x * imgW, y: f.y * imgH, w: f.w * imgW, h: f.h * imgH };
}
export function boxCenter(box) {
  const f = boxToFrac(box);
  return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
}
