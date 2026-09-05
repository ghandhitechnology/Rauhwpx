# 기여하기

Rauhwpx는 Rust 문서 엔진, Studio 웹 편집기, 로컬 에이전트 허브와 Electron 앱으로 구성됩니다. [edwardkim/rhwp](https://github.com/edwardkim/rhwp)의 포크이며, 엔진과 패키지 경로에는 `rhwp` 이름을 유지합니다. 문서 호환성을 검증하는 `rhwp/samples/`와 PDF 기준 자료는 보존하세요.

## 처음 설정하기

- Node 22.18 이상과 npm이 필요합니다.
- Rust는 rustup으로 설치하세요. `rhwp/rust-toolchain.toml`이 엔진 툴체인과 WASM 타깃을 지정합니다.
- wasm-pack 0.15.0을 설치하세요. `cargo install wasm-pack --version 0.15.0 --locked`
- 네이티브 데스크톱 빌드에는 플랫폼 컴파일러가 필요합니다. macOS는 Xcode Command Line Tools, Windows는 Visual Studio Build Tools의 C++ 도구를 사용합니다.

깨끗한 체크아웃에서 저장소 루트 기준으로 실행합니다.

```sh
npm run setup
npm run build:wasm
npm run dev:studio
```

`setup`은 루트, Studio와 에이전트 의존성을 설치합니다. 의존성이 바뀌었을 때 다시 실행하세요. 일반 빌드는 설치를 반복하지 않습니다. Studio는 `rhwp/pkg/`의 WASM을 사용하며 http://127.0.0.1:7700에서 실행됩니다. 인증된 에이전트 허브도 임시 포트에 함께 띄웁니다.

개발 서버가 실행 중인 상태에서 다른 터미널에 `npm run dev:desktop`을 실행하면 Electron이 연결됩니다. 네이티브 빌드와 실행은 다음과 같습니다.

```sh
npm run build:desktop
npm run desktop
```

`desktop`은 기존 빌드를 실행합니다. 처음부터 의존성을 다시 설치하고 빌드하려면 `npm run build:clean`을 사용하세요. `package:mac`과 `package:win`은 기존 빌드를 패키징하고, `dist:mac`과 `dist:win`은 빌드와 패키징을 함께 합니다.

독립 허브 작업에는 루트의 `npm start`, `npm run status`, `npm stop`, `npm run start:fg`를 사용합니다. 이 허브는 http://127.0.0.1:5175를 사용하며 로그는 `.run/rhwp-agent.log`에 남깁니다. Studio 개발 모드에는 별도 허브가 필요하지 않습니다.

제공자 설정은 [에이전트 문서](rhwp/rhwp-agent/README.md), 서명과 배포는 [릴리스 문서](docs/releasing.md)를 참고하세요.

## 변경에 맞는 검사

문서만 바꾸거나 앱을 실행하기 위해 전체 smoke/E2E 검사를 돌릴 필요는 없습니다. 동작을 바꾸면 해당 회귀 테스트를 실행하고, 결과를 PR에 기록하세요.

### Rust 엔진

`rhwp/`에서 실행합니다. 전체 테스트를 돌리기 전에 바꾼 기능을 검증하는 테스트 파일이나 함수로 범위를 좁힐 수 있습니다.

```sh
cargo test --locked --test <test_file_stem>
cargo test --locked --test <test_file_stem> <test_function>
cargo fmt --check
cargo clippy --locked
```

`tests/`의 실제 이름을 사용하세요. 전체 엔진 검증 명령은 [.github/workflows/nightly.yml](.github/workflows/nightly.yml)에 있습니다. WASM을 다시 빌드하려면 저장소 루트에서 `npm run build:wasm`을 실행하세요.

### Studio와 에이전트

저장소 루트에서 실행합니다.

```sh
npm --prefix rhwp/rhwp-studio test
npm --prefix rhwp/rhwp-studio run build
npm --prefix rhwp/rhwp-agent test
npm --prefix rhwp/rhwp-agent run typecheck:acp
```

Studio의 기본 테스트는 브라우저를 실행하지 않습니다. 브라우저 통합 테스트는 WASM과 Chrome을 준비한 뒤 `npm --prefix rhwp/rhwp-studio run test:browser`로 실행하세요. 브라우저 경로는 `PUPPETEER_EXECUTABLE_PATH`로 지정할 수 있습니다. [테스트 안내](rhwp/rhwp-studio/tests/README.md)에 세부 조건이 있습니다.

에이전트의 타입 검사는 공유 backend 계약과 Grok/Cursor ACP 모듈 및 그 의존성을 대상으로 합니다. Claude/Codex/Pi 제공자와 HTTP/WebSocket 허브는 검사 범위에 포함되지 않습니다.

E2E 목록과 참조 검사는 Python 3가 필요합니다. 문서 조작 E2E와 수동 진단은 [E2E 안내](rhwp/rhwp-studio/e2e/README.md)를 참고하세요. `e2e:list`는 스크립트를 찾고 `e2e:check`는 실행 참조를 확인합니다. Browserbase 라이브 검사는 해당 통합을 바꿀 때 수동 실행하며 외부 서비스 계정이 필요합니다.

CI는 변경 경로에 따라 작업을 선택합니다. 실제 명령과 조건은 [.github/workflows/](.github/workflows/)에 있습니다. 패키지 검증은 설치 파일을 만들 때 실행하며, nightly는 더 넓은 엔진 검증을 수행합니다.

## 풀 리퀘스트

작업 브랜치는 `fix/`, `hotfix/`, `feat/`, `release/` 중 하나의 접두사를 사용하고 `main`을 대상으로 PR을 여세요. [AGENTS.md](AGENTS.md)의 PR 설명 형식에 따라 문제, 해결 방법, 검사 결과와 위험을 적습니다. UI가 바뀌면 가능한 경우 화면 증거를 첨부하세요.

파일의 기존 스타일과 제품 언어를 따르세요. Studio는 TypeScript를 사용하며 UI 프레임워크가 없습니다. 디자인 지침은 [DESIGN.md](DESIGN.md), 제품 방향은 [PRODUCT.md](PRODUCT.md)에 있습니다. 코딩 에이전트용 구조 안내는 [CLAUDE.md](CLAUDE.md)를 참고하세요.

## 라이선스

[MIT](rhwp/LICENSE). 한글, 한컴, HWP, HWPX는 Hancom 상표입니다. 이 프로젝트는 Hancom과 무관합니다.
