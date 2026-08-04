//! Stage 4 v3: k-water-rfp 의 표 row height 측정 over-estimate 정량 진단
//!
//! 가설: cell_units 의 `include_trailing_ls = !is_cell_last_line || para_count > 1`
//! 규칙에서 다중 문단 셀의 마지막 paragraph 마지막 line ls 가 포함되어
//! row height over-estimate. 한컴 viewer 는 paragraph 간 break 에서 ls 제외 가능성.
//!
//! 진단 절차:
//!   1. pi=52 (4x4 표) 의 row 3 의 cell 별 raw paragraph height 측정 3 방식 비교
//!      - 방식 A (rhwp 현재): all line 에 ls 포함 (단일 문단 단일 줄 마지막 line 만 제외)
//!      - 방식 B: 각 paragraph 마지막 line ls 제외
//!      - 방식 C: cell 마지막 line ls 만 제외 (모든 paragraph 의 last line 까지 포함)
//!   2. cell_height (raw HWP cell.h) vs 3 방식 측정값 비교
//!   3. row 3 의 max(cell content height) vs cell_h vs 한컴 정답 (PDF p6 fit)

#[test]
fn diag_kwater_pi52_row3_cell_height() {
    let bytes = std::fs::read("samples/k-water-rfp-2024.hwp").expect("read");
    let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
    let section = &doc.sections[1];
    let para = &section.paragraphs[52];

    // controls 에서 table 추출
    use rhwp::model::control::Control;
    let table = para
        .controls
        .iter()
        .find_map(|c| {
            if let Control::Table(t) = c {
                Some(t)
            } else {
                None
            }
        })
        .expect("table at pi=52");

    let dpi = 96.0;
    let to_px = |hu: i32| hu as f64 * dpi / 7200.0;

    eprintln!("\n=== pi=52 표 (4행×4열) row 3 cell 별 height 진단 ===");
    eprintln!(
        "표 size: {}×{} HU = {:.1}×{:.1} px",
        44496,
        55880,
        to_px(44496),
        to_px(55880)
    );

    // row 3 의 cell (row_span==1)
    let row3_cells: Vec<&rhwp::model::table::Cell> = table
        .cells
        .iter()
        .filter(|c| c.row as usize == 3 && c.row_span == 1)
        .collect();

    let mut total_a = 0.0_f64;
    let mut total_b = 0.0_f64;
    let mut total_c = 0.0_f64;
    let mut max_cell_h_raw = 0.0_f64;

    for cell in &row3_cells {
        let cell_h_px = if cell.height < 0x8000_0000 {
            to_px(cell.height as i32)
        } else {
            0.0
        };
        let paras_count = cell.paragraphs.len();

        // 3 방식 측정
        let mut a = 0.0; // rhwp 현재
        let mut b = 0.0; // 각 paragraph 마지막 line ls 제외
        let mut c = 0.0; // cell 마지막 line ls 만 제외

        let para_count = cell.paragraphs.len();
        for (pi, p) in cell.paragraphs.iter().enumerate() {
            let is_last_para = pi + 1 == para_count;
            let lcount = p.line_segs.len();
            for (li, ls) in p.line_segs.iter().enumerate() {
                let h = to_px(ls.line_height);
                let lsp = to_px(ls.line_spacing);
                let is_para_last = li + 1 == lcount;
                let is_cell_last = is_last_para && is_para_last;

                // 방식 A (rhwp 현재): single-para single-line cell 의 last line 만 ls 제외
                let a_include = !(is_cell_last && para_count == 1 && lcount == 1);
                a += h + if a_include { lsp } else { 0.0 };

                // 방식 B: paragraph 마지막 line ls 제외
                b += h + if is_para_last { 0.0 } else { lsp };

                // 방식 C: cell 마지막 line ls 만 제외 (paragraph 간은 포함)
                c += h + if is_cell_last { 0.0 } else { lsp };
            }
        }

        eprintln!(
            "  cell[r=3,c={}] paras={} cell_h={:.1}px A={:.1}px B={:.1}px C={:.1}px",
            cell.col, paras_count, cell_h_px, a, b, c
        );

        total_a = total_a.max(a);
        total_b = total_b.max(b);
        total_c = total_c.max(c);
        max_cell_h_raw = max_cell_h_raw.max(cell_h_px);
    }

    eprintln!("\nrow 3 max:");
    eprintln!("  raw cell.height max: {:.1}px", max_cell_h_raw);
    eprintln!("  방식 A (현재): {:.1}px", total_a);
    eprintln!(
        "  방식 B (para last ls 제외): {:.1}px (diff vs A: {:+.1})",
        total_b,
        total_b - total_a
    );
    eprintln!(
        "  방식 C (cell last ls 제외): {:.1}px (diff vs A: {:+.1})",
        total_c,
        total_c - total_a
    );

    // p6 의 hwp_used=479.1, used=920.6 — diff=441.6
    // row 3 측정값이 어느 방식에서 정답 가까운지 확인
}

