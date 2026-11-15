"""Single rule for button boxes (mirrors public/boxes.js — keep the two in sync).

The guide's `box` is in 0-1000 proportional coordinates (x/1000 * image width, y/1000 * image height),
verified on the TILLREDA microwave photo. README section 7.1 says "pixels"; the real data is 0-1000.
"""


def box_to_frac(box):
    """-> (x0, y0, x1, y1) as fractions 0..1 of the image."""
    return (box["x"] / 1000, box["y"] / 1000, (box["x"] + box["w"]) / 1000, (box["y"] + box["h"]) / 1000)


def box_to_px(box, img_w, img_h):
    x0, y0, x1, y1 = box_to_frac(box)
    return (x0 * img_w, y0 * img_h, (x1 - x0) * img_w, (y1 - y0) * img_h)


def box_center(box):
    x0, y0, x1, y1 = box_to_frac(box)
    return ((x0 + x1) / 2, (y0 + y1) / 2)
