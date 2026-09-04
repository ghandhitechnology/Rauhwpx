<p align="center">
  <img src="rhwp/assets/logo/logo-256.png" alt="Rauhwpx" width="112" />
</p>

<h1 align="center">Rauhwpx</h1>

<p align="center">
  <a href="README.md">English</a> · 한국어
</p>

<p align="center">
  AI 네이티브 한글파일(hwpx, hwp)편집기<br />
</p>

<p align="center">
  Rauhwpx는 Edward Kim의 <a href="https://github.com/edwardkim/rhwp">edwardkim/rhwp</a>를 기반으로 해서 에이전트 기능을 넣은 프로젝트입니다. 
</p>

<p align="center">
  <img src="rhwp/assets/screenshots/studio-agent-sidebar.png" alt="에이전트가 한국어 연구 보고서의 제목 필드를 작성하는 Rauhwpx 화면" width="100%" />
</p>

## 이 프로젝트

사무 업무에서 AI의 사용량이 증가하면서, 워드, 구글독스 등은 Claude for Word, Gemini for Docs 등 AI 와의 협업을 위해 다양한 도구를 제공하고 있습니다. 하지만 한글 에디터는 여전히 이런 도구들이 없어 사람들은 아직도 하나하나 복붙하고, 폰트 바꾸고, 수식 깨지는거 고쳐서 작업하고 있죠. 이 과정을 조금 더 쉽게 만들기 위해 마련한 것이 Rauhwpx 입니다. 

Rauhwpx는 MCP를 통해서 문서 구조, 텍스트 범위, 표, 필드, 렌더링된 페이지를 읽고 눈앞의 문서를 편집하게 만든 에이전트를 위한 한글 에디터입니다. 제공되는 프로바이더 Rau를 사용하거나 Codex, Claude Code, Pi, Grok, Cursor, OpenCode를 연결해서 사용할 수 있습니다.

## 제품 원칙
- **사용자 경험 우선** : 문서편집을 하고 에이전트랑 협업을 해야 하는데, 연결 기능들 때문에 사용성이 저하되면 안되죠. 그래서 이 프로그램을 개발할때 집중한 것은 '사용성' 입니다. 
- **완벽한 자동화** : 이 프로그램의 최종 목표는 '문서 작업의 완벽한 자동화' 입니다. 현존하는 거의 모든 프로그램은 AI가 복잡하고 긴 잡업을 사용하기 시작하면 문제가 발생하고, 수식 생성, 서식 유지, 등 섬세한 작업은 하기 어렵습니다. 그래서 Rauhwpx 에서 **/plan** 과 **subagents** 지원을 통해 장기 작업을 가능하게 했고, 수식 편집과 표 포멧팅에 많은 시간을 쏟아서 완성시켰습니다. 문서 에디터 중 **최초**로, Rauhwpx 는 큰 작업을 쪼개서 병렬 처리하고, 섬세하게 수식과 표를 교차검증하면서 일을 완성시킵니다. 

## 편집기

- **형식.** 새 작업의 기본 저장 및 내보내기 형식은 HWPX입니다. HWP 5.0, HWPX, HML은 읽고 쓸 수 있고 HWP3은 읽기 전용입니다. 열린 `.hwp` 파일은 저장할 때 바이너리 HWP 형식을 유지합니다. 라운드트립 충실도는 핵심 계약이며, `rhwp/samples/`의 실제 문서 488개로 검증합니다.
- **레이아웃과 렌더링.** 전체 페이지 나누기, 어울림 줄바꿈, 페이지 분할 표, 각주와 미주, 수식, 도형, 차트, 포함 개체를 브라우저의 Canvas2D/CanvasKit과 네이티브 Skia로 그립니다.
- **편집.** 문자, 문단, 스타일 대화상자, 표, 목록 번호 매기기, 필드와 양식, 페이지 설정, 찾기와 바꾸기, 문서 비교, revision 기록, 실행 취소와 다시 실행을 지원합니다.
- **이식 가능한 작업 기록.** 문서와 전체 revision 그래프를 하나의 `.rhwpx` 아카이브로 저장합니다. 예전 폴더 번들은 별도의 레거시 가져오기 명령으로 열 수 있습니다.
- **내보내기.** SVG, PNG, PDF, 텍스트, Markdown, 표 덤프를 내보낼 수 있습니다. CLI는 HWPX/HML 변환도 지원합니다.

## 에이전트 사이드바