#[test]
fn diag_kwater_pi180_row_summary() {
    // pi=180 (32x4 표, p15→p17 split) 동일 진단
    let bytes = std::fs::read("samples/k-water-rfp-2024.hwp").expect("read");
    let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
    let section = &doc.sections[1];
    let para = &section.paragraphs[180];

    use rhwp::model::control::Control;
    let table = para
        .controls
        .iter()
        .find_map(|c| {
            if let Control::Table(t) = c {
                Some(t)
            } else {
                None
            }
        })
        .expect("table at pi=180");

    let dpi = 96.0;
    let to_px = |hu: i32| hu as f64 * dpi / 7200.0;

    eprintln!("\n=== pi=180 표 (32행×4열) 전체 row 별 max content height ===");
    eprintln!(
        "{:>4} | {:>5} | {:>8} | {:>8} | {:>8} | {:>8}",
        "row", "paras", "cell_h", "A_max", "B_max", "C_max"
    );

    let mut grand_a = 0.0_f64;
    let mut grand_b = 0.0_f64;
    let mut grand_c = 0.0_f64;
    let mut grand_raw = 0.0_f64;

    for r in 0..32 {
        let row_cells: Vec<&rhwp::model::table::Cell> = table
            .cells
            .iter()
            .filter(|c| c.row as usize == r && c.row_span == 1)
            .collect();
        if row_cells.is_empty() {
            continue;
        }

        let mut max_cell_h = 0.0_f64;
        let mut max_a = 0.0_f64;
        let mut max_b = 0.0_f64;
        let mut max_c = 0.0_f64;
        let mut total_paras = 0;

        for cell in &row_cells {
            let cell_h_px = if cell.height < 0x8000_0000 {
                to_px(cell.height as i32)
            } else {
                0.0
            };
            let para_count = cell.paragraphs.len();
            total_paras += para_count;

            let mut a = 0.0;
            let mut b = 0.0;
            let mut c = 0.0;
            for (pi, p) in cell.paragraphs.iter().enumerate() {
                let is_last_para = pi + 1 == para_count;
                let lcount = p.line_segs.len();
                for (li, ls) in p.line_segs.iter().enumerate() {
                    let h = to_px(ls.line_height);
                    let lsp = to_px(ls.line_spacing);
                    let is_para_last = li + 1 == lcount;
                    let is_cell_last = is_last_para && is_para_last;
                    let a_include = !(is_cell_last && para_count == 1 && lcount == 1);
                    a += h + if a_include { lsp } else { 0.0 };
                    b += h + if is_para_last { 0.0 } else { lsp };
                    c += h + if is_cell_last { 0.0 } else { lsp };
                }
            }
            max_cell_h = max_cell_h.max(cell_h_px);
            max_a = max_a.max(a);
            max_b = max_b.max(b);
            max_c = max_c.max(c);
        }

        let used_a = max_a.max(max_cell_h);
        let used_b = max_b.max(max_cell_h);
        let used_c = max_c.max(max_cell_h);

        eprintln!(
            "{:>4} | {:>5} | {:>8.1} | {:>8.1} | {:>8.1} | {:>8.1}",
            r, total_paras, max_cell_h, used_a, used_b, used_c
        );

        grand_raw += max_cell_h;
        grand_a += used_a;
        grand_b += used_b;
        grand_c += used_c;
    }

    eprintln!("\n전체 row 합 (max(cell_h, content)):");
    eprintln!("  raw cell.h sum: {:.1}px", grand_raw);
    eprintln!(
        "  A (현재) sum: {:.1}px (vs raw: {:+.1})",
        grand_a,
        grand_a - grand_raw
    );
    eprintln!(
        "  B (para last ls 제외) sum: {:.1}px (vs A: {:+.1})",
        grand_b,
        grand_b - grand_a
    );
    eprintln!(
        "  C (cell last ls 제외) sum: {:.1}px (vs A: {:+.1})",
        grand_c,
        grand_c - grand_a
    );
}
