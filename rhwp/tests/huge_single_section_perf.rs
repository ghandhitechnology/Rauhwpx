//! 실문서 본문을 단일 대형 구역으로 합쳐 편집·undo 비용을 계측한다.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use rhwp::wasm_api::HwpDocument;

fn resident_bytes() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let kib = line.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    Some(kib * 1024)
}

fn flatten_to_single_section(document: &mut HwpDocument) {
    let mut sections = std::mem::take(&mut document.document_mut().sections);
    let mut merged = sections.remove(0);
    for section in sections {
        merged.paragraphs.extend(section.paragraphs);
    }
    let model = document.document_mut();
    model.sections.push(merged);
    model.doc_properties.section_count = 1;
    document.refresh_layout_native();
}

#[test]
#[ignore = "local huge-section performance diagnostic; run explicitly"]
fn huge_single_section_edit_and_snapshot_perf() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/2025 행정업무운영 편람(최종).hwpx");
    let bytes = fs::read(&path).expect("read 390-page long-document fixture");
    let command_count = std::env::var("RHWP_HUGE_SECTION_COMMANDS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(6)
        .clamp(2, 20);
    let mut document = HwpDocument::from_bytes(&bytes).expect("load long-document fixture");
    flatten_to_single_section(&mut document);

    assert_eq!(document.get_section_count(), 1);
    let paragraph_count = document
        .get_paragraph_count_native(0)
        .expect("read merged paragraph count");
    let target_paragraph = paragraph_count.saturating_sub(50);
    let initial_length = document
        .get_paragraph_length_native(0, target_paragraph)
        .expect("read target paragraph length");
    let initial_pages = document.page_count();
    let baseline_rss = resident_bytes();
    let mut peak_rss = baseline_rss;
    let mut edit_elapsed = Duration::ZERO;
    let mut snapshot_elapsed = Duration::ZERO;
    let mut snapshot_ids = Vec::with_capacity(command_count);
    let mut previous_after_id = None;

    for _ in 0..command_count {
        let started = Instant::now();
        let before_id = match previous_after_id {
            Some(after_id) => document
                .share_snapshot_native(after_id)
                .expect("share unchanged prior after snapshot"),
            None => document.save_snapshot_native(),
        };
        snapshot_elapsed += started.elapsed();

        let started = Instant::now();
        document
            .insert_text_native(0, target_paragraph, 0, "X")
            .expect("edit late paragraph in huge section");
        edit_elapsed += started.elapsed();

        let started = Instant::now();
        let after_id = document.save_snapshot_native();
        snapshot_elapsed += started.elapsed();
        snapshot_ids.push((before_id, after_id));
        previous_after_id = Some(after_id);
        if let Some(rss) = resident_bytes() {
            peak_rss = Some(peak_rss.unwrap_or(rss).max(rss));
        }
    }
    let snapshot_stats = document.snapshot_storage_stats_native();

    let restore_started = Instant::now();
    document
        .restore_snapshot_native(snapshot_ids[0].0)
        .expect("restore first before snapshot");
    let mut restore_elapsed = restore_started.elapsed();
    assert_eq!(
        document
            .get_paragraph_length_native(0, target_paragraph)
            .expect("read restored before paragraph length"),
        initial_length
    );
    assert_eq!(document.page_count(), initial_pages);

    let restore_started = Instant::now();
    document
        .restore_snapshot_native(snapshot_ids[command_count - 1].1)
        .expect("restore final after snapshot");
    restore_elapsed += restore_started.elapsed();
    assert_eq!(
        document
            .get_paragraph_length_native(0, target_paragraph)
            .expect("read restored after paragraph length"),
        initial_length + command_count
    );
    assert_eq!(document.page_count(), initial_pages);

    eprintln!(
        "RHWP_HUGE_SECTION_PROFILE pages={} paragraphs={} target_para={} commands={} snapshot_ids={} edit_ms={:.3} snapshot_ms={:.3} restore_ms={:.3} baseline_rss_bytes={} peak_rss_bytes={} retained_rss_bytes={} storage={}",
        initial_pages,
        paragraph_count,
        target_paragraph,
        command_count,
        snapshot_ids.len() * 2,
        edit_elapsed.as_secs_f64() * 1000.0,
        snapshot_elapsed.as_secs_f64() * 1000.0,
        restore_elapsed.as_secs_f64() * 1000.0,
        baseline_rss.unwrap_or(0),
        peak_rss.unwrap_or(0),
        peak_rss
            .zip(baseline_rss)
            .map(|(peak, baseline)| peak.saturating_sub(baseline))
            .unwrap_or(0),
        snapshot_stats,
    );
}
