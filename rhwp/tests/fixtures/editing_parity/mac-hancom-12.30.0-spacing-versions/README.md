# Mac Hancom XML-version spacing probes

These files isolate the package version's effect on paragraph units. Each probe differs from the [original body-spacing input](../mac-hancom-12.30.0/body-paragraph-spacing/edited.hwpx) in exactly one XML attribute. ZIP metadata and all other entry contents are preserved by the probe generator.

On Mac Hancom 12.30.0 build 6446, changing only `header.xml` to version 1.5 left the image paragraph at 3/1.5 pt. Changing `version.xml@xmlVersion` to 1.4 or 1.5 made its dialog show 6/3 pt. The 1.3 package probe retained the original image position. The declared package version therefore changes how Hancom interprets the same HwpUnitChar values.

`hancom-spacing-6-3.hwpx` is a separate copy whose paragraph spacing was set to 6/3 pt in Hancom and saved. Its case values are 600/300, default values 1200/600, and package XML version 1.5. This is a controlled spacing edit, not an independent reproduction of the whole image recipe.

[capture.json](capture.json) records hashes, observations and limitations. These observations justify correcting regenerated package metadata, not halving Rau's layout values. Fresh PDF comparisons of the regenerated editing recipes are still required.

To reproduce a probe from the repository root, choose a new destination:

```sh
python3 rhwp/tools/editing_parity/make_header_version_probe.py \
  rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0/body-paragraph-spacing/edited.hwpx \
  /private/tmp/my-new-package-version-probe.hwpx \
  --package-xml-version --version 1.4
```

Omit `--package-xml-version` to change the header version only. Existing destinations cannot be overwritten.
