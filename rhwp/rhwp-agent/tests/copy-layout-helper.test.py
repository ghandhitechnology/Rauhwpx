import importlib.util
import json
import tempfile
import unittest
import zipfile
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


class CopyLayoutHelperTests(unittest.TestCase):
    @staticmethod
    def document_tree(*paragraphs):
        root = copy_layout.etree.Element("section")
        for text in paragraphs:
            paragraph = copy_layout.etree.SubElement(root, "p")
            run = copy_layout.etree.SubElement(paragraph, "run")
            node = copy_layout.etree.SubElement(run, "t")
            node.text = text
        return copy_layout.etree.ElementTree(root)

    def test_guidance_mode_preserves_only_structure_and_instructions(self):
        tree = self.document_tree(
            "1. 제출 형식",
            "2. 작품 개요",
            "PDF 파일로 제출하세요.",
            "The response must be under 500 words.",
            "Submit at https://example.com/contest.",
            "이름: 홍길동",
            "제가 작성한 완성 답안입니다.",
        )

        stats, guidance, approved, _, _ = copy_layout.sanitize_document_tree(
            tree,
            "Contents/section0.xml",
            set(),
            preserve_flow=False,
            preserve_guidance=True,
        )

        self.assertEqual(
            guidance,
            [
                "1. 제출 형식",
                "2. 작품 개요",
                "PDF 파일로 제출하세요.",
                "The response must be under 500 words.",
            ],
        )
        self.assertEqual(
            [text for _, text in approved],
            guidance,
        )
        self.assertEqual(stats["approved_text_nodes_preserved"], 4)
        self.assertEqual(stats["text_nodes_cleared"], 3)
        self.assertEqual(
            [
                copy_layout.normalize_visible_text("".join(node.itertext()))
                for node in tree.iter()
                if copy_layout.local_name(node.tag) == "t" and "".join(node.itertext()).strip()
            ],
            guidance,
        )

    def test_strict_mode_removes_guidance_text_too(self):
        tree = self.document_tree("제출 형식", "PDF 파일로 제출하세요.")

        stats, guidance, approved, _, _ = copy_layout.sanitize_document_tree(
            tree,
            "Contents/section0.xml",
            set(),
            preserve_flow=False,
            preserve_guidance=False,
        )

        self.assertEqual(guidance, [])
        self.assertEqual(approved, [])
        self.assertEqual(stats["text_nodes_cleared"], 2)
        self.assertEqual(copy_layout.visible_text_fragments({"Contents/section0.xml": tree}), [])

    def test_guidance_mode_verifies_an_end_to_end_hwpx_package(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "assignment.hwpx"
            output = root / "assignment-layout.hwpx"
            content = (
                '<package xmlns="http://www.idpf.org/2007/opf/">'
                "<metadata><title>Original</title><creator>A Student</creator></metadata>"
                "<manifest/><spine/>"
                "</package>"
            ).encode()
            section = (
                "<section>"
                "<p><run><t>평가 기준</t></run></p>"
                "<p><run><t>근거를 포함하여 설명하세요.</t></run></p>"
                "<p><run><t>학생이 작성한 답안</t></run></p>"
                "</section>"
            ).encode()
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr(
                    "mimetype",
                    b"application/hwp+zip",
                    compress_type=zipfile.ZIP_STORED,
                )
                archive.writestr("Contents/content.hpf", content)
                archive.writestr("Contents/section0.xml", section)

            report = copy_layout.sanitize_hwpx(
                source,
                output,
                "assignment - Layout",
                set(),
                preserve_flow=False,
                preserve_guidance=True,
            )

            self.assertEqual(
                [item["text"] for item in report["preserved_guidance"]],
                ["평가 기준", "근거를 포함하여 설명하세요."],
            )
            self.assertEqual(report["verification"]["visible_text_nodes"], 2)
            self.assertEqual(report["verification"]["title"], "assignment - Layout")
            self.assertTrue(output.is_file())

    def test_inspection_plan_is_source_bound_and_applied_end_to_end(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "expense.hwpx"
            output = root / "expense-layout.hwpx"
            plan_path = root / "decisions.json"
            content = (
                '<package xmlns="http://www.idpf.org/2007/opf/">'
                "<metadata><title>Original</title></metadata><manifest/><spine/>"
                "</package>"
            ).encode()
            section = (
                "<section>"
                "<p><run><t>지출결의서</t></run></p>"
                "<p><run><t>지출금액 100,000원</t></run></p>"
                "<p><run><t>홍길동</t></run></p>"
                "</section>"
            ).encode()
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr(
                    "mimetype",
                    b"application/hwp+zip",
                    compress_type=zipfile.ZIP_STORED,
                )
                archive.writestr("Contents/content.hpf", content)
                archive.writestr("Contents/section0.xml", section)

            inventory = copy_layout.inspect_hwpx(source)
            self.assertEqual(inventory["paragraph_count"], 3)
            plan_path.write_text(
                json.dumps(
                    {
                        "source_sha256": inventory["source_sha256"],
                        "default": "keep",
                        "keep": [],
                        "remove": ["Contents/section0.xml#p0002"],
                        "replace": {
                            "Contents/section0.xml#p0001": "지출금액",
                        },
                    }
                ),
                encoding="utf-8",
            )

            report = copy_layout.copy_layout(
                source,
                output,
                set(),
                text_plan_path=plan_path,
            )

            self.assertEqual(report["text_decisions"]["kept_count"], 2)
            self.assertEqual(report["text_decisions"]["removed_count"], 1)
            self.assertEqual(report["text_decisions"]["replacement_count"], 1)
            self.assertEqual(
                [item["text"] for item in report["text_decisions"]["kept"]],
                ["지출결의서", "지출금액"],
            )
            self.assertEqual(report["verification"]["visible_text_nodes"], 2)

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

    def test_parser_drops_nonsemantic_xml_control_bytes(self):
        tree = copy_layout.parse_xml(b"<root><a/>\x01<b/></root>", "control.xml")

        self.assertEqual(
            [copy_layout.local_name(element.tag) for element in tree.getroot()],
            ["a", "b"],
        )

    def test_source_bound_text_plan_keeps_labels_and_removes_entered_values(self):
        tree = self.document_tree("복학원서", "성명: 홍길동", "완성 답변")
        second_text = [
            element for element in tree.iter()
            if copy_layout.local_name(element.tag) == "t"
        ][1]
        line_break = copy_layout.etree.SubElement(second_text, "lineBreak")
        line_break.tail = " 추가값"
        plan = {
            "source_sha256": "unused-by-tree-unit-test",
            "default": "remove",
            "keep": {"Contents/section0.xml#p0000"},
            "remove": {"Contents/section0.xml#p0002"},
            "replace": {"Contents/section0.xml#p0001": "성명:"},
        }

        stats, guidance, approved, kept, removed = copy_layout.sanitize_document_tree(
            tree,
            "Contents/section0.xml",
            set(),
            preserve_flow=False,
            preserve_guidance=False,
            text_plan=plan,
        )

        self.assertEqual(guidance, [])
        self.assertEqual([text for _, text in approved], ["복학원서", "성명:"])
        self.assertEqual([item["text"] for item in kept], ["복학원서", "성명:"])
        self.assertEqual(kept[1]["source_text"], "성명: 홍길동 추가값")
        self.assertEqual([item["text"] for item in removed], ["완성 답변"])
        self.assertEqual(stats["approved_text_nodes_preserved"], 2)
        self.assertEqual(stats["text_nodes_cleared"], 1)
        self.assertTrue(
            any(copy_layout.local_name(element.tag) == "lineBreak" for element in tree.iter())
        )

    def test_colored_diagonal_cell_marks_are_inspected_and_cleared_explicitly(self):
        header = copy_layout.etree.fromstring(
            b'<header><borderFill id="9" centerLine="VERTICAL">'
            b'<slash type="NONE" Crooked="1" isCounter="0"/>'
            b'<backSlash type="NONE" Crooked="0" isCounter="0"/>'
            b'<diagonal type="SOLID" width="2.0 mm" color="#FF0000"/>'
            b'<fillBrush><winBrush faceColor="#0000FF" hatchColor="#999999" alpha="0"/>'
            b'</fillBrush>'
            b'</borderFill></header>'
        )
        section = copy_layout.etree.fromstring(
            b'<section><tbl><tr><tc borderFillIDRef="9">'
            b'<cellAddr colAddr="2" rowAddr="3"/><p/>'
            b'</tc></tr></tbl></section>'
        )
        trees = {
            "Contents/header.xml": copy_layout.etree.ElementTree(header),
            "Contents/section0.xml": copy_layout.etree.ElementTree(section),
        }

        marks = copy_layout.border_fill_mark_inventory(trees)
        cleared = copy_layout.clear_border_fill_marks(trees, {"9"})

        self.assertEqual([mark["id"] for mark in marks], ["9", "9"])
        self.assertEqual(
            [mark["kind"] for mark in marks],
            ["diagonal-border-mark", "empty-cell-fill-mark"],
        )
        self.assertEqual(marks[0]["uses"][0]["cell_address"], {"colAddr": "2", "rowAddr": "3"})
        self.assertEqual([item["id"] for item in cleared], ["9"])
        diagonal = next(child for child in header[0] if copy_layout.local_name(child.tag) == "diagonal")
        slash = next(child for child in header[0] if copy_layout.local_name(child.tag) == "slash")
        win_brush = next(
            element for element in header[0].iter()
            if copy_layout.local_name(element.tag) == "winBrush"
        )
        self.assertEqual(diagonal.attrib, {"type": "SOLID", "width": "0.1 mm", "color": "#000000"})
        self.assertEqual(slash.get("Crooked"), "0")
        self.assertEqual(header[0].get("centerLine"), "NONE")
        self.assertEqual(win_brush.get("faceColor"), "#FFFFFF")

    def test_semantic_plan_preserves_fillable_fields_and_control_identity(self):
        root = copy_layout.etree.fromstring(
            b'<section><p><run>'
            b'<fieldBegin id="1" type="CLICK_HERE" name="recipient" editable="1">'
            b'<parameters><stringParam name="Command">placeholder</stringParam></parameters>'
            b'</fieldBegin>'
            b'<t>Recipient</t><fieldEnd id="1"/>'
            b'<checkBtn name="CheckBox1" caption="Option" value="CHECKED"/>'
            b'</run></p></section>'
        )
        tree = copy_layout.etree.ElementTree(root)
        plan = {
            "source_sha256": "unused-by-tree-unit-test",
            "default": "keep",
            "keep": set(),
            "remove": set(),
            "replace": {},
        }

        stats, _, _, _, _ = copy_layout.sanitize_document_tree(
            tree,
            "Contents/section0.xml",
            set(),
            preserve_flow=False,
            preserve_guidance=False,
            text_plan=plan,
        )
        controls = copy_layout.form_control_inventory_from_trees(
            {"Contents/section0.xml": tree}
        )
        reset = copy_layout.reset_form_controls(
            {"Contents/section0.xml": tree},
            {"Contents/section0.xml#control0000"},
        )

        field_begin = next(
            element for element in root.iter()
            if copy_layout.local_name(element.tag) == "fieldBegin"
        )
        check_box = next(
            element for element in root.iter()
            if copy_layout.local_name(element.tag) == "checkBtn"
        )
        command = next(
            element for element in root.iter()
            if copy_layout.local_name(element.tag) == "stringParam"
        )
        self.assertEqual(stats["field_markers_preserved"], 2)
        self.assertEqual(field_begin.get("name"), "recipient")
        self.assertEqual(command.get("name"), "Command")
        self.assertEqual(controls[0]["name"], "CheckBox1")
        self.assertEqual(reset[0]["value"], "CHECKED")
        self.assertEqual(check_box.get("name"), "CheckBox1")
        self.assertEqual(check_box.get("value"), "UNCHECKED")

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

    def test_page_count_mismatch_is_delivered_as_best_effort(self):
        report = {"verification": {"zip_valid": True}}

        result = copy_layout.set_delivery(
            report,
            ["final HWPX pageCount changed: 1 -> 2"],
        )

        self.assertTrue(result["delivery"]["ready"])
        self.assertEqual(result["delivery"]["quality"], "best_effort")
        self.assertEqual(
            result["delivery"]["warnings"],
            ["final HWPX pageCount changed: 1 -> 2"],
        )

    def test_explicit_hwp_failure_delivers_page_mismatched_hwpx_fallback(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source.hwp"
            destination = root / "requested.hwp"
            sanitized = root / "safe.hwpx"
            source.write_bytes(b"source")
            destination.write_bytes(b"partial native output")
            sanitized.write_bytes(b"safe package")
            report = {"verification": {"zip_valid": True}}

            def fake_info(_binary, document):
                return {"pageCount": 1 if document == source else 2}

            with patch.object(copy_layout, "native_document_info", side_effect=fake_info):
                result = copy_layout.deliver_hwpx_fallback(
                    destination,
                    sanitized,
                    report,
                    source,
                    ".hwp",
                    Path("rhwp"),
                    ValueError("native pageCount changed: 1 -> 2"),
                    None,
                )

            fallback = Path(result["output"])
            self.assertFalse(destination.exists())
            self.assertEqual(fallback.suffix, ".hwpx")
            self.assertEqual(fallback.read_bytes(), b"safe package")
            self.assertTrue(result["delivery"]["ready"])
            self.assertEqual(result["delivery"]["quality"], "best_effort")
            self.assertTrue(
                any("pageCount changed: 1 -> 2" in warning for warning in result["delivery"]["warnings"])
            )

    def test_final_hwpx_page_expansion_is_returned_instead_of_deleted(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source.hwp"
            output = root / "requested.hwpx"
            source.write_bytes(b"source")

            def fake_export(_binary, _source, intermediate):
                intermediate.write_bytes(b"intermediate")
                return {"page_gate": "deferred-to-final-output"}

            def fake_sanitize(_source, destination, *_args, **_kwargs):
                destination.write_bytes(b"safe package")
                return {
                    "verification": {
                        "layout": {},
                        "approved_visible_text": [],
                    },
                    "changes": {},
                }

            def fake_info(_binary, document):
                return {
                    "format": "HWPX",
                    "pageCount": 1 if document.suffix == ".hwp" else 2,
                    "sections": 1,
                }

            with patch.object(copy_layout, "resolve_rhwp_binary", return_value=Path("rhwp")), patch.object(
                copy_layout,
                "export_hwpx_for_sanitization",
                side_effect=fake_export,
            ), patch.object(copy_layout, "sanitize_hwpx", side_effect=fake_sanitize), patch.object(
                copy_layout,
                "native_document_info",
                side_effect=fake_info,
            ):
                result = copy_layout.copy_layout(source, output, set())

            self.assertEqual(output.read_bytes(), b"safe package")
            self.assertTrue(result["delivery"]["ready"])
            self.assertEqual(result["delivery"]["quality"], "best_effort")
            self.assertEqual(
                result["delivery"]["warnings"],
                ["final HWPX pageCount changed: 1 -> 2"],
            )


if __name__ == "__main__":
    unittest.main()
