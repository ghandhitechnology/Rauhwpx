//! Generate editable HWPX cases and live/reopened renders for Mac Hancom comparison.
//! Run from rhwp: cargo run --example editing_parity_fixtures -- <new-output-directory>
//! These are diagnostic outputs, not official Hancom reference artifacts.

use std::{fs, io::Cursor, path::Path};

use rhwp::document_core::DocumentCore;
use rhwp::model::provenance::FontMetricsPolicy;
use serde_json::{json, Value};

#[derive(Debug)]
struct FixtureError(String);

impl std::fmt::Display for FixtureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

macro_rules! fixture_errors {
    ($($error:ty),*) => { $(impl From<$error> for FixtureError {
        fn from(error: $error) -> Self { Self(error.to_string()) }
    })* };
}
fixture_errors!(
    rhwp::error::HwpError,
    std::io::Error,
    serde_json::Error,
    image::ImageError,
    &str
);
type Result<T> = std::result::Result<T, FixtureError>;

fn capture(core: &DocumentCore, directory: &Path, label: &str) -> Result<Value> {
    let mut pages = Vec::new();
    for page in 0..core.page_count() {
        fs::write(
            directory.join(format!("{label}-page-{}.svg", page + 1)),
            core.render_page_svg_native(page)?,
        )?;
        let mut layout: Value = serde_json::from_str(&core.get_page_control_layout_native(page)?)?;
        layout["textLayout"] = serde_json::from_str(&core.get_page_text_layout_native(page)?)?;
        pages.push(layout);
    }
    Ok(json!({"pageCount": core.page_count(), "pages": pages}))
}

fn image_bytes() -> Result<Vec<u8>> {
    let image = image::RgbImage::from_fn(240, 120, |x, y| {
        if x % 40 < 2 || y % 40 < 2 {
            image::Rgb([20, 40, 60])
        } else {
            image::Rgb([70, 160, 210])
        }
    });
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png)?;
    Ok(bytes.into_inner())
}

/// Render the exact captured inputs without reproducing the editing recipe.
/// This separates opening existing files from newly generated line-break data.
fn render_reference_inputs(
    output: &Path,
    reference: &Path,
    policy: FontMetricsPolicy,
) -> Result<()> {
    let record: Value = serde_json::from_slice(&fs::read(reference.join("capture.json"))?)?;
    let mut cases = Vec::new();
    let mut unstable = Vec::new();
    for recorded in record["cases"].as_array().ok_or("Missing captured cases")? {
        let id = recorded["id"].as_str().ok_or("Missing captured case ID")?;
        if id.contains(['/', '\\']) || id == "." || id == ".." {
            return Err("Invalid captured case ID".into());
        }
        let directory = output.join(id);
        fs::create_dir(&directory)?;
        let edited = fs::read(reference.join(id).join("edited.hwpx"))?;
        fs::write(directory.join("edited.hwpx"), &edited)?;
        let mut core = DocumentCore::from_bytes_with_font_metrics(&edited, policy)?;
        let live = capture(&core, &directory, "edited-live")?;
        let mut reopened = Vec::new();
        for cycle in 1..=3 {
            let bytes = core.export_hwpx_native()?;
            fs::write(directory.join(format!("saved-{cycle}.hwpx")), &bytes)?;
            core = DocumentCore::from_bytes_with_font_metrics(&bytes, policy)?;
            reopened.push(capture(&core, &directory, &format!("reopened-{cycle}"))?);
        }
        let stable = reopened.iter().all(|layout| layout == &live);
        if !stable {
            unstable.push(id.to_string());
        }
        cases.push(
            json!({"id": id, "editedLiveLayout": live, "reopenedLayouts": reopened,
            "localRoundtrip": {"cycles": 3, "exactLayoutMatch": stable}}),
        );
    }
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 2, "provenance": "rau-render-of-captured-input", "layoutDpi": 96,
            "fontMetricsPolicy": policy, "cases": cases,
            "acceptance": {"positionTolerancePt": 0.5, "samePageCount": true, "sameLineBreaks": true},
        }))?,
    )?;
    if !unstable.is_empty() {
        return Err(FixtureError(format!(
            "Captured inputs changed layout after reopening: {unstable:?}"
        )));
    }
    println!("Rendered captured inputs in {}", output.display());
    Ok(())
}

