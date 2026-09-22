# Fidelity and diagnostic tools

These scripts investigate document rendering and editing against Hancom reference output. They are manual diagnostics unless a package script or workflow explicitly invokes them. Generated reports and fixtures go under `rhwp/output/`; checked-in samples and PDFs retain their reference provenance.

Checkout resources resolve relative to each script. Tools that need an external document corpus require a path argument instead of assuming a contributor's home directory. Run a script with `--help` where supported to see its inputs. Hancom COM tools require Windows, Hancom and pyhwpx; do not run them as part of an ordinary editor build.

## Table row probes

`hangul_row_heights.py` walks table cells and compares each observed height with the engine's row cuts. Its table index includes nested tables. `hangul_row_heights2.py` retains its historical name for existing reproducers, but compares merged-cell segments against sums of row cuts, selects body tables, and accepts a column or paragraph anchor. Those different selection rules are intentional. Both use the same cut-row parser.

```sh
python rhwp/tools/hangul_row_heights.py document.hwp --exe /path/to/rhwp
python rhwp/tools/hangul_row_heights2.py document.hwp --exe /path/to/rhwp --col 1 --pi 271
```

## External corpus examples

```sh
python rhwp/tools/render_page_gate.py --root /path/to/hwpdocs --exe /path/to/rhwp
python rhwp/tools/build_page_oracle.py --root /path/to/hwpdocs -o /path/to/oracle.tsv
```
