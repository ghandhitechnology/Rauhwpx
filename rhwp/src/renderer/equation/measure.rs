//! 수식 글립 측정.
//!
//! 배치 폭은 실제로 칠하는 서체에서 얻는다. 브라우저에서는 painter와 같은 CSS font
//! 문자열로 canvas를 측정하고, 네이티브에서는 같은 fallback 체인의 내장 메트릭을 쓴다.
//! 측정과 paint가 다른 서체를 보면 기호가 옆 원자와 겹친다(△x).

/// canvas painter와 측정이 공유하는 CSS font 문자열.
pub(crate) fn css_font(size: f64, italic: bool, bold: bool, family: &str) -> String {
    let style = if italic { "italic " } else { "" };
    let weight = if bold { "bold " } else { "" };
    format!("{}{}{:.3}px {}", style, weight, size, family)
}

/// 글립 run의 advance와 잉크 오른쪽 끝(시작점 기준, px).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RunMetrics {
    pub advance: f64,
    pub ink_right: f64,
}

impl RunMetrics {
    #[cfg(target_arch = "wasm32")]
    pub fn from_js(value: wasm_bindgen::JsValue) -> Option<Self> {
        let number = |key: &str| {
            js_sys::Reflect::get(&value, &wasm_bindgen::JsValue::from_str(key))
                .ok()?
                .as_f64()
        };
        let metrics = Self {
            advance: number("advance")?,
            ink_right: number("inkRight")?,
        };
        metrics.is_valid().then_some(metrics)
    }

    fn is_valid(&self) -> bool {
        self.advance.is_finite() && self.advance >= 0.0 && self.ink_right.is_finite()
    }

    /// 이탤릭 보정: 잉크가 advance 밖으로 넘친 폭.
    pub fn overhang(&self) -> f64 {
        (self.ink_right - self.advance).max(0.0)
    }
}

/// painter fallback 체인으로 run을 측정한다. 브라우저 canvas가 없으면 None.
#[cfg(target_arch = "wasm32")]
pub(crate) fn measure_css_run(font: &str, text: &str) -> Option<RunMetrics> {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use wasm_bindgen::JsCast;

    thread_local! {
        static CONTEXT: RefCell<Option<web_sys::CanvasRenderingContext2d>> = const { RefCell::new(None) };
        static CACHE: RefCell<HashMap<(String, String), RunMetrics>> = RefCell::new(HashMap::new());
    }

    CONTEXT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = web_sys::window()
                .and_then(|window| window.document())
                .and_then(|document| document.create_element("canvas").ok())
                .and_then(|element| element.dyn_into::<web_sys::HtmlCanvasElement>().ok())
                .and_then(|canvas| canvas.get_context("2d").ok().flatten())
                .and_then(|context| context.dyn_into().ok());
        }
        let context = slot.as_ref()?;
        // painter와 같은 setter를 거쳐 문서 서체 치환도 동일하게 적용된다.
        context.set_font(font);
        // 세션 서체를 가져오면 같은 요청 font라도 실제 runtime family가 달라진다.
        let key = (context.font(), text.to_string());
        if let Some(hit) = CACHE.with(|cache| cache.borrow().get(&key).copied()) {
            return Some(hit);
        }
        let measured = context.measure_text(text).ok()?;
        let metrics = RunMetrics {
            advance: measured.width(),
            ink_right: measured.actual_bounding_box_right(),
        };
        if !metrics.is_valid() {
            return None;
        }
        CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            if cache.len() >= 4096 {
                cache.clear();
            }
            cache.insert(key, metrics);
        });
        Some(metrics)
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn measure_css_run(_font: &str, _text: &str) -> Option<RunMetrics> {
    None
}

/// legacy 수식 서체 run 실측치.
///
/// 한컴 수식기는 글립을 서체 advance가 아니라 잉크 가장자리끼리 포갠다
/// (eq-002 실측: `=`→`−` 원점 간격 6.0pt = `=` 잉크 폭 6.02, `(`→`n` 1.9pt).
/// 배치가 다음 원자 원점을 `앞 잉크 끝 − 이 원자 lsb + 간격`으로 놓으려면
/// hmtx 합이 아니라 첫/마지막 글립의 잉크 경계가 필요하다.
#[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LegacyRunMetrics {
    /// 서체 hmtx advance 총합(px) — painter가 run 내부 글립을 놓는 스텝.
    pub advance: f64,
    /// 마지막 잉크 글립의 오른쪽 끝(run 원점 기준, px).
    pub ink_right: f64,
    /// 첫 잉크 글립의 왼쪽 끝 = 좌측 베어링(lsb, px).
    pub ink_left: f64,
}

