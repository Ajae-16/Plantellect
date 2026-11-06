"""
Copies Google Fonts TTF files into app/src/main/res/font with the names the app expects.

  1. On fonts.google.com open each family (Open Sans, Montserrat, Roboto, Roboto Slab, Lato,
     Playfair Display), press "Get font" > "Download all", and unzip the downloads anywhere.
  2. Run, from the MobileApplication folder:
         python tools/install_fonts.py  <folder that holds the unzipped downloads>

It looks for the STATIC files (OpenSans-SemiBold.ttf ...). Variable fonts (names with [ ] ) and
italics are skipped. Run it again after adding a family to FAMILIES below / to ui/theme/AppFonts.kt.
"""
import re
import shutil
import sys
from pathlib import Path

# Google file name prefix -> the filePrefix in AppFonts.kt
FAMILIES = {
    "OpenSans": "open_sans",
    "Montserrat": "montserrat",
    "Roboto": "roboto",
    "RobotoSlab": "roboto_slab",
    "Lato": "lato",
    "PlayfairDisplay": "playfair_display",
}
WEIGHTS = {"Regular": "regular", "Medium": "medium", "SemiBold": "semibold", "Bold": "bold"}

OUT = Path(__file__).resolve().parent.parent / "app" / "src" / "main" / "res" / "font"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1
    source = Path(sys.argv[1])
    if not source.is_dir():
        print(f"Not a folder: {source}")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    copied = {}
    for ttf in sorted(source.rglob("*.ttf")):
        m = re.fullmatch(r"([A-Za-z]+)-([A-Za-z]+)", ttf.stem)   # "OpenSans-SemiBold"; skips [wght] and _Condensed
        if not m:
            continue
        family, weight = m.groups()
        if family not in FAMILIES or weight not in WEIGHTS:
            continue
        target = OUT / f"{FAMILIES[family]}_{WEIGHTS[weight]}.ttf"
        shutil.copyfile(ttf, target)
        copied.setdefault(family, []).append(WEIGHTS[weight])
    for family in FAMILIES:
        got = copied.get(family)
        print(f"{family:16} {', '.join(sorted(got)) if got else 'NOT FOUND (the app uses the phone font)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
