//! 한컴오피스 2024 저장 파일 vs 한컴 변환기 직출력 비교 → line_segs 합성 공식 reverse engineering

#[test]
fn diag_2024_vs_variant_line_segs() {
    let bytes_v = std::fs::read("samples/hwp3-sample16-hwp5.hwp").expect("read variant");
    let doc_v = rhwp::parser::parse_hwp(&bytes_v).expect("parse variant");

    let bytes_24 = std::fs::read("samples/hwp3-sample16-hwp5-2024.hwp").expect("read 2024");
    let doc_24 = rhwp::parser::parse_hwp(&bytes_24).expect("parse 2024");

    eprintln!(
        "variant total paragraphs: {}",
        doc_v.sections[0].paragraphs.len()
    );
    eprintln!(
        "2024    total paragraphs: {}",
        doc_24.sections[0].paragraphs.len()
    );

    // 같은 paragraph index 비교
    let mut variant_empty = 0;
    let mut v2024_filled = 0;
    let mut both_filled_match = 0;
    let mut both_filled_diff = 0;

    for i in 0..doc_v.sections[0]
        .paragraphs
        .len()
        .min(doc_24.sections[0].paragraphs.len())
    {
        let p_v = &doc_v.sections[0].paragraphs[i];
        let p_24 = &doc_24.sections[0].paragraphs[i];
        let v_empty = p_v.line_segs.is_empty();
        let v24_empty = p_24.line_segs.is_empty();

        if v_empty {
            variant_empty += 1;
        }
        if !v24_empty {
            v2024_filled += 1;
        }

        if !v_empty && !v24_empty {
            let v_first = &p_v.line_segs[0];
            let v24_first = &p_24.line_segs[0];
            if v_first.line_height == v24_first.line_height
                && v_first.line_spacing == v24_first.line_spacing
            {
                both_filled_match += 1;
            } else {
                both_filled_diff += 1;
            }
        }
    }
    eprintln!("variant line_segs empty: {}", variant_empty);
    eprintln!("2024    line_segs filled: {}", v2024_filled);
    eprintln!("both filled, lh+ls match: {}", both_filled_match);
    eprintln!("both filled, lh+ls diff: {}", both_filled_diff);

    // 샘플 3 paragraph 의 base_size + line_segs metrics 매칭
    eprintln!("\n=== p460 비교 ===");
    let p_v = &doc_v.sections[0].paragraphs[460];
    let p_24 = &doc_24.sections[0].paragraphs[460];
    eprintln!(
        "variant: line_segs={}, char_shapes={}",
        p_v.line_segs.len(),
        p_v.char_shapes.len()
    );
    eprintln!(
        "2024:    line_segs={}, char_shapes={}",
        p_24.line_segs.len(),
        p_24.char_shapes.len()
    );
    if let Some(ls) = p_v.line_segs.first() {
        eprintln!(
            "variant ls[0]: lh={} th={} bl={} ls={} cs={} sw={}",
            ls.line_height,
            ls.text_height,
            ls.baseline_distance,
            ls.line_spacing,
            ls.column_start,
            ls.segment_width
        );
    }
    for (i, ls) in p_24.line_segs.iter().enumerate() {
        eprintln!(
            "2024    ls[{}]: vpos={} lh={} th={} bl={} ls={} cs={} sw={} tag=0x{:08X}",
            i,
            ls.vertical_pos,
            ls.line_height,
            ls.text_height,
            ls.baseline_distance,
            ls.line_spacing,
            ls.column_start,
            ls.segment_width,
            ls.tag
        );
    }
    // base_size 매칭
    let cs_2024_id = p_24
        .char_shapes
        .first()
        .map(|cs| cs.char_shape_id)
        .unwrap_or(0);
    let cs_v_id = p_v
        .char_shapes
        .first()
        .map(|cs| cs.char_shape_id)
        .unwrap_or(0);
    let base_2024 = doc_24
        .doc_info
        .char_shapes
        .get(cs_2024_id as usize)
        .map(|cs| cs.base_size)
        .unwrap_or(0);
    let base_v = doc_v
        .doc_info
        .char_shapes
        .get(cs_v_id as usize)
        .map(|cs| cs.base_size)
        .unwrap_or(0);
    eprintln!("variant base_size (cs_id={}): {}", cs_v_id, base_v);
    eprintln!("2024    base_size (cs_id={}): {}", cs_2024_id, base_2024);

    // ParaShape 비교
    let ps_v = doc_v.doc_info.para_shapes.get(p_v.para_shape_id as usize);
    let ps_24 = doc_24.doc_info.para_shapes.get(p_24.para_shape_id as usize);
    if let (Some(v), Some(t)) = (ps_v, ps_24) {
        eprintln!(
            "variant ParaShape: line_spacing={}, type={:?}, sp_before={}, ml={}, mr={}, indent={}",
            v.line_spacing,
            v.line_spacing_type,
            v.spacing_before,
            v.margin_left,
            v.margin_right,
            v.indent
        );
        eprintln!(
            "2024    ParaShape: line_spacing={}, type={:?}, sp_before={}, ml={}, mr={}, indent={}",
            t.line_spacing,
            t.line_spacing_type,
            t.spacing_before,
            t.margin_left,
            t.margin_right,
            t.indent
        );
    }

    // 핵심: variant 의 line_segs empty paragraph 중 합성한 line count 와 2024 의 actual line count 비교
    eprintln!("\n=== empty paragraph 의 line count diff (합성 45 chars/line vs 2024 actual) ===");
    let mut total_diff = 0i32;
    for i in 0..doc_v.sections[0].paragraphs.len() {
        let p_v = &doc_v.sections[0].paragraphs[i];
        if !p_v.line_segs.is_empty() {
            continue;
        }
        let p_24 = &doc_24.sections[0].paragraphs[i];
        let synth_count = p_v.text.chars().count().div_ceil(45).max(1);
        let actual_count = p_24.line_segs.len();
        let diff = actual_count as i32 - synth_count as i32;
        total_diff += diff;
        if diff != 0 && i < 700 {
            let text_pre: String = p_v.text.chars().take(40).collect();
            eprintln!(
                "p{}: chars={}, synth_lines={}, actual_lines={}, diff={:+}  {}",
                i,
                p_v.text.chars().count(),
                synth_count,
                actual_count,
                diff,
                text_pre
            );
        }
    }
    eprintln!("total line count diff: {:+}", total_diff);

    // 합성된 paragraph 와 2024 의 line metrics + line count diff 확인
    eprintln!("\n=== variant (synth) vs 2024 의 paragraph 별 lh+ls + line count diff ===");
    let mut mismatch_count = 0;
    for i in 0..doc_v.sections[0].paragraphs.len() {
        let p_v = &doc_v.sections[0].paragraphs[i];
        let p_24 = &doc_24.sections[0].paragraphs[i];
        if p_v.line_segs.is_empty() || p_24.line_segs.is_empty() {
            continue;
        }
        let v0 = &p_v.line_segs[0];
        let t0 = &p_24.line_segs[0];
        let line_count_v = p_v.line_segs.len();
        let line_count_24 = p_24.line_segs.len();
        let lh_match = v0.line_height == t0.line_height && v0.line_spacing == t0.line_spacing;
        let lc_match = line_count_v == line_count_24;
        if !lh_match || !lc_match {
            mismatch_count += 1;
            if mismatch_count <= 15 {
                let text_pre: String = p_v.text.chars().take(40).collect();
                eprintln!(
                    "p{}: variant(lh={},ls={},lc={}) vs 2024(lh={},ls={},lc={}) {}",
                    i,
                    v0.line_height,
                    v0.line_spacing,
                    line_count_v,
                    t0.line_height,
                    t0.line_spacing,
                    line_count_24,
                    text_pre
                );
            }
        }
    }
    eprintln!("total mismatch paragraph: {}", mismatch_count);
}
