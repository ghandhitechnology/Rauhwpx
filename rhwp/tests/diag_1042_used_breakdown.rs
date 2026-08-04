//! Task #1042 architectural refactor 진단:
//! sample16-2024 p6 (page_num=4) 의 used=969.5 px 구성 분석.
//! paragraph height 합산 vs paragraph_layout 의 y 누적 차이 식별.

#[test]
fn diag_p6_used_breakdown() {
    let bytes = std::fs::read("samples/hwp3-sample16-hwp5-2024.hwp").expect("read");
    let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
    let section = &doc.sections[0];

    let dpi = 96.0;
    let to_px = |hu: i32| hu as f64 * dpi / 7200.0;

    // p6 의 paragraph indices (dump-pages 결과 참조)
    let p6_indices: Vec<usize> = vec![
        142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159,
        160, 161, 162,
    ];

    eprintln!("\n=== sample16-2024 p6 paragraph 별 raw 분석 ===");
    eprintln!(
        "{:>4} | {:>5} | {:>6} | {:>6} | {:>6} | {:>6} | {:>6} | text",
        "pi", "ls#", "vpos[0]", "vpos[L]", "lh[L]", "ls[L]", "spans"
    );
    let mut prev_vpos_end: Option<i32> = None;
    let mut sum_vpos_diffs = 0.0;
    let mut sum_raw_heights = 0.0;

    for &pi in &p6_indices {
        let para = &section.paragraphs[pi];
        if para.line_segs.is_empty() {
            eprintln!("{:>4} | empty paragraph", pi);
            continue;
        }
        let first = &para.line_segs[0];
        let last = para.line_segs.last().unwrap();
        let lcount = para.line_segs.len();

        // paragraph 의 raw height = last.vpos + last.lh + last.ls - first.vpos
        let raw_h_hu =
            last.vertical_pos + last.line_height + last.line_spacing - first.vertical_pos;
        let raw_h_px = to_px(raw_h_hu);

        // 이전 paragraph 끝 vs 현재 paragraph 시작 vpos diff
        let vpos_diff_px = if let Some(prev_end) = prev_vpos_end {
            let diff = first.vertical_pos - prev_end;
            if diff < 0 {
                // vpos reset 발생 — diff 무시
                0.0
            } else {
                to_px(diff)
            }
        } else {
            0.0
        };

        let text_pre: String = para.text.chars().take(30).collect();
        eprintln!(
            "{:>4} | {:>5} | {:>6} | {:>6} | {:>6} | {:>6} | gap={:>5.1} h={:>5.1} | {}",
            pi,
            lcount,
            first.vertical_pos,
            last.vertical_pos,
            last.line_height,
            last.line_spacing,
            vpos_diff_px,
            raw_h_px,
            text_pre
        );

        sum_vpos_diffs += vpos_diff_px;
        sum_raw_heights += raw_h_px;
        prev_vpos_end = Some(last.vertical_pos + last.line_height + last.line_spacing);
    }

    eprintln!("\n합산:");
    eprintln!("  raw paragraph heights 합: {:.1} px", sum_raw_heights);
    eprintln!(
        "  paragraph 간 gap 합 (vpos diff): {:.1} px",
        sum_vpos_diffs
    );
    eprintln!(
        "  total (raw + gap): {:.1} px",
        sum_raw_heights + sum_vpos_diffs
    );
    eprintln!("  dump-pages 의 used: 969.5 px");
}
