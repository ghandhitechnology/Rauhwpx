# 기여하기

Rauhwpx는 HWP/HWPX 편집기입니다. WebAssembly로 컴파일된 Rust 엔진, `rhwp-studio` 웹 편집기, Claude/Codex/Pi용 로컬 `rhwp-agent` 허브, Electron 데스크톱 셸로 구성됩니다. [edwardkim/rhwp](https://github.com/edwardkim/rhwp)의 포크입니다.

대부분의 코드는 `rhwp/`에 있습니다. 일반적인 기여는 엔진 충실도, 편집기 동작, 에이전트 브리지, 데스크톱 패키징, 문서입니다. 라운드트립 충실도는 핵심 계약입니다. 통합 테스트는 `rhwp/samples/`의 실제 문서(HWP/HWPX 약 430개)를 로드합니다.

## 로컬 설정

필요한 것:

- rustup으로 설치한 Rust. `rhwp/rust-toolchain.toml`이 1.93.1과 clippy, rustfmt, `wasm32-unknown-unknown`을 고정합니다.
- [wasm-pack](https://rustwasm.github.io/wasm-pack/) 0.15.0. CI는 `cargo install wasm-pack --version 0.15.0 --locked`로 설치합니다.
- Node 20 이상. `rhwp-agent` 문서는 Node ≥ 20을 적습니다. GitHub Actions는 Node 22를 사용합니다.

Studio는 Vite의 `@wasm` 별칭으로 `rhwp/pkg/`에서 엔진을 로드하므로, 편집기를 시작하기 전에 WASM을 빌드하세요.

```sh
cd rhwp && wasm-pack build --target web
cd rhwp-studio && npm install && npm run dev
```

Studio는 http://127.0.0.1:7700에서 접속을 받습니다. 이 모드에서는 임시 포트에 자체 인증 허브를 띄우므로, 병렬 worktree가 충돌하지 않습니다.

독립 허브를 http://127.0.0.1:5175에서 쓰려면 저장소 루트에서:

```sh
npm start          # detaches when /healthz is ready; logs to .run/rhwp-agent.log
npm run status
npm stop
npm run start:fg   # foreground
```

Studio가 떠 있으면 저장소 루트에서 `npm run dev:desktop`으로 Electron 셸을 그 서버에 붙입니다.

에이전트 설정과 문제 해결: [rhwp/rhwp-agent/README.md](rhwp/rhwp-agent/README.md).

## 테스트, 린트, 빌드

바꾼 내용에 맞는 검사를 실행하세요. 전체 `cargo test`와 모든 `e2e:*` 스크립트는 규모가 큽니다.

### Rust 엔진 (`rhwp/`)

```sh
cargo test
cargo clippy
cargo fmt
```

통합 테스트 파일 하나 또는 함수 하나:

```sh
cargo test --test issue_1234_some_name
cargo test --test issue_1234_some_name test_fn_name
```

이 테스트는 `rhwp/tests/`에 있고, 대부분 이름이 `issue_NNNN_*` 또는 `pr_NNNN_*`입니다. Nightly CI는 `cargo test --locked --workspace`를 실행합니다.

`Cargo.toml`은 단계적 리팩터를 앞두고 구조적 Clippy 린트를 의도적으로 많이 허용합니다. 관련 없는 PR에서 그 allow를 정리하지 마세요. 전용 툴링 이슈 없이 린트 표를 더 엄격하게 만들지 마세요.

`rhwp/rustfmt.toml`은 `max_width = 100`과 Unix 개행을 사용합니다. 포맷 정책 변경은 별도 툴링 이슈로 올리세요.

WASM 빌드 (`rhwp/pkg/`에 기록):

```sh
wasm-pack build --target web
```

PDF와 PNG 내보내기는 네이티브 전용입니다. `native-skia` 기능이 Skia 백엔드를 켭니다.

### Studio (`rhwp/rhwp-studio/`)

```sh
npm test          # Node test runner; also runs ../npm/editor/tests
npm run build     # generate:agent-edit-capabilities, then tsc, then Vite
```

별도의 typecheck 스크립트는 없습니다. `npm run build`가 `tsc`를 실행합니다.

E2E 스크립트는 `npm run e2e:<name>`입니다 (puppeteer-core, 보통 `--mode=headless`). 변경에 해당하는 것을 실행하세요. `npm run e2e:manifest-check`는 e2e 매니페스트를 검사합니다.

### 에이전트 허브 (`rhwp/rhwp-agent/`)

```sh
npm test
npm run typecheck
```

`typecheck`는 Studio의 `tsc`를 사용합니다. 먼저 studio 의존성을 설치하세요.

### CI가 실제로 실행하는 것

모든 풀 리퀘스트와 `main` 또는 `feat/**`로의 푸시는 [Desktop session checks](.github/workflows/desktop-sessions.yml)를 실행합니다. WASM 빌드, 데스크톱과 허브 엔트리 파일에 대한 `node --check`, 이어서 `rhwp-agent`와 `rhwp-studio` 유닛 테스트입니다.

[Nightly verification](.github/workflows/nightly.yml)은 `cargo test --locked --workspace`와 studio의 `npm run build`를 추가합니다.

Clippy, rustfmt, e2e 스위트는 PR 워크플로에 없습니다. 해당 영역을 건드리면 로컬에서 실행하세요.

## 풀 리퀘스트

`main`을 대상으로 PR을 여세요. 이 저장소에는 이슈나 PR 템플릿이 없습니다.

기존 브랜치는 `feat/`와 `fix/` 접두사를 씁니다. `feat/**`로의 푸시도 desktop-session 워크플로를 실행합니다. 문서화된 명명 정책이 아니라 관찰된 관행입니다.

[AGENTS.md](AGENTS.md)가 여기서 쓰는 PR 설명 형식입니다: title, summary, problem, solution, diff overview, testing, risk and rollout, UI가 바뀌면 visual evidence. 실행하지 않은 테스트를 실행했다고 쓰지 마세요.

## 코드 스타일과 에이전트 참고

- 편집하는 파일에 맞추세요. 엔진의 주석, 커밋 메시지, CLI 출력은 한국어인 경우가 많습니다.
- Studio는 TypeScript이고 UI 프레임워크가 없습니다. [DESIGN.md](DESIGN.md)가 비주얼 시스템입니다. 일회성 CSS 색 대신 `--n-*` 토큰을 바꾸세요.
- Studio가 이미 한국어인 곳에서는 제품 언어도 한국어 우선입니다. [PRODUCT.md](PRODUCT.md)를 보세요.
- [CLAUDE.md](CLAUDE.md)에 코딩 에이전트가 쓰는 명령 목록과 아키텍처 맵이 있습니다.

## 라이선스

[MIT](rhwp/LICENSE). 한글, 한컴, HWP, HWPX는 Hancom 상표입니다. 이 프로젝트는 Hancom과 무관합니다.
