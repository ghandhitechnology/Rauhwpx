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

    #[cfg(target_arch = "wasm32")]
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
