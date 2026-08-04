#[test]
fn check_sample16_versions() {
    for f in [
        "samples/hwp3-sample16-hwp5.hwp",
        "samples/hwp3-sample16-hwp5-2010.hwp",
        "samples/hwp3-sample16-hwp5-2018.hwp",
        "samples/hwp3-sample16-hwp5-2022.hwp",
        "samples/hwp3-sample16-hwp5-2024.hwp",
        "samples/k-water-rfp.hwp",
        "samples/k-water-rfp-2024.hwp",
    ]
    .iter()
    {
        let bytes = std::fs::read(f).unwrap();
        let doc = rhwp::parser::parse_hwp(&bytes).unwrap();
        let v = &doc.header.version;
        eprintln!(
            "{}: version={}.{}.{}.{} variant={}",
            f, v.major, v.minor, v.build, v.revision, doc.is_hwp3_variant
        );
    }
}
