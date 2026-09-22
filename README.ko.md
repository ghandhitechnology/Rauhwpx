# Rauhwpx

**한글 문서를 열어 놓고, AI와 함께 고쳐 보세요.**

[English](README.md) · [다운로드](https://github.com/ghandhitechnology/Rauhwpx/releases/latest) · [기여 안내](CONTRIBUTING.md)

Rauhwpx는 `.hwp`와 `.hwpx` 문서를 읽고 편집하는 데스크톱 앱입니다. 문서를 직접 고칠 수도 있고, 옆의 AI 사이드바에 필요한 작업을 부탁할 수도 있습니다. 보고서의 한 문단을 다듬거나 표를 채울 때, 문서와 대화를 한 화면에서 이어 갈 수 있도록 만들고 있습니다.

AI를 연결하지 않아도 문서를 열고 직접 편집할 수 있습니다. 처음부터 모든 기능을 익힐 필요는 없습니다. 지금 작업 중인 문서 하나로 시작해 보세요.

## 먼저 써 보기

[최신 릴리스](https://github.com/ghandhitechnology/Rauhwpx/releases/latest)에서 운영체제에 맞는 설치 파일을 받으세요.

| 환경 | 설치 파일 |
| --- | --- |
| macOS · Apple Silicon (ARM64) | `.dmg` |
| Windows · 64비트 (x64) | `.exe` |

Windows 설치 파일은 현재 서명되지 않아 SmartScreen 경고가 나타날 수 있습니다. 공식 릴리스에서 받은 파일인지 확인해 주세요.

설치 파일로 앱을 사용할 때는 아래의 개발 환경을 따로 준비하지 않아도 됩니다.

### 문서 한 편으로 시작하기

1. **문서를 열어 보세요.** 글자와 문단 서식, 표, 그림, 머리말·꼬리말, 쪽 설정 등을 직접 편집할 수 있습니다.
2. **필요한 부분만 AI에게 부탁하세요.** 사이드바에서 사용할 AI를 연결하고, 고칠 문단이나 원하는 작업을 구체적으로 알려 주세요.
3. **결과를 살펴보고 저장하세요.** 처음에는 **안전** 권한으로 작은 부분부터 맡겨 보는 것을 권합니다. AI의 변경 내용을 확인한 뒤 승인하거나 거절할 수 있습니다.

이런 요청부터 해 볼 수 있습니다.

> 선택한 문단을 보고서 문체로 다듬어 줘. 숫자와 고유명사는 그대로 남겨 줘.

> 참고 자료를 읽고 이 표의 빈 설명 칸을 채워 줘. 근거를 찾을 수 없는 항목은 비워 둬.

> 문서는 수정하지 말고, 핵심 내용과 추가로 확인해야 할 부분만 정리해 줘.

**안전** 권한에서는 성공한 편집이 검토 대기 상태로 남습니다. **전체 접근**에서는 성공한 편집이 자동으로 확정됩니다. 확정된 변경은 편집기의 실행 취소로 되돌릴 수 있지만, 두 권한의 차이를 알고 선택해 주세요.

MCP 도구 목록은 [`rhwp/rhwp-agent/tools.mjs`](rhwp/rhwp-agent/tools.mjs)에 있습니다. [`rhwp/rhwp-agent/tests/tools.test.mjs`](rhwp/rhwp-agent/tests/tools.test.mjs)가 개수를 고정합니다.

### 참고 자료를 곁에 두고 작업하기

HWP/HWPX 문서, PDF, DOCX, 텍스트 파일 등을 참고 자료로 붙여 놓고 내용을 찾아보거나 문서 작성에 활용할 수 있습니다. 자료는 대화별·문서별·공통 범위로 관리합니다. PDF와 DOCX는 참고용이며, 이 형식들을 한글 문서처럼 직접 편집하는 기능과는 다릅니다.

### 수정의 흐름도 남겨 두기

문서를 저장한 뒤 버전 기록을 켜면, 실행 취소와 별도로 수정의 흐름을 살펴볼 수 있습니다. 다른 방향의 수정안을 별도 분기로 나눠 작업할 수도 있습니다. 문서와 버전 기록을 `.rhwpx` 파일 하나로 내보내 다시 열 수도 있습니다.

`.rhwpx`는 Rauhwpx의 **이력 보관 형식**입니다. 다른 한글 편집기에 전달할 문서는 `.hwp`나 `.hwpx`로 저장해 주세요.

## AI 연결하기

설정의 연결 목록에서 사용할 AI를 고르고, 표시되는 안내에 따라 설치와 로그인을 진행하세요. 현재 연결 항목은 다음과 같습니다.

| 연결 | 사용 방식 |
| --- | --- |
| Rau | Rau 계정과 크레딧을 통해 제공되는 모델을 사용합니다. |
| Claude · Codex · Grok · Cursor · OpenCode | 각 도구의 실행 환경과 인증을 연결해 사용합니다. |
| Pi | OpenRouter 연결과 모델 설정을 사용합니다. |

사용 가능한 모델, 인증 방식, 이용 요금은 연결한 서비스에 따라 다릅니다. 앱을 설치하는 것과 AI 서비스를 이용할 권한을 준비하는 것은 별개입니다.

문서 엔진과 에이전트 허브는 내 컴퓨터에서 실행되지만, **AI 요청은 연결한 서비스로 전송됩니다.** 요청에는 문서 내용이나 참고 자료가 포함될 수 있습니다. 민감한 자료를 다룰 때는 연결한 서비스의 데이터 처리 방침과 자료를 공유할 수 있는 범위를 먼저 확인해 주세요.

## 문서 호환성에 대해

HWP 5.0과 HWPX의 읽기·편집·저장을 중심으로 개발하고 있습니다. 새 문서의 기본 저장 형식은 HWPX입니다. HML 불러오기와 일부 HWP 3.0 문서 읽기도 지원합니다.

암호가 걸렸거나 DRM으로 보호된 문서는 지원하지 않습니다. 문서에 따라 글꼴, 표 배치, 쪽 나눔이 원본과 다르게 보일 수 있습니다. 중요한 파일은 사본으로 먼저 작업하고, 저장한 결과를 확인해 주세요.

이 문서는 `main` 브랜치를 기준으로 합니다. 설치한 릴리스에 따라 화면이나 제공되는 기능이 조금 다를 수 있습니다.

## 코드로 실행하기

앱을 고치거나 동작을 살펴보고 싶다면 여기서 시작하세요. 명령은 별도 안내가 없는 한 저장소 루트에서 실행합니다.

### 개발 환경 준비

Git, **Node.js 22.18 이상**과 npm, rustup으로 관리하는 Rust가 필요합니다. 엔진의 Rust 버전과 WASM 타깃은 [`rhwp/rust-toolchain.toml`](rhwp/rust-toolchain.toml)에 고정되어 있습니다. wasm-pack은 **0.15.0**을 사용합니다.

네이티브 빌드를 위해 macOS에서는 Xcode Command Line Tools를, Windows에서는 Visual Studio Build Tools의 C++ 도구를 준비해 주세요.

```sh
git clone https://github.com/ghandhitechnology/Rauhwpx.git
cd Rauhwpx

cargo install wasm-pack --version 0.15.0 --locked
npm run setup
npm run build:wasm
npm run dev:studio
```

`setup`은 루트, Studio, 에이전트의 의존성을 설치합니다. 개발 서버는 `http://127.0.0.1:7700`에서 실행되며, 에이전트 허브도 함께 시작합니다. Studio 개발 모드에는 별도로 `npm start`를 실행할 필요가 없습니다.

개발 서버를 켜 둔 채 **다른 터미널**에서 다음 명령을 실행하면 Electron 창으로 연결됩니다.

```sh
npm run dev:desktop
```

### 데스크톱 앱 빌드

네이티브 문서 도구와 WASM 엔진, Studio를 함께 빌드해 실행하려면 다음 명령을 사용하세요.

```sh
npm run build:desktop
npm run desktop
```

`desktop`은 이미 만들어진 빌드를 실행합니다. 소스를 바꾼 뒤에는 필요한 부분을 다시 빌드해야 합니다. 설치 파일 패키징과 서명은 [릴리스 안내](docs/releasing.md)를 참고하세요.

### 어디를 고치면 될까요?

| 경로 | 맡은 일 |
| --- | --- |
| [`desktop/`](desktop/) | Electron 창, 네이티브 파일 접근, 앱이 실행하는 에이전트 허브 관리 |
| [`rhwp/src/`](rhwp/src/) | Rust 문서 엔진: 파일 읽기, 문서 모델과 편집, 조판·렌더링, 저장 |
| [`rhwp/rhwp-studio/`](rhwp/rhwp-studio/) | TypeScript 편집기, AI 사이드바, 변경 검토, 버전 기록 |
| [`rhwp/rhwp-agent/`](rhwp/rhwp-agent/) | 로컬 Node.js 허브, AI 연결·인증, MCP 도구와 참고 자료 처리 |
| [`rhwp/rau-credits/`](rhwp/rau-credits/) | Rau 계정·크레딧 연동과 모델 목록 |
| [`scripts/`](scripts/) · [`.github/workflows/`](.github/workflows/) | 저장소 검사, 패키지 검증, CI와 배포 |

문서를 읽고 고치는 엔진은 Rust/WASM으로 동작합니다. AI가 문서를 수정할 때는 로컬 허브가 MCP 도구 호출을 Studio로 전달하고, Studio가 열린 문서에 변경을 적용합니다. 그래서 AI 연결부와 실제 편집 동작을 나눠 살펴볼 수 있습니다.

### 변경 확인하기

변경한 영역에 맞춰 검사를 선택하세요.

```sh
npm run test:ci
npm --prefix rhwp/rhwp-studio test
npm --prefix rhwp/rhwp-agent test
```

엔진 테스트, 타입 검사, 브라우저 테스트와 기여 절차는 [기여 안내](CONTRIBUTING.md)에 정리되어 있습니다. 문서만 고치는 작업에 전체 앱 테스트를 돌릴 필요는 없습니다.

## 함께 다듬어 주세요

잘 열리지 않는 문서나 저장 뒤 달라지는 부분을 발견했다면 [이슈](https://github.com/ghandhitechnology/Rauhwpx/issues)로 알려 주세요. 사용한 운영체제와 앱 버전, 기대했던 결과, 실제로 일어난 일을 함께 적어 주시면 확인하는 데 도움이 됩니다. 재현용 파일을 올릴 때는 개인정보와 비공개 내용을 먼저 지워 주세요.

오탈자 수정, 이해하기 어려운 안내 문구, 작은 사용성 개선도 반갑습니다. 코드 기여를 시작하기 전에는 [기여 안내](CONTRIBUTING.md)를 읽어 주세요.

## 바탕이 된 프로젝트와 라이선스

Rauhwpx는 [Edward Kim의 rhwp](https://github.com/edwardkim/rhwp)를 바탕으로 만든 프로젝트입니다. 문서 엔진과 여러 패키지 경로에 `rhwp`라는 이름을 유지하고 있습니다.

라이선스는 [MIT](rhwp/LICENSE)입니다. 함께 사용하는 구성 요소의 고지는 [서드파티 라이선스](rhwp/THIRD_PARTY_LICENSES.md)를 참고하세요.

한글, 한컴, HWP, HWPX는 Hancom의 상표입니다. 이 프로젝트는 Hancom의 공식 제품이 아니며, Hancom과 무관합니다.
