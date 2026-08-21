import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "copy-layout"
    / "scripts"
    / "copy_layout.py"
)
SPEC = importlib.util.spec_from_file_location("copy_layout", SCRIPT)
copy_layout = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(copy_layout)


class IntermediateHwpxExportTests(unittest.TestCase):
    def test_parser_accepts_source_prefix_reserved_by_elementtree(self):
        source = b'<ns1:root xmlns:ns1="urn:copy-layout"><ns1:item /></ns1:root>'

        tree = copy_layout.parse_xml(source, "reserved-prefix.xml")
        serialized = copy_layout.serialize_xml(tree, source)
        reparsed = copy_layout.parse_xml(serialized, "roundtrip.xml")

        self.assertEqual(copy_layout.local_name(reparsed.getroot().tag), "root")
        self.assertEqual(
            [copy_layout.local_name(element.tag) for element in reparsed.getroot()],
            ["item"],
        )

    def test_parser_rejects_doctype_without_third_party_xml_dependencies(self):
        with self.assertRaisesRegex(ValueError, "unsafe XML declaration"):
            copy_layout.parse_xml(
                b'<!DOCTYPE root [<!ENTITY secret "private">]><root>&secret;</root>',
                "unsafe.xml",
            )

    def test_page_mismatch_is_deferred_to_final_output_verification(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source.hwp"
            output = root / "source.hwpx"
            source.write_bytes(b"hwp")
            calls = []

            def fake_run(_binary, arguments, expect_json=False):
                self.assertFalse(expect_json)
                calls.append(arguments)
                if "--verify-pages" in arguments:
                    output.write_bytes(b"partial")
                    raise copy_layout.RhwpCommandError(
                        "export-hwpx",
                        4,
                        "검증 실패(--verify-pages): 변환 전 1쪽, 재파싱 후 2쪽",
                    )
                output.write_bytes(b"usable intermediate")
                return ""

            def fake_info(_binary, document):
                return {"pageCount": 1 if document == source else 2}

            with patch.object(copy_layout, "run_rhwp", side_effect=fake_run), patch.object(
                copy_layout,
                "native_document_info",
                side_effect=fake_info,
            ):
                result = copy_layout.export_hwpx_for_sanitization(
                    Path("rhwp"),
                    source,
                    output,
                )

            self.assertEqual(result["page_gate"], "deferred-to-final-output")
            self.assertEqual(result["source_page_count"], 1)
            self.assertEqual(result["intermediate_page_count"], 2)
            self.assertEqual(len(calls), 2)
            self.assertIn("--verify-pages", calls[0])
            self.assertNotIn("--verify-pages", calls[1])
            self.assertEqual(output.read_bytes(), b"usable intermediate")

    def test_non_pagination_export_failure_is_not_retried(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source.hwp"
            output = root / "source.hwpx"
            source.write_bytes(b"hwp")
            failure = copy_layout.RhwpCommandError("export-hwpx", 2, "invalid input")

            with patch.object(copy_layout, "run_rhwp", side_effect=failure) as run:
                with self.assertRaises(copy_layout.RhwpCommandError) as raised:
                    copy_layout.export_hwpx_for_sanitization(
                        Path("rhwp"),
                        source,
                        output,
                    )

            self.assertIs(raised.exception, failure)
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
