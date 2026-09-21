//! Reviewable, dependency-safe selections over the structural merge result.
//!
//! Paragraphs are the smallest independent document unit here. Changes to
//! positional resources or container structure are grouped with their users;
//! rejecting one can therefore never leave dangling resource references.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnalysis {
    analysis_version: u32,
    result: Value,
    conflicts: Vec<ReviewUnit>,
    automatic_operation_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewUnit {
    #[serde(flatten)]
    value: MergeConflict,
    automatic: bool,
    dependency_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<ReviewPosition>,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
struct ReviewPosition {
    section: usize,
    paragraph: usize,
}

enum Target {
    Document,
    Paragraph(usize, usize),
    Conflict,
}

fn paragraph_value(p: &Paragraph) -> Value {
    json!({ "text": p.text, "contentHash": dh(p).to_hex().to_string(), "controls": p.controls.len() })
}

fn paragraph_hash(p: &Paragraph) -> blake3::Hash {
    let mut value = p.clone();
    value.char_count = 0;
    value.char_offsets.clear();
    value.line_segs.clear();
    for byte in value.raw_header_extra.iter_mut().take(6) {
        *byte = 0;
    }
    dh(&value)
}

fn value_text(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) => Some(text),
        Value::Object(object) => object.get("text").and_then(Value::as_str),
        _ => None,
    }
}

fn texts_support_both(base: &Value, current: &Value, incoming: &Value) -> bool {
    match (value_text(base), value_text(current), value_text(incoming)) {
        (Some(base), Some(current), Some(incoming)) => {
            merge_text(base, current, incoming).is_some()
                || both_text(base, current, incoming, false).is_some()
        }
        _ => false,
    }
}

fn review_choice(choices: &BTreeMap<String, MergeResolution>, id: &str) -> MergeResolution {
    choices.get(id).cloned().unwrap_or(MergeResolution::Current)
}

fn unit(
    path: Vec<String>,
    b: Value,
    c: Value,
    i: Value,
    dependencies: Vec<String>,
    manual: bool,
) -> ReviewUnit {
    let both = texts_support_both(&b, &c, &i);
    let mut value = conflict(
        &path,
        MergeConflictReason::SameFieldChanged,
        &b,
        &c,
        &i,
        both,
    );
    value.id = format!("review:{}", value.fingerprint);
    value.supports_manual = manual;
    value.kind = if manual {
        "rich-text"
    } else {
        "document-change"
    }
    .into();
    ReviewUnit {
        value,
        automatic: dependencies.is_empty(),
        dependency_ids: dependencies,
        position: None,
    }
}

fn plain_text(p: &Paragraph) -> bool {
    p.controls.is_empty()
        && p.field_ranges.is_empty()
        && p.range_tags.is_empty()
        && p.tab_extended.is_empty()
        && p.char_shapes.len() <= 1
        && p.orphan_field_ends.is_empty()
}

