//! 각 한컴 오피스 fixture 의 paragraph vpos 분포 분석.
//! paragraph local (small, <5000) vs absolute (large, >=50000) 비율 측정.

#[test]
fn paragraph_vpos_distribution() {
    for f in [
        "samples/hwp3-sample16-hwp5-2010.hwp",
        "samples/hwp3-sample16-hwp5-2018.hwp",
        "samples/hwp3-sample16-hwp5-2022.hwp",
        "samples/hwp3-sample16-hwp5-2024.hwp",
    ]
    .iter()
    {
        let bytes = std::fs::read(f).unwrap();
        let doc = rhwp::parser::parse_hwp(&bytes).unwrap();
        let section = &doc.sections[0];

        let mut total = 0;
        let mut paragraph_local = 0; // vpos < 5000
        let mut medium = 0; // 5000 <= vpos < 50000
        let mut absolute = 0; // vpos >= 50000
        let mut empty_lines = 0;

        for para in &section.paragraphs {
            if let Some(first) = para.line_segs.first() {
                total += 1;
                let v = first.vertical_pos;
                if v < 5000 {
                    paragraph_local += 1;
                } else if v < 50000 {
                    medium += 1;
                } else {
                    absolute += 1;
                }
            } else {
                empty_lines += 1;
            }
        }

        let pl_pct = (paragraph_local as f64 / total as f64) * 100.0;
        let abs_pct = (absolute as f64 / total as f64) * 100.0;
        eprintln!(
            "{}:\n  total={} paragraph_local={} ({:.1}%) medium={} absolute={} ({:.1}%) empty={}",
            f, total, paragraph_local, pl_pct, medium, absolute, abs_pct, empty_lines
        );
    }
}
