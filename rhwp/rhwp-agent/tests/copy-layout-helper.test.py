import importlib.util
import json
import sys
import tempfile
import time
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

    def test_rhwp_binary_prefers_the_explicit_environment_path(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "custom-rhwp.exe"
            binary.write_bytes(b"binary")
            binary.chmod(0o755)
            with patch.dict(copy_layout.os.environ, {"RHWP_BIN": str(binary)}), patch.object(
                copy_layout.shutil,
                "which",
                return_value=None,
            ):
                resolved = copy_layout.resolve_rhwp_binary(
                    None,
                    platform_name="nt",
                    repository_root=Path(temp) / "repository",
                )
            self.assertEqual(resolved, binary.resolve())

    def test_run_rhwp_stops_an_oversized_stdout_tree(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "stdout exceeded its 64-byte limit"):
            copy_layout.run_rhwp(
                Path(sys.executable),
                [
                    "-S",
                    "-c",
                    "import sys,time; "
                    "sys.stdout.buffer.write(b'x' * 1024); "
                    "sys.stdout.buffer.flush(); time.sleep(5)",
                ],
                max_stdout_bytes=64,
                timeout_seconds=2,
            )
        self.assertLess(time.monotonic() - started, 2)

    def test_run_rhwp_stops_an_oversized_stderr_tree(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "stderr exceeded its 32-byte limit"):
            copy_layout.run_rhwp(
                Path(sys.executable),
                [
                    "-S",
                    "-c",
                    "import sys,time; "
                    "sys.stderr.buffer.write(b'x' * 1024); "
                    "sys.stderr.buffer.flush(); time.sleep(5)",
                ],
                max_stderr_bytes=32,
                timeout_seconds=2,
            )
        self.assertLess(time.monotonic() - started, 2)

    def test_run_rhwp_stops_a_timed_out_process_tree(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "exceeded its 0.05-second timeout"):
            copy_layout.run_rhwp(
                Path(sys.executable),
                ["-S", "-c", "import time; time.sleep(5)"],
                timeout_seconds=0.05,
            )
        self.assertLess(time.monotonic() - started, 2)

    def test_run_rhwp_reports_unconfirmed_tree_cleanup(self):
        terminate = copy_layout._terminate_rhwp_tree

        def clean_but_withhold_proof(process):
            terminate(process)
            return False

        with patch.object(
            copy_layout,
            "_terminate_rhwp_tree",
            side_effect=clean_but_withhold_proof,
        ):
            with self.assertRaisesRegex(
                ValueError,
                "process-tree cleanup could not be confirmed",
            ):
                copy_layout.run_rhwp(
                    Path(sys.executable),
                    ["-S", "-c", "import time; time.sleep(5)"],
                    timeout_seconds=0.05,
                )

    def test_run_rhwp_inherits_the_private_temp_environment_without_a_shell(self):
        with patch.dict(
            copy_layout.os.environ,
            {"TEMP": "private-temp", "TMP": "private-tmp"},
        ):
            result = copy_layout.run_rhwp(
                Path(sys.executable),
                [
                    "-S",
                    "-c",
                    "import json,os; print(json.dumps([os.environ.get('TEMP'), os.environ.get('TMP')]))",
                ],
                expect_json=True,
            )
        self.assertEqual(result, ["private-temp", "private-tmp"])

    def test_rhwp_binary_checks_windows_executable_names(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "rhwp.exe"
            binary.write_bytes(b"binary")
            binary.chmod(0o755)
            checked = []

            def which(name):
                checked.append(name)
                return str(binary) if name == "rhwp.exe" else None

            with patch.dict(copy_layout.os.environ, {"RHWP_BIN": ""}), patch.object(
                copy_layout.shutil,
                "which",
                side_effect=which,
            ):
                resolved = copy_layout.resolve_rhwp_binary(
                    None,
                    platform_name="nt",
                    repository_root=Path(temp) / "repository",
                )
            self.assertEqual(resolved, binary.resolve())
            self.assertEqual(checked, ["rhwp.exe"])

    def test_rhwp_binary_finds_the_windows_repository_build(self):
        with tempfile.TemporaryDirectory() as temp:
            repository = Path(temp) / "repository"
            binary = repository / "target" / "release" / "rhwp.exe"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"binary")
            binary.chmod(0o755)
            with patch.dict(copy_layout.os.environ, {"RHWP_BIN": ""}), patch.object(
                copy_layout.shutil,
                "which",
                return_value=None,
            ):
                resolved = copy_layout.resolve_rhwp_binary(
                    None,
                    platform_name="nt",
                    repository_root=repository,
                )
            self.assertEqual(resolved, binary.resolve())

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
                text
                for node in tree.iter()
                if copy_layout.local_name(node.tag) == "t"
                if (text := copy_layout.normalize_visible_text("".join(node.itertext())))
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

    def test_removed_text_uses_a_zero_width_non_whitespace_layout_anchor(self):
        tree = self.document_tree("private table value")

        copy_layout.sanitize_document_tree(
            tree,
            "Contents/section0.xml",
            set(),
            preserve_flow=False,
            preserve_guidance=False,
        )

        text_node = next(
            node for node in tree.iter() if copy_layout.local_name(node.tag) == "t"
        )
        self.assertEqual(text_node.text, copy_layout.LAYOUT_ANCHOR)
        self.assertFalse(copy_layout.LAYOUT_ANCHOR.isspace())
        self.assertEqual(copy_layout.normalize_visible_text(text_node.text), "")
        self.assertEqual(
            copy_layout.visible_text_fragments({"Contents/section0.xml": tree}),
            [],
        )

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
                archive.writestr("Preview/PrvText.txt", "학생이 작성한 답안")
                archive.writestr("Preview/PrvImage.png", b"private preview")

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
            self.assertEqual(
                report["generated_preview_entries"],
                ["Preview/PrvImage.png", "Preview/PrvText.txt"],
            )
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(
                    archive.read("Preview/PrvText.txt"),
                    copy_layout.PUBLISHABLE_PREVIEW_TEXT,
                )
                self.assertEqual(
                    archive.read("Preview/PrvImage.png"),
                    copy_layout.PUBLISHABLE_PREVIEW_IMAGE,
                )
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
            with zipfile.ZipFile(output) as archive:
                self.assertTrue(set(copy_layout.PUBLISHABLE_PREVIEW_ENTRIES) <= set(archive.namelist()))

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

    def test_archive_inventory_rejects_duplicate_and_traversal_entries(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            for name, entries in {
                "duplicate.hwpx": [("a.xml", b"<a/>"), ("a.xml", b"<b/>")],
                "traversal.hwpx": [("../outside.xml", b"<a/>")],
            }.items():
                package = root / name
                with zipfile.ZipFile(package, "w") as archive:
                    for entry_name, payload in entries:
                        archive.writestr(entry_name, payload)
                with zipfile.ZipFile(package) as archive, self.assertRaisesRegex(
                    ValueError, "unsafe or duplicate"
                ):
                    copy_layout.validate_archive_inventory(archive)

    def test_archive_inventory_rejects_noncanonical_and_oversized_names(self):
        hostile_names = [
            "./a.xml",
            "Contents//a.xml",
            "Contents/./a.xml",
            "Contents/",
            "C:/a.xml",
            f"{'a' * 4093}.xml",
        ]
        for index, name in enumerate(hostile_names):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary_directory:
                package = Path(temporary_directory) / f"unsafe-name-{index}.hwpx"
                with zipfile.ZipFile(package, "w") as archive:
                    archive.writestr(name, b"<a/>")
                with zipfile.ZipFile(package) as archive:
                    with self.assertRaisesRegex(ValueError, "unsafe or duplicate"):
                        copy_layout.validate_archive_inventory(archive)

    def test_archive_reads_enforce_declared_member_and_aggregate_limits(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            package = Path(temporary_directory) / "bounded.hwpx"
            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("Preview/PrvImage.png", b"123456789")
                archive.writestr("Contents/section0.xml", b"<section/>")
            with zipfile.ZipFile(package) as archive, patch.object(
                copy_layout, "MAX_HWPX_THUMBNAIL_ENTRY_BYTES", 8
            ), self.assertRaisesRegex(ValueError, "entry exceeds"):
                copy_layout.validate_archive_inventory(archive)
            with zipfile.ZipFile(package) as archive, patch.object(
                copy_layout, "MAX_HWPX_EXPANDED_BYTES", 8
            ), self.assertRaisesRegex(ValueError, "512 MiB safety limit"):
                copy_layout.validate_archive_inventory(archive)

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

    def test_candidate_render_evidence_is_derived_from_both_documents(self):
        render_calls = []

        def fake_info(_binary, document):
            return {
                "pageCount": 5 if document.name == "source.hwpx" else 5,
                "sections": 2,
            }

        def fake_render(_binary, document, page, _root, label):
            render_calls.append((document.name, page, label))
            return {
                "page": page,
                "width": 100,
                "height": 200,
                "bytes": 24,
                "sha256": "a" * 64,
            }

        report = {
            "verification": {
                "zip_valid": True,
                "xml_valid": True,
                "layout_structure_match": True,
                "layout_fingerprint_match": True,
            },
            "delivery": {"ready": True, "quality": "verified", "warnings": []},
        }
        with tempfile.TemporaryDirectory() as temporary_directory, patch.object(
            copy_layout, "native_document_info", side_effect=fake_info
        ), patch.object(copy_layout, "render_document_page", side_effect=fake_render):
            evidence = copy_layout.candidate_render_evidence(
                Path("rhwp"),
                Path("source.hwpx"),
                Path("candidate.hwpx"),
                report,
            )

        self.assertEqual(evidence["representative_pages"], [0, 2, 4])
        self.assertEqual(evidence["source_page_count"], 5)
        self.assertEqual(evidence["output_page_count"], 5)
        self.assertEqual(evidence["output_section_count"], 2)
        self.assertTrue(evidence["render_compared"])
        self.assertTrue(evidence["geometry_match"])
        self.assertTrue(evidence["safety_verified"])
        self.assertTrue(evidence["readability_verified"])
        self.assertEqual(len(render_calls), 6)

    def test_rendered_svg_record_rejects_invalid_render_output(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            svg = root / "page.svg"
            svg.write_bytes(
                b'<svg xmlns="http://www.w3.org/2000/svg" width="100.2" height="200.1"></svg>'
            )
            record = copy_layout.rendered_svg_record(svg, 0)
            self.assertEqual((record["width"], record["height"]), (101, 201))
            svg.write_bytes(b"not an svg document with enough bytes")
            with self.assertRaisesRegex(ValueError, "not a valid SVG"):
                copy_layout.rendered_svg_record(svg, 0)


if __name__ == "__main__":
    unittest.main()