fn review_documents(
    b: &Document,
    c: &Document,
    i: &Document,
) -> Result<(Document, ReviewAnalysis, Vec<Target>), String> {
    let (automatic_candidate, mut initial) = merge_doc(b, c, i, None)?;
    // Cached thumbnails/text are regenerated from the chosen document; they
    // must not turn independent content edits into a document-wide conflict.
    initial
        .conflicts
        .retain(|item| item.path.first().map(String::as_str) != Some("preview"));
    let incoming_choices = initial
        .conflicts
        .iter()
        .map(|item| (item.id.clone(), MergeResolution::Incoming))
        .collect();
    let candidate = if initial.conflicts.is_empty() {
        automatic_candidate.clone()
    } else {
        merge_doc(b, c, i, Some(&incoming_choices))?.0
    };
    let mut units = vec![];
    let mut targets = vec![];
    // Any non-paragraph dependency makes this a single coherent choice. This
    // includes inserted images and their declarations, positional style IDs,
    // section moves, and table/paragraph insertion sequences.
    let global_changed = dh(&b.header) != dh(&i.header)
        || dh(&b.doc_info) != dh(&i.doc_info)
        || dh(&b.bin_data_content) != dh(&i.bin_data_content)
        || dh(&b.extra_streams) != dh(&i.extra_streams)
        || dh(&b.hwpx_aux_entries) != dh(&i.hwpx_aux_entries)
        || [
            b.doc_properties.page_start_num,
            b.doc_properties.footnote_start_num,
            b.doc_properties.endnote_start_num,
            b.doc_properties.picture_start_num,
            b.doc_properties.table_start_num,
            b.doc_properties.equation_start_num,
        ] != [
            i.doc_properties.page_start_num,
            i.doc_properties.footnote_start_num,
            i.doc_properties.endnote_start_num,
            i.doc_properties.picture_start_num,
            i.doc_properties.table_start_num,
            i.doc_properties.equation_start_num,
        ];
    let same_layout = c.sections.len() == candidate.sections.len()
        && c.sections.len() == b.sections.len()
        && c.sections
            .iter()
            .zip(&candidate.sections)
            .zip(&b.sections)
            .all(|((c, n), b)| {
                c.paragraphs.len() == n.paragraphs.len()
                    && c.paragraphs.len() == b.paragraphs.len()
                    && dh(&c.section_def) == dh(&n.section_def)
                    && c.paragraphs
                        .iter()
                        .zip(&n.paragraphs)
                        .all(|(c, n)| c.raw_header_extra.get(6..) == n.raw_header_extra.get(6..))
            });
    if !same_layout || global_changed {
        if dh(&candidate) != dh(c) || !initial.conflicts.is_empty() {
            units.push(unit(
                vec![],
                dv("document", b),
                dv("document", c),
                dv("document", &candidate),
                initial.conflicts.iter().map(|v| v.id.clone()).collect(),
                false,
            ));
            targets.push(Target::Document);
        }
    } else {
        for (s, section) in candidate.sections.iter().enumerate() {
            for (p, proposed) in section.paragraphs.iter().enumerate() {
                let current = &c.sections[s].paragraphs[p];
                if paragraph_hash(current) == paragraph_hash(proposed) {
                    continue;
                }
                let base = &b.sections[s].paragraphs[p];
                let paragraph_id = current
                    .raw_header_extra
                    .get(6..10)
                    .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                    .filter(|id| *id != 0);
                let path = vec![
                    "sections".into(),
                    s.to_string(),
                    "paragraphs".into(),
                    paragraph_id
                        .map(|id| format!("@{id}"))
                        .unwrap_or_else(|| p.to_string()),
                ];
                let dependencies: Vec<String> = initial
                    .conflicts
                    .iter()
                    .filter(|item| item.path.starts_with(&path))
                    .map(|item| item.id.clone())
                    .collect();
                if !dependencies.is_empty()
                    && paragraph_hash(&automatic_candidate.sections[s].paragraphs[p])
                        == paragraph_hash(current)
                {
                    for original in initial
                        .conflicts
                        .iter()
                        .filter(|item| dependencies.contains(&item.id))
                    {
                        units.push(ReviewUnit {
                            value: original.clone(),
                            automatic: false,
                            dependency_ids: vec![original.id.clone()],
                            position: Some(ReviewPosition {
                                section: s,
                                paragraph: p,
                            }),
                        });
                        targets.push(Target::Conflict);
                    }
                    continue;
                }
                units.push(unit(
                    path,
                    paragraph_value(base),
                    paragraph_value(current),
                    paragraph_value(proposed),
                    dependencies,
                    plain_text(current) && plain_text(proposed),
                ));
                units.last_mut().unwrap().position = Some(ReviewPosition {
                    section: s,
                    paragraph: p,
                });
                targets.push(Target::Paragraph(s, p));
            }
        }
        // A conflict path that cannot be attributed confidently must never be
        // advertised as an automatic change.
        if initial
            .conflicts
            .iter()
            .any(|item| !units.iter().any(|u| u.dependency_ids.contains(&item.id)))
        {
            units = vec![unit(
                vec![],
                dv("document", b),
                dv("document", c),
                dv("document", &candidate),
                initial.conflicts.iter().map(|v| v.id.clone()).collect(),
                false,
            )];
            targets = vec![Target::Document];
        }
    }
    let automatic_operation_count = units.iter().filter(|v| v.automatic).count();
    let result = summary(&candidate);
    Ok((
        candidate,
        ReviewAnalysis {
            analysis_version: 2,
            result,
            conflicts: units,
            automatic_operation_count,
        },
        targets,
    ))
}