- **76개 MCP 도구.** 일반 작업을 위한 의미 기반 읽기와 쓰기, 한 번의 원자 호출로 최대 32개 편집을 적용하는 일괄 쓰기, 경로와 무관한 라이브 문서 스냅샷, 다운로드 가능한 생성 결과물, 엔진 편집 배치를 제공합니다.
- **실시간 변경 미리보기.** 변경은 열린 문서에 바로 표시됩니다. 턴이 성공하면 하나의 실행 취소 단계로 커밋되고, 실패하면 정확한 이전 스냅샷으로 복원됩니다.
- **두 가지 권한 모드.** 안전은 변경을 검토 대상으로 두고 파일 접근을 프로젝트 안으로 제한합니다. 전체는 에이전트가 중단 없이 작업하도록 허용합니다.
- **구현 전 계획.** 에이전트는 문서를 읽기 전용으로 유지한 채 웹, 하위 에이전트, Browserbase로 조사할 수 있습니다. 정리한 계획은 사용자가 승인한 뒤에만 실행합니다.
- **revision 계약.** 모든 읽기는 현재 revision을 반환하고, 모든 쓰기는 예상 revision을 요구합니다. 오래된 쓰기는 `REVISION_MISMATCH`로 실패합니다.
- **여러 에이전트 제공자.** Rau, Claude, Codex, Pi, Grok, Cursor, OpenCode를 선택할 수 있습니다.

## PR 159에서 준비 중인 기능

