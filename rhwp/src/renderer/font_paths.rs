//! [#2864] 폰트 조달 경로를 한 곳에서 결정한다.
//!
//! 종전에는 `renderer/pdf.rs`·`renderer/svg.rs`·`renderer/skia/image_conv.rs`·
//! `renderer/skia/renderer.rs` 네 곳이 각자 탐색 경로를 하드코딩했고, 그중
//! `ttfs/hwp`·`ttfs/windows`(로컬 전용 저작권 폰트, `.gitignore`)와
//! `/mnt/c/Windows/Fonts`(WSL2 개발 PC 전용)는 **특정 환경에만 존재**했다.
//!
//! 서버·컨테이너에서 CLI 로 대량 변환할 때 이 경로들은 아무 값도 주지 못하면서
//! 경로 검사만 발생시키고, WSL2 에서는 `/mnt/c` 가 9p 파일시스템이라 간헐적
//! 극단 지연으로 `export-pdf` 가 통째로 멎었다(#2268, 누적 4회 관측).
//!
//! 폰트는 호출자가 `--font-path`(`options.font_paths`) 또는 `RHWP_FONT_PATH`
//! 로 파일이나 디렉토리를 지정하거나 시스템에 설치해 쓴다. 디렉토리는
//! 하위 항목만 읽고 재귀하지 않는다. 이 모듈은 그 순서만 정의한다.
//!
//! # 조달 순서
//!
//! 1. **호출자 지정** — `--font-path` / `options.font_paths` (최우선)
//! 2. **`RHWP_FONT_PATH`** — 환경변수. 백엔드 대량 변환에서 호출마다 인자를
//!    붙이는 대신 한 번만 설정한다. 복수 경로는 OS 관례 구분자로 나눈다
//!    (유닉스 `:`, Windows `;`).
//! 3. **시스템 기본** — OS별 표준 폰트 디렉터리
//! 4. **`ttfs/opensource`** — 최후 폴백. `.gitignore` 대상이 아닌 **저장소 자산**
//!    (NotoSansKR 2종 + OFL)이라 모든 체크아웃에서 확보된다. 폰트 미설치 환경
//!    (CI headless·컨테이너)에서 한국어가 드롭되는 것을 막는다(#2293).

use std::path::{Path, PathBuf};

/// 폰트 탐색 경로 환경변수. 복수 경로는 OS 관례 구분자로 나눈다.
pub const FONT_PATH_ENV: &str = "RHWP_FONT_PATH";

/// 저장소 번들 오픈소스 폰트 — 최후 폴백(#2293 한국어 드롭 방지).
pub const BUNDLED_OPENSOURCE_DIR: &str = "ttfs/opensource";

/// 네이티브 렌더러가 직접 읽을 수 있는 SFNT 파일인지 판별한다.
pub fn is_font_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "ttf" | "otf" | "ttc"
                )
            })
}

/// 파일/디렉토리 입력을 실제 SFNT 파일 목록으로 펼친다.
///
/// 호출자가 지정한 source 순서는 보존하고 각 디렉토리 안에서는 파일 경로로
/// 정렬한다. 하위 디렉토리는 탐색하지 않는다.
pub fn font_files(sources: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for source in sources {
        if is_font_file(source) {
            files.push(source.clone());
            continue;
        }
        if !source.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(source) else {
            continue;
        };
        let mut directory_files = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| is_font_file(path))
            .collect::<Vec<_>>();
        directory_files.sort();
        files.extend(directory_files);
    }
    files
}

