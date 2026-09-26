//! 한컴 번들 HFT 서체의 글자 폭. 다른 설치 서체로 글리프를 그리더라도
//! 원본 HFT 폭으로 조판하도록 보존한다.

use super::font_metrics_data::{FontMetric, HangulMetric, LatinRange, MetricMatch};

// TEDNREN.HFT: 0x1AA의 포인터가 0x200 폭 디렉터리를 가리킨다.
// U+0020부터 리틀엔디언 폭 102개가 0x20A에 저장되며 앞의 95개는 ASCII다.
static DINARU_ASCII: [u16; 95] = [
    400, 500, 400, 660, 660, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 660, 660,
    660, 660, 660, 660, 660, 660, 660, 660, 500, 500, 500, 1000, 500, 660, 1000, 782, 713, 764,
    771, 761, 730, 819, 771, 340, 585, 710, 689, 872, 769, 818, 719, 819, 767, 712, 746, 771, 726,
    988, 683, 716, 742, 500, 500, 500, 500, 500, 400, 662, 622, 565, 622, 618, 480, 620, 628, 294,
    294, 562, 294, 896, 627, 621, 623, 622, 467, 574, 456, 627, 567, 783, 573, 559, 649, 500, 500,
    500, 1000,
];
static DINARU_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &DINARU_ASCII,
}];

// TEDNRHG.HFT의 한글 음절은 모두 전각이다. 중복 폭 11,172개 대신
// 한 그룹짜리 행렬로 고정 폭을 나타낸다.
static ZERO_CHO: [u8; 19] = [0; 19];
static ZERO_JUNG: [u8; 21] = [0; 21];
static ZERO_JONG: [u8; 28] = [0; 28];
static FULL_EM: [u16; 1] = [1000];
static DINARU_HANGUL: HangulMetric = HangulMetric {
    cho_groups: 1,
    jung_groups: 1,
    jong_groups: 1,
    cho_map: &ZERO_CHO,
    jung_map: &ZERO_JUNG,
    jong_map: &ZERO_JONG,
    widths: &FULL_EM,
};
static DINARU: FontMetric = FontMetric {
    name: "신명 디나루",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &DINARU_LATIN,
    hangul: Some(&DINARU_HANGUL),
};

pub(crate) fn find_metric(name: &str, bold: bool, _italic: bool) -> Option<MetricMatch> {
    (name == DINARU.name).then_some(MetricMatch {
        metric: &DINARU,
        bold_fallback: bold,
    })
}

pub(crate) fn has_native_space_width(name: &str) -> bool {
    name == DINARU.name
}
