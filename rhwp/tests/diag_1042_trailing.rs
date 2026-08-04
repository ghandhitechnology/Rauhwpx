//! trailing line_segs 진단

#[test]
fn diag_trailing_line_segs() {
    let bytes = std::fs::read("samples/hwp3-sample16-hwp5-2022.hwp").expect("read 2022");
    let doc = rhwp::parser::parse_hwp(&bytes).expect("parse");
    let section = &doc.sections[0];
    let para = &section.paragraphs[83];

    let chars_count = para.text.chars().count() as u32;
    let utf16_count = para.text.encode_utf16().count() as u32;
    eprintln!("p83:");
    eprintln!("  text='{}'", para.text);
    eprintln!("  chars_count={}, utf16_count={}", chars_count, utf16_count);
    eprintln!("  char_count field: {}", para.char_count);
    eprintln!("  line_segs.len={}", para.line_segs.len());
    for (i, ls) in para.line_segs.iter().enumerate() {
        eprintln!(
            "    ls[{}]: text_start={}, vpos={}, lh={}",
            i, ls.text_start, ls.vertical_pos, ls.line_height
        );
    }
}