/// `RHWP_FONT_PATH` 를 읽어 경로 목록으로 나눈다.
///
/// 미설정이면 빈 벡터를 돌려준다. 존재하지 않는 경로도 그대로 담아 호출부가
/// 기존 `--font-path` 와 동일하게 경고·건너뛰기를 하도록 맡긴다.
pub fn env_font_paths() -> Vec<PathBuf> {
    let Ok(raw) = std::env::var(FONT_PATH_ENV) else {
        return Vec::new();
    };
    // `split` 은 빈 조각도 내므로(예: 연속 구분자, 양끝 구분자) 걸러낸다.
    raw.split(PATH_SEPARATOR)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Native Windows font locations. `WINDIR` is not guaranteed to be `C:\Windows`,
/// and fonts installed for one user live below LOCALAPPDATA rather than there.
pub fn windows_font_dirs(
    windows_dir: Option<PathBuf>,
    local_app_data: Option<PathBuf>,
    user_profile: Option<PathBuf>,
) -> Vec<PathBuf> {
    let system_root = windows_dir.unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let user_local = local_app_data
        .or_else(|| user_profile.map(|profile| profile.join("AppData").join("Local")));
    let mut dirs = vec![system_root.join("Fonts")];
    if let Some(local) = user_local {
        let user_fonts = local.join("Microsoft").join("Windows").join("Fonts");
        let normalized = user_fonts.to_string_lossy().to_ascii_lowercase();
        if !dirs
            .iter()
            .any(|item| item.to_string_lossy().to_ascii_lowercase() == normalized)
        {
            dirs.push(user_fonts);
        }
    }
    dirs
}

#[cfg(target_os = "windows")]
const PATH_SEPARATOR: char = ';';

#[cfg(not(target_os = "windows"))]
const PATH_SEPARATOR: char = ':';

/// OS별 시스템 폰트 디렉터리.
///
/// `usvg::fontdb::Database::load_system_fonts()` 를 쓰는 경로에서는 필요 없고,
/// 파일을 직접 훑는 경로(`svg.rs::find_font_file`, `skia` typeface 로딩)에서 쓴다.
pub fn system_font_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/Library/Fonts"),
            PathBuf::from("/System/Library/Fonts"),
            PathBuf::from("/System/Library/Fonts/Supplemental"),
        ]
    }
    #[cfg(target_os = "linux")]
    {
        vec![
            PathBuf::from("/usr/share/fonts"),
            PathBuf::from("/usr/local/share/fonts"),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        windows_font_dirs(
            std::env::var_os("WINDIR")
                .or_else(|| std::env::var_os("SystemRoot"))
                .map(PathBuf::from),
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            std::env::var_os("USERPROFILE").map(PathBuf::from),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Vec::new()
    }
}

/// 파일을 직접 훑는 경로용 탐색 디렉터리 전체를 조달 순서대로 돌려준다.
///
/// `extra` 는 호출자 지정 경로(`--font-path` 등)이며 최우선이다.
pub fn search_dirs(extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = extra.to_vec();
    dirs.extend(env_font_paths());
    dirs.extend(system_font_dirs());
    // 최후 폴백 — 저장소 자산이라 항상 존재한다(#2293).
    dirs.push(PathBuf::from(BUNDLED_OPENSOURCE_DIR));
    dirs
}

/// custom typeface 로더(skia `with_font_paths`)용 source — **시스템·번들 제외**.
///
/// custom 로더는 해석 체인에서 시스템 매칭보다 앞선다. 그래서 여기에는
/// 사용자가 의도한 폰트(호출자 지정 → 환경변수)만 담는다:
/// - 시스템 폰트는 이 로더에서 중복 탐색하지 않고
///   `FontMgr::match_family_style`이 담당한다.
/// - 번들 opensource 를 넣으면 깊은 폴백(Noto Sans KR)이 시스템 1순위를
///   제치고 선점된다(#3300, r23 발산 −6.9pp) — 번들은 별도 최후-폴백 로더
///   (`bundled_font_dirs`)로 체인 말미에만 선다.
pub fn custom_font_sources(extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut sources: Vec<PathBuf> = extra.to_vec();
    sources.extend(env_font_paths());
    sources
}

/// 번들 최후-폴백 로더용 디렉터리 — 폰트 미설치 환경(CI headless·컨테이너)
/// 에서 한국어 드롭을 막는 저장소 자산(#2293). 해석 체인에서는 custom·시스템
/// 뒤(최후)에만 선다(#3300).
pub fn bundled_font_dirs() -> Vec<PathBuf> {
    vec![PathBuf::from(BUNDLED_OPENSOURCE_DIR)]
}

/// 폰트 패밀리명이 현재 렌더 폰트 집합에 실재하는지 판별한다.
///
/// substFont(문서 선언 대체 글꼴) 적용 판정용 — 파일명 휴리스틱이 아니라 각
/// 파일의 name 테이블에 기록된 실제 패밀리명으로 판별한다. 기본 집합은
/// 시스템 + `RHWP_FONT_PATH` + 번들이며 프로세스 최초 한 번만 구축하고,
/// `extra` 경로(`--font-path` 인자)는 호출 시마다 스캔한다.
#[cfg(not(target_arch = "wasm32"))]
pub fn font_family_available(family: &str, extra: &[PathBuf]) -> bool {
    fn normalize(name: &str) -> String {
        name.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    }
    let want = normalize(family);
    static BASE: std::sync::OnceLock<std::collections::HashSet<String>> =
        std::sync::OnceLock::new();
    let base = BASE.get_or_init(|| {
        let mut db = usvg::fontdb::Database::new();
        db.load_system_fonts();
        load_into_fontdb(&mut db, &[]);
        db.faces()
            .flat_map(|face| {
                face.families
                    .iter()
                    .map(|(name, _)| normalize(name))
                    .collect::<Vec<_>>()
            })
            .collect()
    });
    if base.contains(&want) {
        return true;
    }
    for file in font_files(extra) {
        let Ok(data) = std::fs::read(&file) else {
            continue;
        };
        let face_count = ttf_parser::fonts_in_collection(&data).unwrap_or(1).min(256);
        for face_index in 0..face_count {
            let Ok(face) = ttf_parser::Face::parse(&data, face_index) else {
                continue;
            };
            let hit = face.names().into_iter().any(|name| {
                matches!(
                    name.name_id,
                    ttf_parser::name_id::FAMILY | ttf_parser::name_id::TYPOGRAPHIC_FAMILY
                ) && name
                    .to_string()
                    .is_some_and(|value| normalize(&value) == want)
            });
            if hit {
                return true;
            }
        }
    }
    false
}

// ─── 사용 가능 face 레지스트리 ───────────────────────────────────────────
// 한컴 macOS의 FontMap 치환은 요청 face가 없을 때만 발동한다. 스키아 페인트
// 경로는 이미 이 규칙을 따르지만(text_replay 가 실제 typeface 해석 성공 여부로
// 치환 여부를 결정), 레이아웃의 폭 측정은 파일 시스템을 직접 보지 못해 폰트
// 실재와 무관하게 치환 메트릭을 쓰면 측정/페인트 폭이 어긋난다 (예: 돋움체 TTF
// 가 주어졌는데 고정폭이 아닌 Haansoft 비례 메트릭으로 조판되는 사례).
// 이 레지스트리는 렌더 시작 시(`register_font_face_availability`) custom
// source(--font-path / RHWP_FONT_PATH)의 face 이름을 적재해 두고, 측정
// 경로가 `custom_font_face_available` 로 실재 여부를 조회한다.

/// 등록된 face 별칭 (정규화: 공백 압축 + 소문자 — skia alias 규칙과 동일).
static CUSTOM_FACE_NAMES: std::sync::RwLock<std::collections::BTreeSet<String>> =
    std::sync::RwLock::new(std::collections::BTreeSet::new());

/// face 별칭 → (파일, TTC face index). 측정 경로가 실제 hmtx 를 읽을 때 쓴다.
static CUSTOM_FACE_SOURCES: std::sync::RwLock<std::collections::BTreeMap<String, (PathBuf, u32)>> =
    std::sync::RwLock::new(std::collections::BTreeMap::new());

/// 파일별 hmtx 캐시 — face 단위가 아니라 파일 단위로 한 번만 파싱한다.
struct RealFaceHmtx {
    units_per_em: u16,
    /// codepoint → horizontal advance (font units). cmap 에 없는 문자는
    /// 키가 없다 — 호출자는 베이크드 메트릭 경로로 폴백한다.
    advance_by_char: std::collections::HashMap<u32, u16>,
}

static REAL_FACE_HMTX: std::sync::LazyLock<
    std::sync::RwLock<std::collections::HashMap<(PathBuf, u32), std::sync::Arc<RealFaceHmtx>>>,
> = std::sync::LazyLock::new(|| std::sync::RwLock::new(std::collections::HashMap::new()));

/// name 테이블 파싱이 끝난 폰트 파일 — 렌더 호출마다 재파싱하지 않는다.
static SCANNED_FACE_FILES: std::sync::RwLock<std::collections::BTreeSet<PathBuf>> =
    std::sync::RwLock::new(std::collections::BTreeSet::new());

/// skia `normalize_typeface_alias` 와 동일 규칙.
fn normalize_face_alias(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then(|| normalized.to_lowercase())
}

/// SFNT 파일의 face 별칭을 레지스트리에 적재한다.
///
/// TTC 의 모든 face를 순회하고 name 테이블의 family/full/postscript 이름을
/// 전 언어에 대해 등록한다. 파일명 스템도 별칭으로 둔다(`find_font_file` 의
/// 후보 파일명 관례와 정합).
fn register_font_file_faces(file: &Path) {
    let Ok(bytes) = std::fs::read(file) else {
        return;
    };
    let mut aliases = Vec::new();
    if let Some(stem) = file.file_stem().and_then(|s| s.to_str()) {
        if let Some(alias) = normalize_face_alias(stem) {
            aliases.push((alias, 0));
        }
    }
    for index in 0.. {
        let Ok(face) = ttf_parser::Face::parse(&bytes, index) else {
            break;
        };
        for name in face.names() {
            if matches!(
                name.name_id,
                ttf_parser::name_id::FAMILY
                    | ttf_parser::name_id::FULL_NAME
                    | ttf_parser::name_id::POST_SCRIPT_NAME
                    | ttf_parser::name_id::TYPOGRAPHIC_FAMILY
                    | ttf_parser::name_id::COMPATIBLE_FULL
                    | ttf_parser::name_id::WWS_FAMILY
            ) {
                if let Some(value) = name.to_string() {
                    if let Some(alias) = normalize_face_alias(&value) {
                        aliases.push((alias, index));
                    }
                }
            }
        }
    }
    if let Ok(mut names) = CUSTOM_FACE_NAMES.write() {
        names.extend(aliases.iter().map(|(alias, _)| alias.clone()));
    }
    if let Ok(mut sources) = CUSTOM_FACE_SOURCES.write() {
        for (alias, index) in aliases {
            // 첫 조달 순서 우선 — 같은 face 가 여러 파일에 있으면 먼저 온 것을 쓴다.
            sources
                .entry(alias)
                .or_insert_with(|| (file.to_path_buf(), index));
        }
    }
}

/// custom source(`extra` = 호출자 지정 경로 + `RHWP_FONT_PATH`)의 face 이름을
/// 등록한다. 렌더 함수는 레이아웃 진입 전에 호출해야 측정 경로가 실재를 본다.
/// 파일별 파싱은 한 번만 수행한다.
pub fn register_font_face_availability(extra: &[PathBuf]) {
    for file in font_files(&custom_font_sources(extra)) {
        if SCANNED_FACE_FILES
            .read()
            .map(|scanned| scanned.contains(&file))
            .unwrap_or(false)
        {
            continue;
        }
        register_font_file_faces(&file);
        if let Ok(mut scanned) = SCANNED_FACE_FILES.write() {
            scanned.insert(file);
        }
    }
}

/// 측정 경로용 — `name` face 가 custom font source 에 실재(로드 가능)한가.
pub fn custom_font_face_available(name: &str) -> bool {
    let Some(alias) = normalize_face_alias(name) else {
        return false;
    };
    CUSTOM_FACE_NAMES
        .read()
        .map(|names| names.contains(&alias))
        .unwrap_or(false)
}

/// face 이름의 등록 파일에서 cmap·hmtx 를 한 번만 읽어 캐시한다.
fn real_face_hmtx(file: &Path, index: u32) -> Option<std::sync::Arc<RealFaceHmtx>> {
    let key = (file.to_path_buf(), index);
    if let Some(hit) = REAL_FACE_HMTX
        .read()
        .ok()
        .and_then(|cache| cache.get(&key).cloned())
    {
        return Some(hit);
    }
    let bytes = std::fs::read(file).ok()?;
    let face = ttf_parser::Face::parse(&bytes, index).ok()?;
    let mut advance_by_char = std::collections::HashMap::new();
    if let Some(cmap) = face.tables().cmap {
        for subtable in cmap.subtables {
            subtable.codepoints(|codepoint| {
                if let Some(ch) = char::from_u32(codepoint) {
                    if let Some(glyph) = face.glyph_index(ch) {
                        if let Some(advance) = face.glyph_hor_advance(glyph) {
                            advance_by_char.insert(codepoint, advance);
                        }
                    }
                }
            });
        }
    }
    let metrics = std::sync::Arc::new(RealFaceHmtx {
        units_per_em: face.units_per_em(),
        advance_by_char,
    });
    if let Ok(mut cache) = REAL_FACE_HMTX.write() {
        cache.entry(key).or_insert_with(|| metrics.clone());
    }
    Some(metrics)
}

/// 실재 face 파일의 문자 advance 를 em 비율로 반환한다 (hmtx/unitsPerEm).
/// face 미등록 또는 cmap 에 글리프가 없으면 None — 호출자가 베이크드
/// 메트릭 경로로 폴백한다. 한컴은 파일이 있는 face 를 실폰트 폭으로
/// 조판하므로 베이크드 테이블(구버전 TTF 기준)보다 이 값이 정확하다.
pub fn custom_face_char_em_advance(name: &str, c: char) -> Option<f64> {
    let alias = normalize_face_alias(name)?;
    let (file, index) = CUSTOM_FACE_SOURCES
        .read()
        .ok()
        .and_then(|sources| sources.get(&alias).cloned())?;
    let metrics = real_face_hmtx(&file, index)?;
    let advance = *metrics.advance_by_char.get(&(c as u32))?;
    (metrics.units_per_em > 0).then(|| advance as f64 / metrics.units_per_em as f64)
}

/// `fontdb` 에 조달 순서대로 폰트를 적재한다.
///
/// 시스템 폰트는 `load_system_fonts()` 가 담당하므로 여기서는 호출자 지정 →
/// 환경변수 → 번들 순으로 파일/디렉토리를 추가한다. 디렉토리는 재귀하지
/// 않는다. 존재하지 않는 경로는 건너뛰되,
/// `extra`(사용자가 명시한 경로)만 경고한다 — 환경변수·번들은 없을 수 있다.
pub fn load_into_fontdb(fontdb: &mut usvg::fontdb::Database, extra: &[PathBuf]) {
    for source in extra {
        if source.exists() {
            for file in font_files(std::slice::from_ref(source)) {
                if let Err(error) = fontdb.load_font_file(&file) {
                    eprintln!(
                        "WARN: font file '{}' could not be loaded: {error}",
                        file.display()
                    );
                }
            }
        } else {
            eprintln!(
                "WARN: font path '{}' not found. 해당 경로의 폰트는 로드하지 않습니다.",
                source.display()
            );
        }
    }
    for source in env_font_paths() {
        if source.exists() {
            for file in font_files(std::slice::from_ref(&source)) {
                if let Err(error) = fontdb.load_font_file(&file) {
                    eprintln!(
                        "WARN: {FONT_PATH_ENV} font file '{}' could not be loaded: {error}",
                        file.display()
                    );
                }
            }
        } else {
            eprintln!(
                "WARN: {FONT_PATH_ENV} entry '{}' not found. 해당 경로의 폰트는 로드하지 않습니다.",
                source.display()
            );
        }
    }
    let bundled = Path::new(BUNDLED_OPENSOURCE_DIR);
    if bundled.exists() {
        for file in font_files(&[bundled.to_path_buf()]) {
            let _ = fontdb.load_font_file(file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 환경변수는 프로세스 전역이라 테스트가 병렬로 돌면 서로를 덮는다.
    /// `RHWP_FONT_PATH` 를 만지는 테스트는 이 락으로 직렬화한다 — 락 없이 셋이
    /// 병렬로 돌면 set 과 read 사이에 다른 테스트의 remove_var 가 끼어들어
    /// 간헐 실패한다(실측 플레이크).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn env_font_paths_parses_and_filters() {
        let _g = ENV_LOCK.lock().unwrap();
        // 미설정
        std::env::remove_var(FONT_PATH_ENV);
        assert!(env_font_paths().is_empty(), "미설정이면 빈 목록이어야 한다");

        // 단일 경로
        std::env::set_var(FONT_PATH_ENV, "/tmp/fonts-a");
        assert_eq!(env_font_paths(), vec![PathBuf::from("/tmp/fonts-a")]);

        // 복수 경로 + 빈 조각(연속·양끝 구분자) 제거
        let joined = format!(
            "{sep}/tmp/fonts-a{sep}{sep}/tmp/fonts-b{sep}",
            sep = PATH_SEPARATOR
        );
        std::env::set_var(FONT_PATH_ENV, joined);
        assert_eq!(
            env_font_paths(),
            vec![PathBuf::from("/tmp/fonts-a"), PathBuf::from("/tmp/fonts-b")],
            "빈 조각은 걸러내고 순서는 보존해야 한다"
        );

        std::env::remove_var(FONT_PATH_ENV);
    }

    #[test]
    fn search_dirs_orders_caller_first_and_bundled_last() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::remove_var(FONT_PATH_ENV);
        let extra = vec![PathBuf::from("/tmp/caller")];
        let dirs = search_dirs(&extra);

        assert_eq!(
            dirs.first(),
            Some(&PathBuf::from("/tmp/caller")),
            "호출자 지정 경로가 최우선이어야 한다"
        );
        assert_eq!(
            dirs.last(),
            Some(&PathBuf::from(BUNDLED_OPENSOURCE_DIR)),
            "번들 오픈소스 폰트가 최후 폴백이어야 한다"
        );
    }

    /// [#2864] 환경 종속 경로가 조달 목록에 다시 들어오지 않도록 고정한다.
    /// 이 가드가 없으면 편의를 위해 재추가되어 #2268 간헐 행이 재발할 수 있다.
    #[test]
    fn search_dirs_excludes_environment_specific_paths() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::remove_var(FONT_PATH_ENV);
        let dirs = search_dirs(&[]);
        let joined: Vec<String> = dirs.iter().map(|p| p.display().to_string()).collect();

        for banned in [
            "/mnt/c/Windows/Fonts", // WSL2 개발 PC 전용 — #2268 간헐 행 원인
            "ttfs/hwp",             // .gitignore 로컬 전용(저작권 폰트)
            "ttfs/windows",
        ] {
            assert!(
                !joined.iter().any(|d| d == banned),
                "환경 종속 경로가 조달 목록에 있다: {banned}\n\
                 폰트가 필요하면 --font-path 또는 {FONT_PATH_ENV} 로 지정한다."
            );
        }
    }

    /// [#3300] custom 로더 목록은 시스템·번들을 포함하면 안 된다.
    /// - 시스템: FontMgr 스타일 매칭과 중복되며 custom 우선순위를 잘못 가져갈 수 있음
    /// - 번들: 깊은 폴백(Noto)이 시스템 1순위를 제치고 본문을 렌더(r23 −6.9pp)
    #[test]
    fn custom_font_sources_excludes_system_and_bundled() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var(FONT_PATH_ENV, "/tmp/env-fonts");
        let extra = vec![PathBuf::from("/tmp/caller")];
        let dirs = custom_font_sources(&extra);
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/tmp/caller"),
                PathBuf::from("/tmp/env-fonts")
            ],
            "custom 로더는 호출자 지정 → 환경변수만 담는다"
        );
        for sys in system_font_dirs() {
            assert!(!dirs.contains(&sys), "시스템 디렉터리 포함 금지: {sys:?}");
        }
        assert!(
            !dirs.contains(&PathBuf::from(BUNDLED_OPENSOURCE_DIR)),
            "번들은 custom 이 아니라 최후-폴백 로더로 간다"
        );
        std::env::remove_var(FONT_PATH_ENV);
    }

    #[test]
    fn font_files_accepts_exact_files_and_sorts_non_recursive_directories() {
        let fixture_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fonts");
        let exact = fixture_dir.join("RHWPExactFaceSmoke.ttc");

        assert_eq!(
            font_files(std::slice::from_ref(&exact)),
            vec![exact.clone()]
        );

        let files = font_files(std::slice::from_ref(&fixture_dir));
        assert_eq!(
            files,
            vec![
                fixture_dir.join("RHWPBitmapSvgGlyphSmoke.ttf"),
                exact,
                fixture_dir.join("RHWPShapingFixture.ttf"),
            ],
            "디렉토리 source는 SFNT 하위 파일만 경로 순으로 내놓아야 한다"
        );
    }

    #[test]
    fn env_font_path_accepts_exact_font_file() {
        let _g = ENV_LOCK.lock().unwrap();
        let exact = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fonts/RHWPBitmapSvgGlyphSmoke.ttf");
        std::env::set_var(FONT_PATH_ENV, &exact);

        assert_eq!(font_files(&custom_font_sources(&[])), vec![exact]);

        std::env::remove_var(FONT_PATH_ENV);
    }

    /// [#3300] 번들 최후-폴백 로더는 저장소 자산만 담는다(#2293 한국어 드롭 방지).
    #[test]
    fn bundled_font_dirs_is_repo_asset_only() {
        assert_eq!(
            bundled_font_dirs(),
            vec![PathBuf::from(BUNDLED_OPENSOURCE_DIR)]
        );
    }

    #[test]
    fn windows_font_dirs_include_relocated_system_and_per_user_fonts() {
        assert_eq!(
            windows_font_dirs(
                Some(PathBuf::from(r"D:\Windows")),
                Some(PathBuf::from(r"E:\Profiles\Rau\Local")),
                Some(PathBuf::from(r"C:\ignored")),
            ),
            vec![
                PathBuf::from(r"D:\Windows").join("Fonts"),
                PathBuf::from(r"E:\Profiles\Rau\Local")
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            ]
        );
    }

    #[test]
    fn windows_font_dirs_fall_back_through_userprofile() {
        assert_eq!(
            windows_font_dirs(None, None, Some(PathBuf::from(r"C:\Users\Rau")),),
            vec![
                PathBuf::from(r"C:\Windows").join("Fonts"),
                PathBuf::from(r"C:\Users\Rau")
                    .join("AppData")
                    .join("Local")
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            ]
        );
    }
}
