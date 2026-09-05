import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile


class VersionProbeTests(unittest.TestCase):
    root = Path(__file__).resolve().parents[3] / "tests/fixtures/editing_parity/mac-hancom-12.30.0-spacing-versions"

    def test_pinned_probes_change_only_the_declared_attribute(self):
        capture = json.loads((self.root / "capture.json").read_text())
        source = self.root / capture["source"]
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), capture["sourceSha256"])
        with ZipFile(source) as original:
            for probe in capture["probes"]:
                path = self.root / probe["file"]
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), probe["sha256"])
                with ZipFile(path) as changed:
                    self.assertEqual(original.namelist(), changed.namelist())
                    for name in original.namelist():
                        expected = original.read(name)
                        if name == probe["entry"]:
                            old = f'{probe["attribute"]}="1.2"'.encode()
                            new = f'{probe["attribute"]}="{probe["value"]}"'.encode()
                            self.assertEqual(expected.count(old), 1)
                            expected = expected.replace(old, new, 1)
                        self.assertEqual(changed.read(name), expected, f'{probe["file"]}/{name}')
        edited = capture["hancomEditedSample"]
        self.assertEqual(hashlib.sha256((self.root / edited["file"]).read_bytes()).hexdigest(), edited["sha256"])

    def test_generator_preserves_other_entries_and_refuses_overwrites(self):
        capture = json.loads((self.root / "capture.json").read_text())
        source = self.root / capture["source"]
        script = Path(__file__).resolve().parents[1] / "make_header_version_probe.py"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "probe.hwpx"
            command = [sys.executable, str(script), str(source), str(output), "--package-xml-version", "--version", "1.4"]
            subprocess.run(command, capture_output=True, check=True)
            with ZipFile(output) as actual, ZipFile(self.root / "package-xml-1-4-only.hwpx") as pinned:
                self.assertEqual(actual.namelist(), pinned.namelist())
                for name in actual.namelist():
                    self.assertEqual(actual.read(name), pinned.read(name))
            original_bytes = output.read_bytes()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(output.read_bytes(), original_bytes)
