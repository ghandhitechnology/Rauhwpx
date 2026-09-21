#!/usr/bin/env python3
"""Regenerate the original MIT-licensed font used by shaping behavior tests.

Run with: uv run --with fonttools python scripts/generate_shaping_fixture.py
"""

from pathlib import Path

from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


def glyph(empty=False):
    pen = TTGlyphPen(None)
    if not empty:
        pen.moveTo((50, 0))
        pen.lineTo((500, 0))
        pen.lineTo((500, 700))
        pen.lineTo((50, 700))
        pen.closePath()
    return pen.glyph()


characters = {ord(ch): ch for ch in "AVTofice"}
characters.update({0x20: "space", 0x301: "acutecomb", 0xD55C: "hangul"})
order = [".notdef", *characters.values(), "ffi"]
builder = FontBuilder(1000, isTTF=True)
builder.setupGlyphOrder(order)
builder.setupCharacterMap(characters)
builder.setupGlyf({name: glyph(name == "space") for name in order})
widths = {name: (600, 0) for name in order}
widths.update(space=(250, 0), acutecomb=(0, 0), hangul=(1000, 0), ffi=(1200, 0))
builder.setupHorizontalMetrics(widths)
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable({
    "familyName": "RHWP Shaping Fixture",
    "styleName": "Regular",
    "uniqueFontIdentifier": "RHWPShapingFixture-Regular",
    "fullName": "RHWP Shaping Fixture Regular",
    "psName": "RHWPShapingFixture-Regular",
    "version": "Version 1.000",
})
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
builder.setupMaxp()
addOpenTypeFeaturesFromString(builder.font, """
languagesystem DFLT dflt;
languagesystem latn dflt;
feature kern { pos A V -200; pos T o -100; } kern;
feature liga { sub f f i by ffi; } liga;
markClass acutecomb <anchor 250 700> @TOP;
feature mark { pos base e <anchor 300 700> mark @TOP; } mark;
""")
builder.font["head"].created = 2082844800
builder.font["head"].modified = 2082844800
builder.font.recalcTimestamp = False
builder.save(Path(__file__).resolve().parents[1] / "tests/fixtures/fonts/RHWPShapingFixture.ttf")
