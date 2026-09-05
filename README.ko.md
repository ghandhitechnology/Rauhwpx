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

Rauhwpx는 HWP/HWPX 문서를 열고 편집하는 앱입니다. Rust 엔진이 문서 파싱, 배치, 렌더링과 편집을 처리하고, 에이전트는 MCP 도구로 열린 문서의 구조와 내용을 읽고 수정합니다. Rau, Claude, Codex, Pi, Grok, Cursor, OpenCode 제공자를 연결할 수 있습니다.

문서 편집은 사용자 기기에서 실행됩니다. AI를 사용하면 프롬프트와 에이전트가 읽은 문서 내용이 선택한 제공자에게 전송됩니다. 웹 조사와 선택 사항인 Browserbase도 외부 서비스를 사용합니다. 로컬 허브는 제공자 세션, 권한, 다운로드와 도구 호출을 관리합니다.

## 편집기

- **형식.** 새 작업의 기본 저장 및 내보내기 형식은 HWPX입니다. HWP 5.0, HWPX, HML은 읽고 쓸 수 있고 HWP3은 읽기 전용입니다. 열린 `.hwp` 파일은 저장할 때 바이너리 HWP 형식을 유지합니다. `rhwp/samples/`의 실제 문서로 저장 후 재열기와 렌더링을 검증합니다. 문서와 기능에 따라 호환성 차이가 있을 수 있습니다.
- **레이아웃과 렌더링.** 전체 페이지 나누기, 어울림 줄바꿈, 페이지 분할 표, 각주와 미주, 수식, 도형, 차트, 포함 개체를 브라우저의 Canvas2D/CanvasKit과 네이티브 Skia로 그립니다.
- **편집.** 문자, 문단, 스타일 대화상자, 표, 목록 번호 매기기, 필드와 양식, 페이지 설정, 찾기와 바꾸기, 문서 비교, revision 기록, 실행 취소와 다시 실행을 지원합니다.
- **이식 가능한 작업 기록.** 문서와 전체 revision 그래프를 하나의 `.rhwpx` 아카이브로 저장합니다. 예전 폴더 번들은 별도의 레거시 가져오기 명령으로 열 수 있습니다.
- **내보내기.** SVG, PNG, PDF, 텍스트, Markdown, 표 덤프를 내보낼 수 있습니다. CLI는 HWPX/HML 변환도 지원합니다.

## 에이전트 사이드바

- **MCP 도구.** 일반 작업을 위한 의미 기반 읽기와 쓰기, 한 번의 원자 호출로 최대 32개 편집을 적용하는 일괄 쓰기, 경로와 무관한 라이브 문서 스냅샷, 다운로드 가능한 생성 결과물, 엔진 편집 배치를 제공합니다.
- **실시간 변경 미리보기.** 변경은 열린 문서에 바로 표시됩니다. 안전 모드에서는 성공한 변경을 검토한 뒤 적용하며, 전체 접근 모드에서는 하나의 실행 취소 단계로 커밋합니다. 실패한 턴의 변경은 되돌립니다.
- **두 가지 권한 모드.** 안전은 변경을 검토 대상으로 두고 파일 접근을 프로젝트 안으로 제한합니다. 전체는 에이전트가 중단 없이 작업하도록 허용합니다.
- **구현 전 계획.** 에이전트는 문서를 읽기 전용으로 유지한 채 웹, 하위 에이전트, Browserbase로 조사할 수 있습니다. 정리한 계획은 사용자가 승인한 뒤에만 실행합니다.
- **revision 계약.** 모든 읽기는 현재 revision을 반환하고, 모든 쓰기는 예상 revision을 요구합니다. 오래된 쓰기는 `REVISION_MISMATCH`로 실패합니다.
- **여러 에이전트 제공자.** Rau, Claude, Codex, Pi, Grok, Cursor, OpenCode를 선택할 수 있습니다.

## 설치

[Releases](https://github.com/ghandhitechnology/Rauhwpx/releases)에서 macOS arm64 DMG/ZIP 또는 Windows x64 설치 관리자를 내려받으세요. macOS 빌드는 서명되어 있습니다. Windows 빌드는 현재 미서명이라 SmartScreen 경고가 표시됩니다.

Windows는 기본적으로 사용자별로 설치됩니다. 기존의 모든 사용자용 설치를 발견하면 두 번째 사본을 만드는 대신 관리자 권한을 요청해 업그레이드합니다.

데스크톱에서 기존 파일을 덮어쓸 때는 충돌과 비정상 종료에 안전한 compare-and-swap을 사용하므로 해당 볼륨이 하드 링크를 지원해야 합니다. FAT/exFAT, 일부 SMB 공유 폴더, 일부 Cloud 동기화 볼륨에서는 원본을 바꾸지 않고 저장을 거부할 수 있습니다. 이때는 로컬 APFS 또는 NTFS 볼륨을 사용하거나 지원되는 위치에 다른 이름으로 저장하세요. Windows에서 원본 파일의 접근 권한까지 보존하려면 System32의 기본 Windows PowerShell도 필요합니다. 게시와 롤백이 모두 실패하면 Rauhwpx가 열 수 있는 복구 사본을 남기고 정확한 경로를 알려 줍니다.

테스터는 [nightly 태그](https://github.com/ghandhitechnology/Rauhwpx/releases/tag/nightly)에서 현재 사전 릴리스를 내려받을 수 있습니다.

자체 CLI를 사용하는 에이전트는 직접 설치하고 로그인해야 합니다. 앱의 **Settings → Connection**에서 제공자를 설치하고 연결할 수 있습니다.

## 개발

Node 22.18 이상, rustup으로 설치한 Rust, wasm-pack 0.15.0이 필요합니다. 저장소 루트에서 실행하세요.

```sh
npm run setup
npm run build:wasm
npm run dev:studio
```

http://127.0.0.1:7700에서 편집기를 엽니다. Studio는 임시 포트에 인증된 에이전트 허브를 함께 실행합니다. 다른 터미널에서 `npm run dev:desktop`을 실행하면 Electron이 이 개발 서버에 연결됩니다.

네이티브 빌드, 테스트와 기여 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다. 서명과 배포 절차는 [docs/releasing.md](docs/releasing.md)를 참고하세요.

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
