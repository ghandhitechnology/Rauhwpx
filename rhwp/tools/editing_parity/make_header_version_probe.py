"""Change one HWPX header or package XML-version attribute for comparison."""

import argparse
import hashlib
from pathlib import Path
import re
from zipfile import ZipFile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--version", default="1.5", choices=["1.2", "1.3", "1.4", "1.5"])
    parser.add_argument("--package-xml-version", action="store_true")
    args = parser.parse_args()
    if args.destination.exists():
        parser.error("destination already exists")
    with ZipFile(args.source) as source:
        entry = "version.xml" if args.package_xml_version else "Contents/header.xml"
        header = source.read(entry)
        pattern = (
            rb'(<hv:HCFVersion\b[^>]*\bxmlVersion=")[^"]+("[^>]*>)'
            if args.package_xml_version
            else rb'(<hh:head\b[^>]*\bversion=")[^"]+("[^>]*>)'
        )
        changed, count = re.subn(
            pattern,
            lambda match: match[1] + args.version.encode("ascii") + match[2],
            header,
            count=1,
        )
        if count != 1 or changed == header:
            parser.error(f"expected one changed XML-version attribute in {entry}")
        with ZipFile(args.destination, "x") as destination:
            destination.comment = source.comment
            for info in source.infolist():
                destination.writestr(
                    info,
                    changed if info.filename == entry else source.read(info),
                )
    with ZipFile(args.source) as source, ZipFile(args.destination) as destination:
        assert source.namelist() == destination.namelist()
        differences = [
            name for name in source.namelist() if source.read(name) != destination.read(name)
        ]
        assert differences == [entry], differences
    print(f"Changed only {entry} XML version to {args.version}")
    print(hashlib.sha256(args.destination.read_bytes()).hexdigest(), args.destination)


if __name__ == "__main__":
    main()
