//! 긴 실문서 후반부 본문 편집의 페이지네이션 비용 계측.

use std::fs;
use std::path::Path;
use std::time::Instant;

use rhwp::wasm_api::HwpDocument;

#[test]
#[ignore = "local long-document performance diagnostic; run explicitly"]
fn long_document_late_section_text_edit_perf() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples/2025 행정업무운영 편람(최종).hwpx");
    let bytes = fs::read(&path).expect("read 390-page long-document fixture");
    let repeats = std::env::var("RHWP_LONG_EDIT_REPEATS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(5)
        .clamp(1, 20);
    let mut elapsed = Vec::with_capacity(repeats);

    for _ in 0..repeats {
        let mut document = HwpDocument::from_bytes(&bytes).expect("load long-document fixture");
        assert_eq!(document.get_section_count(), 14);
        assert_eq!(document.page_count(), 390);

        let started = Instant::now();
        document
            .insert_text_native(12, 42, 0, "X")
            .expect("edit late body paragraph");
        elapsed.push(started.elapsed());
        assert!(document.page_count() >= 390);
    }

    elapsed.sort_unstable();
    let median = elapsed[elapsed.len() / 2];
    eprintln!(
        "RHWP_LONG_EDIT_PROFILE repeats={} section=12 paragraph=42 median_ms={:.3} min_ms={:.3} max_ms={:.3}",
        elapsed.len(),
        median.as_secs_f64() * 1000.0,
        elapsed[0].as_secs_f64() * 1000.0,
        elapsed[elapsed.len() - 1].as_secs_f64() * 1000.0,
    );
}