fn main() -> Result<()> {
    let font_policy = if std::env::args().any(|arg| arg == "--hcr-declared") {
        FontMetricsPolicy::HcrDeclared
    } else {
        FontMetricsPolicy::HancomWindows
    };
    let output = std::env::args()
        .nth(1)
        .ok_or("Supply a new output directory")?;
    let output = Path::new(&output);
    // Reference artifacts must never be silently replaced by a later run.
    if output.exists() {
        return Err("Output directory already exists; choose a new directory".into());
    }
    fs::create_dir_all(output)?;
    if let Some(reference) =
        std::env::args().find_map(|arg| arg.strip_prefix("--reference-inputs=").map(str::to_owned))
    {
        return render_reference_inputs(output, Path::new(&reference), font_policy);
    }
    let image = image_bytes()?;
    fs::write(output.join("grid.png"), &image)?;
    let mut cases = Vec::new();
    let mut unstable_cases = Vec::new();
    for id in [
        "body-mixed-text",
        "body-paragraph-spacing",
        "cell-mixed-text",
        "cell-empty",
        "cell-fit-width",
        "cell-paragraph-spacing",
    ] {
        let directory = output.join(id);
        fs::create_dir(&directory)?;
        let mut blank = DocumentCore::new_empty();
        blank.create_blank_document_native()?;
        // Match Studio's new-document path: open the converted blank as HWPX
        // before editing. The template's HWP5 lineage marker remains intact.
        let mut core =
            DocumentCore::from_bytes_with_font_metrics(&blank.export_hwpx_native()?, font_policy)?;
        let in_cell = id.starts_with("cell-");
        let mut parent = 0usize;
        let mut path = Vec::new();
        let text = "그림 앞의 글입니다. Picture and text share this paragraph. 그림 뒤에도 글이 이어집니다.";
        if in_cell {
            let table: Value = serde_json::from_str(&core.create_table_native(0, 0, 0, 2, 2)?)?;
            parent = table["paraIdx"].as_u64().ok_or("Missing table paragraph")? as usize;
            let control = table["controlIdx"]
                .as_u64()
                .ok_or("Missing table control")? as usize;
            path.push((control, 0, 0));
            if id != "cell-empty" {
                core.insert_text_in_cell_by_path(0, parent, &path, 0, text)?;
            }
        } else if id == "body-mixed-text" {
            core.insert_text_native(0, 0, 0, text)?;
        } else {
            core.insert_text_native(0, 0, 0, "그림 위 문단입니다.")?;
            core.insert_paragraph_native(0, 1)?;
            core.insert_paragraph_native(0, 2)?;
            core.insert_text_native(0, 2, 0, "그림 아래 문단입니다.")?;
            parent = 1;
        }
        fs::write(directory.join("source.hwpx"), core.export_hwpx_native()?)?;
        let source = capture(&core, &directory, "source")?;
        let offset = if id.ends_with("mixed-text") { 10 } else { 0 };
        let width = if id == "cell-fit-width" { 60000 } else { 18000 };
        core.insert_picture_with_placement_native(
            0,
            parent,
            offset,
            &path,
            &image,
            width,
            width / 2,
            240,
            120,
            "png",
            "Editing parity grid",
            None,
            None,
            true,
        )?;
        let spacing = json!({"spacingBefore": 1200, "spacingAfter": 600, "lineSpacing": 160});
        if id.ends_with("paragraph-spacing") {
            if in_cell {
                core.apply_para_format_in_cell_by_path(0, parent, &path, &spacing.to_string())?;
            } else {
                core.apply_para_format_native(0, parent, &spacing.to_string())?;
            }
        }
        let live = capture(&core, &directory, "edited-live")?;
        let edited_bytes = core.export_hwpx_native()?;
        fs::write(directory.join("edited.hwpx"), &edited_bytes)?;
        let mut cycles = Vec::new();
        let mut bytes = edited_bytes;
        for cycle in 1..=3 {
            core = DocumentCore::from_bytes_with_font_metrics(&bytes, font_policy)?;
            cycles.push(capture(&core, &directory, &format!("reopened-{cycle}"))?);
            bytes = core.export_hwpx_native()?;
            fs::write(directory.join(format!("saved-{cycle}.hwpx")), &bytes)?;
        }
        let stable = cycles.iter().all(|reopened| reopened == &live);
        if !stable {
            unstable_cases.push(id);
        }
        cases.push(json!({
            "id": id, "source": format!("{id}/source.hwpx"),
            "edited": format!("{id}/edited.hwpx"),
            "recipe": {
                "target": if in_cell { "first cell, first paragraph" } else if parent == 1 { "second body paragraph" } else { "first body paragraph" },
                "logicalOffset": offset, "image": "grid.png", "placement": "inline",
                "requestedWidthHu": width, "requestedHeightHu": width / 2,
                "fitCellContentWidth": in_cell,
                "paragraphFormatHu": if id.ends_with("paragraph-spacing") { spacing } else { Value::Null },
            },
            "officialReference": {"status": "pending", "application": "Mac Hancom", "version": "12.30.0", "build": "6446"},
            "sourceLayout": source, "editedLiveLayout": live, "reopenedLayouts": cycles,
            "localRoundtrip": {"cycles": 3, "exactLayoutMatch": stable},
        }));
    }
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 2, "provenance": "rau-diagnostic", "layoutDpi": 96, "cases": cases,
            "fontMetricsPolicy": font_policy,
            "acceptance": {"positionTolerancePt": 0.5, "samePageCount": true, "sameLineBreaks": true},
        }))?,
    )?;
    if !unstable_cases.is_empty() {
        return Err(FixtureError(format!(
            "Local layout changed after reopening: {}. See manifest.json for evidence.",
            unstable_cases.join(", ")
        )));
    }
    println!(
        "Generated six diagnostic cases in {}. Official Hancom verification is pending.",
        output.display()
    );
    Ok(())
}
