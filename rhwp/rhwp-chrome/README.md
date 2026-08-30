# rhwp — HWP 문서 뷰어 & 에디터 (Chrome/Edge 확장)

브라우저에서 HWP/HWPX 파일을 열고 편집합니다. 처리는 브라우저 안 WASM에서 끝납니다.

이 트리는 [Rauhwpx](https://github.com/ghandhitechnology/Rauhwpx) 포크의 확장 소스입니다. 스토어 등록명은 여전히 rhwp입니다.

## 설치

- [Chrome Web Store](https://chromewebstore.google.com/detail/pgakpjflombjmehnebnbpnalhegaanag)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/rhwp/nfkdfobhmanddlhdbclkpoanbccpigcn)

## 사용

1. 웹에서 HWP를 받으면 뷰어 탭이 열립니다.
2. 확장 아이콘을 누른 뒤 빈 뷰어에 파일을 끌어다 놓습니다.
3. HWP 링크를 우클릭하고 "rhwp로 열기"를 고릅니다.
4. 페이지의 HWP 링크 옆 파란 H 배지를 누릅니다.

인쇄는 Ctrl+P 또는 파일 메뉴입니다. 저장은 Ctrl+S입니다. `.hwp`는 같은 파일에 덮어씁니다. `.hwpx`는 열람, 편집, 저장과 HWPX에서 HWP로 변환 저장을 지원합니다.

공공 사이트에 `data-hwp-*` 속성을 붙이는 방법은 [개발자 가이드](DEVELOPER_GUIDE.md)를 보세요.

```html
<a href="/files/공문.hwp" data-hwp="true" data-hwp-title="공문" data-hwp-pages="5">
  공문.hwp
</a>
```

## 빌드

```bash
cd rhwp-chrome
npm install
npm run build
```

결과는 `dist/`입니다.

개발 적재:

1. `chrome://extensions` 또는 `edge://extensions`
2. 개발자 모드
3. "압축 해제된 확장 프로그램을 로드합니다"에서 `rhwp-chrome/dist/` 선택

변경 기록은 GitHub Releases를 보세요.

## 라이선스

[MIT](../LICENSE). 개인정보 처리방침은 [PRIVACY.md](PRIVACY.md)입니다.
