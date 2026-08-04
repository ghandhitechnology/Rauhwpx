//! Stage 4: sample16-hwp5-2022 의 +1 baseline 회귀 진단
//! 다른 4 파일 (변환기/2010/2018/2024) 은 64 정합, 2022 만 65.
//! paragraph data 동일 (raw binary 진단)이므로 section_def / header / version flag 차이 추정.

#[test]
fn diag_2022_vs_others_metadata() {
    let files = [
        ("변환기", "samples/hwp3-sample16-hwp5.hwp"),
        ("2010", "samples/hwp3-sample16-hwp5-2010.hwp"),
        ("2018", "samples/hwp3-sample16-hwp5-2018.hwp"),
        ("2022", "samples/hwp3-sample16-hwp5-2022.hwp"),
        ("2024", "samples/hwp3-sample16-hwp5-2024.hwp"),
    ];
    for (label, path) in &files {
        let bytes = std::fs::read(path).expect("read");
        let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
        eprintln!("\n=== {} ({}) ===", label, path);
        eprintln!("  is_hwp3_variant: {}", doc.is_hwp3_variant);
        eprintln!(
            "  header version: {}.{}.{}.{}",
            doc.header.version.major,
            doc.header.version.minor,
            doc.header.version.build,
            doc.header.version.revision
        );
        eprintln!(
            "  header flags: raw=0x{:08X} compressed={} distribution={}",
            doc.header.flags, doc.header.compressed, doc.header.distribution
        );
        // section_def metrics
        for (si, section) in doc.sections.iter().enumerate().take(1) {
            let pd = &section.section_def.page_def;
            eprintln!(
                "  section {}: paper {}×{}, margins L={} R={} T={} B={} (HU)",
                si,
                pd.width,
                pd.height,
                pd.margin_left,
                pd.margin_right,
                pd.margin_top,
                pd.margin_bottom
            );
            eprintln!(
                "    margin_header={}, margin_footer={}, margin_gutter={}",
                pd.margin_header, pd.margin_footer, pd.margin_gutter
            );
            eprintln!("    attr=0x{:08X}, landscape={}", pd.attr, pd.landscape);
            eprintln!(
                "    pagination_bottom_tolerance={}",
                pd.pagination_bottom_tolerance
            );
            eprintln!(
                "    section_def: flags=0x{:08X} column_spacing={} default_tab_spacing={}",
                section.section_def.flags,
                section.section_def.column_spacing,
                section.section_def.default_tab_spacing
            );
            eprintln!(
                "    page_num={}, page_num_type={}",
                section.section_def.page_num, section.section_def.page_num_type
            );
        }
        // doc_properties
        eprintln!(
            "  paragraphs total: {}",
            doc.sections
                .iter()
                .map(|s| s.paragraphs.len())
                .sum::<usize>()
        );
        eprintln!(
            "  para_shapes: {}, char_shapes: {}",
            doc.doc_info.para_shapes.len(),
            doc.doc_info.char_shapes.len()
        );
    }
}

#[test]
fn diag_2022_vs_2010_paragraph_diff() {
    // 2010 vs 2022 paragraph 별 diff (같은 4223 PARA_LINE_SEG 누락이지만 페이지 수 다름)
    let bytes_a = std::fs::read("samples/hwp3-sample16-hwp5-2010.hwp").expect("read 2010");
    let doc_a = rhwp::parser::parse_hwp(&bytes_a).expect("parse 2010");
    let bytes_b = std::fs::read("samples/hwp3-sample16-hwp5-2022.hwp").expect("read 2022");
    let doc_b = rhwp::parser::parse_hwp(&bytes_b).expect("parse 2022");

    let sa = &doc_a.sections[0];
    let sb = &doc_b.sections[0];
    let total = sa.paragraphs.len().min(sb.paragraphs.len());

    let mut diff_count = 0;
    eprintln!("Comparing 2010 vs 2022 paragraphs ({} total)...", total);
    for i in 0..total {
        let pa = &sa.paragraphs[i];
        let pb = &sb.paragraphs[i];
        let mut diffs: Vec<String> = Vec::new();
        if pa.control_mask != pb.control_mask {
            diffs.push(format!(
                "ctrl_mask: 2010=0x{:08X} 2022=0x{:08X}",
                pa.control_mask, pb.control_mask
            ));
        }
        if pa.raw_break_type != pb.raw_break_type {
            diffs.push(format!(
                "break_type: 2010=0x{:02X} 2022=0x{:02X}",
                pa.raw_break_type, pb.raw_break_type
            ));
        }
        if pa.line_segs.len() != pb.line_segs.len() {
            diffs.push(format!(
                "ls.len: 2010={} 2022={}",
                pa.line_segs.len(),
                pb.line_segs.len()
            ));
        }
        if pa.raw_header_extra != pb.raw_header_extra {
            diffs.push(format!(
                "header_extra differ: 2010={:02X?} 2022={:02X?}",
                pa.raw_header_extra, pb.raw_header_extra
            ));
        }
        // line_segs 정합 시 첫 ls 비교
        if pa.line_segs.len() == pb.line_segs.len() {
            for (j, (la, lb)) in pa.line_segs.iter().zip(pb.line_segs.iter()).enumerate() {
                if la.line_height != lb.line_height || la.line_spacing != lb.line_spacing {
                    diffs.push(format!(
                        "ls[{}]: 2010 lh={} ls={} vs 2022 lh={} ls={}",
                        j, la.line_height, la.line_spacing, lb.line_height, lb.line_spacing
                    ));
                    break;
                }
                if la.vertical_pos != lb.vertical_pos {
                    diffs.push(format!(
                        "ls[{}].vpos: 2010={} 2022={}",
                        j, la.vertical_pos, lb.vertical_pos
                    ));
                    break;
                }
            }
        }
        if !diffs.is_empty() {
            diff_count += 1;
            if diff_count <= 15 {
                let text_pre: String = pa.text.chars().take(30).collect();
                eprintln!("p{}: {}  |  {}", i, diffs.join(", "), text_pre);
            }
        }
    }
    eprintln!("\ntotal diff paragraphs: {}", diff_count);
}
