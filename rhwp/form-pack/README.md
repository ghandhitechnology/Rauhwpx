# Rauhwpx 공문/품의 서식

사무실에서 스튜디오·데스크톱으로 바로 여는 HWPX 서식이다. 한컴 제품이 아니고, 브라우저 확장 광고도 아니다. 온나라 전자결재 인증 서식이 아니다.

팩 id는 `rauhwpx-office` 이다. 각 HWPX의 `META-INF/rauhwpx-form-pack` 에 이 id가 있다. 고객 파일이 `공문.hwpx`나 `품의.hwpx`여도 표식이 없으면 일반 HWPX다.

- `공문.hwpx` — 온메일형 시행문. 수신·제목·본문·발신명의·결재 누름틀.
- `품의.hwpx` — 온메일형 품의. 문서정보 표 안에 결재란 중첩 표.

파일 메뉴 **공문/품의 서식**에서 연다. 에이전트는 열린 페이지의 `get_fields` / `set_field_value`로 채운다. 이 팩만 저장을 HWPX로 잠그고, 바이너리 `.hwp` 경로는 거부한다.

재생성: `python3 form-pack/build_forms.py` (`rhwp/` 기준).
