This fixture derives from `rhwp/samples/hwpx/business_overview.hwpx`. Its initial `hp:colPr` in `Contents/section0.xml` uses two unequal columns with widths 10000 and 29000 HWP units, a 1000-unit gap, and `sameSz="0"`.

Inserting 32 long paragraphs at paragraph 5 crosses the column boundary. Deferring intermediate pagination prevents the existing column-width convergence loop from running, so this fixture verifies that agent multiline insertion keeps the original pagination path for unequal columns.
