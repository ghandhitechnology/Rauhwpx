//! Stage 4 v2 옵션 A: paragraph 별 height 계산 정밀 trace
//! k-water-rfp 페이지 2 (diff +5.6 px) 의 paragraph 별 line_segs vpos+lh vs rhwp 측정 비교

#[test]
fn diag_kwater_p2_baseline_trace() {
    // ensure_min_baseline 의 paragraph 별 영향 측정
    // ensure_min_baseline 인라인 구현 (private fn)
    fn ensure_min_baseline(raw_baseline: f64, max_font_size: f64) -> f64 {
        if max_font_size <= 0.0 {
            return raw_baseline;
        }
        raw_baseline.max(max_font_size * 0.8)
    }

    let bytes = std::fs::read("samples/k-water-rfp.hwp").expect("read");
    let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
    let section = &doc.sections[0];

    let dpi = 96.0;
    eprintln!("ensure_min_baseline diff:");
    eprintln!(
        "{:>4} | {:>6} | {:>6} | {:>6} | {:>+6} | {:>4} | text",
        "p#", "raw_bl", "max_fs", "ensured", "diff", "ls"
    );

    let mut total_baseline_diff = 0.0;
    let mut affected_count = 0;
    for i in 0..section.paragraphs.len() {
        let para = &section.paragraphs[i];
        if para.line_segs.is_empty() {
            continue;
        }
        let raw_bl_hu = para.line_segs[0].baseline_distance;
        let raw_bl = raw_bl_hu as f64 * dpi / 7200.0;

        let first_cs_id = para
            .char_shapes
            .first()
            .map(|cs| cs.char_shape_id)
            .unwrap_or(0);
        let base_size = doc
            .doc_info
            .char_shapes
            .get(first_cs_id as usize)
            .map(|cs| cs.base_size)
            .unwrap_or(1000);
        let max_fs_px = base_size as f64 / 100.0 * dpi / 72.0;

        let ensured = ensure_min_baseline(raw_bl, max_fs_px);
        let diff = ensured - raw_bl;
        if diff > 0.01 {
            total_baseline_diff += diff;
            affected_count += 1;
            if affected_count <= 15 {
                let text_pre: String = para.text.chars().take(25).collect();
                eprintln!(
                    "{:>4} | {:>6.2} | {:>6.2} | {:>6.2} | {:>+6.2} | {:>4} | {}",
                    i,
                    raw_bl,
                    max_fs_px,
                    ensured,
                    diff,
                    para.line_segs.len(),
                    text_pre
                );
            }
        }
    }
    eprintln!(
        "affected: {}, total baseline diff: {:.2} px",
        affected_count, total_baseline_diff
    );
}

#[test]
fn diag_kwater_paragraph_total_height() {
    // paragraph 별 line_segs raw height sum vs paragraph_layout 예상 height 비교
    let bytes = std::fs::read("samples/k-water-rfp.hwp").expect("read");
    let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
    let section = &doc.sections[0];

    let dpi = 96.0;
    let to_px = |hu: i32| hu as f64 * dpi / 7200.0;

    eprintln!("paragraph 별 raw line_segs sum (lh+ls):");
    eprintln!(
        "{:>4} | {:>4} | {:>8} | {:>8} | {:>8} | text",
        "p#", "ls#", "lh_sum", "ls_sum", "total"
    );

    for i in 0..section.paragraphs.len().min(50) {
        let para = &section.paragraphs[i];
        if para.line_segs.is_empty() {
            continue;
        }
        let lh_sum: f64 = para.line_segs.iter().map(|ls| to_px(ls.line_height)).sum();
        let ls_sum: f64 = para.line_segs.iter().map(|ls| to_px(ls.line_spacing)).sum();
        let total = lh_sum + ls_sum;
        // raw vpos 기반 paragraph height
        let last = para.line_segs.last().unwrap();
        let first = &para.line_segs[0];
        let vpos_total = to_px(last.vertical_pos + last.line_height - first.vertical_pos);
        let text_pre: String = para.text.chars().take(25).collect();
        if i < 20 || (total - vpos_total).abs() > 0.5 {
            eprintln!("{:>4} | {:>4} | {:>8.2} | {:>8.2} | {:>8.2} | vpos_total={:>7.2}, diff={:+.2} | {}",
                i, para.line_segs.len(), lh_sum, ls_sum, total, vpos_total,
                total - vpos_total, text_pre);
        }
    }
}