fn apply_review(
    b: &Document,
    c: &Document,
    i: &Document,
    choices: &BTreeMap<String, MergeResolution>,
) -> Result<Document, String> {
    let (mut output, analysis, targets) = review_documents(b, c, i)?;
    if analysis.conflicts.iter().all(|unit| {
        matches!(
            review_choice(choices, &unit.value.id),
            MergeResolution::Current
        )
    }) {
        validate_resource_dependencies(c)?;
        return Ok(c.clone());
    }
    if targets
        .iter()
        .any(|target| matches!(target, Target::Conflict))
    {
        let mut structural_choices = analysis
            .conflicts
            .iter()
            .flat_map(|unit| {
                unit.dependency_ids
                    .iter()
                    .map(|id| (id.clone(), MergeResolution::Incoming))
            })
            .collect::<BTreeMap<_, _>>();
        for (unit, target) in analysis.conflicts.iter().zip(&targets) {
            if matches!(target, Target::Conflict) {
                structural_choices.insert(
                    unit.value.id.clone(),
                    review_choice(choices, &unit.value.id),
                );
            }
        }
        output = merge_doc(b, c, i, Some(&structural_choices))?.0;
    }
    for (unit, target) in analysis.conflicts.iter().zip(targets) {
        if matches!(target, Target::Conflict) {
            continue;
        }
        match review_choice(choices, &unit.value.id) {
            MergeResolution::Incoming => {}
            MergeResolution::Current => match target {
                Target::Document => output = c.clone(),
                Target::Paragraph(s, p) => {
                    output.sections[s].paragraphs[p] = c.sections[s].paragraphs[p].clone()
                }
                Target::Conflict => unreachable!(),
            },
            MergeResolution::Both { order } => {
                let Target::Paragraph(s, p) = target else {
                    return Err(format!("{} does not support this selection", unit.value.id));
                };
                let inc_first = match order.as_str() {
                    "incoming-first" => true,
                    "current-first" => false,
                    _ => return Err("invalid both order".into()),
                };
                let combined = merge_text(
                    &b.sections[s].paragraphs[p].text,
                    &c.sections[s].paragraphs[p].text,
                    &i.sections[s].paragraphs[p].text,
                )
                .or_else(|| {
                    both_text(
                        &b.sections[s].paragraphs[p].text,
                        &c.sections[s].paragraphs[p].text,
                        &i.sections[s].paragraphs[p].text,
                        inc_first,
                    )
                })
                .ok_or("unsafe both text")?;
                output.sections[s].paragraphs[p] = c.sections[s].paragraphs[p].clone();
                let para = &mut output.sections[s].paragraphs[p];
                para.text = combined;
                para.line_segs.clear();
                crate::document_core::queries::field_query::rebuild_char_offsets(para);
            }
            MergeResolution::Manual { payload } if unit.value.supports_manual => {
                let Target::Paragraph(s, p) = target else {
                    return Err("manual document replacement is unsupported".into());
                };
                let text = payload
                    .as_str()
                    .or_else(|| payload.get("text").and_then(Value::as_str))
                    .ok_or("manual paragraph requires text")?;
                if text.chars().any(|ch| ch.is_control()) {
                    return Err("manual paragraph contains control characters".into());
                }
                let para = &mut output.sections[s].paragraphs[p];
                para.text = text.into();
                para.line_segs.clear();
                crate::document_core::queries::field_query::rebuild_char_offsets(para);
            }
            _ => return Err(format!("{} does not support this selection", unit.value.id)),
        }
    }
    validate_resource_dependencies(&output)?;
    Ok(output)
}

