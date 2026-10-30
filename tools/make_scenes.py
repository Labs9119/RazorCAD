"""Make the photo render scenes (app/scenes/) from 360° HDR photographs.

    python -I tools/make_scenes.py <folder of the source .hdr files>

Each scene (SCENES below: its id in render.js and the source file) becomes two files:
  app/scenes/<id>.hdr  the lighting: the panorama at 1024 x 512, still HDR (the sun and the lights as bright as they
                       are), for what lights the part and shows in its reflections
  app/scenes/<id>.jpg  the backdrop: the panorama at 4096 x 2048, tone mapped as the renderer does it (ACES filmic,
                       as three.js), behind the part
Both are scaled by the same exposure (each scene's middle band brought to the same brightness), so the part and the
place behind it match. It prints each scene's brightest direction (its sun, or its windows and lights), for
render.js's SCENES `sun` [azimuth, elevation] in degrees (three.js's equirectangular axes).

The sources are CC0 HDRIs from Poly Haven (polyhaven.com), at 4k (dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/).
"""
import os
import sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'app', 'scenes')
# id: (source, exposure trim: a stop or so up or down from the even brightness)
SCENES = {
    'outdoors': ('symmetrical_garden_02_4k.hdr', 0.0),
    'forest': ('misty_pines_4k.hdr', 0.0),
    'office': ('poly_haven_studio_4k.hdr', 0.0),
    'workshop': ('machine_shop_02_4k.hdr', 0.0),
    'store': ('decor_shop_4k.hdr', 0.0),
    'warehouse': ('empty_warehouse_01_4k.hdr', 0.0),
    'sky': ('rooitou_park_4k.hdr', 0.0),
    'overcast': ('kloofendal_overcast_4k.hdr', 0.0),
    'sunset': ('venice_sunset_4k.hdr', 0.0),
}
LIGHT_W, BACK_W, JPEG_Q = 1024, 4096, 80


def read_hdr(path):
    """A Radiance .hdr (RGBE, flat or run-length encoded) as float32 [h, w, 3]."""
    data = open(path, 'rb').read()
    i = 0
    while True:  # (the header: lines up to an empty one, then the size line)
        j = data.index(b'\n', i)
        line = data[i:j]
        i = j + 1
        if not line.strip():
            break
    j = data.index(b'\n', i)
    parts = data[i:j].split()
    i = j + 1
    assert parts[0] == b'-Y' and parts[2] == b'+X', parts
    h, w = int(parts[1]), int(parts[3])
    out = np.empty((h, w, 4), np.uint8)
    mv = memoryview(data)
    for y in range(h):
        if w < 8 or w > 0x7fff or data[i] != 2 or data[i + 1] != 2 or data[i + 2] & 0x80:
            out[y] = np.frombuffer(mv[i:i + w * 4], np.uint8).reshape(w, 4)
            i += w * 4
            continue
        i += 4
        for c in range(4):
            row = out[y, :, c]
            x = 0
            while x < w:
                n = data[i]
                i += 1
                if n > 128:
                    n -= 128
                    row[x:x + n] = data[i]
                    i += 1
                else:
                    row[x:x + n] = np.frombuffer(mv[i:i + n], np.uint8)
                    i += n
                x += n
    e = out[..., 3].astype(np.int32)
    f = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0).astype(np.float32)
    return out[..., :3].astype(np.float32) * f[..., None]


def write_hdr(path, img):
    """float [h, w, 3] as a run-length encoded Radiance .hdr."""
    h, w, _ = img.shape
    m = img.max(axis=2)
    e = np.where(m > 1e-32, np.floor(np.log2(np.maximum(m, 1e-32))) + 1, 0)
    scale = np.where(m > 1e-32, 256.0 / np.exp2(e), 0)
    rgbe = np.zeros((h, w, 4), np.uint8)
    rgbe[..., :3] = np.clip(img * scale[..., None], 0, 255).astype(np.uint8)
    rgbe[..., 3] = np.where(m > 1e-32, e + 128, 0).astype(np.uint8)
    out = bytearray(b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n' + f'-Y {h} +X {w}\n'.encode())
    for y in range(h):
        out += bytes([2, 2, w >> 8, w & 255])
        for c in range(4):
            row = rgbe[y, :, c].tobytes()
            x = 0
            while x < w:
                # (a run of 4 or more of the same byte: as a run; else bytes as they are, up to the next run)
                r = x
                while r < w and r - x < 127 and row[r] == row[x]:
                    r += 1
                if r - x >= 4:
                    out += bytes([128 + r - x, row[x]])
                    x = r
                    continue
                s = x
                while s < w and s - x < 128:
                    if s + 3 < w and row[s] == row[s + 1] == row[s + 2] == row[s + 3]:
                        break
                    s += 1
                out += bytes([s - x]) + row[x:s]
                x = s
    open(path, 'wb').write(bytes(out))


def shrink(img, w):
    """The panorama made w wide (box filter: the mean of each k x k block)."""
    k = img.shape[1] // w
    h = img.shape[0] // k
    return img[:h * k, :w * k].reshape(h, k, w, k, 3).mean(axis=(1, 3))


def aces(c):
    """three.js's ACESFilmicToneMapping (exposure 1), linear in, linear out (0..1)."""
    c = c / 0.6
    a_in = np.array([[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]], np.float32)
    a_out = np.array([[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]], np.float32)
    v = c @ a_in.T
    v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081)
    return np.clip(v @ a_out.T, 0, 1)


def srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def lum(c):
    return c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(OUT, exist_ok=True)
    for sid, (name, trim) in SCENES.items():
        img = read_hdr(os.path.join(src, name))
        h, w, _ = img.shape
        # (the exposure: the log-average brightness of the band from 25° below the horizon to 15° above it, where the
        # backdrop is seen, brought to 0.2; the trim on top)
        rows = slice(int(h * (0.5 - 15 / 180)), int(h * (0.5 + 25 / 180)))
        key = float(np.exp(np.mean(np.log(lum(img[rows]) + 1e-4))))
        gain = 0.2 / key * 2 ** trim
        img *= gain
        light = shrink(img, LIGHT_W)
        write_hdr(os.path.join(OUT, sid + '.hdr'), light)
        back = shrink(img, BACK_W) if w > BACK_W else img
        Image.fromarray((srgb(aces(back)) * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, sid + '.jpg'), quality=JPEG_Q, optimize=True, progressive=True)
        # (the brightest direction: the brightest pixel above the horizon of a 64 x 32 copy, each weighted by its share
        # of the sphere: the sun, or the windows and lights, not their reflection in a floor)
        s = shrink(light, 64)
        sh, sw = s.shape[:2]
        lat = (0.5 - (np.arange(sh) + 0.5) / sh) * np.pi
        y, x = np.unravel_index(np.argmax(lum(s) * (np.cos(lat) * (lat > 0))[:, None]), (sh, sw))
        az = ((x + 0.5) / sw - 0.5) * 360
        el = float(np.degrees(lat[y]))
        print(f"{sid:10s} {name:32s} gain {gain:8.3f}  sun [{az:7.1f}, {el:5.1f}]  "
              f"{os.path.getsize(os.path.join(OUT, sid + '.hdr')) // 1024} KB + {os.path.getsize(os.path.join(OUT, sid + '.jpg')) // 1024} KB")


if __name__ == '__main__':
    main()
