//! pi=162 의 ParaShape attr1 비트 검사 — keep_with_next / widow_orphan 등.

#[test]
fn diag_pi162_attr1() {
    let bytes = std::fs::read("samples/hwp3-sample16-hwp5-2024.hwp").expect("read");
    let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
    let para = &doc.sections[0].paragraphs[162];
    let ps_id = para.para_shape_id;
    let ps = &doc.doc_info.para_shapes[ps_id as usize];

    eprintln!("\n=== pi=162 ParaShape (id={}) attr1 비트 ===", ps_id);
    eprintln!("attr1 = 0x{:08X}", ps.attr1);
    eprintln!("  bit 16 widow_orphan      = {}", (ps.attr1 >> 16) & 1);
    eprintln!("  bit 17 keep_with_next    = {}", (ps.attr1 >> 17) & 1);
    eprintln!("  bit 18 keep_lines        = {}", (ps.attr1 >> 18) & 1);
    eprintln!("  bit 19 page_break_before = {}", (ps.attr1 >> 19) & 1);
    eprintln!("  bit 22 font_line_height  = {}", (ps.attr1 >> 22) & 1);
    eprintln!("spacing_before = {}", ps.spacing_before);
    eprintln!("spacing_after = {}", ps.spacing_after);

    // 비교: pi=124 (1. 일반사항 — 다른 heading)
    let para_124 = &doc.sections[0].paragraphs[124];
    let ps_124 = &doc.doc_info.para_shapes[para_124.para_shape_id as usize];
    eprintln!(
        "\n=== pi=124 ParaShape (id={}) — 다른 heading 비교 ===",
        para_124.para_shape_id
    );
    eprintln!("attr1 = 0x{:08X}", ps_124.attr1);
    eprintln!("  bit 17 keep_with_next    = {}", (ps_124.attr1 >> 17) & 1);
    eprintln!("  bit 19 page_break_before = {}", (ps_124.attr1 >> 19) & 1);

    // pi=192 "3. 제안서 작성기준" — 다른 heading
    let para_192 = &doc.sections[0].paragraphs[192];
    let ps_192 = &doc.doc_info.para_shapes[para_192.para_shape_id as usize];
    eprintln!(
        "\n=== pi=192 ParaShape (id={}) — 3. 제안서 작성기준 ===",
        para_192.para_shape_id
    );
    eprintln!("attr1 = 0x{:08X}", ps_192.attr1);
    eprintln!("  bit 17 keep_with_next    = {}", (ps_192.attr1 >> 17) & 1);
    eprintln!("  bit 19 page_break_before = {}", (ps_192.attr1 >> 19) & 1);
}
