//! Deterministic three-way structural merging and conservative HWP/HWPX adapters.

use crate::model::{
    bin_data::{BinDataBytes, BinDataContent},
    control::{Control, Equation, FormObject},
    document::{DocInfo, DocProperties, Document, Section, SectionDef},
    footnote::{Endnote, Footnote, FootnoteShape},
    header_footer::{Footer, Header, MasterPage},
    image::{CropInfo, ImageAttr, Picture},
    page::{PageBorderFill, PageDef},
    paragraph::{CharShapeRef, Paragraph},
    shape::{
        Axis, Caption, ChartShape, CommonObjAttr, DataSeries, DrawingObjAttr, Legend, OleShape,
        ShapeComponentAttr, ShapeObject, TextBox,
    },
    style::{BorderFill, Bullet, CharShape, Font, HeadType, Numbering, ParaShape, Style, TabDef},
    table::{Cell, Table},
    Point,
};
use crate::parser::{detect_format, parse_document, parse_regenerated_document, FileFormat};
use crate::serializer::{serialize_hwp, serialize_hwpx};
use crate::xml_attr::{image_ref_u16_ascii, ExactXmlAttributeScanner};
use base64::Engine as _;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Debug;
use std::time::Duration;
use wasm_bindgen::prelude::*;
use web_time::Instant;

pub const ANALYSIS_VERSION: u32 = 1;
pub const DEFAULT_SOFT_BUDGET_MS: u64 = 5_000;
const MAX_STRUCTURAL_MANIFEST_OUTPUT_BYTES: usize =
    crate::parser::limits::MAX_UNTRUSTED_INPUT_BYTES;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MergeConflictReason {
    SameFieldChanged,
    DeleteVersusEdit,
    IncompatibleMove,
    ConcurrentInsertion,
    UnknownControlModified,
    LowConfidenceMatch,
    BudgetExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    pub id: String,
    pub kind: String,
    pub path: Vec<String>,
    pub reason: MergeConflictReason,
    pub base: Value,
    pub current: Value,
    pub incoming: Value,
    pub supports_both: bool,
    #[serde(default = "default_true")]
    pub supports_manual: bool,
    pub fingerprint: String,
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeAnalysis {
    pub analysis_version: u32,
    pub result: Value,
    pub conflicts: Vec<MergeConflict>,
    pub automatic_operation_count: usize,
    #[serde(default)]
    pub visited_node_count: usize,
    #[serde(default)]
    pub budget_exceeded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MergeResolution {
    Current,
    Incoming,
    Both { order: String },
    Manual { payload: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MergeOptions {
    pub soft_budget_ms: u64,
    pub node_budget: Option<usize>,
}
impl Default for MergeOptions {
    fn default() -> Self {
        Self {
            soft_budget_ms: DEFAULT_SOFT_BUDGET_MS,
            node_budget: None,
        }
    }
}

fn canonical(v: &Value) -> String {
    fn c(v: &Value) -> Value {
        match v {
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, v)| (k.clone(), c(v)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(a) => Value::Array(a.iter().map(c).collect()),
            _ => v.clone(),
        }
    }
    serde_json::to_string(&c(v)).unwrap()
}
fn fingerprint(path: &[String], b: &Value, c: &Value, i: &Value) -> String {
    let mut h = blake3::Hasher::new();
    h.update(path.join("\0").as_bytes());
    for v in [b, c, i] {
        h.update(&[0]);
        h.update(canonical(v).as_bytes());
    }
    format!("blake3:{}", h.finalize().to_hex())
}
fn kind(path: &[String], values: [&Value; 3]) -> String {
    for v in values {
        if let Some(o) = v.as_object() {
            for k in ["kind", "type", "nodeKind"] {
                if let Some(s) = o.get(k).and_then(Value::as_str) {
                    return s.into();
                }
            }
        }
    }
    path.last().cloned().unwrap_or_else(|| "document".into())
}
fn conflict(
    path: &[String],
    reason: MergeConflictReason,
    b: &Value,
    c: &Value,
    i: &Value,
    both: bool,
) -> MergeConflict {
    let fp = fingerprint(path, b, c, i);
    MergeConflict {
        id: format!("conflict:{}", &fp[7..]),
        kind: kind(path, [c, i, b]),
        path: path.to_vec(),
        reason,
        base: b.clone(),
        current: c.clone(),
        incoming: i.clone(),
        supports_both: both,
        supports_manual: true,
        fingerprint: fp,
    }
}
fn unknown(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.get("unknown").and_then(Value::as_bool) == Some(true)
            || matches!(
                o.get("kind")
                    .or_else(|| o.get("type"))
                    .and_then(Value::as_str),
                Some("unknown" | "unknown-control")
            )
    })
}
fn identity(v: &Value) -> Option<String> {
    let o = v.as_object()?;
    for k in ["stableId", "stable_id", "identity", "id", "key"] {
        match o.get(k) {
            Some(Value::String(s)) if !s.is_empty() => return Some(s.clone()),
            Some(Value::Number(n)) => return Some(n.to_string()),
            _ => {}
        }
    }
    None
}
fn keyed(a: &[Value]) -> Option<(Vec<String>, BTreeMap<String, Value>)> {
    let mut order = vec![];
    let mut map = BTreeMap::new();
    for v in a {
        let k = identity(v)?;
        if map.insert(k.clone(), v.clone()).is_some() {
            return None;
        }
        order.push(k)
    }
    Some((order, map))
}

struct Ctx {
    start: Instant,
    opt: MergeOptions,
    visited: usize,
    auto: usize,
    exceeded: bool,
    conflicts: Vec<MergeConflict>,
}
impl Ctx {
    fn new(opt: MergeOptions) -> Self {
        Self {
            start: Instant::now(),
            opt,
            visited: 0,
            auto: 0,
            exceeded: false,
            conflicts: vec![],
        }
    }
    fn enter(&mut self, p: &[String], b: &Value, c: &Value, i: &Value) -> bool {
        self.visited += 1;
        let over = self.opt.node_budget.is_some_and(|n| self.visited > n)
            || (self.opt.soft_budget_ms > 0
                && self.start.elapsed() > Duration::from_millis(self.opt.soft_budget_ms));
        if over {
            self.exceeded = true;
            self.conflicts.push(conflict(
                p,
                MergeConflictReason::BudgetExceeded,
                b,
                c,
                i,
                false,
            ));
            false
        } else {
            true
        }
    }
}

fn rel(o: &[String], a: &str, b: &str) -> Option<bool> {
    Some(o.iter().position(|x| x == a)? < o.iter().position(|x| x == b)?)
}
fn merged_order(
    base: &[String],
    cur: &[String],
    inc: &[String],
    alive: &BTreeSet<String>,
) -> Result<Vec<String>, ()> {
    let f = |o: &[String]| {
        o.iter()
            .filter(|x| alive.contains(*x))
            .cloned()
            .collect::<Vec<_>>()
    };
    let b = f(base);
    let c = f(cur);
    let i = f(inc);
    if c == i {
        return Ok(c);
    }
    if c == b {
        return Ok(i);
    }
    if i == b {
        return Ok(c);
    }
    let nodes = alive.iter().cloned().collect::<Vec<_>>();
    let mut edges: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut indeg = nodes
        .iter()
        .map(|x| (x.clone(), 0usize))
        .collect::<BTreeMap<_, _>>();
    for x in 0..nodes.len() {
        for y in x + 1..nodes.len() {
            let (l, r) = (&nodes[x], &nodes[y]);
            let br = rel(&b, l, r);
            let cr = rel(&c, l, r);
            let ir = rel(&i, l, r);
            let pick = match (br, cr, ir) {
                (_, Some(x), Some(y)) if x == y => Some(x),
                (Some(x), Some(y), Some(z)) if y == x => Some(z),
                (Some(x), Some(y), Some(z)) if z == x => Some(y),
                (None, Some(x), None) | (None, None, Some(x)) => Some(x),
                (None, Some(_), Some(_)) => return Err(()),
                _ => None,
            };
            if let Some(lr) = pick {
                let (a, z) = if lr { (l, r) } else { (r, l) };
                if edges.entry(a.clone()).or_default().insert(z.clone()) {
                    *indeg.get_mut(z).unwrap() += 1
                }
            }
        }
    }
    let rank = c
        .iter()
        .enumerate()
        .map(|(n, k)| (k, n))
        .collect::<BTreeMap<_, _>>();
    let mut avail = indeg
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(k, _)| k.clone())
        .collect::<Vec<_>>();
    let mut out = vec![];
    while !avail.is_empty() {
        avail.sort_by_key(|k| (rank.get(k).copied().unwrap_or(usize::MAX), k.clone()));
        let k = avail.remove(0);
        out.push(k.clone());
        if let Some(es) = edges.get(&k) {
            for z in es {
                let n = indeg.get_mut(z).unwrap();
                *n -= 1;
                if *n == 0 {
                    avail.push(z.clone())
                }
            }
        }
    }
    if out.len() == nodes.len() {
        Ok(out)
    } else {
        Err(())
    }
}
fn merge_keyed(
    path: &mut Vec<String>,
    b: &[Value],
    c: &[Value],
    i: &[Value],
    ctx: &mut Ctx,
) -> Option<Value> {
    let (bo, bm) = keyed(b)?;
    let (co, cm) = keyed(c)?;
    let (io, im) = keyed(i)?;
    let all = bm
        .keys()
        .chain(cm.keys())
        .chain(im.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut out = BTreeMap::new();
    for k in all {
        path.push(format!("@{k}"));
        match (bm.get(&k), cm.get(&k), im.get(&k)) {
            (Some(b), Some(c), Some(i)) => {
                out.insert(k, merge_value(path, b, c, i, ctx));
            }
            (Some(b), None, Some(i)) if i != b => {
                ctx.conflicts.push(conflict(
                    path,
                    MergeConflictReason::DeleteVersusEdit,
                    b,
                    &Value::Null,
                    i,
                    false,
                ));
                out.insert(k, i.clone());
            }
            (Some(b), Some(c), None) if c != b => {
                ctx.conflicts.push(conflict(
                    path,
                    MergeConflictReason::DeleteVersusEdit,
                    b,
                    c,
                    &Value::Null,
                    false,
                ));
                out.insert(k, c.clone());
            }
            (Some(_), None, None) | (Some(_), None, Some(_)) | (Some(_), Some(_), None) => {
                ctx.auto += 1
            }
            (None, Some(c), Some(i)) if c == i => {
                ctx.auto += 1;
                out.insert(k, c.clone());
            }
            (None, Some(c), Some(i)) => {
                ctx.conflicts.push(conflict(
                    path,
                    MergeConflictReason::ConcurrentInsertion,
                    &Value::Null,
                    c,
                    i,
                    false,
                ));
                out.insert(k, c.clone());
            }
            (None, Some(c), None) => {
                ctx.auto += 1;
                out.insert(k, c.clone());
            }
            (None, None, Some(i)) => {
                ctx.auto += 1;
                out.insert(k, i.clone());
            }
            _ => unreachable!(),
        }
        path.pop();
    }
    let alive = out.keys().cloned().collect();
    let order = merged_order(&bo, &co, &io, &alive).unwrap_or_else(|_| {
        path.push("$order".into());
        ctx.conflicts.push(conflict(
            path,
            MergeConflictReason::IncompatibleMove,
            &json!(bo),
            &json!(co),
            &json!(io),
            false,
        ));
        path.pop();
        let mut v = co
            .iter()
            .chain(io.iter())
            .filter(|x| alive.contains(*x))
            .cloned()
            .collect::<Vec<_>>();
        v.dedup();
        v
    });
    Some(Value::Array(
        order.into_iter().filter_map(|k| out.remove(&k)).collect(),
    ))
}
fn merge_obj(
    path: &mut Vec<String>,
    b: &Map<String, Value>,
    c: &Map<String, Value>,
    i: &Map<String, Value>,
    ctx: &mut Ctx,
) -> Value {
    let keys = b
        .keys()
        .chain(c.keys())
        .chain(i.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut out = Map::new();
    for k in keys {
        path.push(k.clone());
        match (b.get(&k), c.get(&k), i.get(&k)) {
            (Some(b), Some(c), Some(i)) => {
                out.insert(k, merge_value(path, b, c, i, ctx));
            }
            (Some(b), None, Some(i)) if i != b => {
                ctx.conflicts.push(conflict(
                    path,
                    MergeConflictReason::DeleteVersusEdit,
                    b,
                    &Value::Null,
                    i,
                    false,
                ));
                out.insert(k, i.clone());
            }
            (Some(b), Some(c), None) if c != b => {
                ctx.conflicts.push(conflict(
                    path,
                    MergeConflictReason::DeleteVersusEdit,
                    b,
                    c,
                    &Value::Null,
                    false,
                ));
                out.insert(k, c.clone());
            }
            (Some(_), None, None) | (Some(_), None, Some(_)) | (Some(_), Some(_), None) => {
                ctx.auto += 1
            }
            (None, Some(c), Some(i)) if c == i => {
                ctx.auto += 1;
                out.insert(k, c.clone());
            }
            (None, Some(c), Some(i)) => {
                ctx.conflicts.push(conflict(
                    path,
                    MergeConflictReason::ConcurrentInsertion,
                    &Value::Null,
                    c,
                    i,
                    false,
                ));
                out.insert(k, c.clone());
            }
            (None, Some(c), None) => {
                ctx.auto += 1;
                out.insert(k, c.clone());
            }
            (None, None, Some(i)) => {
                ctx.auto += 1;
                out.insert(k, i.clone());
            }
            _ => unreachable!(),
        }
        path.pop();
    }
    Value::Object(out)
}

#[derive(Debug)]
struct Edit {
    start: usize,
    end: usize,
    repl: Vec<char>,
}
fn edit(b: &str, x: &str) -> Edit {
    let b = b.chars().collect::<Vec<_>>();
    let x = x.chars().collect::<Vec<_>>();
    let mut p = 0;
    while p < b.len() && p < x.len() && b[p] == x[p] {
        p += 1
    }
    let mut s = 0;
    while s < b.len() - p && s < x.len() - p && b[b.len() - 1 - s] == x[x.len() - 1 - s] {
        s += 1
    }
    Edit {
        start: p,
        end: b.len() - s,
        repl: x[p..x.len() - s].to_vec(),
    }
}
fn apply_edits(b: &str, es: &[&Edit]) -> String {
    let mut v = b.chars().collect::<Vec<_>>();
    let mut es = es.to_vec();
    es.sort_by_key(|e| std::cmp::Reverse(e.start));
    for e in es {
        v.splice(e.start..e.end, e.repl.clone());
    }
    v.into_iter().collect()
}
fn merge_text(b: &str, c: &str, i: &str) -> Option<String> {
    let ce = edit(b, c);
    let ie = edit(b, i);
    let disjoint = ce.end <= ie.start || ie.end <= ce.start;
    let same_insert = ce.start == ce.end && ie.start == ie.end && ce.start == ie.start;
    if disjoint && !same_insert {
        Some(apply_edits(b, &[&ce, &ie]))
    } else {
        None
    }
}
fn both_text(b: &str, c: &str, i: &str, inc_first: bool) -> Option<String> {
    let ce = edit(b, c);
    let ie = edit(b, i);
    if ce.start != ce.end || ie.start != ie.end || ce.start != ie.start {
        return None;
    }
    let repl = if inc_first {
        ie.repl.iter().chain(&ce.repl)
    } else {
        ce.repl.iter().chain(&ie.repl)
    }
    .copied()
    .collect();
    Some(apply_edits(
        b,
        &[&Edit {
            start: ce.start,
            end: ce.end,
            repl,
        }],
    ))
}
fn both_array(b: &[Value], c: &[Value], i: &[Value], inc_first: bool) -> Option<Value> {
    if !c.starts_with(b) || !i.starts_with(b) || c.len() == b.len() || i.len() == b.len() {
        return None;
    }
    let mut v = b.to_vec();
    if inc_first {
        v.extend_from_slice(&i[b.len()..]);
        v.extend_from_slice(&c[b.len()..])
    } else {
        v.extend_from_slice(&c[b.len()..]);
        v.extend_from_slice(&i[b.len()..])
    }
    Some(Value::Array(v))
}
fn merge_value(path: &mut Vec<String>, b: &Value, c: &Value, i: &Value, ctx: &mut Ctx) -> Value {
    if c == i {
        ctx.auto += 1;
        return c.clone();
    }
    if c == b {
        ctx.auto += 1;
        return i.clone();
    }
    if i == b {
        ctx.auto += 1;
        return c.clone();
    }
    if !ctx.enter(path, b, c, i) {
        return c.clone();
    }
    if unknown(b) || unknown(c) || unknown(i) {
        ctx.conflicts.push(conflict(
            path,
            MergeConflictReason::UnknownControlModified,
            b,
            c,
            i,
            false,
        ));
        return c.clone();
    }
    match (b, c, i) {
        (Value::Object(b), Value::Object(c), Value::Object(i)) => merge_obj(path, b, c, i, ctx),
        (Value::Array(b), Value::Array(c), Value::Array(i)) => merge_keyed(path, b, c, i, ctx)
            .unwrap_or_else(|| {
                let both = both_array(b, c, i, false).is_some();
                ctx.conflicts.push(conflict(
                    path,
                    if both {
                        MergeConflictReason::ConcurrentInsertion
                    } else {
                        MergeConflictReason::LowConfidenceMatch
                    },
                    &Value::Array(b.clone()),
                    &Value::Array(c.clone()),
                    &Value::Array(i.clone()),
                    both,
                ));
                Value::Array(c.clone())
            }),
        (Value::String(b), Value::String(c), Value::String(i)) => merge_text(b, c, i)
            .map(|x| {
                ctx.auto += 2;
                Value::String(x)
            })
            .unwrap_or_else(|| {
                let both = both_text(b, c, i, false).is_some();
                ctx.conflicts.push(conflict(
                    path,
                    if both {
                        MergeConflictReason::ConcurrentInsertion
                    } else {
                        MergeConflictReason::SameFieldChanged
                    },
                    &Value::String(b.clone()),
                    &Value::String(c.clone()),
                    &Value::String(i.clone()),
                    both,
                ));
                Value::String(c.clone())
            }),
        _ => {
            ctx.conflicts.push(conflict(
                path,
                MergeConflictReason::SameFieldChanged,
                b,
                c,
                i,
                false,
            ));
            c.clone()
        }
    }
}

pub fn analyze(b: &Value, c: &Value, i: &Value) -> MergeAnalysis {
    analyze_with_options(b, c, i, MergeOptions::default())
}
pub fn analyze_with_options(b: &Value, c: &Value, i: &Value, opt: MergeOptions) -> MergeAnalysis {
    let mut x = Ctx::new(opt);
    let result = merge_value(&mut vec![], b, c, i, &mut x);
    x.conflicts
        .sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
    MergeAnalysis {
        analysis_version: ANALYSIS_VERSION,
        result,
        conflicts: x.conflicts,
        automatic_operation_count: x.auto,
        visited_node_count: x.visited,
        budget_exceeded: x.exceeded,
    }
}

fn reorder(a: &mut Vec<Value>, order: &[Value]) -> Result<(), String> {
    let mut m = BTreeMap::new();
    for v in std::mem::take(a) {
        m.insert(identity(&v).ok_or("ordered member lacks identity")?, v);
    }
    let mut out = vec![];
    for k in order {
        if let Some(v) = m.remove(k.as_str().ok_or("order member is not string")?) {
            out.push(v)
        }
    }
    out.extend(m.into_values());
    *a = out;
    Ok(())
}
fn set_path(root: &mut Value, path: &[String], v: Value) -> Result<(), String> {
    if path.is_empty() {
        *root = v;
        return Ok(());
    }
    let mut cur = root;
    for p in &path[..path.len() - 1] {
        if let Some(id) = p.strip_prefix('@') {
            cur = cur
                .as_array_mut()
                .ok_or("identity parent is not array")?
                .iter_mut()
                .find(|v| identity(v).as_deref() == Some(id))
                .ok_or("identity absent")?
        } else {
            cur = cur
                .as_object_mut()
                .and_then(|o| o.get_mut(p))
                .ok_or("path absent")?
        }
    }
    let leaf = path.last().unwrap();
    if leaf == "$order" {
        return reorder(
            cur.as_array_mut().ok_or("order parent is not array")?,
            v.as_array().ok_or("order is not array")?,
        );
    }
    if let Some(id) = leaf.strip_prefix('@') {
        let a = cur.as_array_mut().ok_or("identity parent is not array")?;
        if v.is_null() {
            a.retain(|x| identity(x).as_deref() != Some(id))
        } else if let Some(n) = a.iter().position(|x| identity(x).as_deref() == Some(id)) {
            a[n] = v
        } else {
            a.push(v)
        }
    } else {
        let o = cur.as_object_mut().ok_or("property parent is not object")?;
        if v.is_null() {
            o.remove(leaf);
        } else {
            o.insert(leaf.clone(), v);
        }
    }
    Ok(())
}
pub fn materialize(
    a: &MergeAnalysis,
    r: &BTreeMap<String, MergeResolution>,
) -> Result<Value, String> {
    let mut out = a.result.clone();
    for c in &a.conflicts {
        let x = r
            .get(&c.id)
            .ok_or_else(|| format!("{} is unresolved", c.id))?;
        let v = match x {
            MergeResolution::Current => c.current.clone(),
            MergeResolution::Incoming => c.incoming.clone(),
            MergeResolution::Manual { payload } => payload.clone(),
            MergeResolution::Both { order } => {
                if !c.supports_both {
                    return Err(format!("{} does not support both", c.id));
                }
                let first = match order.as_str() {
                    "current-first" => false,
                    "incoming-first" => true,
                    _ => return Err("invalid both order".into()),
                };
                match (&c.base, &c.current, &c.incoming) {
                    (Value::String(b), Value::String(x), Value::String(y)) => {
                        Value::String(both_text(b, x, y, first).ok_or("unsafe both text")?)
                    }
                    (Value::Array(b), Value::Array(x), Value::Array(y)) => {
                        both_array(b, x, y, first).ok_or("unsafe both array")?
                    }
                    _ => return Err("unsafe both".into()),
                }
            }
        };
        set_path(&mut out, &c.path, v)?
    }
    Ok(out)
}

pub fn synthesize_virtual_base(bases: &[Value]) -> Result<Value, String> {
    if bases.is_empty() {
        return Err("at least one merge base is required".into());
    }
    fn go(v: &[&Value]) -> Value {
        if v.iter().all(|x| *x == v[0]) {
            return v[0].clone();
        }
        if v.iter().all(|x| x.is_object()) {
            let keys = v
                .iter()
                .flat_map(|x| x.as_object().unwrap().keys())
                .cloned()
                .collect::<BTreeSet<_>>();
            let mut o = Map::new();
            for k in keys {
                let p = v
                    .iter()
                    .filter_map(|x| x.as_object().unwrap().get(&k))
                    .collect::<Vec<_>>();
                if p.len() == v.len() {
                    o.insert(k, go(&p));
                }
            }
            return Value::Object(o);
        }
        (*v.iter().min_by_key(|x| canonical(x)).unwrap()).clone()
    }
    let mut v = bases.iter().collect::<Vec<_>>();
    v.sort_by_key(|x| canonical(x));
    Ok(go(&v))
}

// Conservative document adapter. Debug hashes are deterministic for the model's
// Vec/BTree-shaped IR except Form properties; those stay atomic at control scope.
fn dv<T: Debug>(kind: &str, v: &T) -> Value {
    let h = dh(v);
    json!({"kind":kind,"hash":format!("blake3:{}",h.to_hex())})
}

struct Blake3DebugWriter(blake3::Hasher);

impl std::fmt::Write for Blake3DebugWriter {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        self.0.update(value.as_bytes());
        Ok(())
    }
}

fn dh<T: Debug + ?Sized>(v: &T) -> blake3::Hash {
    let mut writer = Blake3DebugWriter(blake3::Hasher::new());
    std::fmt::write(&mut writer, format_args!("{v:#?}"))
        .expect("Blake3 Debug writer is infallible");
    writer.0.finalize()
}

fn update_length_prefixed(hasher: &mut blake3::Hasher, bytes: &[u8]) {
    hasher.update(&(bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn opaque_streams_hash(values: &[(String, Vec<u8>)]) -> blake3::Hash {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&(values.len() as u64).to_le_bytes());
    for (name, bytes) in values {
        update_length_prefixed(&mut hasher, name.as_bytes());
        update_length_prefixed(&mut hasher, bytes);
    }
    hasher.finalize()
}

fn opaque_streams_value(kind: &str, values: &[(String, Vec<u8>)]) -> Value {
    let total_bytes = values.iter().fold(0u64, |total, (_, bytes)| {
        total.saturating_add(bytes.len() as u64)
    });
    json!({
        "kind": kind,
        "count": values.len(),
        "byteLength": total_bytes,
        "hash": format!("blake3:{}", opaque_streams_hash(values).to_hex()),
    })
}

fn choose_opaque_streams(
    path: &[String],
    kind: &str,
    base: &[(String, Vec<u8>)],
    current: &[(String, Vec<u8>)],
    incoming: &[(String, Vec<u8>)],
    resolutions: Option<&BTreeMap<String, MergeResolution>>,
    context: &mut Ctx,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let (base_hash, current_hash, incoming_hash) = (
        opaque_streams_hash(base),
        opaque_streams_hash(current),
        opaque_streams_hash(incoming),
    );
    if current_hash == incoming_hash {
        context.auto += 1;
        return Ok(current.to_vec());
    }
    if current_hash == base_hash {
        context.auto += 1;
        return Ok(incoming.to_vec());
    }
    if incoming_hash == base_hash {
        context.auto += 1;
        return Ok(current.to_vec());
    }
    let (base_value, current_value, incoming_value) = (
        opaque_streams_value(kind, base),
        opaque_streams_value(kind, current),
        opaque_streams_value(kind, incoming),
    );
    if !context.enter(path, &base_value, &current_value, &incoming_value) {
        let item = context.conflicts.last_mut().expect("budget conflict");
        item.supports_manual = false;
        return match resolutions.and_then(|values| values.get(&item.id)) {
            None | Some(MergeResolution::Current) => Ok(current.to_vec()),
            Some(MergeResolution::Incoming) => Ok(incoming.to_vec()),
            _ => Err(format!("{} is an atomic budget conflict", item.id)),
        };
    }
    let mut item = conflict(
        path,
        MergeConflictReason::UnknownControlModified,
        &base_value,
        &current_value,
        &incoming_value,
        false,
    );
    item.supports_manual = false;
    let output = match resolutions.and_then(|values| values.get(&item.id)) {
        None | Some(MergeResolution::Current) => current.to_vec(),
        Some(MergeResolution::Incoming) => incoming.to_vec(),
        _ => return Err(format!("{} is atomic; both/manual unsupported", item.id)),
    };
    context.conflicts.push(item);
    Ok(output)
}

fn choose<T: Clone + Debug>(
    p: &[String],
    kind: &str,
    reason: MergeConflictReason,
    b: &T,
    c: &T,
    i: &T,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<T, String> {
    let (bh, ch, ih) = (dh(b), dh(c), dh(i));
    if ch == ih {
        x.auto += 1;
        return Ok(c.clone());
    }
    if ch == bh {
        x.auto += 1;
        return Ok(i.clone());
    }
    if ih == bh {
        x.auto += 1;
        return Ok(c.clone());
    }
    let (bv, cv, iv) = (dv(kind, b), dv(kind, c), dv(kind, i));
    if !x.enter(p, &bv, &cv, &iv) {
        let item = x.conflicts.last_mut().expect("budget conflict");
        item.supports_manual = false;
        return match r.and_then(|m| m.get(&item.id)) {
            None | Some(MergeResolution::Current) => Ok(c.clone()),
            Some(MergeResolution::Incoming) => Ok(i.clone()),
            _ => Err(format!("{} is an atomic budget conflict", item.id)),
        };
    }
    let mut item = conflict(p, reason, &bv, &cv, &iv, false);
    item.supports_manual = false;
    let out = match r.and_then(|m| m.get(&item.id)) {
        None | Some(MergeResolution::Current) => c.clone(),
        Some(MergeResolution::Incoming) => i.clone(),
        _ => return Err(format!("{} is atomic; both/manual unsupported", item.id)),
    };
    x.conflicts.push(item);
    Ok(out)
}
fn choose_typed<T: Clone + Debug + Serialize + DeserializeOwned>(
    p: &[String],
    kind: &str,
    b: &T,
    c: &T,
    i: &T,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<T, String> {
    if canonical(&serde_json::to_value(c).unwrap()) == canonical(&serde_json::to_value(i).unwrap())
    {
        x.auto += 1;
        return Ok(c.clone());
    }
    if canonical(&serde_json::to_value(c).unwrap()) == canonical(&serde_json::to_value(b).unwrap())
    {
        x.auto += 1;
        return Ok(i.clone());
    }
    if canonical(&serde_json::to_value(i).unwrap()) == canonical(&serde_json::to_value(b).unwrap())
    {
        x.auto += 1;
        return Ok(c.clone());
    }
    let bv = serde_json::to_value(b).unwrap();
    let cv = serde_json::to_value(c).unwrap();
    let iv = serde_json::to_value(i).unwrap();
    if !x.enter(p, &bv, &cv, &iv) {
        return Ok(c.clone());
    }
    let mut item = conflict(
        p,
        MergeConflictReason::SameFieldChanged,
        &bv,
        &cv,
        &iv,
        false,
    );
    item.kind = kind.into();
    let out = match r.and_then(|m| m.get(&item.id)) {
        None | Some(MergeResolution::Current) => c.clone(),
        Some(MergeResolution::Incoming) => i.clone(),
        Some(MergeResolution::Manual { payload }) => serde_json::from_value(payload.clone())
            .map_err(|e| format!("invalid manual {}: {e}", item.id))?,
        Some(MergeResolution::Both { .. }) => {
            return Err(format!("{} does not support both", item.id))
        }
    };
    x.conflicts.push(item);
    Ok(out)
}
fn no_controls(p: &Paragraph) -> Paragraph {
    let mut p = p.clone();
    p.controls.clear();
    p.ctrl_data_records.clear();
    p
}
fn merge_text_field(
    path: &[String],
    b: &str,
    c: &str,
    i: &str,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<String, String> {
    if c == i {
        x.auto += 1;
        return Ok(c.into());
    }
    if c == b {
        x.auto += 1;
        return Ok(i.into());
    }
    if i == b {
        x.auto += 1;
        return Ok(c.into());
    }
    if let Some(value) = merge_text(b, c, i) {
        x.auto += 2;
        return Ok(value);
    }
    let both = both_text(b, c, i, false).is_some();
    let item = conflict(
        path,
        if both {
            MergeConflictReason::ConcurrentInsertion
        } else {
            MergeConflictReason::SameFieldChanged
        },
        &json!(b),
        &json!(c),
        &json!(i),
        both,
    );
    let value = match r.and_then(|items| items.get(&item.id)) {
        None | Some(MergeResolution::Current) => c.into(),
        Some(MergeResolution::Incoming) => i.into(),
        Some(MergeResolution::Manual { payload }) => payload
            .as_str()
            .ok_or("manual rich-text value must be a string")?
            .into(),
        Some(MergeResolution::Both { order }) if both => {
            both_text(b, c, i, order == "incoming-first").ok_or("invalid text Both")?
        }
        Some(MergeResolution::Both { .. }) => {
            return Err(format!("{} does not support both", item.id))
        }
    };
    x.conflicts.push(item);
    Ok(value)
}

fn merge_cell(
    path: &[String],
    b: &Cell,
    c: &Cell,
    i: &Cell,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Cell, String> {
    let mut out = c.clone();
    out.paragraphs.clear();
    macro_rules! t {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose_typed(&p, $kind, &b.$name, &c.$name, &i.$name, r, x)?;
        }};
    }
    macro_rules! a {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose(
                &p,
                $kind,
                MergeConflictReason::SameFieldChanged,
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?;
        }};
    }
    t!(col, "table-structure");
    t!(row, "table-structure");
    t!(col_span, "table-structure");
    t!(row_span, "table-structure");
    t!(width, "cell-property");
    t!(height, "cell-property");
    a!(padding, "cell-property");
    t!(border_fill_id, "resource-reference");
    t!(list_header_width_ref, "cell-property");
    t!(text_direction, "cell-property");
    a!(vertical_align, "cell-property");
    a!(line_wrap, "cell-property");
    t!(apply_inner_margin, "cell-property");
    t!(is_header, "cell-property");
    t!(raw_list_extra, "opaque-cell-property");
    t!(field_name, "field");
    t!(dirty_flag, "cell-property");
    let mut pp = path.to_vec();
    pp.push("paragraphs".into());
    out.paragraphs = merge_paras(&pp, &b.paragraphs, &c.paragraphs, &i.paragraphs, r, x)?;
    Ok(out)
}
fn merge_table(
    path: &[String],
    b: &Table,
    c: &Table,
    i: &Table,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Table, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose_typed(&p, $kind, &b.$name, &c.$name, &i.$name, r, x)?;
        }};
    }
    macro_rules! a {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose(
                &p,
                $kind,
                MergeConflictReason::SameFieldChanged,
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?;
        }};
    }
    t!(attr, "table-structure");
    t!(row_count, "table-structure");
    t!(col_count, "table-structure");
    t!(cell_spacing, "table-property");
    a!(padding, "table-property");
    t!(row_sizes, "table-structure");
    t!(border_fill_id, "resource-reference");
    a!(zones, "table-structure");
    a!(page_break, "table-property");
    t!(repeat_header, "table-property");
    a!(caption, "caption");
    a!(common, "table-placement");
    t!(outer_margin_left, "table-placement");
    t!(outer_margin_right, "table-placement");
    t!(outer_margin_top, "table-placement");
    t!(outer_margin_bottom, "table-placement");
    t!(raw_ctrl_data, "opaque-table-property");
    t!(raw_table_record_attr, "table-property");
    t!(raw_table_record_extra, "opaque-table-property");
    t!(local_resize_rows, "table-property");
    t!(local_resize_cols, "table-property");
    t!(local_resize_cell_widths, "table-property");
    t!(local_resize_cell_heights, "table-property");
    fn cells(v: &[Cell]) -> Result<BTreeMap<(u16, u16), &Cell>, String> {
        let mut m = BTreeMap::new();
        for cell in v {
            let key = (cell.row, cell.col);
            if m.insert(key, cell).is_some() {
                return Err(format!(
                    "duplicate table cell coordinate {}:{}",
                    key.0, key.1
                ));
            }
        }
        Ok(m)
    }
    let (bm, cm, im) = (cells(&b.cells)?, cells(&c.cells)?, cells(&i.cells)?);
    let keys = bm
        .keys()
        .chain(cm.keys())
        .chain(im.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    out.cells.clear();
    for key in keys {
        let mut p = path.to_vec();
        p.push("cells".into());
        p.push(format!("{}:{}", key.0, key.1));
        let cell = match (bm.get(&key), cm.get(&key), im.get(&key)) {
            (Some(b), Some(c), Some(i)) => Some(merge_cell(&p, b, c, i, r, x)?),
            (Some(b), None, Some(i)) => choose(
                &p,
                "table-cell",
                MergeConflictReason::DeleteVersusEdit,
                &Some((*b).clone()),
                &None::<Cell>,
                &Some((*i).clone()),
                r,
                x,
            )?,
            (Some(b), Some(c), None) => choose(
                &p,
                "table-cell",
                MergeConflictReason::DeleteVersusEdit,
                &Some((*b).clone()),
                &Some((*c).clone()),
                &None::<Cell>,
                r,
                x,
            )?,
            (Some(_), None, None) => None,
            (None, Some(c), Some(i)) => choose(
                &p,
                "table-cell",
                MergeConflictReason::ConcurrentInsertion,
                &None::<Cell>,
                &Some((*c).clone()),
                &Some((*i).clone()),
                r,
                x,
            )?,
            (None, Some(c), None) => {
                x.auto += 1;
                Some((*c).clone())
            }
            (None, None, Some(i)) => {
                x.auto += 1;
                Some((*i).clone())
            }
            _ => unreachable!(),
        };
        if let Some(cell) = cell {
            out.cells.push(cell)
        }
    }
    out.rebuild_grid();
    out.dirty = true;
    Ok(out)
}
fn merge_picture(
    path: &[String],
    b: &Picture,
    c: &Picture,
    i: &Picture,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Picture, String> {
    let mut out = c.clone();
    macro_rules! f {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose(
                &p,
                $kind,
                MergeConflictReason::SameFieldChanged,
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?;
        }};
    }
    macro_rules! t {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose_typed(&p, $kind, &b.$name, &c.$name, &i.$name, r, x)?;
        }};
    }
    {
        let mut p = path.to_vec();
        p.push("common".into());
        out.common = merge_common(&p, &b.common, &c.common, &i.common, r, x)?;
    }
    f!(shape_attr, "image-placement");
    t!(border_color, "image-property");
    t!(border_width, "image-property");
    f!(border_attr, "image-property");
    t!(border_x, "image-placement");
    t!(border_y, "image-placement");
    {
        let mut p = path.to_vec();
        p.push("crop".into());
        out.crop = merge_crop(&p, &b.crop, &c.crop, &i.crop, r, x)?;
    }
    f!(padding, "image-placement");
    {
        let mut p = path.to_vec();
        p.push("imageAttr".into());
        out.image_attr = merge_image_attr(&p, &b.image_attr, &c.image_attr, &i.image_attr, r, x)?;
    }
    t!(href, "image-resource-reference");
    t!(border_opacity, "image-property");
    t!(instance_id, "image-identity");
    t!(raw_picture_extra, "opaque-picture-property");
    f!(effects, "image-effects");
    f!(caption, "caption");
    t!(img_dim, "image-property");
    t!(reverse, "image-property");
    t!(lock, "image-property");
    Ok(out)
}

fn merge_crop(
    path: &[String],
    b: &CropInfo,
    c: &CropInfo,
    i: &CropInfo,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<CropInfo, String> {
    let mut out = *c;
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(&p, "image-crop", &b.$field, &c.$field, &i.$field, r, x)?;
        }};
    }
    t!(left);
    t!(top);
    t!(right);
    t!(bottom);
    Ok(out)
}

fn merge_image_attr(
    path: &[String],
    b: &ImageAttr,
    c: &ImageAttr,
    i: &ImageAttr,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<ImageAttr, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($field:ident, $kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(&p, $kind, &b.$field, &c.$field, &i.$field, r, x)?;
        }};
    }
    t!(brightness, "image-property");
    t!(contrast, "image-property");
    {
        let mut p = path.to_vec();
        p.push("effect".into());
        out.effect = choose(
            &p,
            "image-effect",
            MergeConflictReason::SameFieldChanged,
            &b.effect,
            &c.effect,
            &i.effect,
            r,
            x,
        )?;
    }
    t!(bin_data_id, "image-resource-reference");
    t!(transparency, "image-property");
    t!(external_path, "image-resource-reference");
    Ok(out)
}
fn merge_equation(
    path: &[String],
    b: &Equation,
    c: &Equation,
    i: &Equation,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Equation, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose_typed(&p, $kind, &b.$name, &c.$name, &i.$name, r, x)?;
        }};
    }
    {
        let mut p = path.to_vec();
        p.push("common".into());
        out.common = merge_common(&p, &b.common, &c.common, &i.common, r, x)?;
    }
    t!(attr, "equation-property");
    t!(script, "formula");
    t!(font_size, "equation-formatting");
    t!(color, "equation-formatting");
    t!(baseline, "equation-formatting");
    t!(unknown, "opaque-equation-property");
    t!(eqedit, "equation-property");
    t!(version_info, "equation-property");
    t!(font_name, "equation-formatting");
    t!(raw_ctrl_data, "opaque-equation-property");
    Ok(out)
}
fn merge_form(
    path: &[String],
    b: &FormObject,
    c: &FormObject,
    i: &FormObject,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<FormObject, String> {
    let mut out = c.clone();
    macro_rules! f {
        ($name:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose(
                &p,
                "form-property",
                MergeConflictReason::SameFieldChanged,
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?;
        }};
    }
    macro_rules! t {
        ($name:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose_typed(&p, "form-property", &b.$name, &c.$name, &i.$name, r, x)?;
        }};
    }
    f!(form_type);
    t!(name);
    t!(caption);
    t!(text);
    t!(width);
    t!(height);
    t!(fore_color);
    t!(back_color);
    t!(value);
    t!(enabled);
    t!(properties);
    Ok(out)
}
fn merge_header(
    path: &[String],
    b: &Header,
    c: &Header,
    i: &Header,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Header, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(
                &p,
                "header-properties",
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    macro_rules! a {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose(
                &p,
                "header-properties",
                MergeConflictReason::SameFieldChanged,
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    a!(apply_to);
    t!(raw_attr);
    t!(raw_ctrl_extra);
    t!(list_attr);
    t!(text_width);
    t!(text_height);
    t!(text_ref);
    t!(num_ref);
    let mut p = path.to_vec();
    p.push("paragraphs".into());
    out.paragraphs = merge_paras(&p, &b.paragraphs, &c.paragraphs, &i.paragraphs, r, x)?;
    Ok(out)
}
fn merge_footer(
    path: &[String],
    b: &Footer,
    c: &Footer,
    i: &Footer,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Footer, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(
                &p,
                "footer-properties",
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    macro_rules! a {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose(
                &p,
                "footer-properties",
                MergeConflictReason::SameFieldChanged,
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    a!(apply_to);
    t!(raw_attr);
    t!(raw_ctrl_extra);
    t!(list_attr);
    t!(text_width);
    t!(text_height);
    t!(text_ref);
    t!(num_ref);
    let mut p = path.to_vec();
    p.push("paragraphs".into());
    out.paragraphs = merge_paras(&p, &b.paragraphs, &c.paragraphs, &i.paragraphs, r, x)?;
    Ok(out)
}
fn merge_footnote(
    path: &[String],
    b: &Footnote,
    c: &Footnote,
    i: &Footnote,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Footnote, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(
                &p,
                "footnote-properties",
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    t!(number);
    t!(before_decoration_letter);
    t!(after_decoration_letter);
    t!(number_shape);
    t!(instance_id);
    t!(list_header_property);
    let mut p = path.to_vec();
    p.push("paragraphs".into());
    out.paragraphs = merge_paras(&p, &b.paragraphs, &c.paragraphs, &i.paragraphs, r, x)?;
    Ok(out)
}
fn merge_endnote(
    path: &[String],
    b: &Endnote,
    c: &Endnote,
    i: &Endnote,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Endnote, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(
                &p,
                "endnote-properties",
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    t!(number);
    t!(before_decoration_letter);
    t!(after_decoration_letter);
    t!(number_shape);
    t!(instance_id);
    t!(list_header_property);
    let mut p = path.to_vec();
    p.push("paragraphs".into());
    out.paragraphs = merge_paras(&p, &b.paragraphs, &c.paragraphs, &i.paragraphs, r, x)?;
    Ok(out)
}
fn merge_control(
    path: &[String],
    b: &Control,
    c: &Control,
    i: &Control,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Control, String> {
    match (b, c, i) {
        (Control::SectionDef(b), Control::SectionDef(c), Control::SectionDef(i)) => Ok(
            Control::SectionDef(Box::new(merge_section_def(path, b, c, i, r, x)?)),
        ),
        (Control::ColumnDef(b), Control::ColumnDef(c), Control::ColumnDef(i)) => {
            let mut out = c.clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "column-settings", &b.$f, &c.$f, &i.$f, r, x)?;
                }};
            }
            macro_rules! a {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(stringify!($f).into());
                    out.$f = choose(
                        &p,
                        "column-settings",
                        MergeConflictReason::SameFieldChanged,
                        &b.$f,
                        &c.$f,
                        &i.$f,
                        r,
                        x,
                    )?;
                }};
            }
            a!(column_type);
            t!(column_count);
            a!(direction);
            t!(same_width);
            t!(spacing);
            t!(widths);
            t!(gaps);
            t!(proportional_widths);
            t!(separator_type);
            t!(separator_width);
            t!(separator_color);
            t!(raw_attr);
            Ok(Control::ColumnDef(out))
        }
        (Control::Table(b), Control::Table(c), Control::Table(i)) => {
            Ok(Control::Table(Box::new(merge_table(path, b, c, i, r, x)?)))
        }
        (Control::Picture(b), Control::Picture(c), Control::Picture(i)) => Ok(Control::Picture(
            Box::new(merge_picture(path, b, c, i, r, x)?),
        )),
        (Control::Shape(b), Control::Shape(c), Control::Shape(i)) => {
            Ok(Control::Shape(Box::new(merge_shape(path, b, c, i, r, x)?)))
        }
        (Control::Equation(b), Control::Equation(c), Control::Equation(i)) => Ok(
            Control::Equation(Box::new(merge_equation(path, b, c, i, r, x)?)),
        ),
        (Control::Form(b), Control::Form(c), Control::Form(i)) => {
            Ok(Control::Form(Box::new(merge_form(path, b, c, i, r, x)?)))
        }
        (Control::Bookmark(b), Control::Bookmark(c), Control::Bookmark(i)) => {
            let mut p = path.to_vec();
            p.push("name".into());
            Ok(Control::Bookmark(crate::model::control::Bookmark {
                name: choose_typed(&p, "bookmark", &b.name, &c.name, &i.name, r, x)?,
            }))
        }
        (Control::Hyperlink(b), Control::Hyperlink(c), Control::Hyperlink(i)) => {
            let mut out = c.clone();
            for (name, bv, cv, iv) in [
                ("url", &b.url, &c.url, &i.url),
                ("text", &b.text, &c.text, &i.text),
            ] {
                let mut p = path.to_vec();
                p.push(name.into());
                let v = choose_typed(&p, "hyperlink", bv, cv, iv, r, x)?;
                if name == "url" {
                    out.url = v
                } else {
                    out.text = v
                }
            }
            Ok(Control::Hyperlink(out))
        }
        (Control::Ruby(b), Control::Ruby(c), Control::Ruby(i)) => {
            let mut out = c.clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "ruby", &b.$f, &c.$f, &i.$f, r, x)?;
                }};
            }
            t!(main_text);
            t!(ruby_text);
            t!(pos_type);
            t!(align);
            t!(sz_ratio);
            t!(option);
            t!(style_id_ref);
            Ok(Control::Ruby(out))
        }
        (Control::CharOverlap(b), Control::CharOverlap(c), Control::CharOverlap(i)) => {
            let mut out = c.clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "character-overlap", &b.$f, &c.$f, &i.$f, r, x)?;
                }};
            }
            t!(chars);
            t!(border_type);
            t!(inner_char_size);
            t!(expansion);
            t!(char_shape_ids);
            Ok(Control::CharOverlap(out))
        }
        (Control::PageHide(b), Control::PageHide(c), Control::PageHide(i)) => {
            let mut out = c.clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "page-hide", &b.$f, &c.$f, &i.$f, r, x)?;
                }};
            }
            t!(hide_header);
            t!(hide_footer);
            t!(hide_master_page);
            t!(hide_border);
            t!(hide_fill);
            t!(hide_page_num);
            Ok(Control::PageHide(out))
        }
        (Control::NewNumber(b), Control::NewNumber(c), Control::NewNumber(i)) => {
            let mut out = c.clone();
            let mut p = path.to_vec();
            p.push("numberType".into());
            out.number_type = choose(
                &p,
                "numbering",
                MergeConflictReason::SameFieldChanged,
                &b.number_type,
                &c.number_type,
                &i.number_type,
                r,
                x,
            )?;
            p.pop();
            p.push("number".into());
            out.number = choose_typed(&p, "numbering", &b.number, &c.number, &i.number, r, x)?;
            Ok(Control::NewNumber(out))
        }
        (Control::AutoNumber(b), Control::AutoNumber(c), Control::AutoNumber(i)) => {
            let mut out = c.clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "numbering", &b.$f, &c.$f, &i.$f, r, x)?;
                }};
            }
            let mut p = path.to_vec();
            p.push("numberType".into());
            out.number_type = choose(
                &p,
                "numbering",
                MergeConflictReason::SameFieldChanged,
                &b.number_type,
                &c.number_type,
                &i.number_type,
                r,
                x,
            )?;
            t!(format);
            t!(superscript);
            t!(assigned_number);
            t!(number);
            t!(user_symbol);
            t!(prefix_char);
            t!(suffix_char);
            Ok(Control::AutoNumber(out))
        }
        (Control::PageNumberPos(b), Control::PageNumberPos(c), Control::PageNumberPos(i)) => {
            let mut out = c.clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "page-number", &b.$f, &c.$f, &i.$f, r, x)?;
                }};
            }
            t!(format);
            t!(position);
            t!(user_symbol);
            t!(prefix_char);
            t!(suffix_char);
            t!(dash_char);
            Ok(Control::PageNumberPos(out))
        }
        (Control::Header(b), Control::Header(c), Control::Header(i)) => Ok(Control::Header(
            Box::new(merge_header(path, b, c, i, r, x)?),
        )),
        (Control::Footer(b), Control::Footer(c), Control::Footer(i)) => Ok(Control::Footer(
            Box::new(merge_footer(path, b, c, i, r, x)?),
        )),
        (Control::Footnote(b), Control::Footnote(c), Control::Footnote(i)) => Ok(
            Control::Footnote(Box::new(merge_footnote(path, b, c, i, r, x)?)),
        ),
        (Control::Endnote(b), Control::Endnote(c), Control::Endnote(i)) => Ok(Control::Endnote(
            Box::new(merge_endnote(path, b, c, i, r, x)?),
        )),
        (Control::HiddenComment(b), Control::HiddenComment(c), Control::HiddenComment(i)) => {
            let mut p = path.to_vec();
            p.push("paragraphs".into());
            let paragraphs = merge_paras(&p, &b.paragraphs, &c.paragraphs, &i.paragraphs, r, x)?;
            Ok(Control::HiddenComment(Box::new(
                crate::model::control::HiddenComment { paragraphs },
            )))
        }
        (Control::Field(b), Control::Field(c), Control::Field(i)) => {
            let mut out = c.clone();
            macro_rules! t {
                ($field:ident) => {{
                    let mut fp = path.to_vec();
                    fp.push(stringify!($field).into());
                    out.$field = choose_typed(
                        &fp,
                        "field-properties",
                        &b.$field,
                        &c.$field,
                        &i.$field,
                        r,
                        x,
                    )?;
                }};
            }
            macro_rules! a {
                ($field:ident) => {{
                    let mut fp = path.to_vec();
                    fp.push(stringify!($field).into());
                    out.$field = choose(
                        &fp,
                        "field-properties",
                        MergeConflictReason::SameFieldChanged,
                        &b.$field,
                        &c.$field,
                        &i.$field,
                        r,
                        x,
                    )?;
                }};
            }
            a!(field_type);
            t!(command);
            t!(properties);
            t!(extra_properties);
            t!(field_id);
            t!(ctrl_id);
            t!(instance_id);
            t!(ctrl_data_name);
            t!(memo_index);
            t!(memo_text_direction);
            t!(raw_parameters_xml);
            let mut p = path.to_vec();
            p.push("memoParagraphs".into());
            out.memo_paragraphs = merge_paras(
                &p,
                &b.memo_paragraphs,
                &c.memo_paragraphs,
                &i.memo_paragraphs,
                r,
                x,
            )?;
            Ok(Control::Field(out))
        }
        _ => choose(
            path,
            "control",
            if matches!(b, Control::Unknown(_))
                || matches!(c, Control::Unknown(_))
                || matches!(i, Control::Unknown(_))
            {
                MergeConflictReason::UnknownControlModified
            } else {
                MergeConflictReason::SameFieldChanged
            },
            b,
            c,
            i,
            r,
            x,
        ),
    }
}
fn control_identity(control: &Control) -> Option<String> {
    let pair = |kind: &str, id: u32| (id != 0).then(|| format!("{kind}:{id}"));
    match control {
        Control::SectionDef(_) => Some("section-def".into()),
        Control::ColumnDef(_) => Some("column-def".into()),
        Control::Table(v) => pair("table", v.common.instance_id),
        Control::Shape(v) => pair("shape", v.common().instance_id),
        Control::Picture(v) => pair("picture", v.common.instance_id),
        Control::Equation(v) => pair("equation", v.common.instance_id),
        Control::Footnote(v) => pair("footnote", v.instance_id),
        Control::Endnote(v) => pair("endnote", v.instance_id),
        Control::Field(v) => pair("field", v.field_id),
        Control::Bookmark(v) if !v.name.is_empty() => Some(format!("bookmark:{}", v.name)),
        Control::Form(v) if !v.name.is_empty() => Some(format!("form:{}", v.name)),
        Control::Unknown(v) => pair("unknown", v.ctrl_id),
        _ => None,
    }
}
fn merge_shape(
    path: &[String],
    b: &ShapeObject,
    c: &ShapeObject,
    i: &ShapeObject,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<ShapeObject, String> {
    macro_rules! path_for {
        ($name:literal) => {{
            let mut p = path.to_vec();
            p.push($name.into());
            p
        }};
    }
    macro_rules! common_drawing {
        ($out:ident,$b:ident,$c:ident,$i:ident) => {{
            $out.common = merge_common(
                &path_for!("placement"),
                &$b.common,
                &$c.common,
                &$i.common,
                r,
                x,
            )?;
            $out.drawing = merge_drawing(
                &path_for!("drawing"),
                &$b.drawing,
                &$c.drawing,
                &$i.drawing,
                r,
                x,
            )?;
        }};
    }
    match (b, c, i) {
        (ShapeObject::Picture(b), ShapeObject::Picture(c), ShapeObject::Picture(i)) => Ok(
            ShapeObject::Picture(Box::new(merge_picture(path, b, c, i, r, x)?)),
        ),
        (ShapeObject::Chart(b), ShapeObject::Chart(c), ShapeObject::Chart(i)) => Ok(
            ShapeObject::Chart(Box::new(merge_chart(path, b, c, i, r, x)?)),
        ),
        (ShapeObject::Ole(b), ShapeObject::Ole(c), ShapeObject::Ole(i)) => {
            Ok(ShapeObject::Ole(Box::new(merge_ole(path, b, c, i, r, x)?)))
        }
        (ShapeObject::Line(b), ShapeObject::Line(c), ShapeObject::Line(i)) => {
            let mut out = c.clone();
            common_drawing!(out, b, c, i);
            out.start = merge_point(&path_for!("start"), &b.start, &c.start, &i.start, r, x)?;
            out.end = merge_point(&path_for!("end"), &b.end, &c.end, &i.end, r, x)?;
            out.started_right_or_bottom = choose_typed(
                &path_for!("startedRightOrBottom"),
                "connector-property",
                &b.started_right_or_bottom,
                &c.started_right_or_bottom,
                &i.started_right_or_bottom,
                r,
                x,
            )?;
            out.connector = choose(
                &path_for!("connector"),
                "connector-property",
                MergeConflictReason::SameFieldChanged,
                &b.connector,
                &c.connector,
                &i.connector,
                r,
                x,
            )?;
            Ok(ShapeObject::Line(out))
        }
        (ShapeObject::Rectangle(b), ShapeObject::Rectangle(c), ShapeObject::Rectangle(i)) => {
            let mut out = c.clone();
            common_drawing!(out, b, c, i);
            out.round_rate = choose_typed(
                &path_for!("roundRate"),
                "shape-property",
                &b.round_rate,
                &c.round_rate,
                &i.round_rate,
                r,
                x,
            )?;
            out.x_coords = choose_typed(
                &path_for!("xCoords"),
                "shape-geometry",
                &b.x_coords,
                &c.x_coords,
                &i.x_coords,
                r,
                x,
            )?;
            out.y_coords = choose_typed(
                &path_for!("yCoords"),
                "shape-geometry",
                &b.y_coords,
                &c.y_coords,
                &i.y_coords,
                r,
                x,
            )?;
            Ok(ShapeObject::Rectangle(out))
        }
        (ShapeObject::Ellipse(b), ShapeObject::Ellipse(c), ShapeObject::Ellipse(i)) => {
            let mut out = c.clone();
            common_drawing!(out, b, c, i);
            out.attr = choose_typed(
                &path_for!("attr"),
                "shape-property",
                &b.attr,
                &c.attr,
                &i.attr,
                r,
                x,
            )?;
            out.center = merge_point(&path_for!("center"), &b.center, &c.center, &i.center, r, x)?;
            out.axis1 = merge_point(&path_for!("axis1"), &b.axis1, &c.axis1, &i.axis1, r, x)?;
            out.axis2 = merge_point(&path_for!("axis2"), &b.axis2, &c.axis2, &i.axis2, r, x)?;
            out.start1 = merge_point(&path_for!("start1"), &b.start1, &c.start1, &i.start1, r, x)?;
            out.end1 = merge_point(&path_for!("end1"), &b.end1, &c.end1, &i.end1, r, x)?;
            out.start2 = merge_point(&path_for!("start2"), &b.start2, &c.start2, &i.start2, r, x)?;
            out.end2 = merge_point(&path_for!("end2"), &b.end2, &c.end2, &i.end2, r, x)?;
            Ok(ShapeObject::Ellipse(out))
        }
        (ShapeObject::Arc(b), ShapeObject::Arc(c), ShapeObject::Arc(i)) => {
            let mut out = c.clone();
            common_drawing!(out, b, c, i);
            out.arc_type = choose_typed(
                &path_for!("arcType"),
                "shape-property",
                &b.arc_type,
                &c.arc_type,
                &i.arc_type,
                r,
                x,
            )?;
            out.center = merge_point(&path_for!("center"), &b.center, &c.center, &i.center, r, x)?;
            out.axis1 = merge_point(&path_for!("axis1"), &b.axis1, &c.axis1, &i.axis1, r, x)?;
            out.axis2 = merge_point(&path_for!("axis2"), &b.axis2, &c.axis2, &i.axis2, r, x)?;
            Ok(ShapeObject::Arc(out))
        }
        (ShapeObject::Polygon(b), ShapeObject::Polygon(c), ShapeObject::Polygon(i)) => {
            let mut out = c.clone();
            common_drawing!(out, b, c, i);
            out.points = merge_points(&path_for!("points"), &b.points, &c.points, &i.points, r, x)?;
            out.raw_trailing = choose_typed(
                &path_for!("rawTrailing"),
                "opaque-shape-property",
                &b.raw_trailing,
                &c.raw_trailing,
                &i.raw_trailing,
                r,
                x,
            )?;
            Ok(ShapeObject::Polygon(out))
        }
        (ShapeObject::Curve(b), ShapeObject::Curve(c), ShapeObject::Curve(i)) => {
            let mut out = c.clone();
            common_drawing!(out, b, c, i);
            out.points = merge_points(&path_for!("points"), &b.points, &c.points, &i.points, r, x)?;
            out.segment_types = choose_typed(
                &path_for!("segmentTypes"),
                "shape-geometry",
                &b.segment_types,
                &c.segment_types,
                &i.segment_types,
                r,
                x,
            )?;
            Ok(ShapeObject::Curve(out))
        }
        (ShapeObject::Group(b), ShapeObject::Group(c), ShapeObject::Group(i)) => {
            let mut out = c.clone();
            out.common = merge_common(
                &path_for!("placement"),
                &b.common,
                &c.common,
                &i.common,
                r,
                x,
            )?;
            out.shape_attr = merge_shape_attr(
                &path_for!("shapeAttr"),
                &b.shape_attr,
                &c.shape_attr,
                &i.shape_attr,
                r,
                x,
            )?;
            out.caption = merge_caption_option(
                &path_for!("caption"),
                &b.caption,
                &c.caption,
                &i.caption,
                r,
                x,
            )?;
            let identity_order = |children: &[ShapeObject]| {
                let ids = children
                    .iter()
                    .map(|s| s.common().instance_id)
                    .collect::<Vec<_>>();
                (ids.iter().all(|id| *id != 0)
                    && ids.iter().copied().collect::<BTreeSet<_>>().len() == ids.len())
                .then_some(ids)
            };
            let orders = (
                identity_order(&b.children),
                identity_order(&c.children),
                identity_order(&i.children),
            );
            let order_safe = match &orders {
                (Some(bo), Some(co), Some(io)) => bo == co && bo == io,
                _ => {
                    b.children.len() == c.children.len()
                        && b.children.len() == i.children.len()
                        && (dh(&b.children) == dh(&c.children)
                            || dh(&b.children) == dh(&i.children))
                }
            };
            if order_safe
                && b.children.len() == c.children.len()
                && b.children.len() == i.children.len()
            {
                out.children.clear();
                for n in 0..b.children.len() {
                    let mut p = path_for!("children");
                    p.push(n.to_string());
                    out.children.push(merge_shape(
                        &p,
                        &b.children[n],
                        &c.children[n],
                        &i.children[n],
                        r,
                        x,
                    )?);
                }
            } else {
                let reason = match &orders {
                    (Some(bo), Some(co), Some(io))
                        if bo.iter().copied().collect::<BTreeSet<_>>()
                            == co.iter().copied().collect::<BTreeSet<_>>()
                            && bo.iter().copied().collect::<BTreeSet<_>>()
                                == io.iter().copied().collect::<BTreeSet<_>>() =>
                    {
                        MergeConflictReason::IncompatibleMove
                    }
                    _ => MergeConflictReason::LowConfidenceMatch,
                };
                out.children = choose(
                    &path_for!("children"),
                    "shape-group-structure",
                    reason,
                    &b.children,
                    &c.children,
                    &i.children,
                    r,
                    x,
                )?;
            }
            Ok(ShapeObject::Group(out))
        }
        _ => choose(
            path,
            "shape-type",
            MergeConflictReason::SameFieldChanged,
            b,
            c,
            i,
            r,
            x,
        ),
    }
}

fn merge_point(
    path: &[String],
    b: &Point,
    c: &Point,
    i: &Point,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Point, String> {
    let mut out = *c;
    for (name, bo, co, io) in [("x", b.x, c.x, i.x), ("y", b.y, c.y, i.y)] {
        let mut p = path.to_vec();
        p.push(name.into());
        let v = choose_typed(&p, "shape-geometry", &bo, &co, &io, r, x)?;
        if name == "x" {
            out.x = v
        } else {
            out.y = v
        }
    }
    Ok(out)
}
fn merge_points(
    path: &[String],
    b: &[Point],
    c: &[Point],
    i: &[Point],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<Point>, String> {
    if b.len() != c.len() || b.len() != i.len() {
        return choose(
            path,
            "shape-geometry",
            MergeConflictReason::SameFieldChanged,
            &b.to_vec(),
            &c.to_vec(),
            &i.to_vec(),
            r,
            x,
        );
    }
    (0..b.len())
        .map(|n| {
            let mut p = path.to_vec();
            p.push(n.to_string());
            merge_point(&p, &b[n], &c[n], &i[n], r, x)
        })
        .collect()
}
fn merge_shape_attr(
    path: &[String],
    b: &ShapeComponentAttr,
    c: &ShapeComponentAttr,
    i: &ShapeComponentAttr,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<ShapeComponentAttr, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field =
                choose_typed(&p, "shape-transform", &b.$field, &c.$field, &i.$field, r, x)?;
        }};
    }
    t!(ctrl_id);
    t!(is_two_ctrl_id);
    t!(offset_x);
    t!(offset_y);
    t!(group_level);
    t!(local_file_version);
    t!(original_width);
    t!(original_height);
    t!(current_width);
    t!(current_height);
    t!(current_width_was_zero);
    t!(current_height_was_zero);
    t!(flip);
    t!(horz_flip);
    t!(vert_flip);
    t!(rotation_angle);
    t!(rotate_image);
    out.rotation_center = merge_point(
        &[path.to_vec(), vec!["rotationCenter".into()]].concat(),
        &b.rotation_center,
        &c.rotation_center,
        &i.rotation_center,
        r,
        x,
    )?;
    t!(raw_rendering);
    t!(render_tx);
    t!(render_ty);
    t!(render_sx);
    t!(render_sy);
    t!(render_b);
    t!(render_c);
    Ok(out)
}
fn merge_text_box(
    path: &[String],
    b: &TextBox,
    c: &TextBox,
    i: &TextBox,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<TextBox, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(
                &p,
                "text-box-property",
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    macro_rules! a {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose(
                &p,
                "text-box-property",
                MergeConflictReason::SameFieldChanged,
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    t!(list_attr);
    t!(vertical_all);
    a!(vertical_align);
    t!(margin_left);
    t!(margin_right);
    t!(margin_top);
    t!(margin_bottom);
    t!(max_width);
    t!(raw_list_header_extra);
    out.paragraphs = merge_paras(
        &[path.to_vec(), vec!["paragraphs".into()]].concat(),
        &b.paragraphs,
        &c.paragraphs,
        &i.paragraphs,
        r,
        x,
    )?;
    Ok(out)
}
fn merge_caption(
    path: &[String],
    b: &Caption,
    c: &Caption,
    i: &Caption,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Caption, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(
                &p,
                "caption-property",
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    macro_rules! a {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose(
                &p,
                "caption-property",
                MergeConflictReason::SameFieldChanged,
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    a!(direction);
    a!(vert_align);
    t!(width);
    t!(spacing);
    t!(max_width);
    t!(include_margin);
    out.paragraphs = merge_paras(
        &[path.to_vec(), vec!["paragraphs".into()]].concat(),
        &b.paragraphs,
        &c.paragraphs,
        &i.paragraphs,
        r,
        x,
    )?;
    Ok(out)
}
fn merge_caption_option(
    path: &[String],
    b: &Option<Caption>,
    c: &Option<Caption>,
    i: &Option<Caption>,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Option<Caption>, String> {
    match (b, c, i) {
        (Some(b), Some(c), Some(i)) => Ok(Some(merge_caption(path, b, c, i, r, x)?)),
        _ => choose(
            path,
            "caption",
            MergeConflictReason::DeleteVersusEdit,
            b,
            c,
            i,
            r,
            x,
        ),
    }
}
fn merge_drawing(
    path: &[String],
    b: &DrawingObjAttr,
    c: &DrawingObjAttr,
    i: &DrawingObjAttr,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<DrawingObjAttr, String> {
    let mut out = c.clone();
    out.shape_attr = merge_shape_attr(
        &[path.to_vec(), vec!["shapeAttr".into()]].concat(),
        &b.shape_attr,
        &c.shape_attr,
        &i.shape_attr,
        r,
        x,
    )?;
    macro_rules! t {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(&p, "shape-style", &b.$field, &c.$field, &i.$field, r, x)?;
        }};
    }
    macro_rules! a {
        ($field:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose(
                &p,
                "shape-style",
                MergeConflictReason::SameFieldChanged,
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    a!(border_line);
    a!(fill);
    t!(shadow_type);
    t!(shadow_color);
    t!(shadow_offset_x);
    t!(shadow_offset_y);
    t!(inst_id);
    t!(shadow_alpha);
    out.text_box = match (&b.text_box, &c.text_box, &i.text_box) {
        (Some(b), Some(c), Some(i)) => Some(merge_text_box(
            &[path.to_vec(), vec!["textBox".into()]].concat(),
            b,
            c,
            i,
            r,
            x,
        )?),
        _ => choose(
            &[path.to_vec(), vec!["textBox".into()]].concat(),
            "text-box",
            MergeConflictReason::DeleteVersusEdit,
            &b.text_box,
            &c.text_box,
            &i.text_box,
            r,
            x,
        )?,
    };
    out.caption = merge_caption_option(
        &[path.to_vec(), vec!["caption".into()]].concat(),
        &b.caption,
        &c.caption,
        &i.caption,
        r,
        x,
    )?;
    Ok(out)
}
fn merge_chart(
    path: &[String],
    b: &ChartShape,
    c: &ChartShape,
    i: &ChartShape,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<ChartShape, String> {
    let mut out = c.clone();
    out.common = merge_common(
        &[path.to_vec(), vec!["placement".into()]].concat(),
        &b.common,
        &c.common,
        &i.common,
        r,
        x,
    )?;
    out.drawing = merge_drawing(
        &[path.to_vec(), vec!["drawing".into()]].concat(),
        &b.drawing,
        &c.drawing,
        &i.drawing,
        r,
        x,
    )?;
    macro_rules! t {
        ($field:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(&p, $kind, &b.$field, &c.$field, &i.$field, r, x)?;
        }};
    }
    macro_rules! a {
        ($field:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose(
                &p,
                $kind,
                MergeConflictReason::SameFieldChanged,
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    a!(chart_type, "chart-property");
    t!(title, "chart-property");
    out.legend = merge_legend_option(
        &[path.to_vec(), vec!["legend".into()]].concat(),
        &b.legend,
        &c.legend,
        &i.legend,
        r,
        x,
    )?;
    out.x_axis = merge_axis_option(
        &[path.to_vec(), vec!["xAxis".into()]].concat(),
        &b.x_axis,
        &c.x_axis,
        &i.x_axis,
        r,
        x,
    )?;
    out.y_axis = merge_axis_option(
        &[path.to_vec(), vec!["yAxis".into()]].concat(),
        &b.y_axis,
        &c.y_axis,
        &i.y_axis,
        r,
        x,
    )?;
    out.series = merge_chart_series(
        &[path.to_vec(), vec!["series".into()]].concat(),
        &b.series,
        &c.series,
        &i.series,
        r,
        x,
    )?;
    t!(raw_chart_data, "chart-data");
    out.caption = merge_caption_option(
        &[path.to_vec(), vec!["caption".into()]].concat(),
        &b.caption,
        &c.caption,
        &i.caption,
        r,
        x,
    )?;
    Ok(out)
}
fn merge_legend_option(
    path: &[String],
    b: &Option<Legend>,
    c: &Option<Legend>,
    i: &Option<Legend>,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Option<Legend>, String> {
    match (b, c, i) {
        (Some(b), Some(c), Some(i)) => {
            let mut out = c.clone();
            out.position = choose(
                &[path.to_vec(), vec!["position".into()]].concat(),
                "chart-legend",
                MergeConflictReason::SameFieldChanged,
                &b.position,
                &c.position,
                &i.position,
                r,
                x,
            )?;
            out.visible = choose_typed(
                &[path.to_vec(), vec!["visible".into()]].concat(),
                "chart-legend",
                &b.visible,
                &c.visible,
                &i.visible,
                r,
                x,
            )?;
            Ok(Some(out))
        }
        _ => choose(
            path,
            "chart-legend",
            MergeConflictReason::DeleteVersusEdit,
            b,
            c,
            i,
            r,
            x,
        ),
    }
}
fn merge_axis_option(
    path: &[String],
    b: &Option<Axis>,
    c: &Option<Axis>,
    i: &Option<Axis>,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Option<Axis>, String> {
    match (b, c, i) {
        (Some(b), Some(c), Some(i)) => {
            let mut out = c.clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "chart-axis", &b.$f, &c.$f, &i.$f, r, x)?;
                }};
            }
            t!(label);
            t!(labels);
            t!(min);
            t!(max);
            Ok(Some(out))
        }
        _ => choose(
            path,
            "chart-axis",
            MergeConflictReason::DeleteVersusEdit,
            b,
            c,
            i,
            r,
            x,
        ),
    }
}
fn merge_chart_series(
    path: &[String],
    b: &[DataSeries],
    c: &[DataSeries],
    i: &[DataSeries],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<DataSeries>, String> {
    if b.len() != c.len() || b.len() != i.len() {
        return choose(
            path,
            "chart-series",
            MergeConflictReason::SameFieldChanged,
            &b.to_vec(),
            &c.to_vec(),
            &i.to_vec(),
            r,
            x,
        );
    }
    (0..b.len())
        .map(|n| {
            let mut out = c[n].clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(n.to_string());
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "chart-series", &b[n].$f, &c[n].$f, &i[n].$f, r, x)?;
                }};
            }
            t!(name);
            t!(values);
            t!(categories);
            t!(color);
            Ok(out)
        })
        .collect()
}
fn merge_ole(
    path: &[String],
    b: &OleShape,
    c: &OleShape,
    i: &OleShape,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<OleShape, String> {
    let mut out = c.clone();
    out.common = merge_common(
        &[path.to_vec(), vec!["placement".into()]].concat(),
        &b.common,
        &c.common,
        &i.common,
        r,
        x,
    )?;
    out.drawing = merge_drawing(
        &[path.to_vec(), vec!["drawing".into()]].concat(),
        &b.drawing,
        &c.drawing,
        &i.drawing,
        r,
        x,
    )?;
    macro_rules! t {
        ($field:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose_typed(&p, $kind, &b.$field, &c.$field, &i.$field, r, x)?;
        }};
    }
    macro_rules! a {
        ($field:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($field).into());
            out.$field = choose(
                &p,
                $kind,
                MergeConflictReason::SameFieldChanged,
                &b.$field,
                &c.$field,
                &i.$field,
                r,
                x,
            )?;
        }};
    }
    t!(extent_x, "ole-property");
    t!(extent_y, "ole-property");
    t!(flags, "ole-property");
    a!(drawing_aspect, "ole-property");
    t!(bin_data_id, "ole-resource-reference");
    a!(preview, "ole-preview-bytes");
    t!(raw_tag_data, "opaque-ole-property");
    out.caption = merge_caption_option(
        &[path.to_vec(), vec!["caption".into()]].concat(),
        &b.caption,
        &c.caption,
        &i.caption,
        r,
        x,
    )?;
    Ok(out)
}
fn merge_common(
    path: &[String],
    b: &CommonObjAttr,
    c: &CommonObjAttr,
    i: &CommonObjAttr,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<CommonObjAttr, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($name:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose_typed(&p, "shape-placement", &b.$name, &c.$name, &i.$name, r, x)?;
        }};
    }
    macro_rules! a {
        ($name:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose(
                &p,
                "shape-placement",
                MergeConflictReason::SameFieldChanged,
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?;
        }};
    }
    t!(ctrl_id);
    t!(attr);
    t!(vertical_offset);
    t!(horizontal_offset);
    t!(width);
    t!(height);
    t!(z_order);
    a!(margin);
    t!(instance_id);
    t!(prevent_page_break);
    t!(treat_as_char);
    t!(flow_with_text);
    t!(allow_overlap);
    t!(affect_line_spacing);
    t!(hwp5_gen_shape_attr_bit26);
    t!(size_protect);
    t!(hwp5_gen_shape_attr_bit28);
    a!(vert_rel_to);
    a!(vert_align);
    a!(horz_rel_to);
    a!(horz_align);
    a!(text_wrap);
    a!(text_flow);
    a!(width_criterion);
    a!(height_criterion);
    t!(description);
    a!(numbering_type);
    a!(drop_cap_style);
    t!(raw_extra);
    t!(locked);
    Ok(out)
}
fn merge_char_shapes(
    path: &[String],
    b: &[CharShapeRef],
    c: &[CharShapeRef],
    i: &[CharShapeRef],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<CharShapeRef>, String> {
    fn map(v: &[CharShapeRef]) -> Result<BTreeMap<u32, &CharShapeRef>, String> {
        let mut m = BTreeMap::new();
        for item in v {
            if m.insert(item.start_pos, item).is_some() {
                return Err(format!(
                    "duplicate formatting interval at {}",
                    item.start_pos
                ));
            }
        }
        Ok(m)
    }
    let (bm, cm, im) = (map(b)?, map(c)?, map(i)?);
    let keys = bm
        .keys()
        .chain(cm.keys())
        .chain(im.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    let mut out = vec![];
    for start in keys {
        let mut p = path.to_vec();
        p.push(start.to_string());
        let value = match (bm.get(&start), cm.get(&start), im.get(&start)) {
            (Some(b), Some(c), Some(i)) => Some(CharShapeRef {
                start_pos: start,
                char_shape_id: choose_typed(
                    &[p.clone(), vec!["charShapeId".into()]].concat(),
                    "formatting",
                    &b.char_shape_id,
                    &c.char_shape_id,
                    &i.char_shape_id,
                    r,
                    x,
                )?,
            }),
            (Some(b), None, Some(i)) => choose(
                &p,
                "formatting-interval",
                MergeConflictReason::DeleteVersusEdit,
                &Some((*b).clone()),
                &None::<CharShapeRef>,
                &Some((*i).clone()),
                r,
                x,
            )?,
            (Some(b), Some(c), None) => choose(
                &p,
                "formatting-interval",
                MergeConflictReason::DeleteVersusEdit,
                &Some((*b).clone()),
                &Some((*c).clone()),
                &None::<CharShapeRef>,
                r,
                x,
            )?,
            (Some(_), None, None) => None,
            (None, Some(c), Some(i)) => {
                let id = choose_typed(
                    &[p.clone(), vec!["charShapeId".into()]].concat(),
                    "formatting",
                    &None::<u32>,
                    &Some(c.char_shape_id),
                    &Some(i.char_shape_id),
                    r,
                    x,
                )?;
                id.map(|char_shape_id| CharShapeRef {
                    start_pos: start,
                    char_shape_id,
                })
            }
            (None, Some(c), None) => Some((*c).clone()),
            (None, None, Some(i)) => Some((*i).clone()),
            _ => unreachable!(),
        };
        if let Some(value) = value {
            out.push(value)
        }
    }
    Ok(out)
}
fn merge_para(
    path: &[String],
    b: &Paragraph,
    c: &Paragraph,
    i: &Paragraph,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Paragraph, String> {
    let mut out = no_controls(c);
    macro_rules! pf {
        ($name:ident, $kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose(
                &p,
                $kind,
                MergeConflictReason::SameFieldChanged,
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?;
        }};
    }
    pf!(control_mask, "paragraph-property");
    pf!(para_shape_id, "formatting");
    pf!(style_id, "style");
    pf!(column_type, "paragraph-property");
    pf!(raw_break_type, "paragraph-property");
    {
        let mut p = path.to_vec();
        p.push("char_shapes".into());
        out.char_shapes =
            merge_char_shapes(&p, &b.char_shapes, &c.char_shapes, &i.char_shapes, r, x)?;
    }
    pf!(line_segs, "line-layout");
    pf!(range_tags, "range-tags");
    pf!(field_ranges, "fields");
    pf!(orphan_field_ends, "fields");
    pf!(char_count_msb, "paragraph-property");
    pf!(raw_header_extra, "paragraph-identity");
    pf!(has_para_text, "paragraph-property");
    pf!(tab_extended, "tab-properties");
    pf!(numbering_restart, "numbering");
    let mut text_path = path.to_vec();
    text_path.push("text".into());
    out.text = merge_text_field(&text_path, &b.text, &c.text, &i.text, r, x)?;
    let mut pp = path.to_vec();
    pp.push("controls".into());
    let identities = |values: &[Control]| {
        let ids = values
            .iter()
            .map(control_identity)
            .collect::<Option<Vec<_>>>()?;
        (ids.iter().cloned().collect::<BTreeSet<_>>().len() == ids.len()).then_some(ids)
    };
    if let (Some(bo), Some(co), Some(io)) = (
        identities(&b.controls),
        identities(&c.controls),
        identities(&i.controls),
    ) {
        let bm = bo
            .iter()
            .enumerate()
            .map(|(n, id)| (id.clone(), n))
            .collect::<BTreeMap<_, _>>();
        let cm = co
            .iter()
            .enumerate()
            .map(|(n, id)| (id.clone(), n))
            .collect::<BTreeMap<_, _>>();
        let im = io
            .iter()
            .enumerate()
            .map(|(n, id)| (id.clone(), n))
            .collect::<BTreeMap<_, _>>();
        let keys = bm
            .keys()
            .chain(cm.keys())
            .chain(im.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut merged = BTreeMap::new();
        for id in keys {
            let mut ip = pp.clone();
            ip.push(format!("@{id}"));
            let value = match (bm.get(&id), cm.get(&id), im.get(&id)) {
                (Some(bn), Some(cn), Some(in_)) => {
                    let control = merge_control(
                        &ip,
                        &b.controls[*bn],
                        &c.controls[*cn],
                        &i.controls[*in_],
                        r,
                        x,
                    )?;
                    let mut dp = ip.clone();
                    dp.push("ctrlData".into());
                    let data = choose(
                        &dp,
                        "opaque-control-data",
                        MergeConflictReason::UnknownControlModified,
                        &b.ctrl_data_records.get(*bn).cloned().flatten(),
                        &c.ctrl_data_records.get(*cn).cloned().flatten(),
                        &i.ctrl_data_records.get(*in_).cloned().flatten(),
                        r,
                        x,
                    )?;
                    Some((control, data))
                }
                (Some(bn), None, Some(in_)) => choose(
                    &ip,
                    "control",
                    MergeConflictReason::DeleteVersusEdit,
                    &Some((
                        b.controls[*bn].clone(),
                        b.ctrl_data_records.get(*bn).cloned().flatten(),
                    )),
                    &None,
                    &Some((
                        i.controls[*in_].clone(),
                        i.ctrl_data_records.get(*in_).cloned().flatten(),
                    )),
                    r,
                    x,
                )?,
                (Some(bn), Some(cn), None) => choose(
                    &ip,
                    "control",
                    MergeConflictReason::DeleteVersusEdit,
                    &Some((
                        b.controls[*bn].clone(),
                        b.ctrl_data_records.get(*bn).cloned().flatten(),
                    )),
                    &Some((
                        c.controls[*cn].clone(),
                        c.ctrl_data_records.get(*cn).cloned().flatten(),
                    )),
                    &None,
                    r,
                    x,
                )?,
                (Some(_), None, None) => None,
                (None, Some(cn), Some(in_)) => choose(
                    &ip,
                    "control",
                    MergeConflictReason::ConcurrentInsertion,
                    &None,
                    &Some((
                        c.controls[*cn].clone(),
                        c.ctrl_data_records.get(*cn).cloned().flatten(),
                    )),
                    &Some((
                        i.controls[*in_].clone(),
                        i.ctrl_data_records.get(*in_).cloned().flatten(),
                    )),
                    r,
                    x,
                )?,
                (None, Some(cn), None) => Some((
                    c.controls[*cn].clone(),
                    c.ctrl_data_records.get(*cn).cloned().flatten(),
                )),
                (None, None, Some(in_)) => Some((
                    i.controls[*in_].clone(),
                    i.ctrl_data_records.get(*in_).cloned().flatten(),
                )),
                _ => unreachable!(),
            };
            if let Some(value) = value {
                merged.insert(id, value);
            }
        }
        let alive = merged.keys().cloned().collect();
        match merged_order(&bo, &co, &io, &alive) {
            Ok(order) => {
                for id in order {
                    if let Some((control, data)) = merged.remove(&id) {
                        out.controls.push(control);
                        out.ctrl_data_records.push(data)
                    }
                }
                crate::document_core::queries::field_query::rebuild_char_offsets(&mut out);
                return Ok(out);
            }
            Err(_) => {
                let pair = choose(
                    &pp,
                    "control-sequence",
                    MergeConflictReason::IncompatibleMove,
                    &(b.controls.clone(), b.ctrl_data_records.clone()),
                    &(c.controls.clone(), c.ctrl_data_records.clone()),
                    &(i.controls.clone(), i.ctrl_data_records.clone()),
                    r,
                    x,
                )?;
                out.controls = pair.0;
                out.ctrl_data_records = pair.1;
                return Ok(out);
            }
        }
    }
    if b.controls.len() != c.controls.len()
        || b.controls.len() != i.controls.len()
        || b.ctrl_data_records.len() != c.ctrl_data_records.len()
        || b.ctrl_data_records.len() != i.ctrl_data_records.len()
    {
        if debug_prefix(&c.controls, &b.controls)
            && debug_prefix(&i.controls, &b.controls)
            && debug_prefix(&c.ctrl_data_records, &b.ctrl_data_records)
            && debug_prefix(&i.ctrl_data_records, &b.ctrl_data_records)
        {
            out.controls = b.controls.clone();
            out.controls
                .extend_from_slice(&c.controls[b.controls.len()..]);
            out.controls
                .extend_from_slice(&i.controls[b.controls.len()..]);
            out.ctrl_data_records = b.ctrl_data_records.clone();
            out.ctrl_data_records
                .extend_from_slice(&c.ctrl_data_records[b.ctrl_data_records.len()..]);
            out.ctrl_data_records
                .extend_from_slice(&i.ctrl_data_records[b.ctrl_data_records.len()..]);
            x.auto += out.controls.len().saturating_sub(b.controls.len());
            return Ok(out);
        }
        let pair = choose(
            &pp,
            "control-sequence",
            MergeConflictReason::LowConfidenceMatch,
            &(b.controls.clone(), b.ctrl_data_records.clone()),
            &(c.controls.clone(), c.ctrl_data_records.clone()),
            &(i.controls.clone(), i.ctrl_data_records.clone()),
            r,
            x,
        )?;
        out.controls = pair.0;
        out.ctrl_data_records = pair.1;
        return Ok(out);
    }
    for n in 0..b.controls.len() {
        let mut ip = pp.clone();
        ip.push(n.to_string());
        out.controls.push(merge_control(
            &ip,
            &b.controls[n],
            &c.controls[n],
            &i.controls[n],
            r,
            x,
        )?);
        ip.push("ctrlData".into());
        out.ctrl_data_records.push(choose(
            &ip,
            "opaque-control-data",
            MergeConflictReason::UnknownControlModified,
            &b.ctrl_data_records.get(n).cloned().flatten(),
            &c.ctrl_data_records.get(n).cloned().flatten(),
            &i.ctrl_data_records.get(n).cloned().flatten(),
            r,
            x,
        )?);
    }
    crate::document_core::queries::field_query::rebuild_char_offsets(&mut out);
    Ok(out)
}
fn merge_paras(
    path: &[String],
    b: &[Paragraph],
    c: &[Paragraph],
    i: &[Paragraph],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<Paragraph>, String> {
    fn pid(p: &Paragraph) -> Option<String> {
        let raw = p.raw_header_extra.get(6..10)?;
        let id = u32::from_le_bytes(raw.try_into().ok()?);
        (id != 0).then(|| id.to_string())
    }
    fn pm<'a>(v: &'a [Paragraph]) -> Option<(Vec<String>, BTreeMap<String, &'a Paragraph>)> {
        let mut o = vec![];
        let mut m = BTreeMap::new();
        for p in v {
            let id = pid(p)?;
            if m.insert(id.clone(), p).is_some() {
                return None;
            }
            o.push(id)
        }
        Some((o, m))
    }
    if dh(c) == dh(b) {
        x.auto += 1;
        return Ok(i.to_vec());
    }
    if dh(i) == dh(b) {
        x.auto += 1;
        return Ok(c.to_vec());
    }
    if let (Some((bo, bm)), Some((co, cm)), Some((io, im))) = (pm(b), pm(c), pm(i)) {
        let keys = bm
            .keys()
            .chain(cm.keys())
            .chain(im.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut merged = BTreeMap::new();
        for id in keys {
            let mut p = path.to_vec();
            p.push(format!("@{id}"));
            let value = match (bm.get(&id), cm.get(&id), im.get(&id)) {
                (Some(b), Some(c), Some(i)) => Some(merge_para(&p, b, c, i, r, x)?),
                (Some(b), None, Some(i)) => choose(
                    &p,
                    "paragraph",
                    MergeConflictReason::DeleteVersusEdit,
                    &Some((*b).clone()),
                    &None::<Paragraph>,
                    &Some((*i).clone()),
                    r,
                    x,
                )?,
                (Some(b), Some(c), None) => choose(
                    &p,
                    "paragraph",
                    MergeConflictReason::DeleteVersusEdit,
                    &Some((*b).clone()),
                    &Some((*c).clone()),
                    &None::<Paragraph>,
                    r,
                    x,
                )?,
                (Some(_), None, None) => None,
                (None, Some(c), Some(i)) => choose(
                    &p,
                    "paragraph",
                    MergeConflictReason::ConcurrentInsertion,
                    &None::<Paragraph>,
                    &Some((*c).clone()),
                    &Some((*i).clone()),
                    r,
                    x,
                )?,
                (None, Some(c), None) => Some((*c).clone()),
                (None, None, Some(i)) => Some((*i).clone()),
                _ => unreachable!(),
            };
            if let Some(value) = value {
                merged.insert(id, value);
            }
        }
        let alive = merged.keys().cloned().collect();
        if let Ok(order) = merged_order(&bo, &co, &io, &alive) {
            return Ok(order
                .into_iter()
                .filter_map(|id| merged.remove(&id))
                .collect());
        }
        return choose(
            path,
            "paragraph-sequence",
            MergeConflictReason::IncompatibleMove,
            &b.to_vec(),
            &c.to_vec(),
            &i.to_vec(),
            r,
            x,
        );
    }
    if b.len() != c.len() || b.len() != i.len() {
        return choose(
            path,
            "paragraph-sequence",
            MergeConflictReason::LowConfidenceMatch,
            &b.to_vec(),
            &c.to_vec(),
            &i.to_vec(),
            r,
            x,
        );
    }
    (0..b.len())
        .map(|n| {
            let mut p = path.to_vec();
            p.push(n.to_string());
            merge_para(&p, &b[n], &c[n], &i[n], r, x)
        })
        .collect()
}
fn merge_sections(
    b: &[Section],
    c: &[Section],
    i: &[Section],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<Section>, String> {
    let root = vec!["sections".into()];
    if dh(c) == dh(b) {
        x.auto += 1;
        return Ok(i.to_vec());
    }
    if dh(i) == dh(b) {
        x.auto += 1;
        return Ok(c.to_vec());
    }
    if b.len() != c.len() || b.len() != i.len() {
        if debug_prefix(c, b) && debug_prefix(i, b) {
            let mut out = b.to_vec();
            out.extend_from_slice(&c[b.len()..]);
            out.extend_from_slice(&i[b.len()..]);
            x.auto += out.len() - b.len();
            return Ok(out);
        }
        return choose(
            &root,
            "section-sequence",
            MergeConflictReason::LowConfidenceMatch,
            &b.to_vec(),
            &c.to_vec(),
            &i.to_vec(),
            r,
            x,
        );
    }
    let section_ids = |v: &[Section]| -> Option<Vec<String>> {
        let ids = v
            .iter()
            .map(|s| {
                s.paragraphs
                    .first()
                    .and_then(|p| p.raw_header_extra.get(6..10))
                    .and_then(|raw| {
                        let id = u32::from_le_bytes(raw.try_into().ok()?);
                        (id != 0).then(|| format!("section:{id:08x}"))
                    })
            })
            .collect::<Option<Vec<_>>>()?;
        (ids.iter().cloned().collect::<BTreeSet<_>>().len() == ids.len()).then_some(ids)
    };
    if let (Some(bo), Some(co), Some(io)) = (section_ids(b), section_ids(c), section_ids(i)) {
        let bs = bo.iter().cloned().collect::<BTreeSet<_>>();
        if bs == co.iter().cloned().collect()
            && bs == io.iter().cloned().collect()
            && (bo != co || bo != io)
        {
            return choose(
                &root,
                "section-sequence",
                MergeConflictReason::IncompatibleMove,
                &b.to_vec(),
                &c.to_vec(),
                &i.to_vec(),
                r,
                x,
            );
        }
    }
    (0..b.len())
        .map(|n| {
            let p = vec!["sections".into(), n.to_string()];
            let mut sp = p.clone();
            sp.push("settings".into());
            let section_def = merge_section_def(
                &sp,
                &b[n].section_def,
                &c[n].section_def,
                &i[n].section_def,
                r,
                x,
            )?;
            let mut pp = p;
            pp.push("paragraphs".into());
            let paragraphs = merge_paras(
                &pp,
                &b[n].paragraphs,
                &c[n].paragraphs,
                &i[n].paragraphs,
                r,
                x,
            )?;
            Ok(Section {
                section_def,
                paragraphs,
                raw_stream: None,
            })
        })
        .collect()
}
fn merge_section_def(
    path: &[String],
    b: &SectionDef,
    c: &SectionDef,
    i: &SectionDef,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<SectionDef, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose_typed(&p, $kind, &b.$name, &c.$name, &i.$name, r, x)?;
        }};
    }
    macro_rules! a {
        ($name:ident,$kind:literal) => {{
            let mut p = path.to_vec();
            p.push(stringify!($name).into());
            out.$name = choose(
                &p,
                $kind,
                MergeConflictReason::SameFieldChanged,
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?;
        }};
    }
    t!(flags, "section-property");
    t!(column_spacing, "column-settings");
    t!(line_grid, "section-property");
    t!(char_grid, "section-property");
    t!(default_tab_spacing, "section-property");
    t!(page_num, "numbering");
    t!(page_num_type, "numbering");
    t!(picture_num, "numbering");
    t!(table_num, "numbering");
    t!(equation_num, "numbering");
    out.page_def = merge_page_def(
        &[path.to_vec(), vec!["pageDef".into()]].concat(),
        &b.page_def,
        &c.page_def,
        &i.page_def,
        r,
        x,
    )?;
    out.footnote_shape = merge_note_shape(
        &[path.to_vec(), vec!["footnoteShape".into()]].concat(),
        &b.footnote_shape,
        &c.footnote_shape,
        &i.footnote_shape,
        r,
        x,
    )?;
    out.endnote_shape = merge_note_shape(
        &[path.to_vec(), vec!["endnoteShape".into()]].concat(),
        &b.endnote_shape,
        &c.endnote_shape,
        &i.endnote_shape,
        r,
        x,
    )?;
    out.page_border_fill = merge_page_border(
        &[path.to_vec(), vec!["pageBorderFill".into()]].concat(),
        &b.page_border_fill,
        &c.page_border_fill,
        &i.page_border_fill,
        r,
        x,
    )?;
    t!(hide_header, "section-property");
    t!(hide_footer, "section-property");
    t!(hide_master_page, "section-property");
    t!(hide_border, "section-property");
    t!(hide_fill, "section-property");
    t!(hide_empty_line, "section-property");
    t!(text_direction, "section-property");
    t!(outline_numbering_id, "numbering");
    t!(raw_ctrl_extra, "opaque-section-property");
    out.extra_page_border_fills = merge_page_borders(
        &[path.to_vec(), vec!["extraPageBorderFills".into()]].concat(),
        &b.extra_page_border_fills,
        &c.extra_page_border_fills,
        &i.extra_page_border_fills,
        r,
        x,
    )?;
    a!(extra_child_records, "opaque-section-property");
    out.master_pages = merge_master_pages(
        &[path.to_vec(), vec!["masterPages".into()]].concat(),
        &b.master_pages,
        &c.master_pages,
        &i.master_pages,
        r,
        x,
    )?;
    Ok(out)
}
fn merge_page_def(
    path: &[String],
    b: &PageDef,
    c: &PageDef,
    i: &PageDef,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<PageDef, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($f:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($f).into());
            out.$f = choose_typed(&p, "page-settings", &b.$f, &c.$f, &i.$f, r, x)?;
        }};
    }
    macro_rules! a {
        ($f:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($f).into());
            out.$f = choose(
                &p,
                "page-settings",
                MergeConflictReason::SameFieldChanged,
                &b.$f,
                &c.$f,
                &i.$f,
                r,
                x,
            )?;
        }};
    }
    t!(width);
    t!(height);
    t!(margin_left);
    t!(margin_right);
    t!(margin_top);
    t!(margin_bottom);
    t!(margin_header);
    t!(margin_footer);
    t!(margin_gutter);
    t!(pagination_bottom_tolerance);
    t!(attr);
    t!(landscape);
    a!(binding);
    Ok(out)
}
fn merge_page_border(
    path: &[String],
    b: &PageBorderFill,
    c: &PageBorderFill,
    i: &PageBorderFill,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<PageBorderFill, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($f:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($f).into());
            out.$f = choose_typed(&p, "page-settings", &b.$f, &c.$f, &i.$f, r, x)?;
        }};
    }
    macro_rules! a {
        ($f:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($f).into());
            out.$f = choose(
                &p,
                "page-settings",
                MergeConflictReason::SameFieldChanged,
                &b.$f,
                &c.$f,
                &i.$f,
                r,
                x,
            )?;
        }};
    }
    t!(attr);
    t!(spacing_left);
    t!(spacing_right);
    t!(spacing_top);
    t!(spacing_bottom);
    t!(border_fill_id);
    a!(basis);
    a!(ui_basis);
    Ok(out)
}
fn merge_page_borders(
    path: &[String],
    b: &[PageBorderFill],
    c: &[PageBorderFill],
    i: &[PageBorderFill],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<PageBorderFill>, String> {
    if b.len() != c.len() || b.len() != i.len() {
        return choose(
            path,
            "page-settings",
            MergeConflictReason::SameFieldChanged,
            &b.to_vec(),
            &c.to_vec(),
            &i.to_vec(),
            r,
            x,
        );
    }
    (0..b.len())
        .map(|n| {
            let mut p = path.to_vec();
            p.push(n.to_string());
            merge_page_border(&p, &b[n], &c[n], &i[n], r, x)
        })
        .collect()
}
fn merge_note_shape(
    path: &[String],
    b: &FootnoteShape,
    c: &FootnoteShape,
    i: &FootnoteShape,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<FootnoteShape, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($f:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($f).into());
            out.$f = choose_typed(&p, "note-settings", &b.$f, &c.$f, &i.$f, r, x)?;
        }};
    }
    macro_rules! a {
        ($f:ident) => {{
            let mut p = path.to_vec();
            p.push(stringify!($f).into());
            out.$f = choose(
                &p,
                "note-settings",
                MergeConflictReason::SameFieldChanged,
                &b.$f,
                &c.$f,
                &i.$f,
                r,
                x,
            )?;
        }};
    }
    t!(attr);
    a!(number_format);
    t!(user_char);
    t!(prefix_char);
    t!(suffix_char);
    t!(start_number);
    t!(separator_length);
    t!(separator_margin_top);
    t!(separator_margin_bottom);
    t!(note_spacing);
    t!(separator_line_type);
    t!(separator_line_width);
    t!(separator_color);
    a!(numbering);
    a!(placement);
    t!(number_code_superscript);
    t!(print_inline_after_text);
    t!(raw_unknown);
    Ok(out)
}
fn merge_master_pages(
    path: &[String],
    b: &[MasterPage],
    c: &[MasterPage],
    i: &[MasterPage],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<MasterPage>, String> {
    if b.len() != c.len() || b.len() != i.len() {
        return choose(
            path,
            "master-pages",
            MergeConflictReason::SameFieldChanged,
            &b.to_vec(),
            &c.to_vec(),
            &i.to_vec(),
            r,
            x,
        );
    }
    (0..b.len())
        .map(|n| {
            let mut out = c[n].clone();
            macro_rules! t {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(n.to_string());
                    p.push(stringify!($f).into());
                    out.$f = choose_typed(&p, "master-page", &b[n].$f, &c[n].$f, &i[n].$f, r, x)?;
                }};
            }
            macro_rules! a {
                ($f:ident) => {{
                    let mut p = path.to_vec();
                    p.push(n.to_string());
                    p.push(stringify!($f).into());
                    out.$f = choose(
                        &p,
                        "master-page",
                        MergeConflictReason::SameFieldChanged,
                        &b[n].$f,
                        &c[n].$f,
                        &i[n].$f,
                        r,
                        x,
                    )?;
                }};
            }
            a!(apply_to);
            t!(is_extension);
            t!(overlap);
            t!(replace_base);
            t!(ext_flags);
            t!(page_front);
            t!(text_width);
            t!(text_height);
            t!(text_ref);
            t!(num_ref);
            t!(text_direction);
            t!(hwpx_page_number);
            t!(raw_list_header);
            let mut p = path.to_vec();
            p.push(n.to_string());
            p.push("paragraphs".into());
            out.paragraphs = merge_paras(
                &p,
                &b[n].paragraphs,
                &c[n].paragraphs,
                &i[n].paragraphs,
                r,
                x,
            )?;
            Ok(out)
        })
        .collect()
}
fn summary(d: &Document) -> Value {
    json!({"kind":"document","sections":d.sections.iter().enumerate().map(|(s,x)|json!({"stableId":format!("section:{s}"),"kind":"section","paragraphs":x.paragraphs.iter().enumerate().map(|(p,x)|json!({"stableId":format!("paragraph:{s}:{p}"),"kind":"paragraph","text":x.text,"styleId":x.style_id,"paraShapeId":x.para_shape_id,"controlCount":x.controls.len()})).collect::<Vec<_>>() })).collect::<Vec<_>>(),"resourceCount":d.bin_data_content.len(),"styleCount":d.doc_info.styles.len()})
}

enum ResourcePayloadObservation {
    Stable(crate::model::bin_data::BinDataPayloadIdentity),
    OpaqueLazy {
        resolver: std::sync::Arc<dyn crate::model::bin_data::BinDataResolver>,
        key: String,
    },
}

impl ResourcePayloadObservation {
    fn from_bytes(bytes: &BinDataBytes) -> Self {
        if let Some(identity) = bytes.payload_identity() {
            return Self::Stable(identity);
        }
        match bytes {
            BinDataBytes::Lazy { resolver, key } => Self::OpaqueLazy {
                resolver: resolver.clone(),
                key: key.clone(),
            },
            BinDataBytes::Loaded(_) | BinDataBytes::Shared(_) => {
                unreachable!("in-memory BinData always has a payload identity")
            }
        }
    }

    fn equivalent(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Stable(left), Self::Stable(right)) => left == right,
            (
                Self::OpaqueLazy {
                    resolver: left_resolver,
                    key: left_key,
                },
                Self::OpaqueLazy {
                    resolver: right_resolver,
                    key: right_key,
                },
            ) => std::sync::Arc::ptr_eq(left_resolver, right_resolver) && left_key == right_key,
            _ => false,
        }
    }

    fn external_identity(&self) -> Option<String> {
        match self {
            Self::Stable(identity) => Some(identity.token()),
            Self::OpaqueLazy { .. } => None,
        }
    }
}

struct ResourceObservation<'a> {
    content: &'a BinDataContent,
    payload: ResourcePayloadObservation,
}

impl<'a> ResourceObservation<'a> {
    fn new(content: &'a BinDataContent) -> Self {
        Self {
            content,
            payload: ResourcePayloadObservation::from_bytes(&content.data),
        }
    }

    fn equivalent(&self, other: &Self) -> bool {
        self.content.id == other.content.id && self.payload_equivalent(other)
    }

    fn payload_equivalent(&self, other: &Self) -> bool {
        self.content.extension == other.content.extension && self.payload.equivalent(&other.payload)
    }

    fn value(&self) -> Value {
        json!({
            "kind": "image-bytes",
            "id": self.content.id,
            "extension": self.content.extension,
            "contentIdentity": self.payload.external_identity(),
        })
    }
}

fn resource_value(v: Option<&BinDataContent>) -> Value {
    match v {
        None => Value::Null,
        Some(v) => ResourceObservation::new(v).value(),
    }
}

fn resources_equal(left: Option<&BinDataContent>, right: Option<&BinDataContent>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            ResourceObservation::new(left).equivalent(&ResourceObservation::new(right))
        }
        (None, Some(_)) | (Some(_), None) => false,
    }
}
#[derive(Debug, Clone, Copy)]
struct TargetBinDataRef {
    slot: u16,
    storage_id: u16,
}

#[derive(Default)]
struct SourceBinDataRefMap {
    by_slot: BTreeMap<u16, TargetBinDataRef>,
    by_storage_id: BTreeMap<u16, TargetBinDataRef>,
}

#[derive(Default)]
struct BinDataRefRewrite {
    image: BTreeMap<u16, u16>,
    storage: BTreeMap<u16, u16>,
}

fn remap_u16_ref(value: &mut u16, remap: &BTreeMap<u16, u16>) -> bool {
    let Some(new) = remap.get(value).copied() else {
        return false;
    };
    if *value == new {
        return false;
    }
    *value = new;
    true
}

fn remap_fill_bin_data_ref(
    fill: &mut crate::model::style::Fill,
    remap: &BTreeMap<u16, u16>,
) -> bool {
    fill.image
        .as_mut()
        .is_some_and(|image| remap_u16_ref(&mut image.bin_data_id, remap))
}

fn remap_bin_data_refs_in_shape(shape: &mut ShapeObject, remap: &BinDataRefRewrite) -> bool {
    let mut changed = false;
    if let Some(d) = shape.drawing_mut() {
        changed |= remap_fill_bin_data_ref(&mut d.fill, &remap.image);
        if let Some(tb) = &mut d.text_box {
            changed |= remap_bin_data_refs_in_paragraphs(&mut tb.paragraphs, remap);
        }
        if let Some(c) = &mut d.caption {
            changed |= remap_bin_data_refs_in_paragraphs(&mut c.paragraphs, remap);
        }
    }
    match shape {
        ShapeObject::Picture(p) => {
            changed |= remap_u16_ref(&mut p.image_attr.bin_data_id, &remap.image);
            if let Some(c) = &mut p.caption {
                changed |= remap_bin_data_refs_in_paragraphs(&mut c.paragraphs, remap);
            }
        }
        ShapeObject::Group(g) => {
            if let Some(c) = &mut g.caption {
                changed |= remap_bin_data_refs_in_paragraphs(&mut c.paragraphs, remap);
            }
            for child in &mut g.children {
                changed |= remap_bin_data_refs_in_shape(child, remap);
            }
        }
        ShapeObject::Chart(v) => {
            if let Some(c) = &mut v.caption {
                changed |= remap_bin_data_refs_in_paragraphs(&mut c.paragraphs, remap);
            }
        }
        ShapeObject::Ole(v) => {
            if let Ok(old) = u16::try_from(v.bin_data_id) {
                if let Some(new) = remap.storage.get(&old).copied().filter(|new| *new != old) {
                    v.bin_data_id = u32::from(new);
                    changed = true;
                }
            }
            if changed {
                // HWP serialization otherwise emits the stale resource ID from
                // the preserved SHAPE_COMPONENT_OLE record verbatim.
                v.raw_tag_data.clear();
            }
            if let Some(c) = &mut v.caption {
                changed |= remap_bin_data_refs_in_paragraphs(&mut c.paragraphs, remap);
            }
        }
        _ => {}
    }
    changed
}
fn visit_nested_paragraphs_mut(paragraphs: &mut [Paragraph], f: &mut impl FnMut(&mut Paragraph)) {
    fn drawing(d: &mut DrawingObjAttr, f: &mut impl FnMut(&mut Paragraph)) {
        if let Some(tb) = &mut d.text_box {
            visit_nested_paragraphs_mut(&mut tb.paragraphs, f)
        }
        if let Some(c) = &mut d.caption {
            visit_nested_paragraphs_mut(&mut c.paragraphs, f)
        }
    }
    fn shape(s: &mut ShapeObject, f: &mut impl FnMut(&mut Paragraph)) {
        if let Some(d) = s.drawing_mut() {
            drawing(d, f)
        }
        match s {
            ShapeObject::Group(g) => {
                if let Some(c) = &mut g.caption {
                    visit_nested_paragraphs_mut(&mut c.paragraphs, f)
                }
                for child in &mut g.children {
                    shape(child, f)
                }
            }
            ShapeObject::Picture(p) => {
                if let Some(c) = &mut p.caption {
                    visit_nested_paragraphs_mut(&mut c.paragraphs, f)
                }
            }
            ShapeObject::Chart(v) => {
                if let Some(c) = &mut v.caption {
                    visit_nested_paragraphs_mut(&mut c.paragraphs, f)
                }
            }
            ShapeObject::Ole(v) => {
                if let Some(c) = &mut v.caption {
                    visit_nested_paragraphs_mut(&mut c.paragraphs, f)
                }
            }
            _ => {}
        }
    }
    for paragraph in paragraphs {
        f(paragraph);
        for control in &mut paragraph.controls {
            match control {
                Control::SectionDef(section_def) => {
                    for page in &mut section_def.master_pages {
                        visit_nested_paragraphs_mut(&mut page.paragraphs, f)
                    }
                }
                Control::Table(v) => {
                    for cell in &mut v.cells {
                        visit_nested_paragraphs_mut(&mut cell.paragraphs, f)
                    }
                    if let Some(c) = &mut v.caption {
                        visit_nested_paragraphs_mut(&mut c.paragraphs, f)
                    }
                }
                Control::Shape(v) => shape(v, f),
                Control::Picture(v) => {
                    if let Some(c) = &mut v.caption {
                        visit_nested_paragraphs_mut(&mut c.paragraphs, f)
                    }
                }
                Control::Header(v) => visit_nested_paragraphs_mut(&mut v.paragraphs, f),
                Control::Footer(v) => visit_nested_paragraphs_mut(&mut v.paragraphs, f),
                Control::Footnote(v) => visit_nested_paragraphs_mut(&mut v.paragraphs, f),
                Control::Endnote(v) => visit_nested_paragraphs_mut(&mut v.paragraphs, f),
                Control::HiddenComment(v) => visit_nested_paragraphs_mut(&mut v.paragraphs, f),
                Control::Field(v) => visit_nested_paragraphs_mut(&mut v.memo_paragraphs, f),
                _ => {}
            }
        }
    }
}
fn any_nested_paragraph(
    paragraphs: &[Paragraph],
    predicate: &mut impl FnMut(&Paragraph) -> bool,
) -> bool {
    fn drawing(drawing: &DrawingObjAttr, predicate: &mut impl FnMut(&Paragraph) -> bool) -> bool {
        drawing
            .text_box
            .as_ref()
            .is_some_and(|text_box| any_nested_paragraph(&text_box.paragraphs, predicate))
            || drawing
                .caption
                .as_ref()
                .is_some_and(|caption| any_nested_paragraph(&caption.paragraphs, predicate))
    }
    fn shape_matches(shape: &ShapeObject, predicate: &mut impl FnMut(&Paragraph) -> bool) -> bool {
        if shape
            .drawing()
            .is_some_and(|value| drawing(value, predicate))
        {
            return true;
        }
        match shape {
            ShapeObject::Group(group) => {
                group
                    .caption
                    .as_ref()
                    .is_some_and(|caption| any_nested_paragraph(&caption.paragraphs, predicate))
                    || group
                        .children
                        .iter()
                        .any(|child| shape_matches(child, predicate))
            }
            ShapeObject::Picture(picture) => picture
                .caption
                .as_ref()
                .is_some_and(|caption| any_nested_paragraph(&caption.paragraphs, predicate)),
            ShapeObject::Chart(chart) => chart
                .caption
                .as_ref()
                .is_some_and(|caption| any_nested_paragraph(&caption.paragraphs, predicate)),
            ShapeObject::Ole(ole) => ole
                .caption
                .as_ref()
                .is_some_and(|caption| any_nested_paragraph(&caption.paragraphs, predicate)),
            _ => false,
        }
    }

    paragraphs.iter().any(|paragraph| {
        predicate(paragraph)
            || paragraph.controls.iter().any(|control| match control {
                Control::SectionDef(section_def) => section_def
                    .master_pages
                    .iter()
                    .any(|page| any_nested_paragraph(&page.paragraphs, predicate)),
                Control::Table(table) => {
                    table
                        .cells
                        .iter()
                        .any(|cell| any_nested_paragraph(&cell.paragraphs, predicate))
                        || table.caption.as_ref().is_some_and(|caption| {
                            any_nested_paragraph(&caption.paragraphs, predicate)
                        })
                }
                Control::Shape(value) => shape_matches(value, predicate),
                Control::Picture(value) => value
                    .caption
                    .as_ref()
                    .is_some_and(|caption| any_nested_paragraph(&caption.paragraphs, predicate)),
                Control::Header(value) => any_nested_paragraph(&value.paragraphs, predicate),
                Control::Footer(value) => any_nested_paragraph(&value.paragraphs, predicate),
                Control::Footnote(value) => any_nested_paragraph(&value.paragraphs, predicate),
                Control::Endnote(value) => any_nested_paragraph(&value.paragraphs, predicate),
                Control::HiddenComment(value) => any_nested_paragraph(&value.paragraphs, predicate),
                Control::Field(value) => any_nested_paragraph(&value.memo_paragraphs, predicate),
                _ => false,
            })
    })
}

fn remap_bin_data_refs_in_paragraphs(
    paragraphs: &mut [Paragraph],
    remap: &BinDataRefRewrite,
) -> bool {
    let mut changed = false;
    for paragraph in paragraphs {
        for control in &mut paragraph.controls {
            match control {
                Control::SectionDef(section_def) => {
                    for page in &mut section_def.master_pages {
                        changed |= remap_bin_data_refs_in_paragraphs(&mut page.paragraphs, remap);
                    }
                }
                Control::Picture(p) => {
                    changed |= remap_u16_ref(&mut p.image_attr.bin_data_id, &remap.image);
                    if let Some(c) = &mut p.caption {
                        changed |= remap_bin_data_refs_in_paragraphs(&mut c.paragraphs, remap);
                    }
                }
                Control::Shape(s) => changed |= remap_bin_data_refs_in_shape(s, remap),
                Control::Table(t) => {
                    for cell in &mut t.cells {
                        changed |= remap_bin_data_refs_in_paragraphs(&mut cell.paragraphs, remap);
                    }
                    if let Some(c) = &mut t.caption {
                        changed |= remap_bin_data_refs_in_paragraphs(&mut c.paragraphs, remap);
                    }
                }
                Control::Header(h) => {
                    changed |= remap_bin_data_refs_in_paragraphs(&mut h.paragraphs, remap)
                }
                Control::Footer(f) => {
                    changed |= remap_bin_data_refs_in_paragraphs(&mut f.paragraphs, remap)
                }
                Control::Footnote(f) => {
                    changed |= remap_bin_data_refs_in_paragraphs(&mut f.paragraphs, remap)
                }
                Control::Endnote(e) => {
                    changed |= remap_bin_data_refs_in_paragraphs(&mut e.paragraphs, remap)
                }
                Control::HiddenComment(h) => {
                    changed |= remap_bin_data_refs_in_paragraphs(&mut h.paragraphs, remap)
                }
                Control::Field(f) => {
                    changed |= remap_bin_data_refs_in_paragraphs(&mut f.memo_paragraphs, remap)
                }
                _ => {}
            }
        }
    }
    changed
}

fn fill_needs_bin_data_remap(fill: &crate::model::style::Fill, remap: &BTreeMap<u16, u16>) -> bool {
    fill.image.as_ref().is_some_and(|image| {
        remap
            .get(&image.bin_data_id)
            .is_some_and(|new| *new != image.bin_data_id)
    })
}

fn shape_needs_bin_data_remap(shape: &ShapeObject, remap: &BinDataRefRewrite) -> bool {
    shape.drawing().is_some_and(|drawing| {
        fill_needs_bin_data_remap(&drawing.fill, &remap.image)
            || drawing
                .text_box
                .as_ref()
                .is_some_and(|text_box| paragraphs_need_bin_data_remap(&text_box.paragraphs, remap))
            || drawing
                .caption
                .as_ref()
                .is_some_and(|caption| paragraphs_need_bin_data_remap(&caption.paragraphs, remap))
    }) || match shape {
        ShapeObject::Picture(picture) => {
            remap
                .image
                .get(&picture.image_attr.bin_data_id)
                .is_some_and(|new| *new != picture.image_attr.bin_data_id)
                || picture.caption.as_ref().is_some_and(|caption| {
                    paragraphs_need_bin_data_remap(&caption.paragraphs, remap)
                })
        }
        ShapeObject::Group(group) => {
            group
                .caption
                .as_ref()
                .is_some_and(|caption| paragraphs_need_bin_data_remap(&caption.paragraphs, remap))
                || group
                    .children
                    .iter()
                    .any(|child| shape_needs_bin_data_remap(child, remap))
        }
        ShapeObject::Ole(ole) => {
            u16::try_from(ole.bin_data_id)
                .ok()
                .is_some_and(|id| remap.storage.get(&id).is_some_and(|new| *new != id))
                || ole.caption.as_ref().is_some_and(|caption| {
                    paragraphs_need_bin_data_remap(&caption.paragraphs, remap)
                })
        }
        ShapeObject::Chart(chart) => chart
            .caption
            .as_ref()
            .is_some_and(|caption| paragraphs_need_bin_data_remap(&caption.paragraphs, remap)),
        _ => false,
    }
}

fn paragraphs_need_bin_data_remap(paragraphs: &[Paragraph], remap: &BinDataRefRewrite) -> bool {
    paragraphs.iter().any(|paragraph| {
        paragraph.controls.iter().any(|control| match control {
            Control::SectionDef(section_def) => section_def
                .master_pages
                .iter()
                .any(|page| paragraphs_need_bin_data_remap(&page.paragraphs, remap)),
            Control::Picture(picture) => {
                remap
                    .image
                    .get(&picture.image_attr.bin_data_id)
                    .is_some_and(|new| *new != picture.image_attr.bin_data_id)
                    || picture.caption.as_ref().is_some_and(|caption| {
                        paragraphs_need_bin_data_remap(&caption.paragraphs, remap)
                    })
            }
            Control::Shape(shape) => shape_needs_bin_data_remap(shape, remap),
            Control::Table(table) => {
                table
                    .cells
                    .iter()
                    .any(|cell| paragraphs_need_bin_data_remap(&cell.paragraphs, remap))
                    || table.caption.as_ref().is_some_and(|caption| {
                        paragraphs_need_bin_data_remap(&caption.paragraphs, remap)
                    })
            }
            Control::Header(value) => paragraphs_need_bin_data_remap(&value.paragraphs, remap),
            Control::Footer(value) => paragraphs_need_bin_data_remap(&value.paragraphs, remap),
            Control::Footnote(value) => paragraphs_need_bin_data_remap(&value.paragraphs, remap),
            Control::Endnote(value) => paragraphs_need_bin_data_remap(&value.paragraphs, remap),
            Control::HiddenComment(value) => {
                paragraphs_need_bin_data_remap(&value.paragraphs, remap)
            }
            Control::Field(value) => paragraphs_need_bin_data_remap(&value.memo_paragraphs, remap),
            _ => false,
        })
    })
}

fn sections_need_bin_data_remap(sections: &[Section], remap: &BinDataRefRewrite) -> bool {
    sections.iter().any(|section| {
        paragraphs_need_bin_data_remap(&section.paragraphs, remap)
            || section
                .section_def
                .master_pages
                .iter()
                .any(|page| paragraphs_need_bin_data_remap(&page.paragraphs, remap))
    })
}

fn doc_info_needs_bin_data_remap(doc_info: &DocInfo, remap: &BinDataRefRewrite) -> bool {
    doc_info
        .border_fills
        .iter()
        .any(|border_fill| fill_needs_bin_data_remap(&border_fill.fill, &remap.image))
        || doc_info.bullets.iter().any(|bullet| {
            u16::try_from(bullet.image_bullet)
                .ok()
                .is_some_and(|id| remap.image.get(&id).is_some_and(|new| *new != id))
        })
        || doc_info.font_faces.iter().flatten().any(|font| {
            font.resolved_bin_data_id
                .is_some_and(|id| remap.storage.get(&id).is_some_and(|new| *new != id))
                || font.subst_font.as_ref().is_some_and(|substitute| {
                    substitute
                        .resolved_bin_data_id
                        .is_some_and(|id| remap.storage.get(&id).is_some_and(|new| *new != id))
                })
        })
}

fn exact_binary_item_numeric_id(value: &str) -> Option<u16> {
    let digits = value
        .strip_prefix("image")
        .or_else(|| value.strip_prefix("ole"))
        .or_else(|| {
            value
                .bytes()
                .all(|byte| byte.is_ascii_digit())
                .then_some(value)
        })?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| digits.parse::<u16>().ok())
        .flatten()
}

fn remap_raw_binary_item_refs<'a>(
    raw: &'a str,
    remap: &BTreeMap<u16, u16>,
) -> Result<(Cow<'a, str>, bool), String> {
    remap_raw_binary_item_refs_limited(raw, remap, crate::parser::limits::MAX_STRUCTURAL_BYTES)
}

fn remap_raw_binary_item_refs_limited<'a>(
    raw: &'a str,
    remap: &BTreeMap<u16, u16>,
    max_bytes: usize,
) -> Result<(Cow<'a, str>, bool), String> {
    if raw.len() > max_bytes {
        return Err(format!(
            "raw HWPX XML exceeds structural byte limit: {} > {max_bytes}",
            raw.len()
        ));
    }

    let mut scanner = ExactXmlAttributeScanner::new(raw);
    let mut projected_len = raw.len();
    let mut matched = false;
    let mut changed = false;
    while let Some((value_start, value_end)) = scanner.next_value("binaryItemIDRef") {
        let Some(new) = exact_binary_item_numeric_id(&raw[value_start..value_end])
            .and_then(|old| remap.get(&old))
            .copied()
        else {
            continue;
        };
        matched = true;
        let mut replacement_buffer = [0u8; 10];
        let replacement = image_ref_u16_ascii(new, &mut replacement_buffer);
        let original = &raw[value_start..value_end];
        if replacement != original {
            changed = true;
            projected_len = projected_len
                .checked_sub(original.len())
                .and_then(|length| length.checked_add(replacement.len()))
                .ok_or_else(|| "raw HWPX BinData reference size overflow".to_string())?;
        }
    }
    if !changed {
        return Ok((Cow::Borrowed(raw), matched));
    }
    if projected_len > max_bytes {
        return Err(format!(
            "rewritten raw HWPX XML exceeds structural byte limit: {projected_len} > {max_bytes}"
        ));
    }

    let mut output = String::new();
    output
        .try_reserve_exact(projected_len)
        .map_err(|error| format!("raw HWPX BinData reference allocation failed: {error}"))?;
    let mut copied = 0usize;
    let mut scanner = ExactXmlAttributeScanner::new(raw);
    while let Some((value_start, value_end)) = scanner.next_value("binaryItemIDRef") {
        let Some(new) = exact_binary_item_numeric_id(&raw[value_start..value_end])
            .and_then(|old| remap.get(&old))
            .copied()
        else {
            continue;
        };
        let mut replacement_buffer = [0u8; 10];
        let replacement = image_ref_u16_ascii(new, &mut replacement_buffer);
        if replacement != &raw[value_start..value_end] {
            output.push_str(&raw[copied..value_start]);
            output.push_str(replacement);
            copied = value_end;
        }
    }
    output.push_str(&raw[copied..]);
    debug_assert_eq!(output.len(), projected_len);
    Ok((Cow::Owned(output), matched))
}

fn regenerated_image_bullet_para_head(bullet: &crate::model::style::Bullet) -> String {
    format!(
        concat!(
            r#"<hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" "#,
            r#"widthAdjust="{}" textOffsetType="PERCENT" textOffset="{}" "#,
            r#"numFormat="DIGIT" charPrIDRef="{}" checkable="{}"/>"#,
            r#"<hh:img binaryItemIDRef="image{}"/>"#
        ),
        bullet.width_adjust,
        bullet.text_distance,
        bullet.char_shape_id,
        u8::from(bullet.check_bullet_char != '\0'),
        bullet.image_bullet,
    )
}

fn remap_doc_info_bin_data_refs(
    doc_info: &mut DocInfo,
    remap: &BinDataRefRewrite,
) -> Result<bool, String> {
    let mut changed = false;
    for border_fill in &mut doc_info.border_fills {
        if remap_fill_bin_data_ref(&mut border_fill.fill, &remap.image) {
            // HWP DocInfo prefers raw records when present, so the structured
            // remap must invalidate the stale record bytes.
            border_fill.raw_data = None;
            changed = true;
        }
    }
    for bullet in &mut doc_info.bullets {
        if let Ok(old) = u16::try_from(bullet.image_bullet) {
            let Some(new) = remap.image.get(&old).copied().filter(|new| *new != old) else {
                continue;
            };
            bullet.image_bullet = i32::from(new);
            bullet.raw_data = None;
            bullet.raw_para_head = if let Some(raw) = bullet.raw_para_head.take() {
                let (rewritten, found) = remap_raw_binary_item_refs(&raw, &remap.image)?;
                // Parsed HWPX image bullets carry the exact <hh:img> reference
                // in this splice. Retain its otherwise-unmodelled attributes
                // only when that stale resource reference was rewritten.
                found.then(|| rewritten.into_owned())
            } else {
                None
            };
            if bullet.raw_para_head.is_none() {
                // HWPX's fallback serializer emits only paraHead, so regenerate
                // the image element when no trustworthy splice remains.
                bullet.raw_para_head = Some(regenerated_image_bullet_para_head(bullet));
            }
            changed = true;
        }
    }
    for font in doc_info.font_faces.iter_mut().flatten() {
        let mut font_changed = false;
        if let Some(id) = &mut font.resolved_bin_data_id {
            font_changed |= remap_u16_ref(id, &remap.storage);
        }
        if let Some(substitute) = font.subst_font.as_mut() {
            if let Some(id) = &mut substitute.resolved_bin_data_id {
                font_changed |= remap_u16_ref(id, &remap.storage);
            }
        }
        if font_changed {
            font.raw_data = None;
            changed = true;
        }
        // bin_item_id_ref is package provenance, not the canonical IR link.
        // HWPX serialization derives a fresh manifest reference from the
        // resolved ID and only falls back to this string when unresolved.
    }
    if changed {
        doc_info.raw_stream_dirty = true;
    }
    Ok(changed)
}

#[derive(Debug, Clone, Copy)]
enum FinalBinDataOrigin {
    Base(usize),
    CurrentAppend(usize),
    IncomingAppend(usize),
}

#[derive(Debug, Clone, Copy)]
struct FinalBinDataDeclaration {
    slot: u16,
    storage_id: u16,
    origin: FinalBinDataOrigin,
}

struct BinDataMergePlan {
    declarations: Vec<FinalBinDataDeclaration>,
    current_refs: BinDataRefRewrite,
    incoming_refs: BinDataRefRewrite,
    current_map: SourceBinDataRefMap,
    incoming_map: SourceBinDataRefMap,
    base_map: SourceBinDataRefMap,
    incoming_chart_ids: BTreeMap<u16, u16>,
}

fn insert_source_bin_data_mapping(
    map: &mut SourceBinDataRefMap,
    source_slot: u16,
    source_storage_id: u16,
    target: TargetBinDataRef,
) -> Result<(), String> {
    map.by_slot.insert(source_slot, target);
    if source_storage_id != 0 {
        if let Some(previous) = map.by_storage_id.insert(source_storage_id, target) {
            if previous.slot != target.slot {
                return Err(format!(
                    "duplicate BinData declaration storage id {source_storage_id}"
                ));
            }
        }
    }
    Ok(())
}

fn allocate_bin_data_storage_id(
    used: &mut BTreeSet<u16>,
    reserved: &BTreeSet<u16>,
) -> Result<u16, String> {
    let after_max = used
        .iter()
        .chain(reserved.iter())
        .next_back()
        .copied()
        .unwrap_or(0)
        .saturating_add(1);
    let candidate = (after_max..=u16::MAX)
        .chain(1..after_max)
        .find(|candidate| {
            *candidate != 0 && !used.contains(candidate) && !reserved.contains(candidate)
        })
        .ok_or_else(|| "no free nonzero BinData storage id remains".to_string())?;
    used.insert(candidate);
    Ok(candidate)
}

fn source_image_ref_map(
    source: &Document,
    target_format: crate::model::provenance::SourceFormat,
    source_map: &SourceBinDataRefMap,
) -> BTreeMap<u16, u16> {
    use crate::model::provenance::SourceFormat;
    let source_refs = match source.provenance.format {
        SourceFormat::Hwp5 | SourceFormat::Hwp3 => &source_map.by_slot,
        SourceFormat::Hwpx | SourceFormat::Hml => &source_map.by_storage_id,
    };
    source_refs
        .iter()
        .filter_map(|(old, target)| {
            let new = match target_format {
                SourceFormat::Hwp5 | SourceFormat::Hwp3 => target.slot,
                SourceFormat::Hwpx | SourceFormat::Hml => target.storage_id,
            };
            (*old != new).then_some((*old, new))
        })
        .collect()
}

fn source_storage_ref_map(source_map: &SourceBinDataRefMap) -> BTreeMap<u16, u16> {
    source_map
        .by_storage_id
        .iter()
        .filter_map(|(old, target)| {
            (*old != target.storage_id).then_some((*old, target.storage_id))
        })
        .collect()
}

fn prepare_bin_data_merge(
    base: &Document,
    current: &Document,
    incoming: &Document,
    target_format: crate::model::provenance::SourceFormat,
) -> Result<BinDataMergePlan, String> {
    let base_len = base.doc_info.bin_data_list.len();
    if current.doc_info.bin_data_list.len() < base_len
        || incoming.doc_info.bin_data_list.len() < base_len
    {
        return Err("BinData declaration deletion cannot be merged positionally".to_string());
    }
    let final_len = current
        .doc_info
        .bin_data_list
        .len()
        .checked_add(incoming.doc_info.bin_data_list.len() - base_len)
        .ok_or_else(|| "BinData declaration count overflow".to_string())?;
    if final_len > usize::from(u16::MAX) {
        return Err(format!(
            "merged BinData declaration count {final_len} exceeds {}",
            u16::MAX
        ));
    }

    let mut reserved = current
        .doc_info
        .bin_data_list
        .iter()
        .chain(incoming.doc_info.bin_data_list.iter())
        .map(|declaration| declaration.storage_id)
        .chain(current.bin_data_content.iter().map(|content| content.id))
        .chain(incoming.bin_data_content.iter().map(|content| content.id))
        .filter(|id| *id != 0)
        .collect::<BTreeSet<_>>();
    let mut used = BTreeSet::new();
    let mut declarations = Vec::with_capacity(final_len);
    let mut base_map = SourceBinDataRefMap::default();
    let mut current_map = SourceBinDataRefMap::default();
    let mut incoming_map = SourceBinDataRefMap::default();

    let mut add_current_declaration = |source_index: usize,
                                       origin: FinalBinDataOrigin,
                                       declarations: &mut Vec<FinalBinDataDeclaration>,
                                       used: &mut BTreeSet<u16>,
                                       reserved: &mut BTreeSet<u16>,
                                       base_mapping: Option<(u16, u16)>|
     -> Result<(), String> {
        let declaration = &current.doc_info.bin_data_list[source_index];
        let target_slot = u16::try_from(declarations.len() + 1)
            .map_err(|_| "BinData target slot overflow".to_string())?;
        let target_storage_id = if declaration.storage_id == 0 {
            allocate_bin_data_storage_id(used, reserved)?
        } else {
            if declaration.storage_id != 0 && !used.insert(declaration.storage_id) {
                return Err(format!(
                    "duplicate current BinData declaration storage id {}",
                    declaration.storage_id
                ));
            }
            declaration.storage_id
        };
        reserved.remove(&target_storage_id);
        let target = TargetBinDataRef {
            slot: target_slot,
            storage_id: target_storage_id,
        };
        insert_source_bin_data_mapping(
            &mut current_map,
            u16::try_from(source_index + 1).unwrap(),
            declaration.storage_id,
            target,
        )?;
        if let Some((base_slot, base_storage_id)) = base_mapping {
            insert_source_bin_data_mapping(&mut base_map, base_slot, base_storage_id, target)?;
            let incoming_declaration = &incoming.doc_info.bin_data_list[source_index];
            insert_source_bin_data_mapping(
                &mut incoming_map,
                base_slot,
                incoming_declaration.storage_id,
                target,
            )?;
        }
        declarations.push(FinalBinDataDeclaration {
            slot: target_slot,
            storage_id: target_storage_id,
            origin,
        });
        Ok(())
    };

    for index in 0..base_len {
        let slot = u16::try_from(index + 1).unwrap();
        add_current_declaration(
            index,
            FinalBinDataOrigin::Base(index),
            &mut declarations,
            &mut used,
            &mut reserved,
            Some((slot, base.doc_info.bin_data_list[index].storage_id)),
        )?;
    }
    for index in base_len..current.doc_info.bin_data_list.len() {
        add_current_declaration(
            index,
            FinalBinDataOrigin::CurrentAppend(index),
            &mut declarations,
            &mut used,
            &mut reserved,
            None,
        )?;
    }
    drop(add_current_declaration);

    for index in base_len..incoming.doc_info.bin_data_list.len() {
        let declaration = &incoming.doc_info.bin_data_list[index];
        let target_slot = u16::try_from(declarations.len() + 1)
            .map_err(|_| "BinData target slot overflow".to_string())?;
        let target_storage_id =
            if declaration.storage_id == 0 || used.contains(&declaration.storage_id) {
                allocate_bin_data_storage_id(&mut used, &reserved)?
            } else {
                used.insert(declaration.storage_id);
                declaration.storage_id
            };
        reserved.remove(&target_storage_id);
        let target = TargetBinDataRef {
            slot: target_slot,
            storage_id: target_storage_id,
        };
        insert_source_bin_data_mapping(
            &mut incoming_map,
            u16::try_from(index + 1).unwrap(),
            declaration.storage_id,
            target,
        )?;
        declarations.push(FinalBinDataDeclaration {
            slot: target_slot,
            storage_id: target_storage_id,
            origin: FinalBinDataOrigin::IncomingAppend(index),
        });
    }

    let mut incoming_chart_ids = BTreeMap::new();
    let base_chart_ids = base
        .bin_data_content
        .iter()
        .filter(|content| content.extension == "ooxml_chart")
        .map(|content| content.id)
        .collect::<BTreeSet<_>>();
    let mut used_chart_ids = used.clone();
    used_chart_ids.extend(
        current
            .bin_data_content
            .iter()
            .chain(incoming.bin_data_content.iter())
            .filter(|content| content.extension != "ooxml_chart")
            .map(|content| content.id),
    );
    used_chart_ids.extend(
        current
            .bin_data_content
            .iter()
            .filter(|content| content.extension == "ooxml_chart")
            .map(|content| content.id),
    );
    for content in incoming.bin_data_content.iter().filter(|content| {
        content.extension == "ooxml_chart" && !base_chart_ids.contains(&content.id)
    }) {
        if used_chart_ids.contains(&content.id) {
            let new = (60001..=u16::MAX)
                .find(|candidate| !used_chart_ids.contains(candidate))
                .ok_or_else(|| "no free OOXML chart resource id remains".to_string())?;
            used_chart_ids.insert(new);
            incoming_chart_ids.insert(content.id, new);
        } else {
            used_chart_ids.insert(content.id);
        }
    }

    let current_refs = BinDataRefRewrite {
        image: source_image_ref_map(current, target_format, &current_map),
        storage: source_storage_ref_map(&current_map),
    };
    let mut incoming_storage = source_storage_ref_map(&incoming_map);
    incoming_storage.extend(incoming_chart_ids.iter().map(|(old, new)| (*old, *new)));
    let incoming_refs = BinDataRefRewrite {
        image: source_image_ref_map(incoming, target_format, &incoming_map),
        storage: incoming_storage,
    };

    Ok(BinDataMergePlan {
        declarations,
        current_refs,
        incoming_refs,
        current_map,
        incoming_map,
        base_map,
        incoming_chart_ids,
    })
}

struct RemappedIncoming<'a> {
    source: &'a Document,
    doc_info: Option<DocInfo>,
    sections: Option<Vec<Section>>,
    bin_data_content: Option<Vec<BinDataContent>>,
}

impl<'a> RemappedIncoming<'a> {
    fn new(source: &'a Document) -> Self {
        Self {
            source,
            doc_info: None,
            sections: None,
            bin_data_content: None,
        }
    }

    fn doc_info(&self) -> &DocInfo {
        self.doc_info.as_ref().unwrap_or(&self.source.doc_info)
    }

    fn doc_info_mut(&mut self) -> &mut DocInfo {
        if self.doc_info.is_none() {
            self.doc_info = Some(self.source.doc_info.clone());
        }
        self.doc_info.as_mut().expect("initialized above")
    }

    fn sections(&self) -> &[Section] {
        self.sections.as_deref().unwrap_or(&self.source.sections)
    }

    fn sections_mut(&mut self) -> &mut Vec<Section> {
        if self.sections.is_none() {
            self.sections = Some(self.source.sections.clone());
        }
        self.sections.as_mut().expect("initialized above")
    }

    fn bin_data_content(&self) -> &[BinDataContent] {
        self.bin_data_content
            .as_deref()
            .unwrap_or(&self.source.bin_data_content)
    }

    fn bin_data_content_mut(&mut self) -> &mut Vec<BinDataContent> {
        if self.bin_data_content.is_none() {
            self.bin_data_content = Some(self.source.bin_data_content.clone());
        }
        self.bin_data_content.as_mut().expect("initialized above")
    }
}

fn apply_bin_data_ref_rewrite(
    view: &mut RemappedIncoming<'_>,
    remap: &BinDataRefRewrite,
) -> Result<(), String> {
    if doc_info_needs_bin_data_remap(view.doc_info(), remap) {
        remap_doc_info_bin_data_refs(view.doc_info_mut(), remap)?;
    }
    if sections_need_bin_data_remap(view.sections(), remap) {
        for section in view.sections_mut() {
            let mut changed = remap_bin_data_refs_in_paragraphs(&mut section.paragraphs, remap);
            for page in &mut section.section_def.master_pages {
                changed |= remap_bin_data_refs_in_paragraphs(&mut page.paragraphs, remap);
            }
            if changed {
                // HWP body serialization otherwise emits the stale raw stream.
                section.raw_stream = None;
            }
        }
    }
    Ok(())
}

struct PreparedMergeViews<'c, 'i> {
    current: RemappedIncoming<'c>,
    incoming: RemappedIncoming<'i>,
    bin_data: BinDataMergePlan,
}

fn merged_append_count(base: usize, current: usize, incoming: usize) -> Result<usize, String> {
    if current < base || incoming < base {
        // Non-append edits remain atomic in merge_list. There is no incoming
        // suffix to shift, so only the chosen branch's cardinality matters.
        return Ok(current.max(incoming));
    }
    current
        .checked_add(incoming - base)
        .ok_or_else(|| "merged positional collection count overflow".to_string())
}

fn checked_shift_u8(value: u8, shift: usize, kind: &str) -> Result<u8, String> {
    let shift = u8::try_from(shift).map_err(|_| format!("{kind} shift exceeds u8"))?;
    value
        .checked_add(shift)
        .ok_or_else(|| format!("{kind} reference {value} overflows u8 after shift {shift}"))
}

fn checked_shift_u16(value: u16, shift: usize, kind: &str) -> Result<u16, String> {
    let shift = u16::try_from(shift).map_err(|_| format!("{kind} shift exceeds u16"))?;
    value
        .checked_add(shift)
        .ok_or_else(|| format!("{kind} reference {value} overflows u16 after shift {shift}"))
}

fn checked_shift_u32(value: u32, shift: usize, kind: &str) -> Result<u32, String> {
    let shift = u32::try_from(shift).map_err(|_| format!("{kind} shift exceeds u32"))?;
    value
        .checked_add(shift)
        .ok_or_else(|| format!("{kind} reference {value} overflows u32 after shift {shift}"))
}

#[derive(Clone, Copy, Default)]
struct PositionalRefShifts {
    style: Option<(usize, usize)>,
    para_shape: Option<(usize, usize)>,
    char_shape: Option<(usize, usize)>,
    tab_def: Option<(usize, usize)>,
    numbering: Option<(usize, usize)>,
    bullet: Option<(usize, usize)>,
    border_fill: Option<(usize, usize)>,
    font_face: [Option<(usize, usize)>; 7],
}

fn concurrent_append_shift(base: usize, current: usize, incoming: usize) -> Option<(usize, usize)> {
    (current >= base && incoming >= base && current > base && incoming > base)
        .then_some((base, current - base))
}

fn ensure_positional_count(kind: &str, count: usize, max_count: usize) -> Result<(), String> {
    if count > max_count {
        return Err(format!(
            "merged {kind} count {count} exceeds the {max_count} representable IDs"
        ));
    }
    Ok(())
}

fn zero_based_u16_needs_shift(value: u16, shift: Option<(usize, usize)>) -> bool {
    shift.is_some_and(|(base, amount)| amount != 0 && value as usize >= base)
}

fn one_based_u16_needs_shift(value: u16, shift: Option<(usize, usize)>) -> bool {
    value != 0 && shift.is_some_and(|(base, amount)| amount != 0 && value as usize > base)
}

fn zero_based_u32_needs_shift(value: u32, shift: Option<(usize, usize)>) -> bool {
    value != u32::MAX && shift.is_some_and(|(base, amount)| amount != 0 && value as usize >= base)
}

fn shift_zero_based_u16(
    value: &mut u16,
    shift: Option<(usize, usize)>,
    kind: &str,
) -> Result<bool, String> {
    if let Some((base, amount)) = shift {
        if amount != 0 && *value as usize >= base {
            *value = checked_shift_u16(*value, amount, kind)?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn shift_one_based_u16(
    value: &mut u16,
    shift: Option<(usize, usize)>,
    kind: &str,
) -> Result<bool, String> {
    if *value == 0 {
        return Ok(false);
    }
    if let Some((base, amount)) = shift {
        if amount != 0 && *value as usize > base {
            *value = checked_shift_u16(*value, amount, kind)?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn shift_zero_based_u32(
    value: &mut u32,
    shift: Option<(usize, usize)>,
    kind: &str,
) -> Result<bool, String> {
    if *value == u32::MAX {
        return Ok(false);
    }
    if let Some((base, amount)) = shift {
        if amount != 0 && *value as usize >= base {
            *value = checked_shift_u32(*value, amount, kind)?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn remap_raw_decimal_attribute_refs(
    raw: &str,
    attribute: &str,
    shift: Option<(usize, usize)>,
    kind: &str,
) -> Result<(String, bool), String> {
    let Some((base, amount)) = shift.filter(|(_, amount)| *amount != 0) else {
        return Ok((raw.to_string(), false));
    };
    let mut output = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    let mut changed = false;
    while let Some(relative) = raw[cursor..].find(attribute) {
        let attribute_start = cursor + relative;
        let mut position = attribute_start + attribute.len();
        let bytes = raw.as_bytes();
        while bytes
            .get(position)
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            position += 1;
        }
        if bytes.get(position) != Some(&b'=') {
            output.push_str(&raw[cursor..position]);
            cursor = position;
            continue;
        }
        position += 1;
        while bytes
            .get(position)
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            position += 1;
        }
        let Some(quote @ (b'\'' | b'"')) = bytes.get(position).copied() else {
            output.push_str(&raw[cursor..position]);
            cursor = position;
            continue;
        };
        let value_start = position + 1;
        let Some(relative_end) = bytes[value_start..].iter().position(|byte| *byte == quote) else {
            output.push_str(&raw[cursor..]);
            return Ok((output, changed));
        };
        let value_end = value_start + relative_end;
        let Ok(value) = raw[value_start..value_end].parse::<u32>() else {
            output.push_str(&raw[cursor..value_end]);
            cursor = value_end;
            continue;
        };
        if value != u32::MAX && value as usize >= base {
            let remapped = checked_shift_u32(value, amount, kind)?;
            output.push_str(&raw[cursor..value_start]);
            output.push_str(&remapped.to_string());
            cursor = value_end;
            changed = true;
        } else {
            output.push_str(&raw[cursor..value_end]);
            cursor = value_end;
        }
    }
    output.push_str(&raw[cursor..]);
    Ok((output, changed))
}

fn section_def_needs_positional_remap(
    section_def: &SectionDef,
    shifts: &PositionalRefShifts,
) -> bool {
    one_based_u16_needs_shift(section_def.outline_numbering_id, shifts.numbering)
        || one_based_u16_needs_shift(
            section_def.page_border_fill.border_fill_id,
            shifts.border_fill,
        )
        || section_def
            .extra_page_border_fills
            .iter()
            .any(|fill| one_based_u16_needs_shift(fill.border_fill_id, shifts.border_fill))
}

fn paragraph_needs_positional_remap(paragraph: &Paragraph, shifts: &PositionalRefShifts) -> bool {
    shifts
        .style
        .is_some_and(|(base, amount)| amount != 0 && paragraph.style_id as usize >= base)
        || shifts
            .para_shape
            .is_some_and(|(base, amount)| amount != 0 && paragraph.para_shape_id as usize >= base)
        || paragraph
            .char_shapes
            .iter()
            .any(|shape| zero_based_u32_needs_shift(shape.char_shape_id, shifts.char_shape))
        || paragraph.controls.iter().any(|control| match control {
            Control::SectionDef(section_def) => {
                section_def_needs_positional_remap(section_def, shifts)
            }
            Control::Table(table) => {
                one_based_u16_needs_shift(table.border_fill_id, shifts.border_fill)
                    || table.zones.iter().any(|zone| {
                        one_based_u16_needs_shift(zone.border_fill_id, shifts.border_fill)
                    })
                    || table.cells.iter().any(|cell| {
                        one_based_u16_needs_shift(cell.border_fill_id, shifts.border_fill)
                    })
            }
            Control::Ruby(ruby) => shifts
                .style
                .is_some_and(|(base, amount)| amount != 0 && ruby.style_id_ref as usize >= base),
            Control::CharOverlap(overlap) => overlap
                .char_shape_ids
                .iter()
                .any(|id| zero_based_u32_needs_shift(*id, shifts.char_shape)),
            Control::Form(form) => {
                shifts.char_shape.is_some()
                    && form.properties.get("CharShapeID").is_some_and(|value| {
                        value
                            .parse::<u32>()
                            .map_or(true, |id| zero_based_u32_needs_shift(id, shifts.char_shape))
                    })
            }
            _ => false,
        })
}

fn sections_need_positional_remap(sections: &[Section], shifts: &PositionalRefShifts) -> bool {
    sections.iter().any(|section| {
        section_def_needs_positional_remap(&section.section_def, shifts)
            || any_nested_paragraph(&section.paragraphs, &mut |paragraph| {
                paragraph_needs_positional_remap(paragraph, shifts)
            })
            || section.section_def.master_pages.iter().any(|page| {
                any_nested_paragraph(&page.paragraphs, &mut |paragraph| {
                    paragraph_needs_positional_remap(paragraph, shifts)
                })
            })
    })
}

fn remap_section_def_positional_refs(
    section_def: &mut SectionDef,
    shifts: &PositionalRefShifts,
) -> Result<bool, String> {
    let mut changed = shift_one_based_u16(
        &mut section_def.outline_numbering_id,
        shifts.numbering,
        "section outline numbering",
    )?;
    changed |= shift_one_based_u16(
        &mut section_def.page_border_fill.border_fill_id,
        shifts.border_fill,
        "page border fill",
    )?;
    for fill in &mut section_def.extra_page_border_fills {
        changed |= shift_one_based_u16(
            &mut fill.border_fill_id,
            shifts.border_fill,
            "page border fill",
        )?;
    }
    Ok(changed)
}

fn remap_paragraph_positional_refs(
    paragraph: &mut Paragraph,
    shifts: &PositionalRefShifts,
) -> Result<bool, String> {
    let mut changed = false;
    if let Some((base, amount)) = shifts.style {
        if amount != 0 && paragraph.style_id as usize >= base {
            paragraph.style_id = checked_shift_u8(paragraph.style_id, amount, "style")?;
            changed = true;
        }
    }
    changed |= shift_zero_based_u16(
        &mut paragraph.para_shape_id,
        shifts.para_shape,
        "paragraph-shape",
    )?;
    for shape in &mut paragraph.char_shapes {
        changed |= shift_zero_based_u32(
            &mut shape.char_shape_id,
            shifts.char_shape,
            "character-shape",
        )?;
    }
    for control in &mut paragraph.controls {
        match control {
            Control::SectionDef(section_def) => {
                changed |= remap_section_def_positional_refs(section_def, shifts)?;
            }
            Control::Table(table) => {
                changed |= shift_one_based_u16(
                    &mut table.border_fill_id,
                    shifts.border_fill,
                    "table border fill",
                )?;
                for zone in &mut table.zones {
                    changed |= shift_one_based_u16(
                        &mut zone.border_fill_id,
                        shifts.border_fill,
                        "table-zone border fill",
                    )?;
                }
                for cell in &mut table.cells {
                    changed |= shift_one_based_u16(
                        &mut cell.border_fill_id,
                        shifts.border_fill,
                        "table-cell border fill",
                    )?;
                }
            }
            Control::Ruby(ruby) => {
                changed |=
                    shift_zero_based_u16(&mut ruby.style_id_ref, shifts.style, "ruby style")?;
            }
            Control::CharOverlap(overlap) => {
                for id in &mut overlap.char_shape_ids {
                    changed |=
                        shift_zero_based_u32(id, shifts.char_shape, "overlap character-shape")?;
                }
            }
            Control::Form(form) => {
                if let Some(value) = form.properties.get("CharShapeID").cloned() {
                    let mut id = value
                        .parse::<u32>()
                        .map_err(|_| "form CharShapeID is not numeric".to_string())?;
                    if shift_zero_based_u32(&mut id, shifts.char_shape, "form character-shape")? {
                        form.properties
                            .insert("CharShapeID".to_string(), id.to_string());
                        changed = true;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(changed)
}

fn remap_sections_positional_refs(
    sections: &mut [Section],
    shifts: &PositionalRefShifts,
) -> Result<(), String> {
    let mut error = None;
    for section in sections {
        let mut changed = remap_section_def_positional_refs(&mut section.section_def, shifts)?;
        let mut rewrite = |paragraph: &mut Paragraph| {
            if error.is_some() {
                return;
            }
            match remap_paragraph_positional_refs(paragraph, shifts) {
                Ok(paragraph_changed) => changed |= paragraph_changed,
                Err(value) => error = Some(value),
            }
        };
        visit_nested_paragraphs_mut(&mut section.paragraphs, &mut rewrite);
        for page in &mut section.section_def.master_pages {
            visit_nested_paragraphs_mut(&mut page.paragraphs, &mut rewrite);
        }
        if changed {
            section.raw_stream = None;
        }
        if let Some(value) = error.take() {
            return Err(value);
        }
    }
    Ok(())
}

fn doc_info_needs_positional_remap(doc_info: &DocInfo, shifts: &PositionalRefShifts) -> bool {
    doc_info.char_shapes.iter().any(|shape| {
        shape
            .font_ids
            .iter()
            .enumerate()
            .any(|(language, id)| zero_based_u16_needs_shift(*id, shifts.font_face[language]))
            || one_based_u16_needs_shift(shape.border_fill_id, shifts.border_fill)
    }) || doc_info.para_shapes.iter().any(|shape| {
        zero_based_u16_needs_shift(shape.tab_def_id, shifts.tab_def)
            || match shape.head_type {
                HeadType::Bullet => one_based_u16_needs_shift(shape.numbering_id, shifts.bullet),
                HeadType::Number | HeadType::Outline => {
                    one_based_u16_needs_shift(shape.numbering_id, shifts.numbering)
                }
                HeadType::None => false,
            }
            || one_based_u16_needs_shift(shape.border_fill_id, shifts.border_fill)
    }) || doc_info.styles.iter().any(|style| {
        (style.next_style_id != u8::MAX
            && shifts
                .style
                .is_some_and(|(base, amount)| amount != 0 && style.next_style_id as usize >= base))
            || zero_based_u16_needs_shift(style.para_shape_id, shifts.para_shape)
            || zero_based_u16_needs_shift(style.char_shape_id, shifts.char_shape)
    }) || doc_info.numberings.iter().any(|numbering| {
        numbering
            .heads
            .iter()
            .any(|head| zero_based_u32_needs_shift(head.char_shape_id, shifts.char_shape))
    }) || doc_info
        .bullets
        .iter()
        .any(|bullet| zero_based_u32_needs_shift(bullet.char_shape_id, shifts.char_shape))
}

fn remap_doc_info_positional_refs(
    doc_info: &mut DocInfo,
    shifts: &PositionalRefShifts,
) -> Result<(), String> {
    let mut changed = false;
    for shape in &mut doc_info.char_shapes {
        let mut shape_changed = false;
        for (language, id) in shape.font_ids.iter_mut().enumerate() {
            shape_changed |= shift_zero_based_u16(id, shifts.font_face[language], "font-face")?;
        }
        shape_changed |= shift_one_based_u16(
            &mut shape.border_fill_id,
            shifts.border_fill,
            "character-shape border fill",
        )?;
        if shape_changed {
            shape.raw_data = None;
            changed = true;
        }
    }
    for shape in &mut doc_info.para_shapes {
        let mut shape_changed =
            shift_zero_based_u16(&mut shape.tab_def_id, shifts.tab_def, "tab-definition")?;
        shape_changed |= match shape.head_type {
            HeadType::Bullet => {
                shift_one_based_u16(&mut shape.numbering_id, shifts.bullet, "bullet")?
            }
            HeadType::Number | HeadType::Outline => {
                shift_one_based_u16(&mut shape.numbering_id, shifts.numbering, "numbering")?
            }
            HeadType::None => false,
        };
        shape_changed |= shift_one_based_u16(
            &mut shape.border_fill_id,
            shifts.border_fill,
            "paragraph-shape border fill",
        )?;
        if shape_changed {
            shape.raw_data = None;
            changed = true;
        }
    }
    for style in &mut doc_info.styles {
        let mut style_changed = false;
        if style.next_style_id != u8::MAX {
            if let Some((base, amount)) = shifts.style {
                if amount != 0 && style.next_style_id as usize >= base {
                    style.next_style_id =
                        checked_shift_u8(style.next_style_id, amount, "next-style")?;
                    style_changed = true;
                }
            }
        }
        style_changed |= shift_zero_based_u16(
            &mut style.para_shape_id,
            shifts.para_shape,
            "paragraph-shape",
        )?;
        style_changed |= shift_zero_based_u16(
            &mut style.char_shape_id,
            shifts.char_shape,
            "character-shape",
        )?;
        if style_changed {
            style.raw_data = None;
            changed = true;
        }
    }
    for numbering in &mut doc_info.numberings {
        let mut numbering_changed = false;
        for head in &mut numbering.heads {
            numbering_changed |= shift_zero_based_u32(
                &mut head.char_shape_id,
                shifts.char_shape,
                "numbering character-shape",
            )?;
        }
        if numbering_changed {
            numbering.raw_data = None;
            if let Some(raw) = numbering.raw_para_heads.take() {
                let (rewritten, found) = remap_raw_decimal_attribute_refs(
                    &raw,
                    "charPrIDRef",
                    shifts.char_shape,
                    "numbering character-shape",
                )?;
                numbering.raw_para_heads = found.then_some(rewritten);
            }
            changed = true;
        }
    }
    for bullet in &mut doc_info.bullets {
        if shift_zero_based_u32(
            &mut bullet.char_shape_id,
            shifts.char_shape,
            "bullet character-shape",
        )? {
            bullet.raw_data = None;
            bullet.raw_para_head = if let Some(raw) = bullet.raw_para_head.take() {
                let (rewritten, found) = remap_raw_decimal_attribute_refs(
                    &raw,
                    "charPrIDRef",
                    shifts.char_shape,
                    "bullet character-shape",
                )?;
                found.then_some(rewritten)
            } else {
                None
            };
            if bullet.raw_para_head.is_none() && bullet.image_bullet > 0 {
                bullet.raw_para_head = Some(regenerated_image_bullet_para_head(bullet));
            }
            changed = true;
        }
    }
    if changed {
        doc_info.raw_stream_dirty = true;
    }
    Ok(())
}

fn prepare_merge_views<'c, 'i>(
    b: &Document,
    c: &'c Document,
    i: &'i Document,
) -> Result<PreparedMergeViews<'c, 'i>, String> {
    prepare_merge_views_for_format(b, c, i, c.provenance.format)
}

fn prepare_merge_views_for_format<'c, 'i>(
    b: &Document,
    c: &'c Document,
    i: &'i Document,
    target_format: crate::model::provenance::SourceFormat,
) -> Result<PreparedMergeViews<'c, 'i>, String> {
    let bin_data = prepare_bin_data_merge(b, c, i, target_format)?;
    let mut current = RemappedIncoming::new(c);
    let mut out = RemappedIncoming::new(i);
    apply_bin_data_ref_rewrite(&mut current, &bin_data.current_refs)?;
    apply_bin_data_ref_rewrite(&mut out, &bin_data.incoming_refs)?;

    let incoming_doc_info = out.doc_info();
    let base_styles = b.doc_info.styles.len();
    let base_para_shapes = b.doc_info.para_shapes.len();
    let base_char_shapes = b.doc_info.char_shapes.len();
    let base_tab_defs = b.doc_info.tab_defs.len();
    let base_numberings = b.doc_info.numberings.len();
    let base_bullets = b.doc_info.bullets.len();
    let base_border_fills = b.doc_info.border_fills.len();

    ensure_positional_count(
        "style",
        merged_append_count(
            base_styles,
            c.doc_info.styles.len(),
            incoming_doc_info.styles.len(),
        )?,
        usize::from(u8::MAX) + 1,
    )?;
    ensure_positional_count(
        "paragraph-shape",
        merged_append_count(
            base_para_shapes,
            c.doc_info.para_shapes.len(),
            incoming_doc_info.para_shapes.len(),
        )?,
        usize::from(u16::MAX) + 1,
    )?;
    ensure_positional_count(
        "character-shape",
        merged_append_count(
            base_char_shapes,
            c.doc_info.char_shapes.len(),
            incoming_doc_info.char_shapes.len(),
        )?,
        usize::from(u16::MAX) + 1,
    )?;
    ensure_positional_count(
        "tab-definition",
        merged_append_count(
            base_tab_defs,
            c.doc_info.tab_defs.len(),
            incoming_doc_info.tab_defs.len(),
        )?,
        usize::from(u16::MAX) + 1,
    )?;
    ensure_positional_count(
        "numbering",
        merged_append_count(
            base_numberings,
            c.doc_info.numberings.len(),
            incoming_doc_info.numberings.len(),
        )?,
        usize::from(u16::MAX),
    )?;
    ensure_positional_count(
        "bullet",
        merged_append_count(
            base_bullets,
            c.doc_info.bullets.len(),
            incoming_doc_info.bullets.len(),
        )?,
        usize::from(u16::MAX),
    )?;
    ensure_positional_count(
        "border-fill",
        merged_append_count(
            base_border_fills,
            c.doc_info.border_fills.len(),
            incoming_doc_info.border_fills.len(),
        )?,
        usize::from(u16::MAX),
    )?;

    let mut shifts = PositionalRefShifts {
        style: concurrent_append_shift(
            base_styles,
            c.doc_info.styles.len(),
            incoming_doc_info.styles.len(),
        ),
        para_shape: concurrent_append_shift(
            base_para_shapes,
            c.doc_info.para_shapes.len(),
            incoming_doc_info.para_shapes.len(),
        ),
        char_shape: concurrent_append_shift(
            base_char_shapes,
            c.doc_info.char_shapes.len(),
            incoming_doc_info.char_shapes.len(),
        ),
        tab_def: concurrent_append_shift(
            base_tab_defs,
            c.doc_info.tab_defs.len(),
            incoming_doc_info.tab_defs.len(),
        ),
        numbering: concurrent_append_shift(
            base_numberings,
            c.doc_info.numberings.len(),
            incoming_doc_info.numberings.len(),
        ),
        bullet: concurrent_append_shift(
            base_bullets,
            c.doc_info.bullets.len(),
            incoming_doc_info.bullets.len(),
        ),
        border_fill: concurrent_append_shift(
            base_border_fills,
            c.doc_info.border_fills.len(),
            incoming_doc_info.border_fills.len(),
        ),
        ..Default::default()
    };
    let font_group_shapes_match = b.doc_info.font_faces.len() == c.doc_info.font_faces.len()
        && b.doc_info.font_faces.len() == incoming_doc_info.font_faces.len();
    for language in 0..7 {
        let base_fonts = b.doc_info.font_faces.get(language).map_or(0, Vec::len);
        let current_fonts = c.doc_info.font_faces.get(language).map_or(0, Vec::len);
        let incoming_fonts = incoming_doc_info
            .font_faces
            .get(language)
            .map_or(0, Vec::len);
        let final_fonts = if font_group_shapes_match {
            merged_append_count(base_fonts, current_fonts, incoming_fonts)?
        } else {
            current_fonts.max(incoming_fonts)
        };
        ensure_positional_count(
            &format!("font-face language {language}"),
            final_fonts,
            usize::from(u16::MAX) + 1,
        )?;
        if font_group_shapes_match {
            shifts.font_face[language] =
                concurrent_append_shift(base_fonts, current_fonts, incoming_fonts);
        }
    }

    if doc_info_needs_positional_remap(out.doc_info(), &shifts) {
        remap_doc_info_positional_refs(out.doc_info_mut(), &shifts)?;
    }
    if sections_need_positional_remap(out.sections(), &shifts) {
        remap_sections_positional_refs(out.sections_mut(), &shifts)?;
    }
    Ok(PreparedMergeViews {
        current,
        incoming: out,
        bin_data,
    })
}
fn manual_resource_from_value(
    v: &Value,
    default_id: u16,
) -> Result<Option<BinDataContent>, String> {
    manual_resource_from_value_with_limit(
        v,
        default_id,
        crate::parser::limits::MAX_UNTRUSTED_INPUT_BYTES,
    )
}

fn manual_resource_from_value_with_limit(
    v: &Value,
    default_id: u16,
    max_bytes: usize,
) -> Result<Option<BinDataContent>, String> {
    if v.is_null() {
        return Ok(None);
    }
    let o = v
        .as_object()
        .ok_or("manual image value must be an object")?;
    let id = o
        .get("id")
        .and_then(Value::as_u64)
        .unwrap_or(default_id as u64)
        .try_into()
        .map_err(|_| "image id exceeds u16")?;
    let extension = o
        .get("extension")
        .and_then(Value::as_str)
        .ok_or("manual image extension is required")?
        .to_string();
    let encoded = o
        .get("bytesBase64")
        .and_then(Value::as_str)
        .ok_or("manual image bytesBase64 is required")?;
    let decoded_len = base64::decoded_len_estimate(encoded.len());
    if decoded_len > max_bytes {
        return Err(format!(
            "manual image exceeds the {max_bytes} byte merge resource limit"
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("invalid image bytesBase64: {e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "manual image exceeds the {max_bytes} byte merge resource limit"
        ));
    }
    Ok(Some(BinDataContent {
        id,
        data: BinDataBytes::from(bytes),
        extension,
    }))
}
fn merge_resources(
    b: &[BinDataContent],
    c: &[BinDataContent],
    i: &[BinDataContent],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<BinDataContent>, String> {
    fn map(v: &[BinDataContent]) -> Result<BTreeMap<u16, &BinDataContent>, String> {
        let mut m = BTreeMap::new();
        for x in v {
            if m.insert(x.id, x).is_some() {
                return Err(format!("duplicate binary resource id {}", x.id));
            }
        }
        Ok(m)
    }
    let (bm, cm, im) = (map(b)?, map(c)?, map(i)?);
    let ids = bm
        .keys()
        .chain(cm.keys())
        .chain(im.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    let mut out = vec![];
    for id in ids {
        let (base, current, incoming) = (
            bm.get(&id).copied(),
            cm.get(&id).copied(),
            im.get(&id).copied(),
        );
        let chosen = if resources_equal(current, incoming) {
            x.auto += 1;
            current
        } else if resources_equal(current, base) {
            x.auto += 1;
            incoming
        } else if resources_equal(incoming, base) {
            x.auto += 1;
            current
        } else {
            let p = vec!["bin_data_content".into(), format!("@{id}")];
            let (bv, cv, iv) = (
                resource_value(base),
                resource_value(current),
                resource_value(incoming),
            );
            if !x.enter(&p, &bv, &cv, &iv) {
                current
            } else {
                let item = conflict(
                    &p,
                    if bv.is_null() {
                        MergeConflictReason::ConcurrentInsertion
                    } else if cv.is_null() || iv.is_null() {
                        MergeConflictReason::DeleteVersusEdit
                    } else {
                        MergeConflictReason::SameFieldChanged
                    },
                    &bv,
                    &cv,
                    &iv,
                    false,
                );
                let selected = match r.and_then(|m| m.get(&item.id)) {
                    None | Some(MergeResolution::Current) => current,
                    Some(MergeResolution::Incoming) => incoming,
                    Some(MergeResolution::Manual { payload }) => {
                        let manual = manual_resource_from_value(payload, id)?;
                        x.conflicts.push(item);
                        if let Some(manual) = manual {
                            out.push(manual);
                        }
                        continue;
                    }
                    Some(MergeResolution::Both { .. }) => {
                        return Err(format!("{} image bytes are atomic", item.id))
                    }
                };
                x.conflicts.push(item);
                selected
            }
        };
        if let Some(value) = chosen {
            out.push(value.clone())
        }
    }
    Ok(out)
}

fn declaration_content<'a>(document: &'a Document, index: usize) -> Option<&'a BinDataContent> {
    use crate::model::bin_data::BinDataType;
    let declaration = document.doc_info.bin_data_list.get(index)?;
    let id = if declaration.storage_id != 0 {
        declaration.storage_id
    } else if matches!(declaration.data_type, BinDataType::Link) {
        u16::try_from(index + 1).ok()?
    } else {
        return None;
    };
    document
        .bin_data_content
        .iter()
        .find(|content| content.extension != "ooxml_chart" && content.id == id)
}

fn normalized_bin_data_declaration(
    declaration: &crate::model::bin_data::BinData,
    storage_id: u16,
) -> crate::model::bin_data::BinData {
    let mut normalized = declaration.clone();
    if normalized.storage_id != storage_id {
        normalized.storage_id = storage_id;
        normalized.raw_data = None;
    }
    normalized
}

fn resources_payload_equal(left: Option<&BinDataContent>, right: Option<&BinDataContent>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            ResourceObservation::new(left).payload_equivalent(&ResourceObservation::new(right))
        }
        (None, Some(_)) | (Some(_), None) => false,
    }
}

fn choose_bin_data_content(
    path: Vec<String>,
    id: u16,
    base: Option<&BinDataContent>,
    current: Option<&BinDataContent>,
    incoming: Option<&BinDataContent>,
    resolutions: Option<&BTreeMap<String, MergeResolution>>,
    context: &mut Ctx,
) -> Result<Option<BinDataContent>, String> {
    let selected = if resources_payload_equal(current, incoming) {
        context.auto += 1;
        current
    } else if resources_payload_equal(current, base) {
        context.auto += 1;
        incoming
    } else if resources_payload_equal(incoming, base) {
        context.auto += 1;
        current
    } else {
        let (base_value, current_value, incoming_value) = (
            resource_value(base),
            resource_value(current),
            resource_value(incoming),
        );
        if !context.enter(&path, &base_value, &current_value, &incoming_value) {
            current
        } else {
            let item = conflict(
                &path,
                if base_value.is_null() {
                    MergeConflictReason::ConcurrentInsertion
                } else if current_value.is_null() || incoming_value.is_null() {
                    MergeConflictReason::DeleteVersusEdit
                } else {
                    MergeConflictReason::SameFieldChanged
                },
                &base_value,
                &current_value,
                &incoming_value,
                false,
            );
            let selected = match resolutions.and_then(|values| values.get(&item.id)) {
                None | Some(MergeResolution::Current) => current.map(Clone::clone),
                Some(MergeResolution::Incoming) => incoming.map(Clone::clone),
                Some(MergeResolution::Manual { payload }) => {
                    manual_resource_from_value(payload, id)?
                }
                Some(MergeResolution::Both { .. }) => {
                    return Err(format!("{} binary payload is atomic", item.id))
                }
            };
            context.conflicts.push(item);
            return Ok(selected.map(|mut content| {
                content.id = id;
                content
            }));
        }
    };
    Ok(selected.map(|content| {
        let mut content = content.clone();
        content.id = id;
        content
    }))
}

fn merge_bin_data_resources(
    base: &Document,
    current: &Document,
    incoming: &Document,
    plan: &BinDataMergePlan,
    resolutions: Option<&BTreeMap<String, MergeResolution>>,
    context: &mut Ctx,
) -> Result<(Vec<crate::model::bin_data::BinData>, Vec<BinDataContent>), String> {
    let mut declarations = Vec::with_capacity(plan.declarations.len());
    let mut contents = Vec::new();
    for final_declaration in &plan.declarations {
        debug_assert_eq!(usize::from(final_declaration.slot), declarations.len() + 1);
        let (declaration, content) = match final_declaration.origin {
            FinalBinDataOrigin::Base(index) => {
                let base_declaration = normalized_bin_data_declaration(
                    &base.doc_info.bin_data_list[index],
                    final_declaration.storage_id,
                );
                let current_declaration = normalized_bin_data_declaration(
                    &current.doc_info.bin_data_list[index],
                    final_declaration.storage_id,
                );
                let incoming_declaration = normalized_bin_data_declaration(
                    &incoming.doc_info.bin_data_list[index],
                    final_declaration.storage_id,
                );
                let declaration = choose(
                    &["doc_info".into(), "bin_data_list".into(), index.to_string()],
                    "resource-index",
                    MergeConflictReason::SameFieldChanged,
                    &base_declaration,
                    &current_declaration,
                    &incoming_declaration,
                    resolutions,
                    context,
                )?;
                let content = choose_bin_data_content(
                    vec!["bin_data_content".into(), format!("@slot{}", index + 1)],
                    final_declaration.storage_id,
                    declaration_content(base, index),
                    declaration_content(current, index),
                    declaration_content(incoming, index),
                    resolutions,
                    context,
                )?;
                (declaration, content)
            }
            FinalBinDataOrigin::CurrentAppend(index) => {
                context.auto += 1;
                (
                    normalized_bin_data_declaration(
                        &current.doc_info.bin_data_list[index],
                        final_declaration.storage_id,
                    ),
                    declaration_content(current, index).map(|content| {
                        let mut content = content.clone();
                        content.id = final_declaration.storage_id;
                        content
                    }),
                )
            }
            FinalBinDataOrigin::IncomingAppend(index) => {
                context.auto += 1;
                (
                    normalized_bin_data_declaration(
                        &incoming.doc_info.bin_data_list[index],
                        final_declaration.storage_id,
                    ),
                    declaration_content(incoming, index).map(|content| {
                        let mut content = content.clone();
                        content.id = final_declaration.storage_id;
                        content
                    }),
                )
            }
        };
        declarations.push(declaration);
        if let Some(content) = content {
            contents.push(content);
        }
    }

    fn chart_map<'a>(
        document: &'a Document,
        remap: Option<&BTreeMap<u16, u16>>,
    ) -> BTreeMap<u16, &'a BinDataContent> {
        document
            .bin_data_content
            .iter()
            .filter(|content| content.extension == "ooxml_chart")
            .map(|content| {
                let id = remap
                    .and_then(|values| values.get(&content.id).copied())
                    .unwrap_or(content.id);
                (id, content)
            })
            .collect::<BTreeMap<_, _>>()
    }
    let (base_charts, current_charts, incoming_charts) = (
        chart_map(base, None),
        chart_map(current, None),
        chart_map(incoming, Some(&plan.incoming_chart_ids)),
    );
    let chart_ids = base_charts
        .keys()
        .chain(current_charts.keys())
        .chain(incoming_charts.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    for id in chart_ids {
        if let Some(content) = choose_bin_data_content(
            vec!["bin_data_content".into(), format!("@chart{id}")],
            id,
            base_charts.get(&id).copied(),
            current_charts.get(&id).copied(),
            incoming_charts.get(&id).copied(),
            resolutions,
            context,
        )? {
            contents.push(content);
        }
    }
    Ok((declarations, contents))
}

fn debug_prefix<T: Debug>(values: &[T], prefix: &[T]) -> bool {
    values.len() >= prefix.len() && values.iter().zip(prefix).all(|(a, b)| dh(a) == dh(b))
}
fn merge_list<T: Clone + Debug>(
    path: &str,
    kind: &str,
    b: &[T],
    c: &[T],
    i: &[T],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<T>, String> {
    // DocInfo IDs are positional. Existing slots can still merge independently,
    // while concurrent append-only allocations are concatenated after the
    // incoming reference-remap pass has made their IDs disjoint.
    if c.len() >= b.len() && i.len() >= b.len() {
        let mut out = Vec::with_capacity(c.len() + i.len().saturating_sub(b.len()));
        for n in 0..b.len() {
            out.push(choose(
                &["doc_info".into(), path.into(), n.to_string()],
                kind,
                MergeConflictReason::SameFieldChanged,
                &b[n],
                &c[n],
                &i[n],
                r,
                x,
            )?);
        }
        match (c.len() > b.len(), i.len() > b.len()) {
            (true, true) => {
                out.extend_from_slice(&c[b.len()..]);
                out.extend_from_slice(&i[b.len()..]);
                x.auto += c.len() + i.len() - 2 * b.len();
            }
            (true, false) => {
                out.extend_from_slice(&c[b.len()..]);
                x.auto += c.len() - b.len();
            }
            (false, true) => {
                out.extend_from_slice(&i[b.len()..]);
                x.auto += i.len() - b.len();
            }
            _ => {}
        }
        return Ok(out);
    }
    choose(
        &["doc_info".into(), path.into()],
        kind,
        MergeConflictReason::SameFieldChanged,
        &b.to_vec(),
        &c.to_vec(),
        &i.to_vec(),
        r,
        x,
    )
}
fn merge_doc_info(
    b: &DocInfo,
    c: &DocInfo,
    i: &DocInfo,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<DocInfo, String> {
    macro_rules! t {
        ($name:ident,$kind:literal) => {
            choose_typed(
                &["doc_info".into(), stringify!($name).into()],
                $kind,
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?
        };
    }
    Ok(DocInfo {
        // Rendering environment belongs to the current session, not the merge.
        font_metrics_policy: c.font_metrics_policy,
        // BinData declarations and payloads are merged together by
        // merge_bin_data_resources so slot identity cannot drift from bytes.
        bin_data_list: Vec::new(),
        font_faces: merge_font_faces(&b.font_faces, &c.font_faces, &i.font_faces, r, x)?,
        border_fills: merge_border_fills(&b.border_fills, &c.border_fills, &i.border_fills, r, x)?,
        char_shapes: merge_character_styles(&b.char_shapes, &c.char_shapes, &i.char_shapes, r, x)?,
        tab_defs: merge_tab_defs(&b.tab_defs, &c.tab_defs, &i.tab_defs, r, x)?,
        numberings: merge_numberings(&b.numberings, &c.numberings, &i.numberings, r, x)?,
        bullets: merge_bullets(&b.bullets, &c.bullets, &i.bullets, r, x)?,
        para_shapes: merge_para_styles(&b.para_shapes, &c.para_shapes, &i.para_shapes, r, x)?,
        styles: merge_styles(&b.styles, &c.styles, &i.styles, r, x)?,
        extra_records: merge_list(
            "extra_records",
            "opaque-resources",
            &b.extra_records,
            &c.extra_records,
            &i.extra_records,
            r,
            x,
        )?,
        raw_stream: None,
        bullet_count: t!(bullet_count, "resource-count"),
        memo_shape_count: t!(memo_shape_count, "resource-count"),
        memo_properties_xml: t!(memo_properties_xml, "memo-properties"),
        distribute_doc_data_removed: t!(distribute_doc_data_removed, "document-property"),
        raw_stream_dirty: true,
        hwpx_head_tail: t!(hwpx_head_tail, "document-property"),
        hwpml_version: t!(hwpml_version, "document-property"),
    })
}
fn merge_styles(
    b: &[Style],
    c: &[Style],
    i: &[Style],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<Style>, String> {
    if c.len() < b.len() || i.len() < b.len() {
        return merge_list("styles", "styles", b, c, i, r, x);
    }
    let mut out = vec![];
    for n in 0..b.len() {
        let mut v = c[n].clone();
        macro_rules! t {
            ($f:ident) => {{
                let p = vec![
                    "doc_info".into(),
                    "styles".into(),
                    n.to_string(),
                    stringify!($f).into(),
                ];
                v.$f = choose_typed(&p, "style", &b[n].$f, &c[n].$f, &i[n].$f, r, x)?;
            }};
        }
        t!(local_name);
        t!(english_name);
        t!(style_type);
        t!(next_style_id);
        t!(lang_id);
        t!(para_shape_id);
        t!(char_shape_id);
        t!(lock_form);
        v.raw_data = None;
        out.push(v)
    }
    out.extend_from_slice(&c[b.len()..]);
    out.extend_from_slice(&i[b.len()..]);
    Ok(out)
}
fn merge_font_faces(
    b: &[Vec<Font>],
    c: &[Vec<Font>],
    i: &[Vec<Font>],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<Vec<Font>>, String> {
    if b.len() != c.len() || b.len() != i.len() {
        return merge_list("font_faces", "fonts", b, c, i, r, x);
    }
    let mut groups = vec![];
    for g in 0..b.len() {
        if c[g].len() < b[g].len() || i[g].len() < b[g].len() {
            groups.push(choose(
                &vec!["doc_info".into(), "font_faces".into(), g.to_string()],
                "fonts",
                MergeConflictReason::SameFieldChanged,
                &b[g],
                &c[g],
                &i[g],
                r,
                x,
            )?);
            continue;
        }
        let mut out = vec![];
        for n in 0..b[g].len() {
            let mut v = c[g][n].clone();
            macro_rules! t {
                ($f:ident) => {{
                    let p = vec![
                        "doc_info".into(),
                        "font_faces".into(),
                        g.to_string(),
                        n.to_string(),
                        stringify!($f).into(),
                    ];
                    v.$f = choose_typed(&p, "font", &b[g][n].$f, &c[g][n].$f, &i[g][n].$f, r, x)?;
                }};
            }
            t!(name);
            t!(alt_type);
            t!(is_embedded);
            t!(bin_item_id_ref);
            t!(resolved_bin_data_id);
            t!(alt_name);
            t!(type_info);
            t!(default_name);
            v.subst_font = choose(
                &vec![
                    "doc_info".into(),
                    "font_faces".into(),
                    g.to_string(),
                    n.to_string(),
                    "substFont".into(),
                ],
                "font",
                MergeConflictReason::SameFieldChanged,
                &b[g][n].subst_font,
                &c[g][n].subst_font,
                &i[g][n].subst_font,
                r,
                x,
            )?;
            v.raw_data = None;
            out.push(v)
        }
        out.extend_from_slice(&c[g][b[g].len()..]);
        out.extend_from_slice(&i[g][b[g].len()..]);
        groups.push(out)
    }
    Ok(groups)
}
fn merge_border_fills(
    b: &[BorderFill],
    c: &[BorderFill],
    i: &[BorderFill],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<BorderFill>, String> {
    if c.len() < b.len() || i.len() < b.len() {
        return merge_list("border_fills", "border-resources", b, c, i, r, x);
    }
    let mut out = vec![];
    for n in 0..b.len() {
        let mut v = c[n].clone();
        macro_rules! t {
            ($f:ident) => {{
                let p = vec![
                    "doc_info".into(),
                    "border_fills".into(),
                    n.to_string(),
                    stringify!($f).into(),
                ];
                v.$f = choose_typed(&p, "border-fill", &b[n].$f, &c[n].$f, &i[n].$f, r, x)?;
            }};
        }
        macro_rules! a {
            ($f:ident) => {{
                let p = vec![
                    "doc_info".into(),
                    "border_fills".into(),
                    n.to_string(),
                    stringify!($f).into(),
                ];
                v.$f = choose(
                    &p,
                    "border-fill",
                    MergeConflictReason::SameFieldChanged,
                    &b[n].$f,
                    &c[n].$f,
                    &i[n].$f,
                    r,
                    x,
                )?;
            }};
        }
        t!(attr);
        a!(borders);
        a!(diagonal);
        a!(center_line);
        a!(fill);
        t!(three_d);
        v.raw_data = None;
        out.push(v)
    }
    out.extend_from_slice(&c[b.len()..]);
    out.extend_from_slice(&i[b.len()..]);
    Ok(out)
}
fn merge_character_styles(
    b: &[CharShape],
    c: &[CharShape],
    i: &[CharShape],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<CharShape>, String> {
    if c.len() < b.len() || i.len() < b.len() {
        return merge_list("char_shapes", "character-styles", b, c, i, r, x);
    }
    let mut out = vec![];
    for n in 0..b.len() {
        let mut v = c[n].clone();
        macro_rules! t {
            ($f:ident) => {{
                let p = vec![
                    "doc_info".into(),
                    "char_shapes".into(),
                    n.to_string(),
                    stringify!($f).into(),
                ];
                v.$f = choose_typed(&p, "character-style", &b[n].$f, &c[n].$f, &i[n].$f, r, x)?;
            }};
        }
        macro_rules! a {
            ($f:ident) => {{
                let p = vec![
                    "doc_info".into(),
                    "char_shapes".into(),
                    n.to_string(),
                    stringify!($f).into(),
                ];
                v.$f = choose(
                    &p,
                    "character-style",
                    MergeConflictReason::SameFieldChanged,
                    &b[n].$f,
                    &c[n].$f,
                    &i[n].$f,
                    r,
                    x,
                )?;
            }};
        }
        t!(font_ids);
        t!(ratios);
        t!(spacings);
        t!(relative_sizes);
        t!(char_offsets);
        t!(base_size);
        t!(attr);
        t!(italic);
        t!(bold);
        a!(underline_type);
        t!(outline_type);
        t!(shadow_type);
        t!(shadow_offset_x);
        t!(shadow_offset_y);
        t!(text_color);
        t!(underline_color);
        t!(shade_color);
        t!(shadow_color);
        t!(border_fill_id);
        t!(strike_color);
        t!(strikethrough);
        t!(subscript);
        t!(superscript);
        t!(emboss);
        t!(engrave);
        t!(emphasis_dot);
        t!(underline_shape);
        t!(strike_shape);
        t!(kerning);
        t!(use_font_space);
        v.raw_data = None;
        out.push(v)
    }
    out.extend_from_slice(&c[b.len()..]);
    out.extend_from_slice(&i[b.len()..]);
    Ok(out)
}
fn merge_tab_defs(
    b: &[TabDef],
    c: &[TabDef],
    i: &[TabDef],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<TabDef>, String> {
    if c.len() < b.len() || i.len() < b.len() {
        return merge_list("tab_defs", "tab-styles", b, c, i, r, x);
    }
    let mut out = vec![];
    for n in 0..b.len() {
        let mut v = c[n].clone();
        v.attr = choose_typed(
            &vec![
                "doc_info".into(),
                "tab_defs".into(),
                n.to_string(),
                "attr".into(),
            ],
            "tab-style",
            &b[n].attr,
            &c[n].attr,
            &i[n].attr,
            r,
            x,
        )?;
        v.auto_tab_left = choose_typed(
            &vec![
                "doc_info".into(),
                "tab_defs".into(),
                n.to_string(),
                "autoTabLeft".into(),
            ],
            "tab-style",
            &b[n].auto_tab_left,
            &c[n].auto_tab_left,
            &i[n].auto_tab_left,
            r,
            x,
        )?;
        v.auto_tab_right = choose_typed(
            &vec![
                "doc_info".into(),
                "tab_defs".into(),
                n.to_string(),
                "autoTabRight".into(),
            ],
            "tab-style",
            &b[n].auto_tab_right,
            &c[n].auto_tab_right,
            &i[n].auto_tab_right,
            r,
            x,
        )?;
        v.tabs = choose(
            &vec![
                "doc_info".into(),
                "tab_defs".into(),
                n.to_string(),
                "tabs".into(),
            ],
            "tab-items",
            MergeConflictReason::SameFieldChanged,
            &b[n].tabs,
            &c[n].tabs,
            &i[n].tabs,
            r,
            x,
        )?;
        v.raw_data = None;
        out.push(v)
    }
    out.extend_from_slice(&c[b.len()..]);
    out.extend_from_slice(&i[b.len()..]);
    Ok(out)
}
fn merge_para_styles(
    b: &[ParaShape],
    c: &[ParaShape],
    i: &[ParaShape],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<ParaShape>, String> {
    if c.len() < b.len() || i.len() < b.len() {
        return merge_list("para_shapes", "paragraph-styles", b, c, i, r, x);
    }
    let mut out = vec![];
    for n in 0..b.len() {
        let mut v = c[n].clone();
        macro_rules! t {
            ($f:ident) => {{
                let p = vec![
                    "doc_info".into(),
                    "para_shapes".into(),
                    n.to_string(),
                    stringify!($f).into(),
                ];
                v.$f = choose_typed(&p, "paragraph-style", &b[n].$f, &c[n].$f, &i[n].$f, r, x)?;
            }};
        }
        macro_rules! a {
            ($f:ident) => {{
                let p = vec![
                    "doc_info".into(),
                    "para_shapes".into(),
                    n.to_string(),
                    stringify!($f).into(),
                ];
                v.$f = choose(
                    &p,
                    "paragraph-style",
                    MergeConflictReason::SameFieldChanged,
                    &b[n].$f,
                    &c[n].$f,
                    &i[n].$f,
                    r,
                    x,
                )?;
            }};
        }
        t!(attr1);
        t!(margin_left);
        t!(margin_right);
        t!(indent);
        t!(spacing_before);
        t!(spacing_after);
        t!(line_spacing);
        a!(alignment);
        a!(line_spacing_type);
        t!(tab_def_id);
        t!(numbering_id);
        t!(border_fill_id);
        t!(border_spacing);
        t!(attr2);
        t!(attr3);
        t!(line_spacing_v2);
        a!(head_type);
        t!(para_level);
        t!(break_latin_word);
        v.raw_data = None;
        out.push(v)
    }
    out.extend_from_slice(&c[b.len()..]);
    out.extend_from_slice(&i[b.len()..]);
    Ok(out)
}
fn merge_numberings(
    b: &[Numbering],
    c: &[Numbering],
    i: &[Numbering],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<Numbering>, String> {
    if c.len() < b.len() || i.len() < b.len() {
        return merge_list("numberings", "numbering", b, c, i, r, x);
    }
    let mut out = vec![];
    for n in 0..b.len() {
        let mut v = c[n].clone();
        for h in 0..7 {
            macro_rules! t {
                ($f:ident) => {{
                    let p = vec![
                        "doc_info".into(),
                        "numberings".into(),
                        n.to_string(),
                        "heads".into(),
                        h.to_string(),
                        stringify!($f).into(),
                    ];
                    v.heads[h].$f = choose_typed(
                        &p,
                        "numbering",
                        &b[n].heads[h].$f,
                        &c[n].heads[h].$f,
                        &i[n].heads[h].$f,
                        r,
                        x,
                    )?;
                }};
            }
            t!(attr);
            t!(width_adjust);
            t!(text_distance);
            t!(char_shape_id);
            t!(number_format);
        }
        v.level_formats = choose_typed(
            &vec![
                "doc_info".into(),
                "numberings".into(),
                n.to_string(),
                "levelFormats".into(),
            ],
            "numbering",
            &b[n].level_formats,
            &c[n].level_formats,
            &i[n].level_formats,
            r,
            x,
        )?;
        v.start_number = choose_typed(
            &vec![
                "doc_info".into(),
                "numberings".into(),
                n.to_string(),
                "startNumber".into(),
            ],
            "numbering",
            &b[n].start_number,
            &c[n].start_number,
            &i[n].start_number,
            r,
            x,
        )?;
        v.level_start_numbers = choose_typed(
            &vec![
                "doc_info".into(),
                "numberings".into(),
                n.to_string(),
                "levelStartNumbers".into(),
            ],
            "numbering",
            &b[n].level_start_numbers,
            &c[n].level_start_numbers,
            &i[n].level_start_numbers,
            r,
            x,
        )?;
        v.raw_para_heads = choose_typed(
            &vec![
                "doc_info".into(),
                "numberings".into(),
                n.to_string(),
                "rawParaHeads".into(),
            ],
            "numbering",
            &b[n].raw_para_heads,
            &c[n].raw_para_heads,
            &i[n].raw_para_heads,
            r,
            x,
        )?;
        v.raw_data = None;
        out.push(v)
    }
    out.extend_from_slice(&c[b.len()..]);
    out.extend_from_slice(&i[b.len()..]);
    Ok(out)
}
fn merge_bullets(
    b: &[Bullet],
    c: &[Bullet],
    i: &[Bullet],
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<Vec<Bullet>, String> {
    if c.len() < b.len() || i.len() < b.len() {
        return merge_list("bullets", "bullets", b, c, i, r, x);
    }
    let mut out = vec![];
    for n in 0..b.len() {
        let mut v = c[n].clone();
        macro_rules! t {
            ($f:ident) => {{
                let p = vec![
                    "doc_info".into(),
                    "bullets".into(),
                    n.to_string(),
                    stringify!($f).into(),
                ];
                v.$f = choose_typed(&p, "bullet", &b[n].$f, &c[n].$f, &i[n].$f, r, x)?;
            }};
        }
        t!(attr);
        t!(width_adjust);
        t!(text_distance);
        t!(char_shape_id);
        t!(bullet_char);
        t!(image_bullet);
        t!(image_data);
        t!(check_bullet_char);
        t!(raw_para_head);
        v.raw_data = None;
        out.push(v)
    }
    out.extend_from_slice(&c[b.len()..]);
    out.extend_from_slice(&i[b.len()..]);
    Ok(out)
}
fn merge_doc_properties(
    b: &DocProperties,
    c: &DocProperties,
    i: &DocProperties,
    r: Option<&BTreeMap<String, MergeResolution>>,
    x: &mut Ctx,
) -> Result<DocProperties, String> {
    let mut out = c.clone();
    macro_rules! t {
        ($name:ident) => {
            out.$name = choose_typed(
                &["doc_properties".into(), stringify!($name).into()],
                "document-property",
                &b.$name,
                &c.$name,
                &i.$name,
                r,
                x,
            )?;
        };
    }
    // Raw record and caret are editor-local/derived state, so the target branch
    // owns them and they never create merge conflicts.
    t!(page_start_num);
    t!(footnote_start_num);
    t!(endnote_start_num);
    t!(picture_start_num);
    t!(table_start_num);
    t!(equation_start_num);
    out.section_count = c.section_count;
    out.raw_data = c.raw_data.clone();
    out.caret_list_id = c.caret_list_id;
    out.caret_para_id = c.caret_para_id;
    out.caret_char_pos = c.caret_char_pos;
    Ok(out)
}
fn merge_doc(
    b: &Document,
    c: &Document,
    i: &Document,
    r: Option<&BTreeMap<String, MergeResolution>>,
) -> Result<(Document, MergeAnalysis), String> {
    merge_doc_for_format(b, c, i, r, c.provenance.format)
}

fn merge_doc_for_format(
    b: &Document,
    c: &Document,
    i: &Document,
    r: Option<&BTreeMap<String, MergeResolution>>,
    target_format: crate::model::provenance::SourceFormat,
) -> Result<(Document, MergeAnalysis), String> {
    let prepared = prepare_merge_views_for_format(b, c, i, target_format)?;
    let current = &prepared.current;
    let incoming = &prepared.incoming;
    let mut x = Ctx::new(MergeOptions::default());
    macro_rules! f {
        ($n:ident,$k:literal,$why:expr) => {
            choose(
                &[stringify!($n).into()],
                $k,
                $why,
                &b.$n,
                &current.source.$n,
                &incoming.source.$n,
                r,
                &mut x,
            )?
        };
    }
    let header = f!(header, "file-header", MergeConflictReason::SameFieldChanged);
    let mut doc_properties = merge_doc_properties(
        &b.doc_properties,
        &current.source.doc_properties,
        &incoming.source.doc_properties,
        r,
        &mut x,
    )?;
    let mut doc_info = merge_doc_info(
        &b.doc_info,
        current.doc_info(),
        incoming.doc_info(),
        r,
        &mut x,
    )?;
    let preview = f!(preview, "preview", MergeConflictReason::SameFieldChanged);
    let (bin_data_list, bin_data_content) =
        merge_bin_data_resources(b, c, i, &prepared.bin_data, r, &mut x)?;
    doc_info.bin_data_list = bin_data_list;
    let extra_streams = choose_opaque_streams(
        &["extra_streams".into()],
        "opaque-streams",
        &b.extra_streams,
        &c.extra_streams,
        &incoming.source.extra_streams,
        r,
        &mut x,
    )?;
    let hwpx_aux_entries = choose_opaque_streams(
        &["hwpx_aux_entries".into()],
        "opaque-hwpx-resources",
        &b.hwpx_aux_entries,
        &c.hwpx_aux_entries,
        &incoming.source.hwpx_aux_entries,
        r,
        &mut x,
    )?;
    let is_hwp3_variant = f!(
        is_hwp3_variant,
        "source-property",
        MergeConflictReason::SameFieldChanged
    );
    let is_hwpx_variant = f!(
        is_hwpx_variant,
        "source-property",
        MergeConflictReason::SameFieldChanged
    );
    let mut provenance = f!(
        provenance,
        "source-property",
        MergeConflictReason::SameFieldChanged
    );
    // Materialization always preserves the current container format. Keep the
    // model's reference semantics aligned with that serializer target even
    // when the incoming document came from another format.
    provenance.format = target_format;
    let sections = merge_sections(
        &b.sections,
        current.sections(),
        incoming.sections(),
        r,
        &mut x,
    )?;
    doc_properties.section_count = u16::try_from(sections.len())
        .map_err(|_| "merged section count exceeds u16".to_string())?;
    let d = Document {
        header,
        doc_properties,
        doc_info,
        sections,
        preview,
        bin_data_content,
        extra_streams,
        hwpx_aux_entries,
        is_hwp3_variant,
        is_hwpx_variant,
        provenance,
    };
    x.conflicts
        .sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
    let a = MergeAnalysis {
        analysis_version: ANALYSIS_VERSION,
        result: summary(&d),
        conflicts: x.conflicts,
        automatic_operation_count: x.auto,
        visited_node_count: x.visited,
        budget_exceeded: x.exceeded,
    };
    Ok((d, a))
}
fn fmt(bytes: &[u8]) -> Result<FileFormat, String> {
    match detect_format(bytes) {
        f @ (FileFormat::Hwp | FileFormat::Hwpx) => Ok(f),
        x => Err(format!("merge supports HWP/HWPX, got {x:?}")),
    }
}
fn parse(bytes: &[u8], name: &str) -> Result<Document, String> {
    fmt(bytes)?;
    parse_document(bytes).map_err(|e| format!("failed to parse {name}: {e}"))
}
fn counts(d: &Document) -> (usize, usize, usize, usize) {
    (
        d.sections.len(),
        d.sections.iter().map(|s| s.paragraphs.len()).sum(),
        d.sections
            .iter()
            .flat_map(|s| &s.paragraphs)
            .map(|p| p.controls.len())
            .sum(),
        d.bin_data_content.len(),
    )
}
fn validate_resource_dependencies(d: &Document) -> Result<(), String> {
    use crate::model::bin_data::BinDataType;
    use crate::model::provenance::SourceFormat;

    ensure_positional_count("style", d.doc_info.styles.len(), usize::from(u8::MAX) + 1)?;
    ensure_positional_count(
        "paragraph-shape",
        d.doc_info.para_shapes.len(),
        usize::from(u16::MAX) + 1,
    )?;
    ensure_positional_count(
        "character-shape",
        d.doc_info.char_shapes.len(),
        usize::from(u16::MAX) + 1,
    )?;
    ensure_positional_count(
        "tab-definition",
        d.doc_info.tab_defs.len(),
        usize::from(u16::MAX) + 1,
    )?;
    ensure_positional_count(
        "numbering",
        d.doc_info.numberings.len(),
        usize::from(u16::MAX),
    )?;
    ensure_positional_count("bullet", d.doc_info.bullets.len(), usize::from(u16::MAX))?;
    ensure_positional_count(
        "border-fill",
        d.doc_info.border_fills.len(),
        usize::from(u16::MAX),
    )?;
    for (language, fonts) in d.doc_info.font_faces.iter().enumerate() {
        ensure_positional_count(
            &format!("font-face language {language}"),
            fonts.len(),
            usize::from(u16::MAX) + 1,
        )?;
    }

    let mut content_ids = BTreeSet::new();
    let mut declared_content_ids = BTreeSet::new();
    let mut chart_ids = BTreeSet::new();
    for content in &d.bin_data_content {
        if content.id == 0 || !content_ids.insert(content.id) {
            return Err(format!(
                "invalid or duplicate BinData content id {}",
                content.id
            ));
        }
        if content.extension == "ooxml_chart" {
            if content.id <= 60000 {
                return Err(format!(
                    "OOXML chart content id {} is outside the chart resource domain",
                    content.id
                ));
            }
            chart_ids.insert(content.id);
        } else {
            declared_content_ids.insert(content.id);
        }
    }
    let target_hwpx = matches!(d.provenance.format, SourceFormat::Hwpx | SourceFormat::Hml);
    let mut storage_ids = BTreeSet::new();
    for (slot, declaration) in d.doc_info.bin_data_list.iter().enumerate() {
        if declaration.storage_id == 0 {
            if target_hwpx || !matches!(declaration.data_type, BinDataType::Link) {
                return Err(format!(
                    "BinData declaration {} has invalid zero storage id",
                    slot + 1
                ));
            }
            continue;
        }
        if !storage_ids.insert(declaration.storage_id) {
            return Err(format!(
                "duplicate BinData declaration storage id {}",
                declaration.storage_id
            ));
        }
        if matches!(
            declaration.data_type,
            BinDataType::Embedding | BinDataType::Storage
        ) && !declared_content_ids.contains(&declaration.storage_id)
        {
            return Err(format!(
                "BinData declaration {} references missing content id {}",
                slot + 1,
                declaration.storage_id
            ));
        }
    }
    for content in d
        .bin_data_content
        .iter()
        .filter(|content| content.extension != "ooxml_chart")
    {
        if !storage_ids.contains(&content.id) {
            return Err(format!(
                "BinData content id {} has no matching declaration",
                content.id
            ));
        }
    }
    let image_refs = if target_hwpx {
        storage_ids.clone()
    } else {
        d.doc_info
            .bin_data_list
            .iter()
            .enumerate()
            .filter_map(|(index, _)| u16::try_from(index + 1).ok())
            .collect::<BTreeSet<_>>()
    };
    fn require_ref(kind: &str, id: u16, valid: &BTreeSet<u16>) -> Result<(), String> {
        if id == 0 || !valid.contains(&id) {
            return Err(format!("{kind} references missing BinData id {id}"));
        }
        Ok(())
    }
    fn image_fill(
        fill: &crate::model::style::Fill,
        kind: &str,
        image_refs: &BTreeSet<u16>,
    ) -> Result<(), String> {
        if let Some(image) = &fill.image {
            if image.bin_data_id != 0 {
                require_ref(kind, image.bin_data_id, image_refs)?;
            }
        }
        Ok(())
    }
    for (index, border_fill) in d.doc_info.border_fills.iter().enumerate() {
        image_fill(
            &border_fill.fill,
            &format!("border fill {index} image"),
            &image_refs,
        )?;
    }
    for (language, fonts) in d.doc_info.font_faces.iter().enumerate() {
        for (index, font) in fonts.iter().enumerate() {
            if let Some(id) = font.resolved_bin_data_id {
                require_ref(
                    &format!("font {index} in language {language}"),
                    id,
                    &storage_ids,
                )?;
            } else if font.is_embedded && !font.bin_item_id_ref.is_empty() {
                return Err(format!(
                    "embedded font {index} in language {language} has unresolved binaryItemIDRef `{}`",
                    font.bin_item_id_ref
                ));
            }
            if let Some(id) = font
                .subst_font
                .as_ref()
                .and_then(|substitute| substitute.resolved_bin_data_id)
            {
                require_ref(
                    &format!("substitute font {index} in language {language}"),
                    id,
                    &storage_ids,
                )?;
            } else if font.subst_font.as_ref().is_some_and(|substitute| {
                substitute.is_embedded && !substitute.bin_item_id_ref.is_empty()
            }) {
                return Err(format!(
                    "embedded substitute font {index} in language {language} has unresolved binaryItemIDRef"
                ));
            }
        }
    }
    for (n, style) in d.doc_info.styles.iter().enumerate() {
        if style.next_style_id != u8::MAX
            && !d.doc_info.styles.is_empty()
            && style.next_style_id as usize >= d.doc_info.styles.len()
        {
            return Err(format!(
                "style {n} has invalid next-style id {}",
                style.next_style_id
            ));
        }
        if !d.doc_info.para_shapes.is_empty()
            && style.para_shape_id as usize >= d.doc_info.para_shapes.len()
        {
            return Err(format!(
                "style {n} has invalid paragraph-style id {}",
                style.para_shape_id
            ));
        }
        if !d.doc_info.char_shapes.is_empty()
            && style.char_shape_id as usize >= d.doc_info.char_shapes.len()
        {
            return Err(format!(
                "style {n} has invalid character-style id {}",
                style.char_shape_id
            ));
        }
    }
    for (n, shape) in d.doc_info.char_shapes.iter().enumerate() {
        for (lang, font) in shape.font_ids.iter().enumerate() {
            let font_count = d.doc_info.font_faces.get(lang).map_or(0, Vec::len);
            if (font_count == 0 && *font != 0) || (font_count != 0 && *font as usize >= font_count)
            {
                return Err(format!(
                    "character style {n} references missing font {font} in language {lang}"
                ));
            }
        }
        if shape.border_fill_id != 0
            && shape.border_fill_id as usize > d.doc_info.border_fills.len()
        {
            return Err(format!(
                "character style {n} references missing border fill {}",
                shape.border_fill_id
            ));
        }
    }
    for (n, shape) in d.doc_info.para_shapes.iter().enumerate() {
        if (d.doc_info.tab_defs.is_empty() && shape.tab_def_id != 0)
            || (!d.doc_info.tab_defs.is_empty()
                && shape.tab_def_id as usize >= d.doc_info.tab_defs.len())
        {
            return Err(format!(
                "paragraph style {n} references missing tab definition {}",
                shape.tab_def_id
            ));
        }
        let referenced_count = match shape.head_type {
            HeadType::Bullet => Some(("bullet", d.doc_info.bullets.len())),
            HeadType::Number | HeadType::Outline => {
                Some(("numbering", d.doc_info.numberings.len()))
            }
            HeadType::None => None,
        };
        if let Some((kind, count)) = referenced_count {
            if shape.numbering_id != 0 && shape.numbering_id as usize > count {
                return Err(format!(
                    "paragraph style {n} references missing {kind} {}",
                    shape.numbering_id
                ));
            }
        }
        if shape.border_fill_id != 0
            && shape.border_fill_id as usize > d.doc_info.border_fills.len()
        {
            return Err(format!(
                "paragraph style {n} references missing border fill {}",
                shape.border_fill_id
            ));
        }
    }
    for (n, numbering) in d.doc_info.numberings.iter().enumerate() {
        for head in &numbering.heads {
            if head.char_shape_id != u32::MAX
                && !d.doc_info.char_shapes.is_empty()
                && head.char_shape_id as usize >= d.doc_info.char_shapes.len()
            {
                return Err(format!(
                    "numbering {n} references missing character style {}",
                    head.char_shape_id
                ));
            }
        }
    }
    for (n, bullet) in d.doc_info.bullets.iter().enumerate() {
        if bullet.image_bullet != 0 {
            let id = u16::try_from(bullet.image_bullet).map_err(|_| {
                format!(
                    "image bullet {n} has invalid BinData id {}",
                    bullet.image_bullet
                )
            })?;
            require_ref(&format!("image bullet {n}"), id, &image_refs)?;
            if target_hwpx {
                let raw = bullet.raw_para_head.as_deref().ok_or_else(|| {
                    format!("image bullet {n} has no serialized hh:img reference")
                })?;
                let identity = BTreeMap::from([(id, id)]);
                let (_, found) = remap_raw_binary_item_refs(raw, &identity)?;
                if !found {
                    return Err(format!(
                        "image bullet {n} raw binaryItemIDRef does not match typed id {id}"
                    ));
                }
            }
        }
        if bullet.char_shape_id != u32::MAX
            && !d.doc_info.char_shapes.is_empty()
            && bullet.char_shape_id as usize >= d.doc_info.char_shapes.len()
        {
            return Err(format!(
                "bullet {n} references missing character style {}",
                bullet.char_shape_id
            ));
        }
    }
    fn picture(p: &Picture, image_refs: &BTreeSet<u16>) -> Result<(), String> {
        let id = p.image_attr.bin_data_id;
        if id != 0 {
            require_ref("picture", id, image_refs)?;
        }
        Ok(())
    }
    fn drawing(
        d: &DrawingObjAttr,
        image_refs: &BTreeSet<u16>,
        storage_ids: &BTreeSet<u16>,
        chart_ids: &BTreeSet<u16>,
    ) -> Result<(), String> {
        image_fill(&d.fill, "shape fill image", image_refs)?;
        if let Some(tb) = &d.text_box {
            paras(&tb.paragraphs, image_refs, storage_ids, chart_ids)?;
        }
        if let Some(c) = &d.caption {
            paras(&c.paragraphs, image_refs, storage_ids, chart_ids)?;
        }
        Ok(())
    }
    fn shape(
        s: &ShapeObject,
        image_refs: &BTreeSet<u16>,
        storage_ids: &BTreeSet<u16>,
        chart_ids: &BTreeSet<u16>,
    ) -> Result<(), String> {
        if let Some(drawing_attr) = s.drawing() {
            drawing(drawing_attr, image_refs, storage_ids, chart_ids)?;
        }
        match s {
            ShapeObject::Picture(p) => {
                picture(p, image_refs)?;
                if let Some(c) = &p.caption {
                    paras(&c.paragraphs, image_refs, storage_ids, chart_ids)?;
                }
            }
            ShapeObject::Group(g) => {
                if let Some(c) = &g.caption {
                    paras(&c.paragraphs, image_refs, storage_ids, chart_ids)?;
                }
                for child in &g.children {
                    shape(child, image_refs, storage_ids, chart_ids)?;
                }
            }
            ShapeObject::Ole(o) => {
                if o.bin_data_id != 0 {
                    let id = u16::try_from(o.bin_data_id)
                        .map_err(|_| format!("OLE has invalid BinData id {}", o.bin_data_id))?;
                    if !chart_ids.contains(&id) {
                        require_ref("OLE", id, storage_ids)?;
                    }
                }
                if let Some(c) = &o.caption {
                    paras(&c.paragraphs, image_refs, storage_ids, chart_ids)?;
                }
            }
            ShapeObject::Chart(chart) => {
                if let Some(c) = &chart.caption {
                    paras(&c.paragraphs, image_refs, storage_ids, chart_ids)?;
                }
            }
            ShapeObject::Line(_)
            | ShapeObject::Rectangle(_)
            | ShapeObject::Ellipse(_)
            | ShapeObject::Arc(_)
            | ShapeObject::Polygon(_)
            | ShapeObject::Curve(_) => {}
        }
        Ok(())
    }
    fn paras(
        ps: &[Paragraph],
        image_refs: &BTreeSet<u16>,
        storage_ids: &BTreeSet<u16>,
        chart_ids: &BTreeSet<u16>,
    ) -> Result<(), String> {
        for p in ps {
            for ctrl in &p.controls {
                match ctrl {
                    Control::SectionDef(section_def) => {
                        for page in &section_def.master_pages {
                            paras(&page.paragraphs, image_refs, storage_ids, chart_ids)?;
                        }
                    }
                    Control::Picture(v) => {
                        picture(v, image_refs)?;
                        if let Some(c) = &v.caption {
                            paras(&c.paragraphs, image_refs, storage_ids, chart_ids)?;
                        }
                    }
                    Control::Shape(v) => shape(v, image_refs, storage_ids, chart_ids)?,
                    Control::Table(v) => {
                        for cell in &v.cells {
                            paras(&cell.paragraphs, image_refs, storage_ids, chart_ids)?;
                        }
                        if let Some(c) = &v.caption {
                            paras(&c.paragraphs, image_refs, storage_ids, chart_ids)?
                        }
                    }
                    Control::Header(v) => paras(&v.paragraphs, image_refs, storage_ids, chart_ids)?,
                    Control::Footer(v) => paras(&v.paragraphs, image_refs, storage_ids, chart_ids)?,
                    Control::Footnote(v) => {
                        paras(&v.paragraphs, image_refs, storage_ids, chart_ids)?
                    }
                    Control::Endnote(v) => {
                        paras(&v.paragraphs, image_refs, storage_ids, chart_ids)?
                    }
                    Control::HiddenComment(v) => {
                        paras(&v.paragraphs, image_refs, storage_ids, chart_ids)?
                    }
                    Control::Field(v) => {
                        paras(&v.memo_paragraphs, image_refs, storage_ids, chart_ids)?
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
    #[derive(Clone, Copy)]
    struct PositionalCounts {
        styles: usize,
        para_shapes: usize,
        char_shapes: usize,
        border_fills: usize,
        numberings: usize,
    }
    fn zero_based_ref(kind: &str, id: u64, count: usize) -> Result<(), String> {
        if (count == 0 && id != 0) || (count != 0 && id >= count as u64) {
            return Err(format!("{kind} references missing positional id {id}"));
        }
        Ok(())
    }
    fn one_based_ref(kind: &str, id: u16, count: usize) -> Result<(), String> {
        if id != 0 && id as usize > count {
            return Err(format!("{kind} references missing positional id {id}"));
        }
        Ok(())
    }
    fn section_def_refs(section_def: &SectionDef, counts: PositionalCounts) -> Result<(), String> {
        one_based_ref(
            "section outline numbering",
            section_def.outline_numbering_id,
            counts.numberings,
        )?;
        one_based_ref(
            "page border fill",
            section_def.page_border_fill.border_fill_id,
            counts.border_fills,
        )?;
        for fill in &section_def.extra_page_border_fills {
            one_based_ref(
                "extra page border fill",
                fill.border_fill_id,
                counts.border_fills,
            )?;
        }
        for page in &section_def.master_pages {
            paragraph_refs(&page.paragraphs, counts)?;
        }
        Ok(())
    }
    fn drawing_refs(d: &DrawingObjAttr, counts: PositionalCounts) -> Result<(), String> {
        if let Some(tb) = &d.text_box {
            paragraph_refs(&tb.paragraphs, counts)?
        }
        if let Some(c) = &d.caption {
            paragraph_refs(&c.paragraphs, counts)?
        }
        Ok(())
    }
    fn shape_refs(s: &ShapeObject, counts: PositionalCounts) -> Result<(), String> {
        if let Some(d) = s.drawing() {
            drawing_refs(d, counts)?
        }
        match s {
            ShapeObject::Group(v) => {
                if let Some(c) = &v.caption {
                    paragraph_refs(&c.paragraphs, counts)?
                }
                for child in &v.children {
                    shape_refs(child, counts)?
                }
            }
            ShapeObject::Picture(v) => {
                if let Some(c) = &v.caption {
                    paragraph_refs(&c.paragraphs, counts)?
                }
            }
            ShapeObject::Chart(v) => {
                if let Some(c) = &v.caption {
                    paragraph_refs(&c.paragraphs, counts)?
                }
            }
            ShapeObject::Ole(v) => {
                if let Some(c) = &v.caption {
                    paragraph_refs(&c.paragraphs, counts)?
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn paragraph_refs(ps: &[Paragraph], counts: PositionalCounts) -> Result<(), String> {
        for p in ps {
            zero_based_ref("paragraph style", u64::from(p.style_id), counts.styles)?;
            zero_based_ref(
                "paragraph shape",
                u64::from(p.para_shape_id),
                counts.para_shapes,
            )?;
            for cs in &p.char_shapes {
                zero_based_ref(
                    "formatting interval character shape",
                    u64::from(cs.char_shape_id),
                    counts.char_shapes,
                )?;
            }
            for control in &p.controls {
                match control {
                    Control::SectionDef(section_def) => section_def_refs(section_def, counts)?,
                    Control::Table(v) => {
                        one_based_ref("table border fill", v.border_fill_id, counts.border_fills)?;
                        for zone in &v.zones {
                            one_based_ref(
                                "table-zone border fill",
                                zone.border_fill_id,
                                counts.border_fills,
                            )?;
                        }
                        for cell in &v.cells {
                            one_based_ref(
                                "table-cell border fill",
                                cell.border_fill_id,
                                counts.border_fills,
                            )?;
                            paragraph_refs(&cell.paragraphs, counts)?
                        }
                        if let Some(c) = &v.caption {
                            paragraph_refs(&c.paragraphs, counts)?
                        }
                    }
                    Control::Shape(v) => shape_refs(v, counts)?,
                    Control::Picture(v) => {
                        if let Some(c) = &v.caption {
                            paragraph_refs(&c.paragraphs, counts)?
                        }
                    }
                    Control::Header(v) => paragraph_refs(&v.paragraphs, counts)?,
                    Control::Footer(v) => paragraph_refs(&v.paragraphs, counts)?,
                    Control::Footnote(v) => paragraph_refs(&v.paragraphs, counts)?,
                    Control::Endnote(v) => paragraph_refs(&v.paragraphs, counts)?,
                    Control::HiddenComment(v) => paragraph_refs(&v.paragraphs, counts)?,
                    Control::Field(v) => paragraph_refs(&v.memo_paragraphs, counts)?,
                    Control::Ruby(v) => {
                        zero_based_ref("ruby style", u64::from(v.style_id_ref), counts.styles)?
                    }
                    Control::CharOverlap(v) => {
                        for id in &v.char_shape_ids {
                            if *id != u32::MAX {
                                zero_based_ref(
                                    "character overlap character shape",
                                    u64::from(*id),
                                    counts.char_shapes,
                                )?;
                            }
                        }
                    }
                    Control::Form(v) => {
                        if let Some(value) = v.properties.get("CharShapeID") {
                            let id = value
                                .parse::<u32>()
                                .map_err(|_| "form CharShapeID is not numeric".to_string())?;
                            if id != u32::MAX {
                                zero_based_ref(
                                    "form character shape",
                                    u64::from(id),
                                    counts.char_shapes,
                                )?;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
    let positional_counts = PositionalCounts {
        styles: d.doc_info.styles.len(),
        para_shapes: d.doc_info.para_shapes.len(),
        char_shapes: d.doc_info.char_shapes.len(),
        border_fills: d.doc_info.border_fills.len(),
        numberings: d.doc_info.numberings.len(),
    };
    for section in &d.sections {
        section_def_refs(&section.section_def, positional_counts)?;
        paragraph_refs(&section.paragraphs, positional_counts)?;
        paras(&section.paragraphs, &image_refs, &storage_ids, &chart_ids)?;
        for page in &section.section_def.master_pages {
            paras(&page.paragraphs, &image_refs, &storage_ids, &chart_ids)?;
        }
    }
    Ok(())
}
pub fn analyze_document_bytes(b: &[u8], c: &[u8], i: &[u8]) -> Result<MergeAnalysis, String> {
    merge_doc(
        &parse(b, "base")?,
        &parse(c, "current")?,
        &parse(i, "incoming")?,
        None,
    )
    .map(|x| x.1)
}
pub fn materialize_document_bytes(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    r: &BTreeMap<String, MergeResolution>,
) -> Result<Vec<u8>, String> {
    let format = fmt(c)?;
    let (d, a) = merge_doc(
        &parse(b, "base")?,
        &parse(c, "current")?,
        &parse(i, "incoming")?,
        Some(r),
    )?;
    for x in &a.conflicts {
        if !r.contains_key(&x.id) {
            return Err(format!("{} is unresolved", x.id));
        }
    }
    validate_resource_dependencies(&d)?;
    let expected = counts(&d);
    let bytes = match format {
        FileFormat::Hwp => serialize_hwp(&d),
        FileFormat::Hwpx => serialize_hwpx(&d),
        _ => unreachable!(),
    }
    .map_err(|e| e.to_string())?;
    if detect_format(&bytes) != format {
        return Err("export changed current format".into());
    }
    let loaded =
        parse_regenerated_document(&bytes).map_err(|e| format!("reload validation failed: {e}"))?;
    validate_resource_dependencies(&loaded)?;
    if counts(&loaded) != expected {
        return Err(format!(
            "structural validation failed: {:?} != {expected:?}",
            counts(&loaded)
        ));
    }
    Ok(bytes)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestHint {
    #[serde(default, alias = "identityHint")]
    identity: Option<String>,
    kind: String,
    path: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
struct ManifestHints {
    #[serde(default)]
    entries: Vec<ManifestHint>,
}
#[derive(Default)]
struct ManifestRestore {
    paragraphs: BTreeMap<u32, Vec<u8>>,
    controls: BTreeMap<u32, u32>,
}
fn paragraph_at_manifest_path<'a>(
    doc: &'a mut Document,
    path: &[String],
) -> Option<&'a mut Paragraph> {
    fn caption<'a>(value: &'a mut Option<Caption>, path: &[String]) -> Option<&'a mut Paragraph> {
        within(&mut value.as_mut()?.paragraphs, path)
    }
    fn shape<'a>(value: &'a mut ShapeObject, path: &[String]) -> Option<&'a mut Paragraph> {
        if path.first().is_some_and(|v| v == "children") {
            let n = path.get(1)?.parse::<usize>().ok()?;
            let ShapeObject::Group(g) = value else {
                return None;
            };
            return shape(g.children.get_mut(n)?, &path[2..]);
        }
        if path.first().is_some_and(|v| v == "drawing") {
            let drawing = value.drawing_mut()?;
            return match path.get(1)?.as_str() {
                "textBox" => within(&mut drawing.text_box.as_mut()?.paragraphs, &path[2..]),
                "caption" => caption(&mut drawing.caption, &path[2..]),
                _ => None,
            };
        }
        if path.first().is_some_and(|v| v == "caption") {
            return match value {
                ShapeObject::Group(v) => caption(&mut v.caption, &path[1..]),
                ShapeObject::Picture(v) => caption(&mut v.caption, &path[1..]),
                ShapeObject::Chart(v) => caption(&mut v.caption, &path[1..]),
                ShapeObject::Ole(v) => caption(&mut v.caption, &path[1..]),
                _ => None,
            };
        }
        None
    }
    fn within<'a>(
        paragraphs: &'a mut Vec<Paragraph>,
        path: &[String],
    ) -> Option<&'a mut Paragraph> {
        if path.first()?.as_str() != "paragraphs" {
            return None;
        }
        let n = path.get(1)?.parse::<usize>().ok()?;
        let para = paragraphs.get_mut(n)?;
        let rest = &path[2..];
        if rest.is_empty() {
            return Some(para);
        }
        if rest.first()?.as_str() != "controls" {
            return None;
        }
        let k = rest.get(1)?.parse::<usize>().ok()?;
        let control = para.controls.get_mut(k)?;
        let rest = &rest[2..];
        match control {
            Control::Table(v) => match rest.first()?.as_str() {
                "cells" => {
                    let cell = rest.get(1)?.parse::<usize>().ok()?;
                    within(&mut v.cells.get_mut(cell)?.paragraphs, &rest[2..])
                }
                "caption" => caption(&mut v.caption, &rest[1..]),
                _ => None,
            },
            Control::Shape(v) => shape(v, rest),
            Control::Picture(v) if rest.first().is_some_and(|v| v == "caption") => {
                caption(&mut v.caption, &rest[1..])
            }
            Control::Header(v) => within(&mut v.paragraphs, rest),
            Control::Footer(v) => within(&mut v.paragraphs, rest),
            Control::Footnote(v) => within(&mut v.paragraphs, rest),
            Control::Endnote(v) => within(&mut v.paragraphs, rest),
            Control::HiddenComment(v) => within(&mut v.paragraphs, rest),
            Control::Field(v) => {
                let p = rest.iter().position(|v| v == "paragraphs")?;
                within(&mut v.memo_paragraphs, &rest[p..])
            }
            _ => None,
        }
    }
    let s = path.iter().position(|v| v == "sections")?;
    let section = doc
        .sections
        .get_mut(path.get(s + 1)?.parse::<usize>().ok()?)?;
    let rest = &path[s + 2..];
    if rest.first().is_some_and(|v| v == "masterPages") {
        let page = section
            .section_def
            .master_pages
            .get_mut(rest.get(1)?.parse::<usize>().ok()?)?;
        within(&mut page.paragraphs, &rest[2..])
    } else {
        within(&mut section.paragraphs, rest)
    }
}
fn manifest_identity_ids(manifests: [&ManifestHints; 3]) -> BTreeMap<String, u32> {
    let ids = manifests
        .iter()
        .flat_map(|m| &m.entries)
        .filter_map(|e| e.identity.clone())
        .collect::<BTreeSet<_>>();
    let mut used = BTreeSet::new();
    let mut out = BTreeMap::new();
    for identity in ids {
        let hash = blake3::hash(identity.as_bytes());
        let mut id = u32::from_le_bytes(hash.as_bytes()[..4].try_into().unwrap()) | 1;
        while used.contains(&id) {
            id = id.wrapping_add(2) | 1;
        }
        used.insert(id);
        out.insert(identity, id);
    }
    out
}
fn apply_manifest_ids(
    doc: &mut Document,
    manifest: &ManifestHints,
    ids: &BTreeMap<String, u32>,
    restore: &mut ManifestRestore,
) {
    for entry in &manifest.entries {
        let Some(identity) = &entry.identity else {
            continue;
        };
        let Some(id) = ids.get(identity).copied() else {
            continue;
        };
        if entry.kind == "paragraph" {
            let Some(para) = paragraph_at_manifest_path(doc, &entry.path) else {
                continue;
            };
            restore
                .paragraphs
                .entry(id)
                .or_insert_with(|| para.raw_header_extra.clone());
            if para.raw_header_extra.len() < 10 {
                para.raw_header_extra.resize(10, 0)
            }
            para.raw_header_extra[6..10].copy_from_slice(&id.to_le_bytes());
            continue;
        }
        let Some(control_pos) = entry.path.iter().rposition(|v| v == "controls") else {
            continue;
        };
        let Some(k) = entry
            .path
            .get(control_pos + 1)
            .and_then(|v| v.parse::<usize>().ok())
        else {
            continue;
        };
        let Some(para) = paragraph_at_manifest_path(doc, &entry.path[..control_pos]) else {
            continue;
        };
        let Some(control) = para.controls.get_mut(k) else {
            continue;
        };
        let slot = match control {
            Control::Table(v) => Some(&mut v.common.instance_id),
            Control::Shape(v) => Some(&mut v.common_mut().instance_id),
            Control::Picture(v) => Some(&mut v.common.instance_id),
            Control::Equation(v) => Some(&mut v.common.instance_id),
            Control::Footnote(v) => Some(&mut v.instance_id),
            Control::Endnote(v) => Some(&mut v.instance_id),
            Control::Field(v) => Some(&mut v.field_id),
            _ => None,
        };
        if let Some(slot) = slot {
            restore.controls.entry(id).or_insert(*slot);
            *slot = id;
        }
    }
}
fn restore_manifest_ids(doc: &mut Document, restore: &ManifestRestore) {
    for section in &mut doc.sections {
        let mut restore_para = |para: &mut Paragraph| {
            if let Some(raw) = para.raw_header_extra.get(6..10) {
                let id = u32::from_le_bytes(raw.try_into().unwrap());
                if let Some(original) = restore.paragraphs.get(&id) {
                    para.raw_header_extra = original.clone();
                }
            }
            for control in &mut para.controls {
                let slot = match control {
                    Control::Table(v) => Some(&mut v.common.instance_id),
                    Control::Shape(v) => Some(&mut v.common_mut().instance_id),
                    Control::Picture(v) => Some(&mut v.common.instance_id),
                    Control::Equation(v) => Some(&mut v.common.instance_id),
                    Control::Footnote(v) => Some(&mut v.instance_id),
                    Control::Endnote(v) => Some(&mut v.instance_id),
                    Control::Field(v) => Some(&mut v.field_id),
                    _ => None,
                };
                if let Some(slot) = slot {
                    if let Some(original) = restore.controls.get(slot) {
                        *slot = *original
                    }
                }
            }
        };
        visit_nested_paragraphs_mut(&mut section.paragraphs, &mut restore_para);
        for page in &mut section.section_def.master_pages {
            visit_nested_paragraphs_mut(&mut page.paragraphs, &mut restore_para)
        }
    }
}
fn parse_manifests(
    base: &str,
    current: &str,
    incoming: &str,
) -> Result<(ManifestHints, ManifestHints, ManifestHints), String> {
    Ok((
        serde_json::from_str(base).map_err(|e| format!("invalid base manifest: {e}"))?,
        serde_json::from_str(current).map_err(|e| format!("invalid current manifest: {e}"))?,
        serde_json::from_str(incoming).map_err(|e| format!("invalid incoming manifest: {e}"))?,
    ))
}
fn manifest_documents(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    bm: &ManifestHints,
    cm: &ManifestHints,
    im: &ManifestHints,
) -> Result<(Document, Document, Document, ManifestRestore), String> {
    let (mut bd, mut cd, mut id) = (
        parse(b, "base")?,
        parse(c, "current")?,
        parse(i, "incoming")?,
    );
    let ids = manifest_identity_ids([bm, cm, im]);
    let mut restore = ManifestRestore::default();
    // Current identity metadata wins on materialization, then incoming, then base.
    apply_manifest_ids(&mut cd, cm, &ids, &mut restore);
    apply_manifest_ids(&mut id, im, &ids, &mut restore);
    apply_manifest_ids(&mut bd, bm, &ids, &mut restore);
    Ok((bd, cd, id, restore))
}
pub fn analyze_document_bytes_with_manifests(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    base_manifest: &str,
    current_manifest: &str,
    incoming_manifest: &str,
) -> Result<MergeAnalysis, String> {
    let (bm, cm, im) = parse_manifests(base_manifest, current_manifest, incoming_manifest)?;
    let (b, c, i, _) = manifest_documents(b, c, i, &bm, &cm, &im)?;
    merge_doc(&b, &c, &i, None).map(|x| x.1)
}
pub fn materialize_document_bytes_with_manifests(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    base_manifest: &str,
    current_manifest: &str,
    incoming_manifest: &str,
    r: &BTreeMap<String, MergeResolution>,
) -> Result<Vec<u8>, String> {
    let format = fmt(c)?;
    let (bm, cm, im) = parse_manifests(base_manifest, current_manifest, incoming_manifest)?;
    let (b, c, i, restore) = manifest_documents(b, c, i, &bm, &cm, &im)?;
    let (mut d, a) = merge_doc(&b, &c, &i, Some(r))?;
    for item in &a.conflicts {
        if !r.contains_key(&item.id) {
            return Err(format!("{} is unresolved", item.id));
        }
    }
    restore_manifest_ids(&mut d, &restore);
    validate_resource_dependencies(&d)?;
    let expected = counts(&d);
    let bytes = match format {
        FileFormat::Hwp => serialize_hwp(&d),
        FileFormat::Hwpx => serialize_hwpx(&d),
        _ => unreachable!(),
    }
    .map_err(|e| e.to_string())?;
    let loaded = parse_regenerated_document(&bytes)
        .map_err(|e| format!("manifest merge reload validation failed: {e}"))?;
    validate_resource_dependencies(&loaded)?;
    if counts(&loaded) != expected {
        return Err("manifest merge failed structural validation".into());
    }
    Ok(bytes)
}

fn neutralize_paragraphs(values: &[Paragraph]) -> Vec<Paragraph> {
    values
        .iter()
        .map(|p| {
            let mut out = Paragraph::default();
            out.raw_header_extra = p.raw_header_extra.clone();
            out.controls = p
                .controls
                .iter()
                .map(|control| match control {
                    Control::SectionDef(_) => Control::SectionDef(Box::default()),
                    Control::ColumnDef(_) => Control::ColumnDef(Default::default()),
                    Control::Table(t) => {
                        let mut table = Table::default();
                        table.row_count = t.row_count;
                        table.col_count = t.col_count;
                        table.common.instance_id = t.common.instance_id;
                        table.cells = t
                            .cells
                            .iter()
                            .map(|cell| Cell {
                                row: cell.row,
                                col: cell.col,
                                row_span: cell.row_span,
                                col_span: cell.col_span,
                                paragraphs: neutralize_paragraphs(&cell.paragraphs),
                                ..Default::default()
                            })
                            .collect();
                        table.rebuild_grid();
                        Control::Table(Box::new(table))
                    }
                    Control::Picture(v) => {
                        let mut pic = Picture::default();
                        pic.common.instance_id = v.common.instance_id;
                        Control::Picture(Box::new(pic))
                    }
                    Control::Equation(v) => {
                        let mut eq = Equation::default();
                        eq.common.instance_id = v.common.instance_id;
                        Control::Equation(Box::new(eq))
                    }
                    Control::Header(v) => Control::Header(Box::new(Header {
                        paragraphs: neutralize_paragraphs(&v.paragraphs),
                        ..Default::default()
                    })),
                    Control::Footer(v) => Control::Footer(Box::new(Footer {
                        paragraphs: neutralize_paragraphs(&v.paragraphs),
                        ..Default::default()
                    })),
                    Control::Footnote(v) => Control::Footnote(Box::new(Footnote {
                        instance_id: v.instance_id,
                        paragraphs: neutralize_paragraphs(&v.paragraphs),
                        ..Default::default()
                    })),
                    Control::Endnote(v) => Control::Endnote(Box::new(Endnote {
                        instance_id: v.instance_id,
                        paragraphs: neutralize_paragraphs(&v.paragraphs),
                        ..Default::default()
                    })),
                    Control::Field(v) => Control::Field(crate::model::control::Field {
                        field_id: v.field_id,
                        memo_paragraphs: neutralize_paragraphs(&v.memo_paragraphs),
                        ..Default::default()
                    }),
                    Control::HiddenComment(v) => {
                        Control::HiddenComment(Box::new(crate::model::control::HiddenComment {
                            paragraphs: neutralize_paragraphs(&v.paragraphs),
                        }))
                    }
                    other => other.clone(),
                })
                .collect();
            out.ctrl_data_records = vec![None; out.controls.len()];
            out
        })
        .collect()
}
fn neutral_document(template: &Document) -> Document {
    let mut out = template.clone();
    out.header = Default::default();
    out.doc_properties = Default::default();
    out.doc_properties.section_count = template.sections.len().try_into().unwrap_or(u16::MAX);
    let old = &template.doc_info;
    let mut info = DocInfo::default();
    info.bin_data_list = vec![Default::default(); old.bin_data_list.len()];
    info.font_faces = old
        .font_faces
        .iter()
        .map(|g| vec![Default::default(); g.len()])
        .collect();
    info.border_fills = vec![Default::default(); old.border_fills.len()];
    info.char_shapes = vec![Default::default(); old.char_shapes.len()];
    info.tab_defs = vec![Default::default(); old.tab_defs.len()];
    info.numberings = vec![Default::default(); old.numberings.len()];
    info.bullets = vec![Default::default(); old.bullets.len()];
    info.para_shapes = vec![Default::default(); old.para_shapes.len()];
    info.styles = vec![Default::default(); old.styles.len()];
    info.bullet_count = info.bullets.len() as u32;
    out.doc_info = info;
    out.preview = Default::default();
    out.bin_data_content.clear();
    out.extra_streams.clear();
    out.hwpx_aux_entries.clear();
    for (s, section) in out.sections.iter_mut().enumerate() {
        section.section_def = Default::default();
        section.paragraphs = neutralize_paragraphs(&template.sections[s].paragraphs);
        section.raw_stream = None;
    }
    out
}

/// Deterministic n-way virtual base for criss-cross histories. Bases are sorted,
/// then folded through the same recursive merge engine against a topology-
/// preserving neutral IR. Atomic ambiguities use canonical fingerprints.
pub fn synthesize_virtual_base_document_bytes(
    bases: &[Vec<u8>],
    current_format: FileFormat,
) -> Result<Vec<u8>, String> {
    if bases.is_empty() {
        return Err("at least one document merge base is required".into());
    }
    if !matches!(current_format, FileFormat::Hwp | FileFormat::Hwpx) {
        return Err("virtual base output must be HWP or HWPX".into());
    }
    let target_format = match current_format {
        FileFormat::Hwp => crate::model::provenance::SourceFormat::Hwp5,
        FileFormat::Hwpx => crate::model::provenance::SourceFormat::Hwpx,
        _ => unreachable!(),
    };
    let mut docs = bases
        .iter()
        .enumerate()
        .map(|(n, b)| {
            parse(b, &format!("merge base {n}"))
                .map(|document| (*blake3::hash(b).as_bytes(), document))
        })
        .collect::<Result<Vec<_>, _>>()?;
    docs.sort_by_key(|(hash, _)| *hash);
    let mut out = docs.remove(0).1;
    for (_, incoming) in docs {
        let neutral = neutral_document(&out);
        let (_, analysis) = merge_doc_for_format(&neutral, &out, &incoming, None, target_format)?;
        let resolutions = analysis
            .conflicts
            .iter()
            .map(|conflict| {
                let choice = if canonical(&conflict.current) <= canonical(&conflict.incoming) {
                    MergeResolution::Current
                } else {
                    MergeResolution::Incoming
                };
                (conflict.id.clone(), choice)
            })
            .collect::<BTreeMap<_, _>>();
        out = merge_doc_for_format(&neutral, &out, &incoming, Some(&resolutions), target_format)?.0;
    }
    out.doc_properties.section_count = out.sections.len().try_into().unwrap_or(u16::MAX);
    validate_resource_dependencies(&out)?;
    let expected = counts(&out);
    let bytes = match current_format {
        FileFormat::Hwp => serialize_hwp(&out),
        FileFormat::Hwpx => serialize_hwpx(&out),
        _ => unreachable!(),
    }
    .map_err(|e| e.to_string())?;
    let loaded = parse_regenerated_document(&bytes)
        .map_err(|e| format!("virtual base reload validation failed: {e}"))?;
    validate_resource_dependencies(&loaded)?;
    if counts(&loaded) != expected {
        return Err("virtual base failed structural validation".into());
    }
    Ok(bytes)
}

#[wasm_bindgen(js_name=structuralMergeAnalyze)]
pub fn structural_merge_analyze(b: &str, c: &str, i: &str) -> Result<String, JsValue> {
    let p = |s: &str| serde_json::from_str(s).map_err(|e| JsValue::from_str(&e.to_string()));
    serde_json::to_string(&analyze(&p(b)?, &p(c)?, &p(i)?))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen(js_name=structuralMergeAnalyzeWithOptions)]
pub fn structural_merge_analyze_with_options(
    b: &str,
    c: &str,
    i: &str,
    o: &str,
) -> Result<String, JsValue> {
    let b: Value = serde_json::from_str(b).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let c: Value = serde_json::from_str(c).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let i: Value = serde_json::from_str(i).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let o: MergeOptions = serde_json::from_str(o).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_json::to_string(&analyze_with_options(&b, &c, &i, o))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen(js_name=structuralMergeMaterialize)]
pub fn structural_merge_materialize(a: &str, r: &str) -> Result<String, JsValue> {
    let a = serde_json::from_str(a).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let r = serde_json::from_str(r).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_json::to_string(&materialize(&a, &r).map_err(|e| JsValue::from_str(&e))?)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen(js_name=structuralMergeVirtualBase)]
pub fn structural_merge_virtual_base(s: &str) -> Result<String, JsValue> {
    let v: Vec<Value> = serde_json::from_str(s).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_json::to_string(&synthesize_virtual_base(&v).map_err(|e| JsValue::from_str(&e))?)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen(js_name=structuralMergeAnalyzeDocument)]
pub fn structural_merge_analyze_document(b: &[u8], c: &[u8], i: &[u8]) -> Result<String, JsValue> {
    serde_json::to_string(&analyze_document_bytes(b, c, i).map_err(|e| JsValue::from_str(&e))?)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen(js_name=structuralMergeMaterializeDocument)]
pub fn structural_merge_materialize_document(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    r: &str,
) -> Result<Vec<u8>, JsValue> {
    let r = serde_json::from_str(r).map_err(|e| JsValue::from_str(&e.to_string()))?;
    materialize_document_bytes(b, c, i, &r).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name=structuralMergeAnalyzeDocumentWithManifests)]
pub fn structural_merge_analyze_document_with_manifests(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    base_manifest: &str,
    current_manifest: &str,
    incoming_manifest: &str,
) -> Result<String, JsValue> {
    serde_json::to_string(
        &analyze_document_bytes_with_manifests(
            b,
            c,
            i,
            base_manifest,
            current_manifest,
            incoming_manifest,
        )
        .map_err(|e| JsValue::from_str(&e))?,
    )
    .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen(js_name=structuralMergeMaterializeDocumentWithManifests)]
pub fn structural_merge_materialize_document_with_manifests(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    base_manifest: &str,
    current_manifest: &str,
    incoming_manifest: &str,
    resolutions: &str,
) -> Result<Vec<u8>, JsValue> {
    let r = serde_json::from_str(resolutions).map_err(|e| JsValue::from_str(&e.to_string()))?;
    materialize_document_bytes_with_manifests(
        b,
        c,
        i,
        base_manifest,
        current_manifest,
        incoming_manifest,
        &r,
    )
    .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name=structuralMergeVirtualBaseDocument)]
pub fn structural_merge_virtual_base_document(
    bases_base64_json: &str,
    current_format: &str,
) -> Result<Vec<u8>, JsValue> {
    let encoded: Vec<String> =
        serde_json::from_str(bases_base64_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let bases = encoded
        .iter()
        .map(|s| {
            base64::engine::general_purpose::STANDARD
                .decode(s)
                .map_err(|e| JsValue::from_str(&e.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let format = match current_format {
        "hwp" => FileFormat::Hwp,
        "hwpx" => FileFormat::Hwpx,
        _ => return Err(JsValue::from_str("currentFormat must be hwp or hwpx")),
    };
    synthesize_virtual_base_document_bytes(&bases, format).map_err(|e| JsValue::from_str(&e))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralManifestEntry {
    pub kind: String,
    pub path: Vec<String>,
    pub property_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_hint: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralManifest {
    pub analysis_version: u32,
    pub entries: Vec<StructuralManifestEntry>,
}

struct ManifestSizeCounter {
    bytes: usize,
    limit: usize,
}

impl std::io::Write for ManifestSizeCounter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let next = self
            .bytes
            .checked_add(data.len())
            .ok_or_else(|| std::io::Error::other("structural manifest size overflow"))?;
        if next > self.limit {
            return Err(std::io::Error::other(format!(
                "structural manifest exceeds the {} byte output limit",
                self.limit
            )));
        }
        self.bytes = next;
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct ManifestEntries {
    values: Vec<StructuralManifestEntry>,
    encoded_bytes: usize,
    output_limit: usize,
}

impl ManifestEntries {
    // The serialized wrapper is currently much smaller than this. Reserving a
    // fixed upper bound keeps per-entry checks simple and fail-closed.
    const WRAPPER_BUDGET: usize = 128;

    fn new(output_limit: usize) -> Result<Self, String> {
        if output_limit < Self::WRAPPER_BUDGET {
            return Err(format!(
                "structural manifest exceeds the {output_limit} byte output limit"
            ));
        }
        Ok(Self {
            values: Vec::new(),
            encoded_bytes: Self::WRAPPER_BUDGET,
            output_limit,
        })
    }

    fn push<T: Debug>(
        &mut self,
        kind: &str,
        path: Vec<String>,
        value: &T,
        identity_hint: Option<String>,
    ) -> Result<(), String> {
        let entry = StructuralManifestEntry {
            kind: kind.into(),
            path,
            property_hash: format!("blake3:{}", dh(value).to_hex()),
            identity_hint,
        };
        let remaining = self.output_limit.saturating_sub(self.encoded_bytes);
        let mut counter = ManifestSizeCounter {
            bytes: 0,
            limit: remaining,
        };
        serde_json::to_writer(&mut counter, &entry).map_err(|error| {
            format!(
                "structural manifest exceeds the {} byte output limit: {error}",
                self.output_limit
            )
        })?;
        let next = self
            .encoded_bytes
            .checked_add(counter.bytes)
            .and_then(|bytes| bytes.checked_add(1))
            .ok_or_else(|| "structural manifest size overflow".to_string())?;
        if next > self.output_limit {
            return Err(format!(
                "structural manifest exceeds the {} byte output limit",
                self.output_limit
            ));
        }
        self.encoded_bytes = next;
        self.values.push(entry);
        Ok(())
    }
}

fn manifest_entry<T: Debug>(
    entries: &mut ManifestEntries,
    kind: &str,
    path: Vec<String>,
    value: &T,
    identity_hint: Option<String>,
) -> Result<(), String> {
    entries.push(kind, path, value, identity_hint)
}
fn manifest_paragraphs(
    entries: &mut ManifestEntries,
    root: &[String],
    paragraphs: &[Paragraph],
) -> Result<(), String> {
    for (n, p) in paragraphs.iter().enumerate() {
        let mut path = root.to_vec();
        path.push("paragraphs".into());
        path.push(n.to_string());
        let identity = p.raw_header_extra.get(6..10).and_then(|v| {
            let id = u32::from_le_bytes(v.try_into().ok()?);
            (id != 0).then(|| format!("paragraph:{id}"))
        });
        let shell = no_controls(p);
        manifest_entry(entries, "paragraph", path.clone(), &shell, identity)?;
        manifest_entry(
            entries,
            "text",
            [path.clone(), vec!["text".into()]].concat(),
            &p.text,
            None,
        )?;
        for (f, shape) in p.char_shapes.iter().enumerate() {
            manifest_entry(
                entries,
                "formatting-interval",
                [path.clone(), vec!["charShapes".into(), f.to_string()]].concat(),
                shape,
                Some(format!("offset:{}", shape.start_pos)),
            )?;
        }
        for (k, control) in p.controls.iter().enumerate() {
            manifest_control(
                entries,
                &[path.clone(), vec!["controls".into(), k.to_string()]].concat(),
                control,
            )?;
        }
    }
    Ok(())
}
fn manifest_caption(
    entries: &mut ManifestEntries,
    path: &[String],
    caption: &Option<Caption>,
) -> Result<(), String> {
    if let Some(v) = caption {
        let mut shell = v.clone();
        shell.paragraphs.clear();
        manifest_entry(entries, "caption", path.to_vec(), &shell, None)?;
        manifest_paragraphs(entries, path, &v.paragraphs)?;
    }
    Ok(())
}
fn manifest_shape(
    entries: &mut ManifestEntries,
    path: &[String],
    shape: &ShapeObject,
) -> Result<(), String> {
    manifest_entry(
        entries,
        "shape",
        path.to_vec(),
        shape,
        control_identity(&Control::Shape(Box::new(shape.clone()))),
    )?;
    if let Some(d) = shape.drawing() {
        manifest_entry(
            entries,
            "shape-drawing",
            [path.to_vec(), vec!["drawing".into()]].concat(),
            d,
            None,
        )?;
        if let Some(tb) = &d.text_box {
            manifest_paragraphs(
                entries,
                &[
                    path.to_vec(),
                    vec!["drawing", "textBox"]
                        .into_iter()
                        .map(String::from)
                        .collect(),
                ]
                .concat(),
                &tb.paragraphs,
            )?;
        }
        manifest_caption(
            entries,
            &[path.to_vec(), vec!["drawing".into(), "caption".into()]].concat(),
            &d.caption,
        )?;
    }
    match shape {
        ShapeObject::Group(g) => {
            manifest_caption(
                entries,
                &[path.to_vec(), vec!["caption".into()]].concat(),
                &g.caption,
            )?;
            for (n, child) in g.children.iter().enumerate() {
                manifest_shape(
                    entries,
                    &[path.to_vec(), vec!["children".into(), n.to_string()]].concat(),
                    child,
                )?;
            }
        }
        ShapeObject::Picture(p) => manifest_entry(
            entries,
            "picture-resource-reference",
            [path.to_vec(), vec!["binDataId".into()]].concat(),
            &p.image_attr.bin_data_id,
            None,
        )?,
        ShapeObject::Chart(c) => {
            manifest_entry(
                entries,
                "chart",
                [path.to_vec(), vec!["chart".into()]].concat(),
                c,
                None,
            )?;
            manifest_caption(
                entries,
                &[path.to_vec(), vec!["caption".into()]].concat(),
                &c.caption,
            )?;
        }
        ShapeObject::Ole(o) => {
            manifest_entry(
                entries,
                "ole",
                [path.to_vec(), vec!["ole".into()]].concat(),
                o,
                None,
            )?;
            manifest_caption(
                entries,
                &[path.to_vec(), vec!["caption".into()]].concat(),
                &o.caption,
            )?;
        }
        _ => {}
    }
    Ok(())
}
fn manifest_control(
    entries: &mut ManifestEntries,
    path: &[String],
    control: &Control,
) -> Result<(), String> {
    let kind = match control {
        Control::SectionDef(_) => "section-def",
        Control::ColumnDef(_) => "column-settings",
        Control::Table(_) => "table",
        Control::Shape(_) => "shape",
        Control::Picture(_) => "picture",
        Control::Header(_) => "header",
        Control::Footer(_) => "footer",
        Control::Footnote(_) => "footnote",
        Control::Endnote(_) => "endnote",
        Control::AutoNumber(_) => "auto-number",
        Control::NewNumber(_) => "new-number",
        Control::PageNumberPos(_) => "page-number-position",
        Control::Bookmark(_) => "bookmark",
        Control::Hyperlink(_) => "hyperlink",
        Control::Ruby(_) => "ruby",
        Control::CharOverlap(_) => "character-overlap",
        Control::PageHide(_) => "page-hide",
        Control::HiddenComment(_) => "hidden-comment",
        Control::Equation(_) => "equation",
        Control::Field(_) => "field",
        Control::Form(_) => "form",
        Control::Unknown(_) => "unknown-control",
    };
    manifest_entry(
        entries,
        kind,
        path.to_vec(),
        control,
        control_identity(control),
    )?;
    match control {
        Control::Table(t) => {
            for (n, cell) in t.cells.iter().enumerate() {
                let cp = [path.to_vec(), vec!["cells".into(), n.to_string()]].concat();
                manifest_entry(entries, "table-cell", cp.clone(), cell, None)?;
                manifest_paragraphs(entries, &cp, &cell.paragraphs)?;
            }
            manifest_caption(
                entries,
                &[path.to_vec(), vec!["caption".into()]].concat(),
                &t.caption,
            )?;
        }
        Control::Shape(s) => manifest_shape(entries, path, s)?,
        Control::Picture(p) => {
            manifest_entry(
                entries,
                "picture-resource-reference",
                [path.to_vec(), vec!["binDataId".into()]].concat(),
                &p.image_attr.bin_data_id,
                None,
            )?;
            manifest_caption(
                entries,
                &[path.to_vec(), vec!["caption".into()]].concat(),
                &p.caption,
            )?;
        }
        Control::Header(v) => manifest_paragraphs(entries, path, &v.paragraphs)?,
        Control::Footer(v) => manifest_paragraphs(entries, path, &v.paragraphs)?,
        Control::Footnote(v) => manifest_paragraphs(entries, path, &v.paragraphs)?,
        Control::Endnote(v) => manifest_paragraphs(entries, path, &v.paragraphs)?,
        Control::HiddenComment(v) => manifest_paragraphs(entries, path, &v.paragraphs)?,
        Control::Field(v) => manifest_paragraphs(
            entries,
            &[path.to_vec(), vec!["memo".into()]].concat(),
            &v.memo_paragraphs,
        )?,
        _ => {}
    }
    Ok(())
}
fn build_structural_manifest_with_output_limit(
    bytes: &[u8],
    output_limit: usize,
) -> Result<StructuralManifest, String> {
    let d = parse(bytes, "manifest document")?;
    let mut entries = ManifestEntries::new(output_limit)?;
    manifest_entry(&mut entries, "document", vec![], &counts(&d), None)?;
    manifest_entry(
        &mut entries,
        "document-properties",
        vec!["docProperties".into()],
        &d.doc_properties,
        None,
    )?;
    for (s, section) in d.sections.iter().enumerate() {
        let path = vec!["sections".into(), s.to_string()];
        manifest_entry(
            &mut entries,
            "section",
            path.clone(),
            &section.section_def,
            None,
        )?;
        manifest_entry(
            &mut entries,
            "section-settings",
            [path.clone(), vec!["settings".into()]].concat(),
            &section.section_def,
            None,
        )?;
        manifest_paragraphs(&mut entries, &path, &section.paragraphs)?;
        for (m, page) in section.section_def.master_pages.iter().enumerate() {
            let mp = [path.clone(), vec!["masterPages".into(), m.to_string()]].concat();
            manifest_entry(&mut entries, "master-page", mp.clone(), page, None)?;
            manifest_paragraphs(&mut entries, &mp, &page.paragraphs)?;
        }
    }
    macro_rules! list {
        ($field:ident,$kind:literal) => {
            for (n, v) in d.doc_info.$field.iter().enumerate() {
                manifest_entry(
                    &mut entries,
                    $kind,
                    vec!["docInfo".into(), stringify!($field).into(), n.to_string()],
                    v,
                    None,
                )?;
            }
        };
    }
    list!(font_faces, "font-group");
    list!(border_fills, "border-fill");
    list!(char_shapes, "character-style");
    list!(tab_defs, "tab-definition");
    list!(numberings, "numbering");
    list!(bullets, "bullet");
    list!(para_shapes, "paragraph-style");
    list!(styles, "style");
    for resource in &d.bin_data_content {
        manifest_entry(
            &mut entries,
            "resource",
            vec!["resources".into(), resource.id.to_string()],
            &resource_value(Some(resource)),
            Some(format!("resource:{}", resource.id)),
        )?;
    }
    entries
        .values
        .sort_by(|a, b| a.path.cmp(&b.path).then(a.kind.cmp(&b.kind)));
    Ok(StructuralManifest {
        analysis_version: ANALYSIS_VERSION,
        entries: entries.values,
    })
}

pub fn build_structural_manifest(bytes: &[u8]) -> Result<StructuralManifest, String> {
    build_structural_manifest_with_output_limit(bytes, MAX_STRUCTURAL_MANIFEST_OUTPUT_BYTES)
}

#[wasm_bindgen(js_name=structuralMergeBuildManifest)]
pub fn structural_merge_build_manifest(bytes: &[u8]) -> Result<String, JsValue> {
    serde_json::to_string(&build_structural_manifest(bytes).map_err(|e| JsValue::from_str(&e))?)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn raw_binary_item_rewrite_requires_an_exact_numeric_value() {
        let raw = r#"<hh:img binaryItemIDRef="asset-1-v2"/>"#;
        let remap = BTreeMap::from([(12, 99)]);

        let (rewritten, matched) = remap_raw_binary_item_refs(raw, &remap).unwrap();

        assert!(!matched);
        assert!(matches!(
            rewritten,
            Cow::Borrowed(value) if value.as_ptr() == raw.as_ptr()
        ));
    }

    #[test]
    fn raw_binary_item_rewrite_ignores_comments_text_and_prefixed_names() {
        let raw = concat!(
            r#"<root>"#,
            r#"<!-- <hh:img binaryItemIDRef="image1"/> -->"#,
            r#"<![CDATA[<hh:img binaryItemIDRef="image1"/>]]>"#,
            r#"<hp:t>binaryItemIDRef="image1"</hp:t>"#,
            r#"<x x:binaryItemIDRef="image1" foobinaryItemIDRef="image1" binaryItemIDRefExtra="image1"/>"#,
            r#"<x a=binaryItemIDRef="image1"/>"#,
            r#"<hh:img binaryItemIDRef="image1"/>"#,
            r#"</root>"#,
        );
        let expected = raw.replacen(
            r#"<hh:img binaryItemIDRef="image1"/></root>"#,
            r#"<hh:img binaryItemIDRef="image7"/></root>"#,
            1,
        );

        let (rewritten, matched) =
            remap_raw_binary_item_refs(raw, &BTreeMap::from([(1, 7)])).unwrap();

        assert!(matched);
        assert_eq!(rewritten, expected);
    }

    #[test]
    fn raw_binary_item_rewrite_is_two_pass_and_bounded_for_many_replacements() {
        const COUNT: usize = 16_384;
        let raw = r#"<hh:img binaryItemIDRef="image1"/>"#.repeat(COUNT);
        let remap = BTreeMap::from([(1, u16::MAX)]);
        let projected_len = raw.len() + COUNT * 4;

        let (rewritten, matched) = remap_raw_binary_item_refs_limited(&raw, &remap, projected_len)
            .expect("many rewrites must use one preflighted output allocation");

        assert!(matched);
        assert!(matches!(&rewritten, Cow::Owned(_)));
        assert_eq!(rewritten.len(), projected_len);
        assert_eq!(rewritten.matches("image65535").count(), COUNT);
        assert!(remap_raw_binary_item_refs_limited(&raw, &remap, projected_len - 1).is_err());
    }

    #[test]
    fn raw_binary_item_identity_match_borrows_unchanged_xml() {
        let raw = r#"<hh:img binaryItemIDRef="image42"/>"#;

        let (rewritten, matched) =
            remap_raw_binary_item_refs(raw, &BTreeMap::from([(42, 42)])).unwrap();

        assert!(matched);
        assert!(matches!(
            rewritten,
            Cow::Borrowed(value) if value.as_ptr() == raw.as_ptr()
        ));
    }

    #[test]
    fn debug_hash_streams_formatter_output_into_blake3() {
        struct ChunkedDebug;

        impl std::fmt::Debug for ChunkedDebug {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                for _ in 0..4096 {
                    formatter.write_str("0123456789abcdef")?;
                }
                Ok(())
            }
        }

        let mut expected = blake3::Hasher::new();
        for _ in 0..4096 {
            expected.update(b"0123456789abcdef");
        }
        assert_eq!(dh(&ChunkedDebug), expected.finalize());
    }

    #[test]
    fn opaque_stream_hash_is_length_delimited_and_byte_sensitive() {
        let original = vec![
            ("A".to_string(), vec![1, 2, 3]),
            ("BC".to_string(), vec![4, 5]),
        ];
        let equivalent = original.clone();
        let mut changed_bytes = original.clone();
        changed_bytes[1].1[0] ^= 0xff;
        let changed_boundaries = vec![
            ("AB".to_string(), vec![1, 2, 3]),
            ("C".to_string(), vec![4, 5]),
        ];

        assert_eq!(
            opaque_streams_hash(&original),
            opaque_streams_hash(&equivalent)
        );
        assert_ne!(
            opaque_streams_hash(&original),
            opaque_streams_hash(&changed_bytes)
        );
        assert_ne!(
            opaque_streams_hash(&original),
            opaque_streams_hash(&changed_boundaries)
        );
        let descriptor = opaque_streams_value("opaque", &original);
        assert_eq!(descriptor["byteLength"], 5);
        assert!(descriptor.get("bytes").is_none());
        assert!(descriptor.get("bytesBase64").is_none());
    }

    #[test]
    fn matrix_and_disjoint() {
        assert_eq!(
            analyze(&json!({"v":1}), &json!({"v":2}), &json!({"v":1})).result,
            json!({"v":2})
        );
        let a = analyze(
            &json!({"p":{"x":1,"y":1}}),
            &json!({"p":{"x":2,"y":1}}),
            &json!({"p":{"x":1,"y":2}}),
        );
        assert!(a.conflicts.is_empty());
        assert_eq!(a.result, json!({"p":{"x":2,"y":2}}));
        let a = analyze(&json!({"v":1}), &json!({"v":2}), &json!({"v":3}));
        assert_eq!(a.conflicts[0].reason, MergeConflictReason::SameFieldChanged)
    }
    #[test]
    fn text_ranges_and_both() {
        let a = analyze(
            &json!({"t":"가나다라마"}),
            &json!({"t":"가X나다라마"}),
            &json!({"t":"가나다라Y마"}),
        );
        assert_eq!(a.result["t"], "가X나다라Y마");
        let a = analyze(&json!({"t":"ab"}), &json!({"t":"aCb"}), &json!({"t":"aIb"}));
        let c = &a.conflicts[0];
        assert!(c.supports_both);
        let m = materialize(
            &a,
            &BTreeMap::from([(
                c.id.clone(),
                MergeResolution::Both {
                    order: "incoming-first".into(),
                },
            )]),
        )
        .unwrap();
        assert_eq!(m["t"], "aICb")
    }
    #[test]
    fn keyed_and_delete_edit() {
        let a = analyze(
            &json!({"x":[{"id":"a","x":0,"y":0},{"id":"b","v":0}]}),
            &json!({"x":[{"id":"a","x":1,"y":0}]}),
            &json!({"x":[{"id":"a","x":0,"y":2},{"id":"b","v":3}]}),
        );
        assert_eq!(a.result["x"][0], json!({"id":"a","x":1,"y":2}));
        assert_eq!(a.conflicts[0].reason, MergeConflictReason::DeleteVersusEdit)
    }
    #[test]
    fn incompatible_moves_preserve_clean_node_edits_during_resolution() {
        let b = json!({"x":[{"id":"a","v":0},{"id":"b","v":0},{"id":"c","v":0}]});
        let c = json!({"x":[{"id":"a","v":0},{"id":"c","v":0},{"id":"b","v":1}]});
        let i = json!({"x":[{"id":"b","v":0},{"id":"a","v":2},{"id":"c","v":0}]});
        let a = analyze(&b, &c, &i);
        let order = a
            .conflicts
            .iter()
            .find(|c| c.reason == MergeConflictReason::IncompatibleMove)
            .unwrap();
        let out = materialize(
            &a,
            &BTreeMap::from([(order.id.clone(), MergeResolution::Incoming)]),
        )
        .unwrap();
        assert_eq!(
            out["x"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["b", "a", "c"]
        );
        assert_eq!(out["x"][0]["v"], 1);
        assert_eq!(out["x"][1]["v"], 2);
    }
    #[test]
    fn identity_collision_disallows_both() {
        let a = analyze(
            &json!({"x":[]}),
            &json!({"x":[{"id":"a","v":1}]}),
            &json!({"x":[{"id":"a","v":2}]}),
        );
        assert_eq!(
            a.conflicts[0].reason,
            MergeConflictReason::ConcurrentInsertion
        );
        assert!(!a.conflicts[0].supports_both)
    }
    #[test]
    fn unknown_is_atomic_but_one_sided_clean() {
        let b = json!({"kind":"unknown-control","unknown":true,"raw":"a"});
        assert!(analyze(
            &b,
            &json!({"kind":"unknown-control","unknown":true,"raw":"b"}),
            &b
        )
        .conflicts
        .is_empty());
        assert_eq!(
            analyze(
                &b,
                &json!({"kind":"unknown-control","unknown":true,"raw":"b"}),
                &json!({"kind":"unknown-control","unknown":true,"raw":"c"})
            )
            .conflicts[0]
                .reason,
            MergeConflictReason::UnknownControlModified
        )
    }
    #[test]
    fn deterministic_virtual_base_and_budget() {
        let (b, c, i) = (
            json!({"z":0,"a":{"x":0}}),
            json!({"z":1,"a":{"x":1}}),
            json!({"z":2,"a":{"x":2}}),
        );
        let expected = analyze(&b, &c, &i);
        for _ in 0..50 {
            assert_eq!(analyze(&b, &c, &i), expected)
        }
        let a = analyze_with_options(
            &b,
            &c,
            &i,
            MergeOptions {
                soft_budget_ms: 5000,
                node_budget: Some(0),
            },
        );
        assert!(a.budget_exceeded);
        let x = json!({"same":1,"o":{"x":1,"a":1}});
        let y = json!({"same":1,"o":{"x":1,"b":2}});
        assert_eq!(
            synthesize_virtual_base(&[x.clone(), y.clone()]).unwrap(),
            synthesize_virtual_base(&[y, x]).unwrap()
        )
    }
    #[test]
    fn byte_hwpx_disjoint_paragraph_roundtrip() {
        let mut b = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        let template = b.sections[0].paragraphs[0].clone();
        b.sections[0].paragraphs = vec![template.clone(), template];
        b.sections[0].paragraphs[0].text = "a".into();
        b.sections[0].paragraphs[1].text = "b".into();
        b.doc_properties.section_count = 1;
        let mut c = b.clone();
        c.sections[0].paragraphs[0].text = "C".into();
        let mut i = b.clone();
        i.sections[0].paragraphs[1].text = "I".into();
        let (bb, cb, ib) = (
            serialize_hwpx(&b).unwrap(),
            serialize_hwpx(&c).unwrap(),
            serialize_hwpx(&i).unwrap(),
        );
        let a = analyze_document_bytes(&bb, &cb, &ib).unwrap();
        assert!(a.conflicts.is_empty(), "{:?}", a.conflicts);
        let out = materialize_document_bytes(&bb, &cb, &ib, &BTreeMap::new()).unwrap();
        assert_eq!(detect_format(&out), FileFormat::Hwpx);
        let d = parse_document(&out).unwrap();
        assert_eq!(d.sections[0].paragraphs[0].text, "C");
        assert_eq!(d.sections[0].paragraphs[1].text, "I")
    }
    #[test]
    fn byte_adapter_merges_disjoint_text_ranges_and_virtual_base_is_deterministic() {
        let mut b = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        b.sections[0].paragraphs[0].text = "abcdef".into();
        crate::document_core::queries::field_query::rebuild_char_offsets(
            &mut b.sections[0].paragraphs[0],
        );
        let mut c = b.clone();
        c.sections[0].paragraphs[0].text = "aXbcdef".into();
        crate::document_core::queries::field_query::rebuild_char_offsets(
            &mut c.sections[0].paragraphs[0],
        );
        let mut i = b.clone();
        i.sections[0].paragraphs[0].text = "abcdeYf".into();
        crate::document_core::queries::field_query::rebuild_char_offsets(
            &mut i.sections[0].paragraphs[0],
        );
        let (bb, cb, ib) = (
            serialize_hwpx(&b).unwrap(),
            serialize_hwpx(&c).unwrap(),
            serialize_hwpx(&i).unwrap(),
        );
        let analysis = analyze_document_bytes(&bb, &cb, &ib).unwrap();
        assert!(analysis.conflicts.is_empty(), "{:?}", analysis.conflicts);
        let out = materialize_document_bytes(&bb, &cb, &ib, &BTreeMap::new()).unwrap();
        assert_eq!(
            parse_document(&out).unwrap().sections[0].paragraphs[0].text,
            "aXbcdeYf"
        );
        let first =
            synthesize_virtual_base_document_bytes(&[cb.clone(), ib.clone()], FileFormat::Hwpx)
                .unwrap();
        let second = synthesize_virtual_base_document_bytes(&[ib, cb], FileFormat::Hwpx).unwrap();
        assert_eq!(first, second);
        assert_eq!(detect_format(&first), FileFormat::Hwpx);
    }
    #[test]
    fn byte_hwp_preserves_current_format_and_reloads() {
        let b = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        let mut c = b.clone();
        c.sections[0].paragraphs[0].style_id = b.sections[0].paragraphs[0].style_id;
        let mut i = b.clone();
        i.sections[0].paragraphs[0].text = "incoming hwp".into();
        crate::document_core::queries::field_query::rebuild_char_offsets(
            &mut i.sections[0].paragraphs[0],
        );
        i.sections[0].raw_stream = None;
        let bb = serialize_hwp(&b).unwrap();
        let cb = serialize_hwp(&c).unwrap();
        let ib = serialize_hwp(&i).unwrap();
        let out = materialize_document_bytes(&bb, &cb, &ib, &BTreeMap::new()).unwrap();
        assert_eq!(detect_format(&out), FileFormat::Hwp);
        assert_eq!(
            parse_document(&out).unwrap().sections[0].paragraphs[0].text,
            "incoming hwp"
        );
    }
    #[test]
    fn table_cells_merge_independently_and_ir_budget_conflicts() {
        let para = |text: &str| {
            let mut p = Paragraph::default();
            p.text = text.into();
            p
        };
        let mut b = Table::default();
        b.cells = vec![
            Cell {
                paragraphs: vec![para("a")],
                ..Cell::default()
            },
            Cell {
                col: 1,
                paragraphs: vec![para("b")],
                ..Cell::default()
            },
        ];
        let mut c = b.clone();
        c.cells[0].paragraphs[0].text = "C".into();
        let mut i = b.clone();
        i.cells[1].paragraphs[0].text = "I".into();
        let mut ctx = Ctx::new(MergeOptions::default());
        let out = merge_table(&["table".into()], &b, &c, &i, None, &mut ctx).unwrap();
        assert!(ctx.conflicts.is_empty());
        assert_eq!(out.cells[0].paragraphs[0].text, "C");
        assert_eq!(out.cells[1].paragraphs[0].text, "I");
        let mut limited = Ctx::new(MergeOptions {
            soft_budget_ms: 5000,
            node_budget: Some(0),
        });
        let _ = choose(
            &["resource".into()],
            "resource",
            MergeConflictReason::SameFieldChanged,
            &0,
            &1,
            &2,
            None,
            &mut limited,
        )
        .unwrap();
        assert!(limited.exceeded);
        assert_eq!(
            limited.conflicts[0].reason,
            MergeConflictReason::BudgetExceeded
        );
    }
    #[test]
    fn table_row_column_and_split_operations_merge_conservatively() {
        let mut b = Table::default();
        b.row_count = 1;
        b.col_count = 1;
        b.cells = vec![Cell {
            row: 0,
            col: 0,
            col_span: 1,
            row_span: 1,
            ..Cell::default()
        }];
        b.rebuild_grid();
        let mut c = b.clone();
        c.row_count = 2;
        c.cells.push(Cell {
            row: 1,
            col: 0,
            col_span: 1,
            row_span: 1,
            ..Cell::default()
        });
        c.rebuild_grid();
        let mut i = b.clone();
        i.col_count = 2;
        i.cells.push(Cell {
            row: 0,
            col: 1,
            col_span: 1,
            row_span: 1,
            ..Cell::default()
        });
        i.rebuild_grid();
        let mut ctx = Ctx::new(MergeOptions::default());
        let out = merge_table(&["table".into()], &b, &c, &i, None, &mut ctx).unwrap();
        assert!(ctx.conflicts.is_empty(), "{:?}", ctx.conflicts);
        assert_eq!((out.row_count, out.col_count, out.cells.len()), (2, 2, 3));
        let mut same_c = b.clone();
        same_c.cells.push(Cell {
            row: 1,
            col: 0,
            ..Cell::default()
        });
        same_c.row_count = 2;
        let mut same_i = same_c.clone();
        same_i.cells[1].width = 99;
        let mut ctx = Ctx::new(MergeOptions::default());
        let _ = merge_table(&["table".into()], &b, &same_c, &same_i, None, &mut ctx).unwrap();
        let insertion = ctx
            .conflicts
            .iter()
            .find(|x| x.reason == MergeConflictReason::ConcurrentInsertion)
            .unwrap();
        assert!(!insertion.supports_both);
    }
    #[test]
    fn manifests_match_inserted_paragraph_sequences_without_embedded_ids() {
        let mut b = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        let template = b.sections[0].paragraphs[0].clone();
        b.sections[0].paragraphs = vec![template.clone(), template.clone()];
        b.sections[0].paragraphs[0].text = "a".into();
        b.sections[0].paragraphs[1].text = "b".into();
        for p in &mut b.sections[0].paragraphs {
            p.raw_header_extra.clear();
        }
        let mut c = b.clone();
        let mut inserted = template.clone();
        inserted.text = "x".into();
        inserted.raw_header_extra.clear();
        c.sections[0].paragraphs.insert(1, inserted);
        let mut i = b.clone();
        i.sections[0].paragraphs[1].text = "I".into();
        let (bb, cb, ib) = (
            serialize_hwpx(&b).unwrap(),
            serialize_hwpx(&c).unwrap(),
            serialize_hwpx(&i).unwrap(),
        );
        let manifest = |entries: Vec<(&str, usize)>| {
            json!({"entries":entries.into_iter().map(|(identity,p)|json!({"identity":identity,"kind":"paragraph","path":["sections","0","paragraphs",p.to_string()],"propertyHash":"blake3:x"})).collect::<Vec<_>>()}).to_string()
        };
        let bm = manifest(vec![("a", 0), ("b", 1)]);
        let cm = manifest(vec![("a", 0), ("x", 1), ("b", 2)]);
        let im = manifest(vec![("a", 0), ("b", 1)]);
        let analysis = analyze_document_bytes_with_manifests(&bb, &cb, &ib, &bm, &cm, &im).unwrap();
        assert!(analysis.conflicts.is_empty(), "{:?}", analysis.conflicts);
        let out = materialize_document_bytes_with_manifests(
            &bb,
            &cb,
            &ib,
            &bm,
            &cm,
            &im,
            &BTreeMap::new(),
        )
        .unwrap();
        let d = parse_document(&out).unwrap();
        assert_eq!(
            d.sections[0]
                .paragraphs
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "x", "I"]
        );
    }
    #[test]
    fn manifests_propagate_control_identity_across_insertion_and_edit() {
        let mut b = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        b.sections[0].raw_stream = None;
        b.sections[0].paragraphs[0].raw_header_extra.clear();
        b.sections[0].paragraphs[0].controls = vec![Control::Picture(Box::new(Picture::default()))];
        b.sections[0].paragraphs[0].ctrl_data_records = vec![None];
        let mut c = b.clone();
        let mut inserted = Picture::default();
        inserted.common.width = 10;
        c.sections[0].paragraphs[0]
            .controls
            .insert(0, Control::Picture(Box::new(inserted)));
        c.sections[0].paragraphs[0]
            .ctrl_data_records
            .insert(0, None);
        let mut i = b.clone();
        let Control::Picture(pic) = &mut i.sections[0].paragraphs[0].controls[0] else {
            panic!()
        };
        pic.crop.left = 25;
        let (bb, cb, ib) = (
            serialize_hwpx(&b).unwrap(),
            serialize_hwpx(&c).unwrap(),
            serialize_hwpx(&i).unwrap(),
        );
        let manifest = |controls: Vec<(&str, usize)>| {
            let mut entries = vec![
                json!({"identity":"paragraph-a","kind":"paragraph","path":["sections","0","paragraphs","0"]}),
            ];
            entries.extend(controls.into_iter().map(|(identity,n)|json!({"identity":identity,"kind":"picture","path":["sections","0","paragraphs","0","controls",n.to_string()]})));
            json!({"entries":entries}).to_string()
        };
        let bm = manifest(vec![("picture-a", 2)]);
        let cm = manifest(vec![("picture-new", 2), ("picture-a", 3)]);
        let im = manifest(vec![("picture-a", 2)]);
        let a = analyze_document_bytes_with_manifests(&bb, &cb, &ib, &bm, &cm, &im).unwrap();
        assert!(a.conflicts.is_empty(), "{:?}", a.conflicts);
        let out = materialize_document_bytes_with_manifests(
            &bb,
            &cb,
            &ib,
            &bm,
            &cm,
            &im,
            &BTreeMap::new(),
        )
        .unwrap();
        let d = parse_document(&out).unwrap();
        assert_eq!(d.sections[0].paragraphs[0].controls.len(), 4);
        let Control::Picture(existing) = &d.sections[0].paragraphs[0].controls[3] else {
            panic!()
        };
        assert_eq!(existing.crop.left, 25);
    }
    #[test]
    fn typed_manual_formula_table_and_image_bytes_apply() {
        let mut b = Equation::default();
        b.script = "base".into();
        let mut c = b.clone();
        c.script = "current".into();
        let mut i = b.clone();
        i.script = "incoming".into();
        let mut ctx = Ctx::new(MergeOptions::default());
        let _ = merge_equation(&["equation".into()], &b, &c, &i, None, &mut ctx).unwrap();
        let formula = ctx.conflicts.iter().find(|x| x.kind == "formula").unwrap();
        assert_eq!(formula.current, json!("current"));
        let mut resolved = Ctx::new(MergeOptions::default());
        let out = merge_equation(
            &["equation".into()],
            &b,
            &c,
            &i,
            Some(&BTreeMap::from([(
                formula.id.clone(),
                MergeResolution::Manual {
                    payload: json!("manual"),
                },
            )])),
            &mut resolved,
        )
        .unwrap();
        assert_eq!(out.script, "manual");

        let mut bcell = Cell::default();
        bcell.width = 1;
        let mut ccell = bcell.clone();
        ccell.width = 2;
        let mut icell = bcell.clone();
        icell.width = 3;
        let mut ctx = Ctx::new(MergeOptions::default());
        let _ = merge_cell(&["cell".into()], &bcell, &ccell, &icell, None, &mut ctx).unwrap();
        let width = ctx
            .conflicts
            .iter()
            .find(|x| x.path.last().is_some_and(|p| p == "width"))
            .unwrap();
        assert_eq!(width.base, json!(1));
        let mut resolved = Ctx::new(MergeOptions::default());
        let out = merge_cell(
            &["cell".into()],
            &bcell,
            &ccell,
            &icell,
            Some(&BTreeMap::from([(
                width.id.clone(),
                MergeResolution::Manual { payload: json!(4) },
            )])),
            &mut resolved,
        )
        .unwrap();
        assert_eq!(out.width, 4);

        let resource = |bytes: &[u8]| BinDataContent {
            id: 1,
            data: BinDataBytes::from(bytes.to_vec()),
            extension: "png".into(),
        };
        let (br, cr, ir) = (
            vec![resource(b"b")],
            vec![resource(b"c")],
            vec![resource(b"i")],
        );
        let mut ctx = Ctx::new(MergeOptions::default());
        let _ = merge_resources(&br, &cr, &ir, None, &mut ctx).unwrap();
        let image = &ctx.conflicts[0];
        assert_eq!(image.kind, "image-bytes");
        assert!(image.current.get("bytesBase64").is_none());
        assert!(image.current["contentIdentity"]
            .as_str()
            .is_some_and(|identity| identity.starts_with("decoded:")));
        let manual = json!({"kind":"image-bytes","id":1,"extension":"png","bytesBase64":base64::engine::general_purpose::STANDARD.encode(b"manual")});
        let mut resolved = Ctx::new(MergeOptions::default());
        let out = merge_resources(
            &br,
            &cr,
            &ir,
            Some(&BTreeMap::from([(
                image.id.clone(),
                MergeResolution::Manual { payload: manual },
            )])),
            &mut resolved,
        )
        .unwrap();
        assert_eq!(out[0].data.load(), b"manual");
    }

    #[test]
    fn manual_resource_rejects_oversized_base64_before_decode() {
        let payload = json!({
            "kind": "image-bytes",
            "id": 1,
            "extension": "png",
            "bytesBase64": base64::engine::general_purpose::STANDARD.encode(b"12345"),
        });

        let error = manual_resource_from_value_with_limit(&payload, 1, 4)
            .expect_err("decoded output must be checked before allocation");

        assert!(error.contains("4 byte merge resource limit"));
    }

    #[test]
    fn structural_manifest_budget_fails_before_building_unbounded_output() {
        let bytes = serialize_hwp(&Document::default()).expect("fixture serialization");

        let error =
            build_structural_manifest_with_output_limit(&bytes, ManifestEntries::WRAPPER_BUDGET)
                .expect_err("the first entry must exceed an exhausted output budget");

        assert!(error.contains("structural manifest exceeds"));
        assert!(error.contains("output limit"));
    }
    #[test]
    fn picture_placement_and_crop_are_disjoint_regions() {
        let b = Picture::default();
        let mut c = b.clone();
        c.common.width = 100;
        let mut i = b.clone();
        i.crop.left = 20;
        let mut ctx = Ctx::new(MergeOptions::default());
        let out = merge_picture(&["picture".into()], &b, &c, &i, None, &mut ctx).unwrap();
        assert!(ctx.conflicts.is_empty());
        assert_eq!(out.common.width, 100);
        assert_eq!(out.crop.left, 20);
    }
    #[test]
    fn concurrent_resource_and_style_ids_are_deterministically_remapped() {
        use crate::model::bin_data::{BinData, BinDataType};

        let mut b = Document::default();
        b.sections = vec![Section {
            paragraphs: vec![Paragraph::default()],
            ..Section::default()
        }];
        let mut c = b.clone();
        c.doc_info.bin_data_list.push(BinData {
            data_type: BinDataType::Embedding,
            storage_id: 7,
            extension: Some("png".into()),
            ..Default::default()
        });
        c.bin_data_content.push(BinDataContent {
            id: 7,
            data: BinDataBytes::from(b"current".to_vec()),
            extension: "png".into(),
        });
        c.sections[0].paragraphs[0]
            .controls
            .push(Control::Picture(Box::new(Picture {
                image_attr: crate::model::image::ImageAttr {
                    bin_data_id: 1,
                    ..Default::default()
                },
                ..Picture::default()
            })));
        let mut i = b.clone();
        i.doc_info.bin_data_list.push(BinData {
            data_type: BinDataType::Embedding,
            storage_id: 7,
            extension: Some("png".into()),
            ..Default::default()
        });
        i.bin_data_content.push(BinDataContent {
            id: 7,
            data: BinDataBytes::from(b"incoming".to_vec()),
            extension: "png".into(),
        });
        i.sections[0].paragraphs[0]
            .controls
            .push(Control::Picture(Box::new(Picture {
                image_attr: crate::model::image::ImageAttr {
                    bin_data_id: 1,
                    ..Default::default()
                },
                ..Picture::default()
            })));
        c.doc_info.styles.push(Default::default());
        i.doc_info.styles.push(Default::default());
        c.sections[0].paragraphs[0].style_id = 0;
        i.sections[0].paragraphs[0].style_id = 0;
        let prepared = prepare_merge_views(&b, &c, &i).unwrap();
        assert_eq!(prepared.bin_data.declarations[0].storage_id, 7);
        assert_eq!(prepared.bin_data.declarations[1].storage_id, 8);
        let Control::Picture(pic) = &prepared.incoming.sections()[0].paragraphs[0].controls[0]
        else {
            panic!()
        };
        // HWP image references are declaration slots, not sparse storage IDs.
        assert_eq!(pic.image_attr.bin_data_id, 2);
        assert_eq!(prepared.incoming.sections()[0].paragraphs[0].style_id, 1);
        let mut ctx = Ctx::new(MergeOptions::default());
        let (declarations, resources) =
            merge_bin_data_resources(&b, &c, &i, &prepared.bin_data, None, &mut ctx).unwrap();
        assert_eq!(
            declarations
                .iter()
                .map(|declaration| declaration.storage_id)
                .collect::<Vec<_>>(),
            vec![7, 8]
        );
        assert_eq!(
            resources.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![7, 8]
        );
    }

    #[test]
    fn collision_remap_covers_slots_storage_refs_raw_buffers_and_links() {
        use crate::model::bin_data::{BinData, BinDataType};
        use crate::model::shape::{GroupShape, RectangleShape};
        use crate::model::style::{Fill, FillType, ImageFill, SubstFont};

        let declaration = |data_type| BinData {
            data_type,
            attr: match data_type {
                BinDataType::Link => 0,
                BinDataType::Embedding => 1,
                BinDataType::Storage => 2,
            },
            storage_id: 10,
            extension: Some("dat".into()),
            ..Default::default()
        };
        let content = |bytes: &[u8]| BinDataContent {
            id: 10,
            data: BinDataBytes::from(bytes.to_vec()),
            extension: "dat".into(),
        };
        let image_fill = || Fill {
            fill_type: FillType::Image,
            image: Some(ImageFill {
                bin_data_id: 1,
                ..Default::default()
            }),
            ..Default::default()
        };
        let ole = || {
            ShapeObject::Ole(Box::new(OleShape {
                bin_data_id: 10,
                raw_tag_data: vec![9, 9, 9],
                ..Default::default()
            }))
        };

        let base = Document::default();
        let current = Document {
            doc_info: DocInfo {
                bin_data_list: vec![declaration(BinDataType::Link)],
                ..Default::default()
            },
            ..Default::default()
        };
        let mut incoming = Document {
            doc_info: DocInfo {
                bin_data_list: vec![declaration(BinDataType::Embedding)],
                border_fills: vec![BorderFill {
                    raw_data: Some(vec![4, 5, 6]),
                    fill: image_fill(),
                    ..Default::default()
                }],
                bullets: vec![Bullet {
                    image_bullet: 1,
                    raw_data: Some(vec![7, 8]),
                    raw_para_head: Some(
                        r#"<hh:paraHead custom="kept"/><hh:img binaryItemIDRef="image1"/>"#.into(),
                    ),
                    ..Default::default()
                }],
                font_faces: vec![vec![Font {
                    raw_data: Some(vec![9, 8, 7]),
                    is_embedded: true,
                    bin_item_id_ref: "font-resource-alpha".into(),
                    resolved_bin_data_id: Some(10),
                    subst_font: Some(SubstFont {
                        is_embedded: true,
                        bin_item_id_ref: "font-resource-beta".into(),
                        resolved_bin_data_id: Some(10),
                        ..Default::default()
                    }),
                    ..Default::default()
                }]],
                ..Default::default()
            },
            sections: vec![Section {
                raw_stream: Some(vec![0xaa, 0xbb]),
                paragraphs: vec![Paragraph {
                    controls: vec![
                        Control::Picture(Box::new(Picture {
                            image_attr: ImageAttr {
                                bin_data_id: 1,
                                ..Default::default()
                            },
                            ..Default::default()
                        })),
                        Control::Shape(Box::new(ShapeObject::Rectangle(RectangleShape {
                            drawing: DrawingObjAttr {
                                fill: image_fill(),
                                ..Default::default()
                            },
                            ..Default::default()
                        }))),
                        Control::Shape(Box::new(ole())),
                        Control::Shape(Box::new(ShapeObject::Group(GroupShape {
                            children: vec![ole()],
                            ..Default::default()
                        }))),
                    ],
                    ..Default::default()
                }],
                section_def: SectionDef {
                    master_pages: vec![MasterPage {
                        paragraphs: vec![Paragraph {
                            controls: vec![Control::Shape(Box::new(ole()))],
                            ..Default::default()
                        }],
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                ..Default::default()
            }],
            bin_data_content: vec![content(b"incoming")],
            ..Default::default()
        };
        incoming.doc_info.bin_data_list[0].raw_data = Some(vec![1, 2, 3]);

        let prepared = prepare_merge_views(&base, &current, &incoming).unwrap();
        assert_eq!(prepared.bin_data.declarations[0].storage_id, 10);
        assert_eq!(prepared.bin_data.declarations[1].storage_id, 11);
        assert_eq!(
            prepared.incoming.doc_info().border_fills[0]
                .fill
                .image
                .as_ref()
                .unwrap()
                .bin_data_id,
            2
        );
        assert!(prepared.incoming.doc_info().border_fills[0]
            .raw_data
            .is_none());
        let bullet = &prepared.incoming.doc_info().bullets[0];
        assert_eq!(bullet.image_bullet, 2);
        assert!(bullet.raw_data.is_none());
        assert!(bullet.raw_para_head.as_deref().unwrap().contains("image2"));
        let font = &prepared.incoming.doc_info().font_faces[0][0];
        assert!(font.raw_data.is_none());
        assert_eq!(font.resolved_bin_data_id, Some(11));
        assert_eq!(font.bin_item_id_ref, "font-resource-alpha");
        assert_eq!(
            font.subst_font.as_ref().unwrap().resolved_bin_data_id,
            Some(11)
        );
        assert_eq!(
            font.subst_font.as_ref().unwrap().bin_item_id_ref,
            "font-resource-beta"
        );
        assert!(prepared.incoming.sections()[0].raw_stream.is_none());
        let controls = &prepared.incoming.sections()[0].paragraphs[0].controls;
        let Control::Picture(picture) = &controls[0] else {
            panic!()
        };
        assert_eq!(picture.image_attr.bin_data_id, 2);
        let Control::Shape(rectangle) = &controls[1] else {
            panic!()
        };
        assert_eq!(
            rectangle
                .drawing()
                .unwrap()
                .fill
                .image
                .as_ref()
                .unwrap()
                .bin_data_id,
            2
        );
        let Control::Shape(top_ole) = &controls[2] else {
            panic!()
        };
        let ShapeObject::Ole(top_ole) = top_ole.as_ref() else {
            panic!()
        };
        assert_eq!(top_ole.bin_data_id, 11);
        assert!(top_ole.raw_tag_data.is_empty());
        let Control::Shape(group) = &controls[3] else {
            panic!()
        };
        let ShapeObject::Group(group) = group.as_ref() else {
            panic!()
        };
        let ShapeObject::Ole(nested_ole) = &group.children[0] else {
            panic!()
        };
        assert_eq!(nested_ole.bin_data_id, 11);
        let Control::Shape(master_ole) =
            &prepared.incoming.sections()[0].section_def.master_pages[0].paragraphs[0].controls[0]
        else {
            panic!()
        };
        let ShapeObject::Ole(master_ole) = master_ole.as_ref() else {
            panic!()
        };
        assert_eq!(master_ole.bin_data_id, 11);

        let mut context = Ctx::new(MergeOptions::default());
        let (declarations, contents) = merge_bin_data_resources(
            &base,
            &current,
            &incoming,
            &prepared.bin_data,
            None,
            &mut context,
        )
        .unwrap();
        assert!(declarations[1].raw_data.is_none());
        let mut validated = incoming.clone();
        validated.doc_info = prepared.incoming.doc_info().clone();
        validated.doc_info.bin_data_list = declarations;
        validated.sections = prepared.incoming.sections().to_vec();
        validated.bin_data_content = contents;
        validate_resource_dependencies(&validated).unwrap();
        let reparsed = parse_document(&serialize_hwp(&validated).unwrap()).unwrap();
        assert_eq!(
            reparsed
                .doc_info
                .bin_data_list
                .iter()
                .map(|declaration| declaration.storage_id)
                .collect::<Vec<_>>(),
            vec![0, 11]
        );
        assert_eq!(reparsed.doc_info.bullets[0].image_bullet, 2);
        let Control::Picture(reparsed_picture) = &reparsed.sections[0].paragraphs[0].controls[0]
        else {
            panic!()
        };
        assert_eq!(reparsed_picture.image_attr.bin_data_id, 2);
        let Control::Shape(reparsed_ole) = &reparsed.sections[0].paragraphs[0].controls[2] else {
            panic!()
        };
        let ShapeObject::Ole(reparsed_ole) = reparsed_ole.as_ref() else {
            panic!()
        };
        assert_eq!(reparsed_ole.bin_data_id, 11);

        // The reverse collision keeps embedded bytes on the current declaration
        // while assigning the incoming Link its own storage ID and final slot.
        let reverse_current = Document {
            doc_info: DocInfo {
                bin_data_list: vec![declaration(BinDataType::Embedding)],
                ..Default::default()
            },
            bin_data_content: vec![content(b"current")],
            ..Default::default()
        };
        let mut reverse_incoming = Document {
            doc_info: DocInfo {
                bin_data_list: vec![declaration(BinDataType::Link)],
                ..Default::default()
            },
            ..Default::default()
        };
        reverse_incoming.doc_info.bin_data_list[0].abs_path =
            Some("C:\\linked-resource.dat".into());
        let reverse = prepare_merge_views(&base, &reverse_current, &reverse_incoming).unwrap();
        assert_eq!(reverse.bin_data.declarations[0].storage_id, 10);
        assert_eq!(reverse.bin_data.declarations[1].storage_id, 11);

        let (reverse_hwpx, analysis) = merge_doc_for_format(
            &base,
            &reverse_current,
            &reverse_incoming,
            None,
            crate::model::provenance::SourceFormat::Hwpx,
        )
        .unwrap();
        assert!(analysis.conflicts.is_empty());
        assert_eq!(
            reverse_hwpx
                .doc_info
                .bin_data_list
                .iter()
                .map(|declaration| declaration.storage_id)
                .collect::<Vec<_>>(),
            vec![10, 11]
        );
        validate_resource_dependencies(&reverse_hwpx).unwrap();
        let bytes = serialize_hwpx(&reverse_hwpx).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut manifest = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("Contents/content.hpf").unwrap(),
            &mut manifest,
        )
        .unwrap();
        assert!(manifest.contains(r#"id="image10""#));
        assert!(manifest.contains(r#"id="image11""#));
        let reverse_reparsed = parse_document(&serialize_hwpx(&reverse_hwpx).unwrap()).unwrap();
        validate_resource_dependencies(&reverse_reparsed).unwrap();
        assert_eq!(
            reverse_reparsed
                .doc_info
                .bin_data_list
                .iter()
                .map(|declaration| declaration.storage_id)
                .collect::<Vec<_>>(),
            vec![10, 11]
        );
    }

    #[test]
    fn target_hwpx_maps_both_hwp_sources_from_slots_to_sparse_storage_ids() {
        use crate::model::bin_data::{BinData, BinDataType};
        use crate::model::provenance::SourceFormat;

        let with_picture = |storage_id: u16| Document {
            doc_info: DocInfo {
                bin_data_list: vec![BinData {
                    data_type: BinDataType::Embedding,
                    storage_id,
                    ..Default::default()
                }],
                ..Default::default()
            },
            sections: vec![Section {
                paragraphs: vec![Paragraph {
                    controls: vec![Control::Picture(Box::new(Picture {
                        image_attr: ImageAttr {
                            bin_data_id: 1,
                            ..Default::default()
                        },
                        ..Default::default()
                    }))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            bin_data_content: vec![BinDataContent {
                id: storage_id,
                data: BinDataBytes::from(vec![storage_id as u8]),
                extension: "dat".into(),
            }],
            ..Default::default()
        };
        let base = Document::default();
        let current = with_picture(10);
        let incoming = with_picture(20);
        let prepared =
            prepare_merge_views_for_format(&base, &current, &incoming, SourceFormat::Hwpx).unwrap();
        let picture_id = |view: &RemappedIncoming<'_>| {
            let Control::Picture(picture) = &view.sections()[0].paragraphs[0].controls[0] else {
                panic!()
            };
            picture.image_attr.bin_data_id
        };
        assert_eq!(picture_id(&prepared.current), 10);
        assert_eq!(picture_id(&prepared.incoming), 20);
        assert_eq!(
            prepared
                .bin_data
                .declarations
                .iter()
                .map(|declaration| (declaration.slot, declaration.storage_id))
                .collect::<Vec<_>>(),
            vec![(1, 10), (2, 20)]
        );
    }

    #[test]
    fn collision_detector_reaches_picture_inside_shape_text_box() {
        use crate::model::bin_data::{BinData, BinDataType};
        use crate::model::shape::LineShape;

        let declaration = || BinData {
            data_type: BinDataType::Link,
            storage_id: 1,
            ..Default::default()
        };
        let base = Document::default();
        let current = Document {
            doc_info: DocInfo {
                bin_data_list: vec![declaration()],
                ..Default::default()
            },
            ..Default::default()
        };
        let mut line = LineShape::default();
        line.drawing.text_box = Some(TextBox {
            paragraphs: vec![Paragraph {
                controls: vec![Control::Picture(Box::new(Picture {
                    image_attr: ImageAttr {
                        bin_data_id: 1,
                        ..Default::default()
                    },
                    ..Default::default()
                }))],
                ..Default::default()
            }],
            ..Default::default()
        });
        let incoming = Document {
            doc_info: DocInfo {
                bin_data_list: vec![declaration()],
                ..Default::default()
            },
            sections: vec![Section {
                raw_stream: Some(vec![0xde, 0xad]),
                paragraphs: vec![Paragraph {
                    controls: vec![Control::Shape(Box::new(ShapeObject::Line(line)))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

        let prepared = prepare_merge_views(&base, &current, &incoming).unwrap();
        assert!(prepared.incoming.sections()[0].raw_stream.is_none());
        let Control::Shape(line) = &prepared.incoming.sections()[0].paragraphs[0].controls[0]
        else {
            panic!()
        };
        let picture = line
            .drawing()
            .unwrap()
            .text_box
            .as_ref()
            .unwrap()
            .paragraphs[0]
            .controls
            .first()
            .unwrap();
        let Control::Picture(picture) = picture else {
            panic!()
        };
        assert_eq!(picture.image_attr.bin_data_id, 2);
    }

    #[test]
    fn incoming_chart_id_avoids_final_ordinary_storage_domain() {
        use crate::model::bin_data::{BinData, BinDataType};
        use crate::model::provenance::SourceFormat;

        let base = Document::default();
        let current = Document {
            doc_info: DocInfo {
                bin_data_list: vec![BinData {
                    data_type: BinDataType::Embedding,
                    storage_id: 60001,
                    ..Default::default()
                }],
                ..Default::default()
            },
            bin_data_content: vec![BinDataContent {
                id: 60001,
                data: BinDataBytes::from(b"ordinary".to_vec()),
                extension: "dat".into(),
            }],
            ..Default::default()
        };
        let mut incoming = Document {
            sections: vec![Section {
                paragraphs: vec![Paragraph {
                    controls: vec![Control::Shape(Box::new(ShapeObject::Ole(Box::new(
                        OleShape {
                            bin_data_id: 60001,
                            raw_tag_data: vec![1, 2, 3],
                            ..Default::default()
                        },
                    ))))],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            bin_data_content: vec![BinDataContent {
                id: 60001,
                data: BinDataBytes::from(b"chart".to_vec()),
                extension: "ooxml_chart".into(),
            }],
            ..Default::default()
        };
        incoming.provenance.format = SourceFormat::Hwpx;

        let prepared = prepare_merge_views(&base, &current, &incoming).unwrap();
        assert_eq!(
            prepared.bin_data.incoming_chart_ids.get(&60001),
            Some(&60002)
        );
        let Control::Shape(ole) = &prepared.incoming.sections()[0].paragraphs[0].controls[0] else {
            panic!()
        };
        let ShapeObject::Ole(ole) = ole.as_ref() else {
            panic!()
        };
        assert_eq!(ole.bin_data_id, 60002);
        assert!(ole.raw_tag_data.is_empty());
        let mut context = Ctx::new(MergeOptions::default());
        let (_, contents) = merge_bin_data_resources(
            &base,
            &current,
            &incoming,
            &prepared.bin_data,
            None,
            &mut context,
        )
        .unwrap();
        assert_eq!(
            contents
                .iter()
                .map(|content| (content.id, content.extension.as_str()))
                .collect::<Vec<_>>(),
            vec![(60001, "dat"), (60002, "ooxml_chart")]
        );
    }

    #[test]
    fn collision_remap_keeps_untouched_incoming_opaque_buffers_borrowed() {
        use crate::model::bin_data::{BinData, BinDataType};

        let base = Document::default();
        let current = Document {
            doc_info: DocInfo {
                bin_data_list: vec![BinData {
                    data_type: BinDataType::Embedding,
                    storage_id: 7,
                    ..Default::default()
                }],
                ..Default::default()
            },
            bin_data_content: vec![BinDataContent {
                id: 7,
                data: BinDataBytes::from(b"current".to_vec()),
                extension: "dat".to_string(),
            }],
            ..Default::default()
        };
        let incoming = Document {
            doc_info: DocInfo {
                bin_data_list: vec![BinData {
                    data_type: BinDataType::Embedding,
                    storage_id: 7,
                    ..Default::default()
                }],
                ..Default::default()
            },
            bin_data_content: vec![BinDataContent {
                id: 7,
                data: BinDataBytes::from(b"incoming".to_vec()),
                extension: "dat".to_string(),
            }],
            extra_streams: vec![("/Opaque".to_string(), vec![0x5a; 4096])],
            hwpx_aux_entries: vec![("Aux/opaque.bin".to_string(), vec![0xa5; 4096])],
            ..Default::default()
        };
        let extra_ptr = incoming.extra_streams[0].1.as_ptr();
        let aux_ptr = incoming.hwpx_aux_entries[0].1.as_ptr();

        let prepared = prepare_merge_views(&base, &current, &incoming).unwrap();

        assert!(prepared.incoming.bin_data_content.is_none());
        assert!(prepared.incoming.doc_info.is_none());
        assert!(prepared.incoming.sections.is_none());
        assert_eq!(prepared.bin_data.declarations[1].storage_id, 8);
        assert_eq!(
            prepared.incoming.source.extra_streams[0].1.as_ptr(),
            extra_ptr
        );
        assert_eq!(
            prepared.incoming.source.hwpx_aux_entries[0].1.as_ptr(),
            aux_ptr
        );
    }

    #[test]
    fn remapped_lazy_resource_preserves_raw_fallback_and_reparsed_storage_id() {
        use crate::model::bin_data::{
            BinData, BinDataCompression, BinDataResolver, BinDataStreamEncoding, BinDataType,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[derive(Debug)]
        struct RawOnlyResolver {
            bytes: Vec<u8>,
            decoded_calls: AtomicUsize,
            raw_calls: AtomicUsize,
        }

        impl BinDataResolver for RawOnlyResolver {
            fn resolve(&self, _key: &str) -> Vec<u8> {
                panic!("merge must not eagerly resolve the lazy resource")
            }

            fn resolve_limited(&self, _key: &str, _max_bytes: usize) -> Option<Vec<u8>> {
                self.decoded_calls.fetch_add(1, Ordering::SeqCst);
                None
            }

            fn resolve_original_stream_limited(
                &self,
                key: &str,
                expected_encoding: BinDataStreamEncoding,
                max_bytes: usize,
            ) -> Option<Vec<u8>> {
                self.raw_calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(key, "BIN0001.dat");
                assert_eq!(
                    expected_encoding,
                    BinDataStreamEncoding {
                        compressed: false,
                        ole_storage: false,
                    }
                );
                (self.bytes.len() <= max_bytes).then(|| self.bytes.clone())
            }
        }

        let bin_info = || BinData {
            attr: 0x0021,
            data_type: BinDataType::Embedding,
            compression: BinDataCompression::NoCompress,
            storage_id: 1,
            extension: Some("dat".to_string()),
            ..Default::default()
        };
        let source = Document {
            doc_info: DocInfo {
                bin_data_list: vec![bin_info()],
                ..Default::default()
            },
            bin_data_content: vec![BinDataContent {
                id: 1,
                data: BinDataBytes::from(b"incoming-raw".to_vec()),
                extension: "dat".to_string(),
            }],
            ..Default::default()
        };
        let source_bytes = serialize_hwp(&source).expect("source serialization");
        let parsed_source = parse_document(&source_bytes).expect("source reparse");
        let incoming_info = parsed_source.doc_info.bin_data_list[0].clone();
        assert!(incoming_info.raw_data.is_some());

        let base = Document::default();
        let current = Document {
            doc_info: DocInfo {
                bin_data_list: vec![bin_info()],
                ..Default::default()
            },
            bin_data_content: vec![BinDataContent {
                id: 1,
                data: BinDataBytes::from(b"current".to_vec()),
                extension: "dat".to_string(),
            }],
            ..Default::default()
        };
        let resolver = std::sync::Arc::new(RawOnlyResolver {
            bytes: b"incoming-raw".to_vec(),
            decoded_calls: AtomicUsize::new(0),
            raw_calls: AtomicUsize::new(0),
        });
        let incoming = Document {
            doc_info: DocInfo {
                bin_data_list: vec![incoming_info.clone()],
                ..Default::default()
            },
            bin_data_content: vec![BinDataContent {
                id: 1,
                data: BinDataBytes::lazy(resolver.clone(), "BIN0001.dat".to_string()),
                extension: "dat".to_string(),
            }],
            ..Default::default()
        };

        let (merged, _) = merge_doc(&base, &current, &incoming, None).expect("document merge");
        assert_eq!(
            merged
                .doc_info
                .bin_data_list
                .iter()
                .map(|info| info.storage_id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(merged.doc_info.bin_data_list[1].raw_data.is_none());
        assert_eq!(
            merged
                .bin_data_content
                .iter()
                .map(|content| content.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(resolver.decoded_calls.load(Ordering::SeqCst), 0);

        let merged_bytes = serialize_hwp(&merged).expect("merged serialization");
        assert_eq!(resolver.decoded_calls.load(Ordering::SeqCst), 1);
        assert_eq!(resolver.raw_calls.load(Ordering::SeqCst), 1);
        let reparsed = parse_document(&merged_bytes).expect("merged reparse");
        assert_eq!(
            reparsed
                .doc_info
                .bin_data_list
                .iter()
                .map(|info| info.storage_id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        let remapped = reparsed
            .bin_data_content
            .iter()
            .find(|content| content.id == 2)
            .expect("remapped BinData content");
        assert_eq!(
            remapped.data.load_limited(64).as_deref(),
            Some(b"incoming-raw".as_slice())
        );
    }
    #[test]
    fn formatting_known_controls_and_page_fields_merge_independently() {
        let b = vec![
            CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            },
            CharShapeRef {
                start_pos: 4,
                char_shape_id: 0,
            },
        ];
        let mut c = b.clone();
        c[0].char_shape_id = 1;
        let mut i = b.clone();
        i[1].char_shape_id = 2;
        let mut ctx = Ctx::new(MergeOptions::default());
        let out = merge_char_shapes(&["format".into()], &b, &c, &i, None, &mut ctx).unwrap();
        assert!(ctx.conflicts.is_empty());
        assert_eq!((out[0].char_shape_id, out[1].char_shape_id), (1, 2));
        let b = Control::Hyperlink(crate::model::control::Hyperlink {
            url: "base".into(),
            text: "base".into(),
        });
        let c = Control::Hyperlink(crate::model::control::Hyperlink {
            url: "current".into(),
            text: "base".into(),
        });
        let i = Control::Hyperlink(crate::model::control::Hyperlink {
            url: "base".into(),
            text: "incoming".into(),
        });
        let mut ctx = Ctx::new(MergeOptions::default());
        let Control::Hyperlink(out) =
            merge_control(&["control".into()], &b, &c, &i, None, &mut ctx).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            (out.url.as_str(), out.text.as_str()),
            ("current", "incoming")
        );
        assert!(ctx.conflicts.is_empty());
        let mut b = PageDef::default();
        b.width = 100;
        b.height = 200;
        let mut c = b.clone();
        c.margin_left = 10;
        let mut i = b.clone();
        i.margin_right = 20;
        let mut ctx = Ctx::new(MergeOptions::default());
        let out = merge_page_def(&["page".into()], &b, &c, &i, None, &mut ctx).unwrap();
        assert_eq!((out.margin_left, out.margin_right), (10, 20));
        assert!(ctx.conflicts.is_empty());
        let b = ChartShape::default();
        let mut c = b.clone();
        c.title = Some("current".into());
        let mut i = b.clone();
        i.raw_chart_data = vec![1, 2, 3];
        let mut ctx = Ctx::new(MergeOptions::default());
        let out = merge_chart(&["chart".into()], &b, &c, &i, None, &mut ctx).unwrap();
        assert_eq!(out.title.as_deref(), Some("current"));
        assert_eq!(out.raw_chart_data, vec![1, 2, 3]);
        assert!(ctx.conflicts.is_empty());
    }
    #[test]
    fn doc_info_note_and_master_page_properties_merge_independently() {
        let mut b = DocInfo::default();
        b.font_faces = vec![vec![Font::default()]];
        b.border_fills = vec![BorderFill::default()];
        b.char_shapes = vec![CharShape::default()];
        b.tab_defs = vec![TabDef::default()];
        b.para_shapes = vec![ParaShape::default()];
        let mut c = b.clone();
        c.font_faces[0][0].name = "Current Font".into();
        c.char_shapes[0].bold = true;
        c.para_shapes[0].margin_left = 100;
        let mut i = b.clone();
        i.font_faces[0][0].alt_type = 2;
        i.char_shapes[0].text_color = 0x123456;
        i.para_shapes[0].margin_right = 200;
        let mut ctx = Ctx::new(MergeOptions::default());
        let out = merge_doc_info(&b, &c, &i, None, &mut ctx).unwrap();
        assert!(ctx.conflicts.is_empty(), "{:?}", ctx.conflicts);
        assert_eq!(out.font_faces[0][0].name, "Current Font");
        assert_eq!(out.font_faces[0][0].alt_type, 2);
        assert!(out.char_shapes[0].bold);
        assert_eq!(out.char_shapes[0].text_color, 0x123456);
        assert_eq!(
            (
                out.para_shapes[0].margin_left,
                out.para_shapes[0].margin_right
            ),
            (100, 200)
        );
        let mut b = SectionDef::default();
        b.master_pages = vec![MasterPage {
            paragraphs: vec![Paragraph::default()],
            ..Default::default()
        }];
        let mut c = b.clone();
        c.footnote_shape.separator_length = 10;
        c.master_pages[0].text_width = 300;
        let mut i = b.clone();
        i.footnote_shape.note_spacing = 20;
        i.master_pages[0].paragraphs[0].text = "incoming master".into();
        let mut ctx = Ctx::new(MergeOptions::default());
        let out = merge_section_def(&["section".into()], &b, &c, &i, None, &mut ctx).unwrap();
        assert!(ctx.conflicts.is_empty(), "{:?}", ctx.conflicts);
        assert_eq!(
            (
                out.footnote_shape.separator_length,
                out.footnote_shape.note_spacing
            ),
            (10, 20)
        );
        assert_eq!(out.master_pages[0].text_width, 300);
        assert_eq!(out.master_pages[0].paragraphs[0].text, "incoming master");
    }
    #[test]
    fn document_model_moves_are_conflicts_not_positional_inference() {
        let para = |id: u32| {
            let mut p = Paragraph::default();
            p.raw_header_extra = vec![0; 10];
            p.raw_header_extra[6..10].copy_from_slice(&id.to_le_bytes());
            p
        };
        let b = vec![para(1), para(2), para(3)];
        let c = vec![b[0].clone(), b[2].clone(), b[1].clone()];
        let i = vec![b[1].clone(), b[0].clone(), b[2].clone()];
        let mut ctx = Ctx::new(MergeOptions::default());
        let _ = merge_paras(&["paragraphs".into()], &b, &c, &i, None, &mut ctx).unwrap();
        assert!(ctx
            .conflicts
            .iter()
            .any(|v| v.reason == MergeConflictReason::IncompatibleMove));
        let shape = |id: u32| {
            let mut v = crate::model::shape::LineShape::default();
            v.common.instance_id = id;
            ShapeObject::Line(v)
        };
        let mut bg = crate::model::shape::GroupShape::default();
        bg.children = vec![shape(1), shape(2), shape(3)];
        let mut cg = bg.clone();
        cg.children.swap(1, 2);
        let mut ig = bg.clone();
        ig.children.swap(0, 1);
        let mut ctx = Ctx::new(MergeOptions::default());
        let _ = merge_shape(
            &["group".into()],
            &ShapeObject::Group(bg),
            &ShapeObject::Group(cg),
            &ShapeObject::Group(ig),
            None,
            &mut ctx,
        )
        .unwrap();
        assert!(ctx
            .conflicts
            .iter()
            .any(|v| v.reason == MergeConflictReason::IncompatibleMove));
    }
    #[test]
    fn generated_structural_merges_are_deterministic_and_reloadable() {
        let mut seed = 0x1234_5678_u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 32) as u32
        };
        for _ in 0..128 {
            let count = (next() % 8 + 1) as usize;
            let base = (0..count)
                .map(|n| json!({"id":format!("n{n}"),"x":next()%7,"y":next()%7}))
                .collect::<Vec<_>>();
            let mut current = base.clone();
            let mut incoming = base.clone();
            let ci = (next() as usize) % count;
            let ii = (next() as usize) % count;
            current[ci]["x"] = json!(next() % 20);
            incoming[ii]["y"] = json!(next() % 20);
            let b = json!({"nodes":base});
            let c = json!({"nodes":current});
            let i = json!({"nodes":incoming});
            let first = analyze(&b, &c, &i);
            for _ in 0..3 {
                assert_eq!(analyze(&b, &c, &i), first)
            }
            let resolutions = first
                .conflicts
                .iter()
                .map(|v| (v.id.clone(), MergeResolution::Current))
                .collect();
            assert!(materialize(&first, &resolutions).is_ok());
        }
        let mut doc = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        doc.sections[0].paragraphs[0].text = "manifest fixture".into();
        doc.sections[0].raw_stream = None;
        crate::document_core::queries::field_query::rebuild_char_offsets(
            &mut doc.sections[0].paragraphs[0],
        );
        for bytes in [serialize_hwp(&doc).unwrap(), serialize_hwpx(&doc).unwrap()] {
            let manifest = build_structural_manifest(&bytes).unwrap();
            assert!(manifest
                .entries
                .iter()
                .any(|v| v.kind == "section-settings"));
            assert!(manifest.entries.iter().any(|v| v.kind == "text"));
            let a = analyze_document_bytes(&bytes, &bytes, &bytes).unwrap();
            assert!(a.conflicts.is_empty());
            let out = materialize_document_bytes(&bytes, &bytes, &bytes, &BTreeMap::new()).unwrap();
            assert_eq!(
                parse_document(&out).unwrap().sections[0].paragraphs[0].text,
                "manifest fixture"
            );
        }
    }
    #[test]
    fn virtual_document_base_retains_disjoint_nested_fields() {
        let mut template = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        template.sections[0].raw_stream = None;
        template.sections[0].paragraphs[0].text.clear();
        crate::document_core::queries::field_query::rebuild_char_offsets(
            &mut template.sections[0].paragraphs[0],
        );
        let mut text_base = template.clone();
        text_base.sections[0].paragraphs[0].text = "virtual text".into();
        crate::document_core::queries::field_query::rebuild_char_offsets(
            &mut text_base.sections[0].paragraphs[0],
        );
        let mut page_base = template.clone();
        page_base.sections[0].section_def.page_def.margin_left = 7777;
        let a = serialize_hwpx(&text_base).unwrap();
        let b = serialize_hwpx(&page_base).unwrap();
        let first =
            synthesize_virtual_base_document_bytes(&[a.clone(), b.clone()], FileFormat::Hwpx)
                .unwrap();
        let second = synthesize_virtual_base_document_bytes(&[b, a], FileFormat::Hwpx).unwrap();
        assert_eq!(first, second);
        let out = parse_document(&first).unwrap();
        assert_eq!(out.sections[0].paragraphs[0].text, "virtual text");
        assert_eq!(out.sections[0].section_def.page_def.margin_left, 7777);
    }
    #[test]
    fn manifest_paths_and_walkers_cover_shape_textboxes_and_captions() {
        let mut line = crate::model::shape::LineShape::default();
        line.drawing.text_box = Some(TextBox {
            paragraphs: vec![Paragraph {
                text: "textbox".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        let mut chart = ChartShape::default();
        chart.caption = Some(Caption {
            paragraphs: vec![Paragraph {
                text: "caption".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        let group = crate::model::shape::GroupShape {
            children: vec![ShapeObject::Chart(Box::new(chart))],
            ..Default::default()
        };
        let mut doc = Document {
            sections: vec![Section {
                paragraphs: vec![Paragraph {
                    controls: vec![
                        Control::Shape(Box::new(ShapeObject::Line(line))),
                        Control::Shape(Box::new(ShapeObject::Group(group))),
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let textbox = vec![
            "sections",
            "0",
            "paragraphs",
            "0",
            "controls",
            "0",
            "drawing",
            "textBox",
            "paragraphs",
            "0",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        paragraph_at_manifest_path(&mut doc, &textbox)
            .unwrap()
            .style_id = 3;
        let caption = vec![
            "sections",
            "0",
            "paragraphs",
            "0",
            "controls",
            "1",
            "children",
            "0",
            "caption",
            "paragraphs",
            "0",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        paragraph_at_manifest_path(&mut doc, &caption)
            .unwrap()
            .style_id = 4;
        let mut seen = vec![];
        visit_nested_paragraphs_mut(&mut doc.sections[0].paragraphs, &mut |p| {
            seen.push((p.text.clone(), p.style_id))
        });
        assert!(seen.contains(&("textbox".into(), 3)));
        assert!(seen.contains(&("caption".into(), 4)));
    }
    #[test]
    fn dependency_validation_rejects_missing_picture_bytes() {
        let mut d = Document::default();
        let mut p = Paragraph::default();
        p.controls.push(Control::Picture(Box::new(Picture {
            image_attr: ImageAttr {
                bin_data_id: 42,
                ..Default::default()
            },
            ..Default::default()
        })));
        d.sections.push(Section {
            paragraphs: vec![p],
            ..Default::default()
        });
        assert!(validate_resource_dependencies(&d)
            .unwrap_err()
            .contains("missing BinData id 42"));
    }

    #[test]
    fn hwp_link_declaration_slot_is_a_valid_image_reference() {
        use crate::model::bin_data::{BinData, BinDataType};
        use crate::model::provenance::SourceFormat;

        let mut document = Document::default();
        document.provenance.format = SourceFormat::Hwp5;
        document.doc_info.bin_data_list.push(BinData {
            data_type: BinDataType::Link,
            storage_id: 0,
            abs_path: Some("C:\\external.png".into()),
            ..Default::default()
        });
        document.sections.push(Section {
            paragraphs: vec![Paragraph {
                controls: vec![Control::Picture(Box::new(Picture {
                    image_attr: ImageAttr {
                        bin_data_id: 1,
                        ..Default::default()
                    },
                    ..Default::default()
                }))],
                ..Default::default()
            }],
            ..Default::default()
        });

        validate_resource_dependencies(&document).unwrap();
        let reparsed = parse_document(&serialize_hwp(&document).unwrap()).unwrap();
        validate_resource_dependencies(&reparsed).unwrap();
        let Control::Picture(picture) = &reparsed.sections[0].paragraphs[0].controls[0] else {
            panic!()
        };
        assert_eq!(picture.image_attr.bin_data_id, 1);
    }

    #[test]
    fn dependency_validation_covers_every_bin_data_consumer_and_association() {
        use crate::model::bin_data::{BinData, BinDataType};
        use crate::model::provenance::SourceFormat;
        use crate::model::shape::{GroupShape, RectangleShape};
        use crate::model::style::{Fill, FillType, ImageFill, SubstFont};

        let valid_declaration = || BinData {
            data_type: BinDataType::Embedding,
            storage_id: 1,
            ..Default::default()
        };
        let valid_content = || BinDataContent {
            id: 1,
            data: BinDataBytes::from(vec![1]),
            extension: "dat".into(),
        };
        let valid = || Document {
            doc_info: DocInfo {
                bin_data_list: vec![valid_declaration()],
                ..Default::default()
            },
            bin_data_content: vec![valid_content()],
            ..Default::default()
        };
        let missing_fill = || Fill {
            fill_type: FillType::Image,
            image: Some(ImageFill {
                bin_data_id: 2,
                ..Default::default()
            }),
            ..Default::default()
        };

        let mut duplicate = valid();
        duplicate.doc_info.bin_data_list.push(valid_declaration());
        assert!(validate_resource_dependencies(&duplicate)
            .unwrap_err()
            .contains("duplicate BinData declaration"));

        let orphan = Document {
            bin_data_content: vec![valid_content()],
            ..Default::default()
        };
        assert!(validate_resource_dependencies(&orphan)
            .unwrap_err()
            .contains("no matching declaration"));

        let missing_payload = Document {
            doc_info: DocInfo {
                bin_data_list: vec![valid_declaration()],
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(validate_resource_dependencies(&missing_payload)
            .unwrap_err()
            .contains("missing content"));

        let mut border = valid();
        border.doc_info.border_fills.push(BorderFill {
            fill: missing_fill(),
            ..Default::default()
        });
        assert!(validate_resource_dependencies(&border)
            .unwrap_err()
            .contains("border fill"));

        let mut fonts = valid();
        fonts.doc_info.font_faces = vec![vec![Font {
            resolved_bin_data_id: Some(2),
            subst_font: Some(SubstFont {
                resolved_bin_data_id: Some(2),
                ..Default::default()
            }),
            ..Default::default()
        }]];
        assert!(validate_resource_dependencies(&fonts)
            .unwrap_err()
            .contains("font"));

        let mut bullet = valid();
        bullet.doc_info.bullets.push(Bullet {
            image_bullet: 2,
            ..Default::default()
        });
        assert!(validate_resource_dependencies(&bullet)
            .unwrap_err()
            .contains("image bullet"));

        let mut nested_fill = valid();
        nested_fill.sections.push(Section {
            paragraphs: vec![Paragraph {
                controls: vec![Control::Shape(Box::new(ShapeObject::Group(GroupShape {
                    children: vec![ShapeObject::Rectangle(RectangleShape {
                        drawing: DrawingObjAttr {
                            fill: missing_fill(),
                            ..Default::default()
                        },
                        ..Default::default()
                    })],
                    ..Default::default()
                })))],
                ..Default::default()
            }],
            ..Default::default()
        });
        assert!(validate_resource_dependencies(&nested_fill)
            .unwrap_err()
            .contains("shape fill image"));

        let mut overflowing_ole = valid();
        overflowing_ole.sections.push(Section {
            paragraphs: vec![Paragraph {
                controls: vec![Control::Shape(Box::new(ShapeObject::Ole(Box::new(
                    OleShape {
                        bin_data_id: u32::from(u16::MAX) + 1,
                        ..Default::default()
                    },
                ))))],
                ..Default::default()
            }],
            ..Default::default()
        });
        assert!(validate_resource_dependencies(&overflowing_ole)
            .unwrap_err()
            .contains("65536"));

        let mut stale_bullet = valid();
        stale_bullet.provenance.format = SourceFormat::Hwpx;
        stale_bullet.doc_info.bullets.push(Bullet {
            image_bullet: 1,
            raw_para_head: Some(r#"<hh:img binaryItemIDRef="image2"/>"#.into()),
            ..Default::default()
        });
        assert!(validate_resource_dependencies(&stale_bullet)
            .unwrap_err()
            .contains("does not match typed id"));
    }

    #[test]
    fn numbering_and_bullet_appends_shift_only_matching_head_types() {
        let mut base = Document::default();
        base.doc_info.numberings.push(Numbering::default());
        base.doc_info.bullets.push(Bullet::default());

        let mut current_numbering = base.clone();
        current_numbering
            .doc_info
            .numberings
            .push(Numbering::default());
        let mut incoming = base.clone();
        incoming.doc_info.numberings.push(Numbering::default());
        incoming.doc_info.bullets.push(Bullet::default());
        incoming.doc_info.para_shapes = vec![
            ParaShape {
                head_type: HeadType::Number,
                numbering_id: 2,
                raw_data: Some(vec![1]),
                ..Default::default()
            },
            ParaShape {
                head_type: HeadType::Bullet,
                numbering_id: 2,
                raw_data: Some(vec![2]),
                ..Default::default()
            },
        ];

        let prepared = prepare_merge_views(&base, &current_numbering, &incoming).unwrap();
        assert_eq!(prepared.incoming.doc_info().para_shapes[0].numbering_id, 3);
        assert_eq!(prepared.incoming.doc_info().para_shapes[1].numbering_id, 2);
        assert!(prepared.incoming.doc_info().para_shapes[0]
            .raw_data
            .is_none());
        assert_eq!(
            prepared.incoming.doc_info().para_shapes[1].raw_data,
            Some(vec![2])
        );

        let mut current_bullet = base.clone();
        current_bullet.doc_info.bullets.push(Bullet::default());
        let prepared = prepare_merge_views(&base, &current_bullet, &incoming).unwrap();
        assert_eq!(prepared.incoming.doc_info().para_shapes[0].numbering_id, 2);
        assert_eq!(prepared.incoming.doc_info().para_shapes[1].numbering_id, 3);
    }

    #[test]
    fn concurrent_positional_resources_remap_every_consumer_and_reparse() {
        use crate::model::control::{CharOverlap, FormObject, Ruby};
        use crate::model::provenance::SourceFormat;
        use crate::model::table::TableZone;

        let mut base = Document::default();
        base.doc_info.font_faces = (0..7)
            .map(|language| {
                vec![Font {
                    name: format!("Base font {language}"),
                    ..Default::default()
                }]
            })
            .collect();
        base.doc_info.border_fills.push(BorderFill::default());
        base.doc_info.char_shapes.push(CharShape::default());
        base.doc_info.tab_defs.push(TabDef::default());
        base.doc_info.numberings.push(Numbering::default());
        base.doc_info.bullets.push(Bullet::default());
        base.doc_info.para_shapes.push(ParaShape::default());
        base.doc_info.styles.push(Style::default());
        base.sections.push(Section {
            paragraphs: vec![Paragraph::default()],
            ..Default::default()
        });

        let mut current = base.clone();
        current.doc_info.font_faces[0].push(Font {
            name: "Current appended font".into(),
            ..Default::default()
        });
        current.doc_info.border_fills.push(BorderFill::default());
        current.doc_info.char_shapes.push(CharShape::default());
        current.doc_info.tab_defs.push(TabDef::default());
        current.doc_info.numberings.push(Numbering::default());
        current.doc_info.bullets.push(Bullet::default());
        current.doc_info.para_shapes.push(ParaShape::default());
        current.doc_info.styles.push(Style::default());

        let mut incoming = base.clone();
        incoming.doc_info.font_faces[0].push(Font {
            name: "Incoming appended font".into(),
            ..Default::default()
        });
        incoming.doc_info.border_fills.push(BorderFill::default());
        incoming.doc_info.char_shapes.push(CharShape {
            raw_data: Some(vec![1, 2]),
            font_ids: [1, 0, 0, 0, 0, 0, 0],
            border_fill_id: 2,
            ..Default::default()
        });
        incoming.doc_info.tab_defs.push(TabDef::default());
        let mut incoming_numbering = Numbering {
            raw_para_heads: Some(r#"<hh:paraHead level="1" charPrIDRef="1"/>"#.into()),
            raw_data: Some(vec![9]),
            ..Default::default()
        };
        incoming_numbering.heads[0].char_shape_id = 1;
        incoming.doc_info.numberings.push(incoming_numbering);
        incoming.doc_info.bullets.push(Bullet {
            char_shape_id: 1,
            raw_para_head: Some(r#"<hh:paraHead charPrIDRef="1"/>"#.into()),
            raw_data: Some(vec![10]),
            ..Default::default()
        });
        incoming.doc_info.para_shapes.extend([
            ParaShape {
                raw_data: Some(vec![3, 4]),
                tab_def_id: 1,
                head_type: HeadType::Number,
                numbering_id: 2,
                border_fill_id: 2,
                ..Default::default()
            },
            ParaShape {
                raw_data: Some(vec![5, 6]),
                tab_def_id: 1,
                head_type: HeadType::Bullet,
                numbering_id: 2,
                border_fill_id: 2,
                ..Default::default()
            },
        ]);
        incoming.doc_info.styles.push(Style {
            raw_data: Some(vec![7, 8]),
            next_style_id: 1,
            para_shape_id: 1,
            char_shape_id: 1,
            ..Default::default()
        });

        let mut form = FormObject::default();
        form.name = "positional-form".into();
        form.properties.insert("CharShapeID".into(), "1".into());
        let nested_cell = Cell {
            border_fill_id: 2,
            paragraphs: vec![Paragraph {
                para_shape_id: 1,
                style_id: 1,
                char_shapes: vec![CharShapeRef {
                    char_shape_id: 1,
                    ..Default::default()
                }],
                controls: vec![Control::Ruby(Ruby {
                    style_id_ref: 1,
                    ..Default::default()
                })],
                ..Default::default()
            }],
            ..Default::default()
        };
        let nested_table = Table {
            row_count: 1,
            col_count: 1,
            row_sizes: vec![1],
            border_fill_id: 2,
            zones: vec![TableZone {
                border_fill_id: 2,
                ..Default::default()
            }],
            cells: vec![nested_cell],
            ..Default::default()
        };
        incoming.sections[0] = Section {
            raw_stream: Some(vec![0xaa, 0xbb]),
            paragraphs: vec![Paragraph {
                para_shape_id: 1,
                style_id: 1,
                char_shapes: vec![CharShapeRef {
                    char_shape_id: 1,
                    ..Default::default()
                }],
                controls: vec![
                    Control::Ruby(Ruby {
                        style_id_ref: 1,
                        ..Default::default()
                    }),
                    Control::CharOverlap(CharOverlap {
                        chars: vec!['A'],
                        char_shape_ids: vec![1, u32::MAX],
                        ..Default::default()
                    }),
                    Control::Form(Box::new(form)),
                ],
                ..Default::default()
            }],
            section_def: SectionDef {
                outline_numbering_id: 2,
                page_border_fill: PageBorderFill {
                    border_fill_id: 2,
                    ..Default::default()
                },
                extra_page_border_fills: vec![PageBorderFill {
                    border_fill_id: 2,
                    ..Default::default()
                }],
                master_pages: vec![MasterPage {
                    paragraphs: vec![Paragraph {
                        controls: vec![Control::Table(Box::new(nested_table))],
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
            ..Default::default()
        };

        let prepared =
            prepare_merge_views_for_format(&base, &current, &incoming, SourceFormat::Hwpx).unwrap();
        let info = prepared.incoming.doc_info();
        assert_eq!(info.char_shapes[1].font_ids[0], 2);
        assert_eq!(info.char_shapes[1].border_fill_id, 3);
        assert!(info.char_shapes[1].raw_data.is_none());
        assert_eq!(info.para_shapes[1].tab_def_id, 2);
        assert_eq!(info.para_shapes[1].numbering_id, 3);
        assert_eq!(info.para_shapes[2].numbering_id, 3);
        assert_eq!(info.para_shapes[1].border_fill_id, 3);
        assert!(info.para_shapes[1].raw_data.is_none());
        assert_eq!(info.styles[1].next_style_id, 2);
        assert_eq!(info.styles[1].para_shape_id, 2);
        assert_eq!(info.styles[1].char_shape_id, 2);
        assert!(info.styles[1].raw_data.is_none());
        assert_eq!(info.numberings[1].heads[0].char_shape_id, 2);
        assert!(info.numberings[1].raw_data.is_none());
        assert!(info.numberings[1]
            .raw_para_heads
            .as_deref()
            .unwrap()
            .contains(r#"charPrIDRef="2""#));
        assert_eq!(info.bullets[1].char_shape_id, 2);
        assert!(info.bullets[1].raw_data.is_none());
        assert!(info.bullets[1]
            .raw_para_head
            .as_deref()
            .unwrap()
            .contains(r#"charPrIDRef="2""#));

        let section = &prepared.incoming.sections()[0];
        assert!(section.raw_stream.is_none());
        assert_eq!(section.section_def.outline_numbering_id, 3);
        assert_eq!(section.section_def.page_border_fill.border_fill_id, 3);
        assert_eq!(
            section.section_def.extra_page_border_fills[0].border_fill_id,
            3
        );
        let paragraph = &section.paragraphs[0];
        assert_eq!(paragraph.style_id, 2);
        assert_eq!(paragraph.para_shape_id, 2);
        assert_eq!(paragraph.char_shapes[0].char_shape_id, 2);
        let Control::Ruby(ruby) = &paragraph.controls[0] else {
            panic!()
        };
        assert_eq!(ruby.style_id_ref, 2);
        let Control::CharOverlap(overlap) = &paragraph.controls[1] else {
            panic!()
        };
        assert_eq!(overlap.char_shape_ids, vec![2, u32::MAX]);
        let Control::Form(form) = &paragraph.controls[2] else {
            panic!()
        };
        assert_eq!(form.properties["CharShapeID"], "2");
        let Control::Table(table) = &section.section_def.master_pages[0].paragraphs[0].controls[0]
        else {
            panic!()
        };
        assert_eq!(table.border_fill_id, 3);
        assert_eq!(table.zones[0].border_fill_id, 3);
        assert_eq!(table.cells[0].border_fill_id, 3);
        assert_eq!(table.cells[0].paragraphs[0].style_id, 2);

        let (merged, analysis) =
            merge_doc_for_format(&base, &current, &incoming, None, SourceFormat::Hwpx).unwrap();
        assert!(analysis.conflicts.is_empty());
        validate_resource_dependencies(&merged).unwrap();
        let reparsed = parse_document(&serialize_hwpx(&merged).unwrap()).unwrap();
        validate_resource_dependencies(&reparsed).unwrap();
        assert_eq!(reparsed.doc_info.char_shapes[2].font_ids[0], 2);
        assert_eq!(reparsed.doc_info.char_shapes[2].border_fill_id, 3);
        assert_eq!(reparsed.doc_info.para_shapes[2].tab_def_id, 2);
        assert_eq!(reparsed.doc_info.para_shapes[2].numbering_id, 3);
        assert_eq!(reparsed.doc_info.numberings[2].heads[0].char_shape_id, 2);
        assert_eq!(reparsed.doc_info.bullets[2].char_shape_id, 2);
        assert_eq!(reparsed.sections[0].section_def.outline_numbering_id, 3);
        assert_eq!(
            reparsed.sections[0].section_def.master_pages[0].paragraphs[0]
                .controls
                .iter()
                .find_map(|control| match control {
                    Control::Table(table) => Some(table.cells[0].border_fill_id),
                    _ => None,
                }),
            Some(3)
        );
    }

    #[test]
    fn dependency_validation_covers_positional_consumers() {
        use crate::model::control::{CharOverlap, FormObject, Ruby};

        let mut valid = Document::default();
        valid.doc_info.font_faces = vec![vec![Font::default()]; 7];
        valid.doc_info.border_fills.push(BorderFill::default());
        valid.doc_info.char_shapes.push(CharShape::default());
        valid.doc_info.tab_defs.push(TabDef::default());
        valid.doc_info.numberings.push(Numbering::default());
        valid.doc_info.bullets.push(Bullet::default());
        valid.doc_info.para_shapes.push(ParaShape::default());
        valid.doc_info.styles.push(Style::default());
        let mut form = FormObject::default();
        form.properties.insert("CharShapeID".into(), "0".into());
        valid.sections.push(Section {
            section_def: SectionDef {
                outline_numbering_id: 1,
                page_border_fill: PageBorderFill {
                    border_fill_id: 1,
                    ..Default::default()
                },
                ..Default::default()
            },
            paragraphs: vec![Paragraph {
                controls: vec![
                    Control::Table(Box::new(Table {
                        border_fill_id: 1,
                        cells: vec![Cell {
                            border_fill_id: 1,
                            ..Default::default()
                        }],
                        ..Default::default()
                    })),
                    Control::Ruby(Ruby::default()),
                    Control::CharOverlap(CharOverlap {
                        char_shape_ids: vec![0, u32::MAX],
                        ..Default::default()
                    }),
                    Control::Form(Box::new(form)),
                ],
                ..Default::default()
            }],
            ..Default::default()
        });
        validate_resource_dependencies(&valid).unwrap();

        let mut invalid = valid.clone();
        invalid.doc_info.char_shapes[0].font_ids[0] = 1;
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("missing font"));

        let mut invalid = valid.clone();
        invalid.doc_info.para_shapes[0].tab_def_id = 1;
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("tab definition"));

        let mut invalid = valid.clone();
        invalid.doc_info.para_shapes[0].head_type = HeadType::Bullet;
        invalid.doc_info.para_shapes[0].numbering_id = 2;
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("missing bullet"));

        let mut invalid = valid.clone();
        invalid.sections[0].section_def.outline_numbering_id = 2;
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("section outline numbering"));

        let mut invalid = valid.clone();
        invalid.sections[0]
            .section_def
            .page_border_fill
            .border_fill_id = 2;
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("page border fill"));

        let mut invalid = valid.clone();
        let Control::Table(table) = &mut invalid.sections[0].paragraphs[0].controls[0] else {
            panic!()
        };
        table.cells[0].border_fill_id = 2;
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("table-cell border fill"));

        let mut invalid = valid.clone();
        let Control::Ruby(ruby) = &mut invalid.sections[0].paragraphs[0].controls[1] else {
            panic!()
        };
        ruby.style_id_ref = 1;
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("ruby style"));

        let mut invalid = valid.clone();
        let Control::CharOverlap(overlap) = &mut invalid.sections[0].paragraphs[0].controls[2]
        else {
            panic!()
        };
        overlap.char_shape_ids[0] = 1;
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("character overlap"));

        let mut invalid = valid;
        let Control::Form(form) = &mut invalid.sections[0].paragraphs[0].controls[3] else {
            panic!()
        };
        form.properties.insert("CharShapeID".into(), "1".into());
        assert!(validate_resource_dependencies(&invalid)
            .unwrap_err()
            .contains("form character shape"));
    }

    #[test]
    fn style_reference_shift_accepts_id_255_and_rejects_257_styles() {
        let mut base = Document::default();
        base.doc_info.styles = vec![Style::default(); 254];
        base.sections = vec![Section {
            paragraphs: vec![Paragraph {
                style_id: 253,
                ..Default::default()
            }],
            ..Default::default()
        }];
        let mut current = base.clone();
        current.doc_info.styles.push(Style::default());
        let mut incoming = base.clone();
        incoming.doc_info.styles.push(Style::default());
        incoming.sections[0].paragraphs[0].style_id = 254;

        let prepared = prepare_merge_views(&base, &current, &incoming).unwrap();
        assert_eq!(prepared.incoming.sections()[0].paragraphs[0].style_id, 255);
        let mut boundary = incoming.clone();
        boundary.doc_info.styles = current.doc_info.styles.clone();
        boundary.doc_info.styles.push(Style::default());
        boundary.sections = prepared.incoming.sections().to_vec();
        boundary.sections[0].raw_stream = None;
        let bytes = serialize_hwp(&boundary).unwrap();
        let reparsed = parse_document(&bytes).unwrap();
        assert_eq!(reparsed.doc_info.styles.len(), 256);
        assert_eq!(reparsed.sections[0].paragraphs[0].style_id, 255);

        current.doc_info.styles.push(Style::default());
        let error = prepare_merge_views(&base, &current, &incoming)
            .err()
            .expect("257 merged styles must fail before u8 reference saturation");
        assert!(error.contains("merged style count 257"), "{error}");
    }
}
