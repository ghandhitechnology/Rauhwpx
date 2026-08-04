//! Stage 4 재진단: 정상 (2010 HWP3 / 2024 HWP5) vs 비정상 (2018 / 2022) 비교 리버싱

#[test]
fn diag_2010_vs_2018_paragraph_diff() {
    let bytes_a = std::fs::read("samples/hwp3-sample16-hwp5-2010.hwp").expect("read 2010");
    let doc_a = rhwp::parser::parse_hwp(&bytes_a).expect("parse 2010");
    let bytes_b = std::fs::read("samples/hwp3-sample16-hwp5-2018.hwp").expect("read 2018");
    let doc_b = rhwp::parser::parse_hwp(&bytes_b).expect("parse 2018");

    let sa = &doc_a.sections[0];
    let sb = &doc_b.sections[0];
    let total = sa.paragraphs.len().min(sb.paragraphs.len());

    let mut diff_count = 0;
    let mut diff_ls_count = 0;
    let mut diff_lh = 0;
    let mut diff_ls_field = 0;
    eprintln!("2010 (HWP3 정상) vs 2018 (비정상) paragraphs ({}):", total);
    for i in 0..total {
        let pa = &sa.paragraphs[i];
        let pb = &sb.paragraphs[i];
        let mut diffs: Vec<String> = Vec::new();

        if pa.line_segs.len() != pb.line_segs.len() {
            diff_ls_count += 1;
            diffs.push(format!(
                "ls.len 2010={} 2018={}",
                pa.line_segs.len(),
                pb.line_segs.len()
            ));
        }
        if pa.line_segs.len() == pb.line_segs.len() && !pa.line_segs.is_empty() {
            for (la, lb) in pa.line_segs.iter().zip(pb.line_segs.iter()) {
                if la.line_height != lb.line_height {
                    diff_lh += 1;
                    diffs.push(format!(
                        "lh 2010={} 2018={}",
                        la.line_height, lb.line_height
                    ));
                    break;
                }
                if la.line_spacing != lb.line_spacing {
                    diff_ls_field += 1;
                    diffs.push(format!(
                        "ls 2010={} 2018={}",
                        la.line_spacing, lb.line_spacing
                    ));
                    break;
                }
            }
        }

        if !diffs.is_empty() {
            diff_count += 1;
            if diff_count <= 10 {
                let text_pre: String = pa.text.chars().take(30).collect();
                eprintln!("  p{}: {}  | {}", i, diffs.join(", "), text_pre);
            }
        }
    }
    eprintln!(
        "total diff: {} (ls.len diff: {}, lh diff: {}, ls diff: {})",
        diff_count, diff_ls_count, diff_lh, diff_ls_field
    );
}

#[test]
fn diag_2024_vs_2022_paragraph_diff() {
    let bytes_a = std::fs::read("samples/hwp3-sample16-hwp5-2024.hwp").expect("read 2024");
    let doc_a = rhwp::parser::parse_hwp(&bytes_a).expect("parse 2024");
    let bytes_b = std::fs::read("samples/hwp3-sample16-hwp5-2022.hwp").expect("read 2022");
    let doc_b = rhwp::parser::parse_hwp(&bytes_b).expect("parse 2022");

    let sa = &doc_a.sections[0];
    let sb = &doc_b.sections[0];
    let total = sa.paragraphs.len().min(sb.paragraphs.len());

    let mut diff_count = 0;
    let mut diff_ls_count = 0;
    eprintln!(
        "\n2024 (HWP5 정상) vs 2022 (비정상) paragraphs ({}):",
        total
    );
    for i in 0..total {
        let pa = &sa.paragraphs[i];
        let pb = &sb.paragraphs[i];
        let mut diffs: Vec<String> = Vec::new();

        if pa.line_segs.len() != pb.line_segs.len() {
            diff_ls_count += 1;
            diffs.push(format!(
                "ls.len 2024={} 2022={}",
                pa.line_segs.len(),
                pb.line_segs.len()
            ));
        }
        if pa.line_segs.len() == pb.line_segs.len() && !pa.line_segs.is_empty() {
            for (la, lb) in pa.line_segs.iter().zip(pb.line_segs.iter()) {
                if la.line_height != lb.line_height {
                    diffs.push(format!(
                        "lh 2024={} 2022={}",
                        la.line_height, lb.line_height
                    ));
                    break;
                }
                if la.line_spacing != lb.line_spacing {
                    diffs.push(format!(
                        "ls 2024={} 2022={}",
                        la.line_spacing, lb.line_spacing
                    ));
                    break;
                }
                if la.vertical_pos != lb.vertical_pos {
                    diffs.push(format!(
                        "vpos 2024={} 2022={}",
                        la.vertical_pos, lb.vertical_pos
                    ));
                    break;
                }
            }
        }

        if !diffs.is_empty() {
            diff_count += 1;
            if diff_count <= 10 {
                let text_pre: String = pa.text.chars().take(30).collect();
                eprintln!("  p{}: {}  | {}", i, diffs.join(", "), text_pre);
            }
        }
    }
    eprintln!(
        "total diff: {} (ls.len diff: {})",
        diff_count, diff_ls_count
    );
}
