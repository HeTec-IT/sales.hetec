#!/usr/bin/env python3
"""Erzeugt aus EINEM Foto des o2-Vorschlags (Monitorfoto) typische Problemfotos zum Testen.
Aufruf: python3 make_variants.py <foto.jpg> <ausgabeordner>      (benoetigt: pip install pillow numpy)
Das Beleg-Foto selbst gehoert nicht ins Repo (Kundendaten) - jeder Entwickler nimmt sein eigenes Testfoto."""
import sys, os, io
import numpy as np
from PIL import Image, ImageFilter

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
im = Image.open(src).convert('RGB')
W, H = im.size
rng = np.random.default_rng(7)
def save(name, img, q=92): img.save(os.path.join(out, name + '.jpg'), quality=q)
def arr(img): return np.asarray(img).astype(np.float32)
def img(a): return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

save('orig', im)
# ungleichmaessige Helligkeit (Verlauf von links dunkel nach rechts hell)
g = np.linspace(0.45, 1.0, W)[None, :, None]
save('gradient', img(arr(im) * g))
# Spiegelung: heller Fleck ueber dem Text
yy, xx = np.mgrid[0:H, 0:W]
glare = np.exp(-(((xx - W * 0.6) / (W * 0.25)) ** 2 + ((yy - H * 0.4) / (H * 0.12)) ** 2)) * 90
save('glare', img(arr(im) + glare[..., None]))
save('blur_light', im.filter(ImageFilter.GaussianBlur(2.2)))
save('blur_heavy', im.filter(ImageFilter.GaussianBlur(12)))
buf = io.BytesIO(); im.save(buf, 'JPEG', quality=30); save('jpeg30', Image.open(buf).convert('RGB'))
save('lowres', im.resize((W // 2 + 8, H // 2 + 8), Image.BILINEAR))
save('rot4', im.rotate(4, resample=Image.BICUBIC, expand=True, fillcolor=(20, 20, 20)))
save('noise', img(rng.integers(0, 255, (H, W, 3)).astype(np.float32)), 85)
save('blank', Image.new('RGB', (W, H), (240, 240, 240)))
save('top_only', im.crop((0, 0, W, int(H * 0.62))))
save('bottom_only', im.crop((0, int(H * 0.5), W, H)))
with open(os.path.join(out, 'orig.jpg'), 'rb') as f: raw = f.read()
open(os.path.join(out, 'truncated.jpg'), 'wb').write(raw[:len(raw) // 5])
open(os.path.join(out, 'garbage.jpg'), 'wb').write(b'this is not an image' * 50)
print('ok', sorted(os.listdir(out)))