[PR #159](https://github.com/ghandhitechnology/Rauhwpx/pull/159)는 로컬 편집 상태를 유지하면서 같은 문서 작업을 Cloud로 이어 가는 기능을 준비하고 있습니다.

- **하나의 Local / Cloud 작업 공간.** 전환할 때 화면과 입력창의 전송 대상만 바뀝니다. 로컬 선택 영역, 스크롤, 실행 취소 기록, 작성 중인 메시지, 문서와 대화 상태는 그대로 유지됩니다. Cloud가 문서를 쓰는 동안 Local 편집은 잠깁니다.
- **직접 조작하는 Cloud 화면.** 앱은 서명된 원격 화면을 보여 주고 마우스, 휠, 키보드, 붙여넣기, 한글 IME 입력을 인증된 경로로 전달합니다. 화면 연결이 끊겨도 저장된 대화와 체크포인트는 유지됩니다.
- **지속되는 다중 턴 대화.** 후속 메시지를 대기열에 넣고 질문에 답하거나 계획을 승인할 수 있습니다. 앱을 닫아도 원격 작업은 계속되며, 실행 환경이 잠든 뒤에도 같은 대화로 돌아올 수 있습니다.
- **검증된 체크포인트와 이어받기.** 문서와 작업 기록을 함께 저장한 안정 지점에서 복구합니다. 이어받기와 결과 적용은 검증된 경계에서만 로컬 파일을 바꾸고, 외부 변경과 충돌하면 두 파일을 모두 보존합니다.
- **Raucloud와 내 서버.** Raucloud는 Rauhwpx 계정으로 관리하는 Railway 실행 환경입니다. 내 서버는 사용자가 소유한 서버에 SSH로 Cloud 환경을 설치합니다.
- **최대 30분의 Raucloud 준비 흐름.** 서버는 작업을 먼저 예약하고 데스크톱은 같은 작업의 상태를 폴링합니다. 설정 창을 닫았다가 열어도 진행 시간과 상태를 이어서 보여 주며 중복 환경을 만들지 않습니다.

같은 PR에서 Linux x64 및 arm64 AppImage/Debian 패키지, Rauhwpx 계정 기능, Rau 체험 제공자, Pi/Rau 하위 에이전트도 함께 개발하고 있습니다.

## 설치

[Releases](https://github.com/ghandhitechnology/Rauhwpx/releases)에서 macOS arm64 DMG/ZIP 또는 Windows x64 설치 관리자를 내려받으세요. macOS 빌드는 서명되어 있습니다. Windows 빌드는 현재 미서명이라 SmartScreen 경고가 표시됩니다.

Windows는 기본적으로 사용자별로 설치됩니다. 기존의 모든 사용자용 설치를 발견하면 두 번째 사본을 만드는 대신 관리자 권한을 요청해 업그레이드합니다.

데스크톱에서 기존 파일을 덮어쓸 때는 충돌과 비정상 종료에 안전한 compare-and-swap을 사용하므로 해당 볼륨이 하드 링크를 지원해야 합니다. FAT/exFAT, 일부 SMB 공유 폴더, 일부 Cloud 동기화 볼륨에서는 원본을 바꾸지 않고 저장을 거부할 수 있습니다. 이때는 로컬 APFS 또는 NTFS 볼륨을 사용하거나 지원되는 위치에 다른 이름으로 저장하세요. Windows에서 원본 파일의 접근 권한까지 보존하려면 System32의 기본 Windows PowerShell도 필요합니다. 게시와 롤백이 모두 실패하면 Rauhwpx가 열 수 있는 복구 사본을 남기고 정확한 경로를 알려 줍니다.

테스터는 [nightly 태그](https://github.com/ghandhitechnology/Rauhwpx/releases/tag/nightly)에서 현재 사전 릴리스를 내려받을 수 있습니다.

자체 CLI를 사용하는 에이전트는 직접 설치하고 로그인해야 합니다. 앱의 **Settings → Connection**에서 제공자를 설치하고 연결할 수 있습니다.

## 개발

```sh
cd rhwp && wasm-pack build --target web    # build the engine
cd rhwp-studio && npm install && npm run dev
```

Studio는 http://127.0.0.1:7700에서 실행되며 임시 포트에 자체 인증 허브를 띄우므로 병렬 worktree가 충돌하지 않습니다. 저장소 루트에서 `npm run dev:desktop`을 실행하면 Electron 셸이 해당 개발 서버에 붙습니다.

독립 허브 작업용으로는 루트에서 `npm start`를 실행하면 http://127.0.0.1:5175에서 실행되고 `.run/rhwp-agent.log`에 로그를 남긴 뒤 준비되면 반환됩니다. `npm stop`, `npm run status`, `npm run start:fg`를 함께 사용할 수 있습니다.

Rust: `cargo test`, `cargo clippy`, `cargo fmt`. Studio: `npm test`, `npm run build`, `npm run e2e:*`.

## 기여하기

[CONTRIBUTING.md](CONTRIBUTING.md)에서 로컬 설정, PR 전에 실행할 검사, [AGENTS.md](AGENTS.md)의 설명 형식을 확인하세요.

## 릴리스

`package.json`과 일치하는 `v*` 태그를 푸시하면 GitHub Actions가 설치 관리자를 빌드하고 첨부합니다.

```bash
git tag v1.1.0
git push origin v1.1.0
```

macOS 서명에는 `macos-release` 환경을 사용합니다. 필요한 비밀은 `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`입니다. 로컬 Windows 빌드: Windows에서 `npm run dist:win`.

### Nightly

GitHub Actions는 KST 오전 4시(`0 19 * * *` UTC)에 nightly 데스크톱 설치 관리자를 빌드합니다. **Actions → Nightly desktop release**에서 수동으로 실행할 수 있으며, 수동 실행은 `main`에서만 게시합니다.

테스터는 [nightly 사전 릴리스](https://github.com/ghandhitechnology/Rauhwpx/releases/tag/nightly)에서 현재 빌드를 내려받습니다. 각 성공적인 실행은 해당 사전 릴리스를 대체하고 `nightly` 태그를 이동합니다.

이 워크플로는 서명되고 공증된 macOS arm64 DMG 및 ZIP 설치 관리자를 빌드합니다. 또한 태그 릴리스와 동일하게 미서명 Windows x64 NSIS 설치 관리자를 빌드합니다. Linux 데스크톱 nightly는 없습니다.

`.github/workflows/nightly.yml`은 Linux 엔진과 Studio 검증 워크플로로 남아 있으며 설치 관리자를 게시하지 않습니다.

macOS는 태그 릴리스와 동일한 `macos-release` 환경을 사용합니다. 필요한 비밀은 `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`입니다. 비밀이 하나라도 없으면 macOS 작업이 실패하고 GitHub는 부분적인 nightly를 게시하지 않습니다. `macos-release`에 검토자가 필요하면 예약된 실행은 승인을 기다립니다.

nightly 앱 버전과 아티팩트 이름은 `<version>-nightly.<date>.<sha>` 형식을 사용합니다. `<date>`는 UTC `YYYYMMDD` 날짜이고, `<sha>`는 커밋 SHA의 앞 7자입니다.

## 저장소 레이아웃

| 경로 | 내용 |
| --- | --- |
| `rhwp/src/` | Rust 엔진. parser, model, document_core, renderer, serializer, wasm_api |
| `rhwp/rhwp-studio/` | 웹 편집기(TypeScript, 프레임워크 없음)와 에이전트 사이드바 |
| `rhwp/rhwp-agent/` | 에이전트 CLI를 열린 탭에 연결하는 로컬 WS 허브 |
| `desktop/` | Electron 셸. 다중 창, 창별 에이전트 세션 |
| `rhwp/rhwp-{chrome,firefox,safari,vscode}/` | 브라우저 및 VS Code 뷰어 확장 |
| `rhwp/npm/editor/` | 임베드 가능한 편집기 패키지 |

## 라이선스

[MIT](rhwp/LICENSE). 독립 프로젝트이며, 한글, 한컴, HWP, HWPX는 Hancom 상표입니다. 이 프로젝트는 Hancom과 제휴하거나 Hancom의 승인을 받지 않았습니다.
