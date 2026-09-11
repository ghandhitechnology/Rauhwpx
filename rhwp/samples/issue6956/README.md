# #6956 — 형광펜 표지 왕복 보존

`3024739-exposure-algorithm-markpen.hwpx` — 환경부 「환경유해인자 위해성평가를 위한 절차와
방법 등에 관한 지침」 [별표 4]. 코퍼스의 형광펜 문서 18건 중 **가장 작다**(11KB).

형광펜 표지가 **세 쌍**으로 들어 있다. 텍스트 안 두 쌍과, run 바로 밑에서 표를 감싼
한 쌍을 모두 왕복한다.

```xml
<!-- ① hp:t 안 -->
<hp:run charPrIDRef="5"><hp:t>□ <hp:markpenBegin color="#FFFFFF"/>노출량 산정 알고리즘<hp:markpenEnd/></hp:t></hp:run>

<!-- ② run 바로 밑에서 표를 감싼다 -->
<hp:run charPrIDRef="14"><hp:markpenBegin color="#FFFFFF"/><hp:tbl …/><hp:t><hp:markpenEnd/></hp:t></hp:run>

<!-- ③ hp:t 안 -->
<hp:run charPrIDRef="9"><hp:t> ○ <hp:markpenBegin color="#FFFFFF"/>접촉률 : …<hp:markpenEnd/></hp:t></hp:run>
```

## 계약

세 쌍 모두 색(`#FFFFFF`)까지 왕복한다. 표를 감싼 문단은 빈 텍스트에 표지 두 개만 남고
`utf16_pos` 는 `Some(0)` 과 `Some(8)` 이다. HWP5 저장은 PARA_RANGE_TAG 종류 2,
COLORREF BGR, 끝 위치 exclusive 로 되돌린다.

표지는 글자 축을 소비하지 않는다. `text` 에 sentinel 을 넣지 않으므로
`hp:lineseg/@textpos` 가 밀리지 않는다.
