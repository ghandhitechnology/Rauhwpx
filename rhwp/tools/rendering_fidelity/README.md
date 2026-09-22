# Hancom rendering audit

The corpus contains 20 existing documents and 10 generated fixtures. Generate the
fixtures with `python3 generate_synthetic_hwpx.py`; export each exact source from
the installed Hancom editor to PDF. Reference filenames are listed in
`sample_manifest.json`; synthetic references use `verified-<fixture stem>.pdf` (configurable with `--synthetic-prefix`).
Regenerating a fixture requires exporting its reference again.

Preserve the native binaries before and after changes. Install Python dependencies
`pymupdf`, `numpy`, and `Pillow`, then run from the repository root:

```sh
python3 rhwp/tools/rendering_fidelity/audit_corpus.py \
  --baseline-bin /path/to/before/rhwp \
  --after-bin /path/to/after/rhwp \
  --official-dir /path/to/hancom-pdfs \
  --official-version 'Hancom 12.30.0 build 6446' \
  --font-path '/Applications/Hancom Office HWP.app/Contents/Resources/Hnc/Shared/TTF' \
  --out /path/to/new-audit-directory
```

Use the full installed font directory, including `Install`, `All`, and `Hwp`.
For example, GulimChe is in `Install`; passing only `Hwp` creates a font mismatch.
`--font-path` can be repeated. The audit records source, reference, binary, and
font SHA-256 hashes. It never copies licensed fonts into the repository.

Each document gets all native and official pages, overlay review sheets, and
before/after/official panels. `report.json` records page counts and foreground
difference metrics. Missing references, render failures, and different page counts
produce a nonzero exit. Use `--id` repeatedly to select a smaller group.

Successful execution means the comparison artifacts were created. It does not
mean the renderings match. Review every page and relevant enlarged detail, and
record remaining differences. Check the actual Studio renderer separately: native
Skia and browser font selection and text replay differ. A shared layout fix should
also have a Studio screenshot showing the corrected behavior.