/// legacy 수식 서체의 glyf/hmtx 원표 — 글립 잉크 경계를 디자인 단위로 읽는다.
///
/// skia `get_widths_bounds` 는 스트라이크 패딩(+1px)과 정수 라운딩이 섞여
/// 소수 pt 정밀도가 필요한 잉크 포개기에는 쓸 수 없다 (eq-002: `=` 참값
/// [0.67,8.65]px 가 [−1,10] 으로 옴). 서체 표를 직접 파싱하면 결정적이다.
#[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
struct LegacyTables {
    units_per_em: f64,
    advances: Vec<u16>,
    loca: Vec<u32>,
    glyf: Vec<u8>,
}

#[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
impl LegacyTables {
    fn table(typeface: &skia_safe::Typeface, tag: [u8; 4]) -> Option<Vec<u8>> {
        typeface
            .copy_table_data(u32::from_be_bytes(tag))
            .map(|d| d.as_bytes().to_vec())
    }

    fn u16be(d: &[u8], off: usize) -> Option<u16> {
        d.get(off..off + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
    }

    fn i16be(d: &[u8], off: usize) -> Option<i16> {
        Self::u16be(d, off).map(|v| v as i16)
    }

    fn load(typeface: &skia_safe::Typeface) -> Option<Self> {
        let head = Self::table(typeface, *b"head")?;
        let maxp = Self::table(typeface, *b"maxp")?;
        let hhea = Self::table(typeface, *b"hhea")?;
        let hmtx = Self::table(typeface, *b"hmtx")?;
        let loca_raw = Self::table(typeface, *b"loca")?;
        let glyf = Self::table(typeface, *b"glyf")?;
        let units_per_em = Self::u16be(&head, 18)? as f64;
        let loca_long = Self::i16be(&head, 50)? != 0;
        let num_glyphs = Self::u16be(&maxp, 4)? as usize;
        let num_metrics = (Self::u16be(&hhea, 34)? as usize).min(num_glyphs);
        // hmtx: num_metrics 개의 (advance,lsb) 쌍 뒤에 lsb 배열.
        let mut advances = Vec::with_capacity(num_glyphs);
        for g in 0..num_glyphs {
            let off = if g < num_metrics {
                g * 4
            } else {
                (num_metrics - 1) * 4
            };
            advances.push(Self::u16be(&hmtx, off)?);
        }
        let mut loca = Vec::with_capacity(num_glyphs + 1);
        for g in 0..=num_glyphs {
            let v = if loca_long {
                u32::from_be_bytes([
                    *loca_raw.get(g * 4)?,
                    *loca_raw.get(g * 4 + 1)?,
                    *loca_raw.get(g * 4 + 2)?,
                    *loca_raw.get(g * 4 + 3)?,
                ])
            } else {
                u32::from(Self::u16be(&loca_raw, g * 2)?) * 2
            };
            loca.push(v);
        }
        if units_per_em <= 0.0 {
            return None;
        }
        Some(Self {
            units_per_em,
            advances,
            loca,
            glyf,
        })
    }

    fn advance(&self, gid: u16) -> f64 {
        self.advances.get(gid as usize).copied().unwrap_or(0) as f64 / self.units_per_em
    }

    /// 글립 잉크 상자(em) — 비어 있으면 None.
    fn ink(&self, gid: u16) -> Option<(f64, f64, f64, f64)> {
        let g = gid as usize;
        let (lo, hi) = (*self.loca.get(g)?, *self.loca.get(g + 1)?);
        if lo >= hi {
            return None;
        }
        let d = self.glyf.get(lo as usize..hi as usize)?;
        if d.len() < 10 {
            return None;
        }
        Some((
            Self::i16be(d, 2)? as f64 / self.units_per_em,
            Self::i16be(d, 4)? as f64 / self.units_per_em,
            Self::i16be(d, 6)? as f64 / self.units_per_em,
            Self::i16be(d, 8)? as f64 / self.units_per_em,
        ))
    }
}

/// 네이티브 skia painter(draw_text)의 legacy 서체 경로로 run을 실측한다.
///
/// painter는 요청 서체가 HYhwpEQ 이고 실제 서체가 PUA cmap 을 가질 때 글자를
/// PUA 로 옮겨 칠한다(skia/equation_conv.rs). 네이티브에는 canvas 가 없으므로
/// 같은 typeface·같은 매핑으로 여기서 직접 잰다 — 다른 서체 폭으로 배치하면
/// 개체 advance 와 내부 간격이 paint 와 어긋난다. 서체가 없거나 글립이 빠지면
/// None — 호출자는 기존 내장 메트릭/추정 경로로 내려간다.
#[cfg(all(not(target_arch = "wasm32"), feature = "native-skia"))]
pub(crate) fn measure_legacy_run_native(
    text: &str,
    font_size: f64,
    italic: bool,
    bold: bool,
) -> Option<LegacyRunMetrics> {
    use skia_safe::{Font, FontMgr, FontStyle, Typeface};
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static LEGACY_FACE: RefCell<Option<Option<(Typeface, std::rc::Rc<LegacyTables>)>>> =
            const { RefCell::new(None) };
        static RUN_CACHE: RefCell<HashMap<(String, u64, bool, bool), Option<LegacyRunMetrics>>> =
            RefCell::new(HashMap::new());
    }
    let key = (text.to_string(), font_size.to_bits(), italic, bold);
    if let Some(hit) = RUN_CACHE.with(|cache| cache.borrow().get(&key).copied()) {
        return hit;
    }
    let (typeface, tables) = LEGACY_FACE.with(|slot| {
        let mut slot = slot.borrow_mut();
        slot.get_or_insert_with(|| {
            let font_mgr = FontMgr::default();
            // skia::font_lookup 의 system_families 필터와 같은 이유 — 없는 family 를
            // CoreText 에 넘기면 downloadable font 조회가 대기할 수 있어 선차단한다.
            if !font_mgr
                .family_names()
                .any(|name| name.eq_ignore_ascii_case("HYhwpEQ"))
            {
                return None;
            }
            let face = font_mgr.match_family_style("HYhwpEQ", FontStyle::normal())?;
            let tables = LegacyTables::load(&face)?;
            Some((face, std::rc::Rc::new(tables)))
        })
        .clone()
    })?;
    // painter 와 같은 문자→PUA 매핑.
    let glyphs: String = text
        .chars()
        .map(|c| super::font::legacy_equation_glyph(c, italic).0)
        .collect();
    if !glyphs
        .chars()
        .filter(|c| !c.is_whitespace())
        .all(|c| typeface.unichar_to_glyph(c as i32) != 0)
    {
        return None;
    }
    let font = Font::new(typeface, font_size as f32);
    let mut advance = 0.0f64;
    let mut ink_left = f64::NAN;
    let mut ink_right = 0.0f64;
    for gid in font.str_to_glyphs_vec(&glyphs) {
        let adv = tables.advance(gid) * font_size;
        if let Some((x_min, _y_min, x_max, _y_max)) = tables.ink(gid) {
            let left = advance + x_min * font_size;
            if ink_left.is_nan() {
                ink_left = left;
            }
            ink_right = advance + x_max * font_size;
        }
        advance += adv;
    }
    if ink_left.is_nan() {
        ink_left = 0.0;
        ink_right = advance;
    }
    let metrics = LegacyRunMetrics {
        advance,
        ink_right,
        ink_left,
    };
    let metrics = (metrics.ink_right.is_finite()
        && metrics.ink_left.is_finite()
        && metrics.advance.is_finite()
        && metrics.advance >= 0.0)
        .then_some(metrics);
    RUN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(key, metrics);
    });
    metrics
}

/// Times 계열 이탤릭 자형의 오른쪽 잉크 초과량(em, 천분율). canvas 잉크를 얻을 수
/// 없는 네이티브 경로의 이탤릭 보정값이며, 0.015em 미만은 생략한다.
pub(crate) fn italic_overhang_em(ch: char) -> f64 {
    let per_mille = match ch {
        'd' => 41,
        'f' => 193,
        'g' => 21,
        'k' => 44,
        'l' => 20,
        'r' => 16,
        't' => 21,
        'C' => 37,
        'E' => 21,
        'F' => 58,
        'H' => 89,
        'I' => 77,
        'J' => 103,
        'K' => 62,
        'M' => 91,
        'N' => 95,
        'S' => 42,
        'T' => 93,
        'U' => 92,
        'V' => 112,
        'W' => 111,
        'X' => 130,
        'Y' => 111,
        'Z' => 55,
        'ζ' => 125,
        'θ' => 16,
        'ξ' => 62,
        'π' => 31,
        'σ' => 34,
        'τ' => 32,
        'χ' => 29,
        'ψ' => 26,
        _ => 0,
    };
    f64::from(per_mille) / 1000.0
}