#[wasm_bindgen(js_name=structuralMergeReviewDocument)]
pub fn review_document(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    bm: &str,
    cm: &str,
    im: &str,
) -> Result<String, JsValue> {
    let run = || -> Result<String, String> {
        let (bm, cm, im) = parse_manifests(bm, cm, im)?;
        let (b, c, i, _) = manifest_documents(b, c, i, &bm, &cm, &im)?;
        serde_json::to_string(&review_documents(&b, &c, &i)?.1).map_err(|e| e.to_string())
    };
    run().map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name=structuralMergeMaterializeReviewDocument)]
pub fn materialize_review_document(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    bm: &str,
    cm: &str,
    im: &str,
    resolutions: &str,
) -> Result<Vec<u8>, JsValue> {
    let run = || -> Result<Vec<u8>, String> {
        let format = fmt(c)?;
        let (bm, cm, im) = parse_manifests(bm, cm, im)?;
        let (b, c, i, restore) = manifest_documents(b, c, i, &bm, &cm, &im)?;
        let choices = serde_json::from_str(resolutions)
            .map_err(|e| format!("invalid review choices: {e}"))?;
        let mut output = apply_review(&b, &c, &i, &choices)?;
        restore_manifest_ids(&mut output, &restore);
        let bytes = match format {
            FileFormat::Hwp => serialize_hwp(&output),
            _ => serialize_hwpx(&output),
        }
        .map_err(|e| e.to_string())?;
        let loaded = parse_regenerated_document(&bytes).map_err(|e| e.to_string())?;
        validate_resource_dependencies(&loaded)?;
        if counts(&loaded) != counts(&output) {
            return Err("review result failed structural validation".into());
        }
        Ok(bytes)
    };
    run().map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Document {
        let mut document = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        let mut para = document.sections[0].paragraphs[0].clone();
        para.controls.clear();
        para.ctrl_data_records.clear();
        para.raw_header_extra.clear();
        para.text = "first".into();
        document.sections[0].raw_stream = None;
        document.sections[0].paragraphs = vec![para.clone(), para.clone(), para];
        document
    }

    #[test]
    fn review_each_paragraph_preserves_unrelated_local_work() {
        let base = fixture();
        let mut current = base.clone();
        current.sections[0].paragraphs[0].text = "local".into();
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[1].text = "cloud one".into();
        incoming.sections[0].paragraphs[2].text = "cloud two".into();
        let (_, analysis, _) = review_documents(&base, &current, &incoming).unwrap();
        assert_eq!(
            analysis.conflicts.len(),
            2,
            "{:?}",
            analysis
                .conflicts
                .iter()
                .map(|v| &v.value.path)
                .collect::<Vec<_>>()
        );
        assert!(analysis.conflicts.iter().all(|v| v.automatic));
        let mut choices = analysis
            .conflicts
            .iter()
            .map(|v| (v.value.id.clone(), MergeResolution::Incoming))
            .collect::<BTreeMap<_, _>>();
        let output = apply_review(&base, &current, &incoming, &choices).unwrap();
        assert_eq!(output.sections[0].paragraphs[0].text, "local");
        assert_eq!(output.sections[0].paragraphs[1].text, "cloud one");
        choices.insert(
            analysis.conflicts[1].value.id.clone(),
            MergeResolution::Current,
        );
        let output = apply_review(&base, &current, &incoming, &choices).unwrap();
        assert_eq!(output.sections[0].paragraphs[2].text, "first");
        assert_eq!(output.sections[0].paragraphs[1].text, "cloud one");
    }

    #[test]
    fn review_conflicts_are_explicit_and_stale_choices_do_not_apply() {
        let base = fixture();
        let mut current = base.clone();
        current.sections[0].paragraphs[0].text = "local".into();
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[0].text = "remote".into();
        let (_, analysis, _) = review_documents(&base, &current, &incoming).unwrap();
        assert!(analysis.conflicts.iter().any(|v| !v.automatic));
        assert_eq!(
            dh(&apply_review(&base, &current, &incoming, &BTreeMap::new()).unwrap()),
            dh(&current)
        );
        let choices = analysis
            .conflicts
            .iter()
            .map(|v| (v.value.id.clone(), MergeResolution::Current))
            .collect();
        let rejected = apply_review(&base, &current, &incoming, &choices).unwrap();
        assert_eq!(dh(&rejected), dh(&current));
        current.sections[0].paragraphs[0].text = "new local".into();
        assert_eq!(
            dh(&apply_review(&base, &current, &incoming, &choices).unwrap()),
            dh(&current)
        );
    }

    #[test]
    fn review_structural_insertions_are_atomic_and_rejectable() {
        let base = fixture();
        let mut incoming = base.clone();
        let inserted = incoming.sections[0].paragraphs[0].clone();
        incoming.sections[0].paragraphs.push(inserted);
        let (_, analysis, _) = review_documents(&base, &base, &incoming).unwrap();
        assert_eq!(analysis.conflicts.len(), 1);
        assert!(!analysis.conflicts[0].value.supports_manual);
        let choices = BTreeMap::from([(
            analysis.conflicts[0].value.id.clone(),
            MergeResolution::Current,
        )]);
        assert_eq!(
            dh(&apply_review(&base, &base, &incoming, &choices).unwrap()),
            dh(&base)
        );
    }

    #[test]
    fn review_mixed_choices_and_manual_text_reload_in_both_formats() {
        let base = fixture();
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[1].text = "cloud one".into();
        incoming.sections[0].paragraphs[2].text = "cloud two".into();
        let (_, analysis, _) = review_documents(&base, &base, &incoming).unwrap();
        assert_eq!(analysis.conflicts.len(), 2);
        for mask in 0..4 {
            let choices = analysis
                .conflicts
                .iter()
                .enumerate()
                .map(|(n, unit)| {
                    (
                        unit.value.id.clone(),
                        if mask & (1 << n) != 0 {
                            MergeResolution::Incoming
                        } else {
                            MergeResolution::Current
                        },
                    )
                })
                .collect();
            let output = apply_review(&base, &base, &incoming, &choices).unwrap();
            for bytes in [
                serialize_hwp(&output).unwrap(),
                serialize_hwpx(&output).unwrap(),
            ] {
                let loaded = parse_regenerated_document(&bytes).unwrap();
                validate_resource_dependencies(&loaded).unwrap();
                for n in 0..2 {
                    assert_eq!(
                        loaded.sections[0].paragraphs[n + 1].text,
                        if mask & (1 << n) != 0 {
                            incoming.sections[0].paragraphs[n + 1].text.as_str()
                        } else {
                            "first"
                        }
                    );
                }
            }
        }
        let choices = analysis
            .conflicts
            .iter()
            .map(|unit| {
                (
                    unit.value.id.clone(),
                    MergeResolution::Manual {
                        payload: json!("직접 수정"),
                    },
                )
            })
            .collect();
        let output = apply_review(&base, &base, &incoming, &choices).unwrap();
        assert_eq!(output.sections[0].paragraphs[1].text, "직접 수정");
        assert_eq!(output.sections[0].paragraphs[2].text, "직접 수정");
    }

    fn form002_edited_bytes() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let bytes = std::fs::read("samples/hwpx/form-002.hwpx").expect("form-002.hwpx");
        let mut current = crate::wasm_api::HwpDocument::from_bytes(&bytes).expect("current");
        current
            .insert_text_native(0, 0, 0, "UNSAVED_CLOUD_HANDOFF ")
            .expect("handoff");
        current
            .insert_text_native(0, 0, 0, "LOCAL_DURING_CLOUD ")
            .expect("local");
        let current_bytes = current.export_hwpx_native().expect("export current");
        let mut incoming = crate::wasm_api::HwpDocument::from_bytes(&bytes).expect("incoming");
        incoming
            .insert_text_native(0, 0, 0, "UNSAVED_CLOUD_HANDOFF ")
            .expect("incoming handoff");
        let length = incoming
            .get_paragraph_length_native(0, 0)
            .expect("paragraph length");
        incoming
            .insert_text_native(0, 0, length, " CLOUD_FINISHED")
            .expect("cloud");
        let incoming_bytes = incoming.export_hwpx_native().expect("export incoming");
        (bytes, current_bytes, incoming_bytes)
    }

    #[test]
    fn form002_review_materialize_roundtrips_inserted_text() {
        let (base_bytes, current_bytes, incoming_bytes) = form002_edited_bytes();
        let base = parse(&base_bytes, "base").expect("parse base");
        let current = parse(&current_bytes, "current").expect("parse current");
        let incoming = parse(&incoming_bytes, "incoming").expect("parse incoming");
        validate_resource_dependencies(&base).expect("base resources");
        validate_resource_dependencies(&current).expect("current resources");
        validate_resource_dependencies(&incoming).expect("incoming resources");
        let (_, analysis, _) =
            review_documents(&base, &current, &incoming).expect("review analysis");
        let reject = analysis
            .conflicts
            .iter()
            .map(|unit| (unit.value.id.clone(), MergeResolution::Current))
            .collect();
        let output = apply_review(&base, &current, &incoming, &reject)
            .unwrap_or_else(|error| panic!("all-current review materialize: {error}"));
        let serialized =
            serialize_hwpx(&output).unwrap_or_else(|error| panic!("serialize: {error}"));
        let loaded = parse_regenerated_document(&serialized)
            .unwrap_or_else(|error| panic!("reload: {error}"));
        validate_resource_dependencies(&loaded)
            .unwrap_or_else(|error| panic!("reloaded resources: {error}"));
        assert_eq!(
            counts(&loaded),
            counts(&output),
            "review result failed structural validation"
        );
        let accept = analysis
            .conflicts
            .iter()
            .map(|unit| (unit.value.id.clone(), MergeResolution::Incoming))
            .collect();
        apply_review(&base, &current, &incoming, &accept)
            .unwrap_or_else(|error| panic!("all-incoming review materialize: {error}"));
    }

    #[test]
    fn review_paragraph_both_keeps_prefix_and_suffix() {
        let base = fixture();
        let mut current = base.clone();
        current.sections[0].paragraphs[0].text = format!(
            "LOCAL_DURING_CLOUD {}",
            current.sections[0].paragraphs[0].text
        );
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[0].text =
            format!("{} CLOUD_FINISHED", incoming.sections[0].paragraphs[0].text);
        let (_, analysis, _) = review_documents(&base, &current, &incoming).unwrap();
        let paragraph = analysis
            .conflicts
            .iter()
            .find(|unit| {
                unit.position
                    == Some(ReviewPosition {
                        section: 0,
                        paragraph: 0,
                    })
            })
            .expect("paragraph 0 review unit");
        assert!(paragraph.value.supports_both);
        let mut choices = analysis
            .conflicts
            .iter()
            .map(|unit| (unit.value.id.clone(), MergeResolution::Current))
            .collect::<BTreeMap<_, _>>();
        choices.insert(
            paragraph.value.id.clone(),
            MergeResolution::Both {
                order: "current-first".into(),
            },
        );
        let output = apply_review(&base, &current, &incoming, &choices).unwrap();
        assert!(
            output.sections[0].paragraphs[0]
                .text
                .contains("LOCAL_DURING_CLOUD"),
            "{}",
            output.sections[0].paragraphs[0].text
        );
        assert!(
            output.sections[0].paragraphs[0]
                .text
                .contains("CLOUD_FINISHED"),
            "{}",
            output.sections[0].paragraphs[0].text
        );
    }
}
