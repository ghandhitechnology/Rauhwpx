"""Focused invariants for PDF-vector to OpenType/CFF conversion."""

from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest

import pymupdf
import pathops
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

import atlas_to_otf as atlas


class FakePixmap:
    alpha = True
    n = 4

    def __init__(self, alpha: int):
        self.samples = bytes([0, 0, 0, alpha] * 4)


class FakePage:
    def __init__(self, alpha: int):
        self.alpha = alpha

    def get_pixmap(self, **kwargs):
        assert kwargs["alpha"] is True
        return FakePixmap(self.alpha)


class AtlasTests(unittest.TestCase):
    def test_blank_proof_requires_transparent_render(self):
        self.assertTrue(atlas.rendered_cell_is_blank(FakePage(0), pymupdf.Rect(0, 0, 1, 1)))
        # An all-zero grayscale image can be opaque black. Encoded samples
        # alone cannot establish whether the cell is actually blank.
        self.assertFalse(atlas.rendered_cell_is_blank(FakePage(255), pymupdf.Rect(0, 0, 1, 1)))

    def test_audited_stroke_expands_ink_and_rejects_dash(self):
        square = [["M", 0, 0], ["L", 100, 0], ["L", 100, 100],
                  ["L", 0, 100], ["Z"]]
        profile = {"line_cap": "butt", "line_join": "miter",
                   "miter_limit": 10, "dash": "solid",
                   "source_width_units": 1, "basis": "source PDF operators audited"}
        draw = {"type": "fs", "fill": (0.0, 0.0, 0.0), "fill_opacity": 1.0,
                "stroke_opacity": 1.0, "color": (0.0, 0.0, 0.0),
                "lineCap": (0, 0, 0), "lineJoin": 0.0,
                "dashes": "[] 0", "width": 0.03, "even_odd": False}
        entry = {"em_units": 1000, "font_size_pt": 30}
        result = atlas.paint_commands(draw, square, entry, {"stroke_profile": profile})
        self.assertEqual(atlas.skia_path(result).bounds, (-0.5, -0.5, 100.5, 100.5))
        with self.assertRaisesRegex(atlas.AtlasError, "unsupported glyph stroke"):
            atlas.paint_commands({**draw, "dashes": "[2 1] 0"}, square, entry,
                                 {"stroke_profile": profile})
        with self.assertRaisesRegex(atlas.AtlasError, "audited source"):
            atlas.paint_commands({**draw, "width": 0.06}, square, entry,
                                 {"stroke_profile": profile})
        with self.assertRaisesRegex(atlas.AtlasError, "lacks audited"):
            atlas.paint_commands(draw, square, entry, {})

    def test_even_odd_hole_becomes_nonzero_winding(self):
        # Both rings point the same way, so plain CFF winding would fill the
        # center. PDF even-odd semantics must become reversed inner winding.
        rings = [["M", 0, 0], ["L", 100, 0], ["L", 100, 100],
                 ["L", 0, 100], ["Z"], ["M", 20, 20], ["L", 80, 20],
                 ["L", 80, 80], ["L", 20, 80], ["Z"]]
        draw = {"type": "f", "fill": (0.0, 0.0, 0.0), "fill_opacity": 1.0,
                "even_odd": True}
        result = atlas.paint_commands(draw, rings, {}, {})
        path = atlas.skia_path(result)
        self.assertEqual(path.fillType, pathops.FillType.WINDING)
        self.assertEqual(abs(path.area), 6400)

    def test_multipart_cubic_and_hole_survive_cff_build(self):
        # Outer and inner rectangles have opposite winding. The curved
        # component has a control point outside its actual ink bounds.
        commands = [
            ["M", 0, 0], ["L", 100, 0], ["L", 100, 100],
            ["L", 0, 100], ["Z"],
            ["M", 20, 20], ["L", 20, 80], ["L", 80, 80],
            ["L", 80, 20], ["Z"],
            ["M", 200, 0], ["C", 250, 200, 350, 200, 400, 0], ["Z"],
        ]
        outlines = {"font_family": "검증 글꼴", "style": "Regular",
                    "font_weight": 400,
                    "italic_angle_deg": 0, "italic_angle_basis": "upright",
                    "vertical_metrics": {"ascender_units": 800,
                                         "descender_units": -200,
                                         "line_gap_units": 0},
                    "vertical_metrics_basis": "test_fixture",
                    "manifest_sha256": "0" * 64, "pdf_sha256": "1" * 64,
                    "glyphs": [{"codepoint": 0xAC00, "glyph_name": "uniAC00",
                                "advance_units": 500, "commands": commands,
                                "source_entry": {"em_units": 1000}}]}
        with TemporaryDirectory() as directory:
            path = Path(directory) / "test.otf"
            result = atlas.build(outlines, path)
            font = TTFont(path)
            self.assertEqual(result["glyph_count"], 1)
            self.assertEqual(font.getBestCmap()[0xAC00], "uniAC00")
            self.assertEqual(font["hmtx"]["uniAC00"], (500, 0))
            self.assertEqual(font["OS/2"].usWeightClass, 400)
            self.assertEqual(font["head"].macStyle, 0)
            self.assertEqual(font["name"].getDebugName(10), atlas.HFT_NAME_MARKER)
            pen = RecordingPen()
            font.getGlyphSet()["uniAC00"].draw(pen)
            self.assertEqual(sum(op == "moveTo" for op, _ in pen.value), 3)
            self.assertEqual(sum(op == "curveTo" for op, _ in pen.value), 1)
            self.assertEqual(sum(op == "closePath" for op, _ in pen.value), 3)

    def test_rejects_duplicate_codepoints_and_unproved_blank(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "atlas.pdf").write_bytes(b"pdf source")
            (root / "source.hwpx").write_bytes(b"document source")
            bank_bytes = bytearray(512 + 10 + 95 * 2)
            bank_bytes[522:524] = (400).to_bytes(2, "little")
            (root / "bank.hft").write_bytes(bank_bytes)
            entry = {"codepoint": "U+0020", "char": " ", "font_family": "F",
                     "style": "Regular", "advance_units": 400, "font_size_pt": 30,
                     "em_units": 1000, "cell_rect_pt": [0, 0, 20, 20],
                     "origin_pt": [0, 10], "expected_status": "source_verified_blank",
                     "source_hft_advance_units": 400}
            manifest = {"schema_version": 1, "font_family": "F", "style": "Regular",
                        "vertical_metrics": {"ascender_units": 800,
                                             "descender_units": -200,
                                             "line_gap_units": 0},
                        "vertical_metrics_basis": "test_fixture",
                        "pdf": "atlas.pdf", "pdf_sha256": atlas.sha256(root / "atlas.pdf"),
                        "source_hwpx": "source.hwpx",
                        "source_hwpx_sha256": atlas.sha256(root / "source.hwpx"),
                        "hft_banks": [{"filename": "bank.hft",
                                       "encoding": "latin_hft_0x20_0x85",
                                       "record_type": 1,
                                       "width_table_offset": 512,
                                       "sha256": atlas.sha256(root / "bank.hft")}],
                        "entries": [entry]}
            path = root / "atlas.json"
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(atlas.AtlasError, "blank requires proof"):
                atlas.require_manifest(path, root)
            proof = {"source_hft_bank": "bank.hft", "source_hft_advance_units": 400}
            manifest["entries"] = [{**entry, "blank_proof": proof},
                                   {**entry, "blank_proof": proof}]
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(atlas.AtlasError, "duplicate"):
                atlas.require_manifest(path, root)
            manifest["entries"] = [{**entry, "blank_proof": proof}]
            manifest["entries"][0]["advance_units"] = 500
            manifest["entries"][0]["source_hft_advance_units"] = 500
            manifest["entries"][0]["blank_proof"] = {
                "source_hft_bank": "bank.hft", "source_hft_advance_units": 500}
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(atlas.AtlasError, "HFT bytes"):
                atlas.require_manifest(path, root)


if __name__ == "__main__":
    unittest.main()
