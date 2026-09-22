# rhwp — HWP 문서 뷰어 & 에디터 (Firefox 확장)

브라우저에서 HWP/HWPX 파일을 열고 편집합니다. 처리는 브라우저 안 WASM에서 끝납니다.

이 트리는 [Rauhwpx](https://github.com/ghandhitechnology/Rauhwpx) 포크의 확장 소스입니다. AMO 등록명은 여전히 rhwp입니다.

## 설치

- [Firefox Add-ons (AMO)](https://addons.mozilla.org/firefox/addon/rhwp-free-hwp-editor/)

## 사용

1. 웹에서 HWP를 받으면 뷰어 탭이 열립니다.
2. 확장 아이콘을 누른 뒤 빈 뷰어에 파일을 끌어다 놓습니다.
3. HWP 링크를 우클릭하고 "rhwp로 열기"를 고릅니다.
4. 페이지의 HWP 링크 옆 파란 H 배지를 누릅니다.

인쇄는 Ctrl+P 또는 파일 메뉴입니다. 저장은 Ctrl+S입니다. HWP와 HWPX를 저장할 수 있고, HWPX에서 HWP로 변환 저장도 됩니다.

공공 사이트에 `data-hwp-*` 속성을 붙이는 방법은 [개발자 가이드](../rhwp-chrome/DEVELOPER_GUIDE.md)를 보세요.

```html
<a href="/files/공문.hwp" data-hwp="true" data-hwp-title="공문" data-hwp-pages="5">
  공문.hwp
</a>
```

## 빌드

```bash
cd rhwp-firefox
npm install
npm run build
```

결과는 `dist/`입니다.

개발 적재:

1. `about:debugging#/runtime/this-firefox`
2. "임시 부가 기능 로드..."
3. `rhwp-firefox/dist/manifest.json` 선택

Chrome 확장과의 차이:

- `manifest.json`은 Firefox MV3용 `background.scripts`를 씁니다.
- `background.js`는 `browser.*`를 씁니다.
- 다운로드 가로채기는 `onCreated`를 씁니다.

이전 확장 버전 기록은 이 파일의 git 역사와 [edwardkim/rhwp](https://github.com/edwardkim/rhwp) 이슈에 있습니다.

## 라이선스

[MIT](../LICENSE). 개인정보 처리방침은 [PRIVACY.md](PRIVACY.md)입니다.
