#!/usr/bin/env python3
"""Derive PI-Desktop native icons from the iAgent website mark.

The renderer's ``iagent-mark.png`` is the brand source. This script emits:

  apps/desktop/build/icon_1024.png  - development Dock icon
  apps/desktop/build/icon.icns      - via `iconutil` (macOS only)
  apps/desktop/build/icon.ico       - multi-size Windows application icon
  apps/desktop/build/icon.png       - 512px Windows/Linux package icon
  apps/desktop/build/tray-icon-mac.png - transparent macOS template icon

Run: python3 scripts/make-icon.py
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
SOURCE = ROOT / "apps" / "desktop" / "src" / "assets" / "brand" / "iagent-mark.png"

BASE = 1024


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"canonical logo is missing: {SOURCE}")

    with Image.open(SOURCE) as source:
        mark = source.convert("RGBA")
    bounds = mark.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("the iAgent mark is empty")
    mark = mark.crop(bounds)
    master = Image.new("RGBA", (BASE, BASE))
    ImageDraw.Draw(master).rounded_rectangle((48, 48, 976, 976), radius=200, fill="#f0f7ff")
    # Scale uniformly from the renderer artwork for native icon sizes.
    scale = 680 / max(mark.size)
    tile_mark = mark.resize(tuple(round(side * scale) for side in mark.size), Image.LANCZOS)
    master.alpha_composite(tile_mark, ((BASE - tile_mark.width) // 2, (BASE - tile_mark.height) // 2))
    BUILD.mkdir(parents=True, exist_ok=True)
    master.save(BUILD / "icon_1024.png")
    windows_icon = BUILD / "icon.ico"
    master.save(
        windows_icon,
        format="ICO",
        sizes=[
            (16, 16),
            (32, 32),
            (48, 48),
            (64, 64),
            (128, 128),
            (256, 256),
        ],
    )
    package_icon = BUILD / "icon.png"
    master.resize((512, 512), Image.LANCZOS).save(package_icon)

    # macOS tints template images using their alpha channel.
    mark.thumbnail((100, 100), Image.LANCZOS)
    tray_alpha = Image.new("L", (128, 128))
    tray_alpha.paste(mark.getchannel("A"), ((128 - mark.width) // 2, (128 - mark.height) // 2))
    tray_icon_mac = Image.new("RGBA", tray_alpha.size)
    tray_icon_mac.putalpha(tray_alpha)
    tray_icon_mac_path = BUILD / "tray-icon-mac.png"
    tray_icon_mac.save(tray_icon_mac_path)

    iconutil = shutil.which("iconutil")
    if iconutil is None:
        print(f"used {SOURCE}")
        print(f"wrote {windows_icon}")
        print(f"wrote {package_icon}")
        print(f"wrote {tray_icon_mac_path}")
        print("skipped icon.icns (iconutil is unavailable)")
        return

    icns = BUILD / "icon.icns"
    with TemporaryDirectory() as temporary:
        iconset = Path(temporary) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            master.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            master.resize((size * 2, size * 2), Image.LANCZOS).save(
                iconset / f"icon_{size}x{size}@2x.png"
            )
        subprocess.run(
            [iconutil, "-c", "icns", str(iconset), "-o", str(icns)], check=True
        )
    print(f"used {SOURCE}")
    print(f"wrote {windows_icon}")
    print(f"wrote {package_icon}")
    print(f"wrote {tray_icon_mac_path}")
    print(f"wrote {icns}")


if __name__ == "__main__":
    main()
