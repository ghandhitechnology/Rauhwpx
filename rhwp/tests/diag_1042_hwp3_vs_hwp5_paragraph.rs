//! HWP3 (hwp3-sample16.hwp) vs HWP5 변환본 (hwp3-sample16-hwp5-2024.hwp) 의
//! paragraph data 측정 비교. paragraph 분포 정합 위해 측정값 일치 필요.

#[test]
fn diag_paragraph_metrics_compare() {
    let hwp3_bytes = std::fs::read("samples/hwp3-sample16.hwp").expect("read");
    let hwp5_bytes = std::fs::read("samples/hwp3-sample16-hwp5-2024.hwp").expect("read");

    let hwp3_doc = rhwp::parser::parse_document(&hwp3_bytes).expect("parse hwp3");
    let hwp5_doc = rhwp::parser::parse_document(&hwp5_bytes).expect("parse hwp5");

    eprintln!("\n=== variant flag ===");
    eprintln!(
        "HWP3 original: is_hwp3_variant={}",
        hwp3_doc.is_hwp3_variant
    );
    eprintln!(
        "HWP5 variant : is_hwp3_variant={}",
        hwp5_doc.is_hwp3_variant
    );

    // 같은 paragraph (pi=199 "(3) 제안서 작성 요령") 비교
    for &pi in &[199_usize, 200, 201] {
        let hwp3_para = &hwp3_doc.sections[0].paragraphs.get(pi);
        let hwp5_para = &hwp5_doc.sections[0].paragraphs.get(pi);
        eprintln!("\n--- pi={} ---", pi);
        if let (Some(h3p), Some(h5p)) = (hwp3_para, hwp5_para) {
            eprintln!(
                "HWP3 pi={} ps_id={} text='{}'",
                pi,
                h3p.para_shape_id,
                h3p.text.chars().take(40).collect::<String>()
            );
            eprintln!(
                "HWP5 pi={} ps_id={} text='{}'",
                pi,
                h5p.para_shape_id,
                h5p.text.chars().take(40).collect::<String>()
            );
            let h3_ps = hwp3_doc
                .doc_info
                .para_shapes
                .get(h3p.para_shape_id as usize);
            let h5_ps = hwp5_doc
                .doc_info
                .para_shapes
                .get(h5p.para_shape_id as usize);
            if let (Some(h3s), Some(h5s)) = (h3_ps, h5_ps) {
                eprintln!(
                    "HWP3 ParaShape: sb={} sa={} margin_l={} margin_r={} indent={} line_spacing={}",
                    h3s.spacing_before,
                    h3s.spacing_after,
                    h3s.margin_left,
                    h3s.margin_right,
                    h3s.indent,
                    h3s.line_spacing
                );
                eprintln!(
                    "HWP5 ParaShape: sb={} sa={} margin_l={} margin_r={} indent={} line_spacing={}",
                    h5s.spacing_before,
                    h5s.spacing_after,
                    h5s.margin_left,
                    h5s.margin_right,
                    h5s.indent,
                    h5s.line_spacing
                );
            }
            // line_segs 비교
            if !h3p.line_segs.is_empty() && !h5p.line_segs.is_empty() {
                let h3l = &h3p.line_segs[0];
                let h5l = &h5p.line_segs[0];
                eprintln!(
                    "HWP3 line_segs[0]: vpos={} lh={} ls={}",
                    h3l.vertical_pos, h3l.line_height, h3l.line_spacing
                );
                eprintln!(
                    "HWP5 line_segs[0]: vpos={} lh={} ls={}",
                    h5l.vertical_pos, h5l.line_height, h5l.line_spacing
                );
            }
        }
    }
}
