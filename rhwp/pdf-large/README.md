# 대용량 PDF 기준 자료

50 MB가 넘는 PDF는 이 폴더에서 Git LFS로 추적합니다. 기존 `pdf/`, `pdf-2020/`, `pdf-2010/` 기준 자료는 각 폴더에 그대로 보존합니다.

한컴에서 출력한 기준 PDF의 출처와 생성 방법은 [pdf/README.md](../pdf/README.md)를 참고하세요. 이름은 원본 문서의 stem 뒤에 한컴 버전을 붙입니다. 예를 들어 한글 2022 출력은 `문서명-2022.pdf`입니다. 원본이 `samples/`의 하위 폴더에 있으면 PDF도 같은 하위 구조를 유지합니다.

## 파일 받기

Git LFS를 설치하지 않은 체크아웃에서는 PDF 대신 작은 포인터 파일만 보일 수 있습니다. [Git LFS](https://git-lfs.com)를 설치한 뒤 저장소에서 실행하세요.

```sh
git lfs install
git lfs pull
```

## 새 기준 자료 추가

`rhwp/.gitattributes`의 `pdf-large/**/*.pdf` 규칙이 LFS 추적을 지정합니다. `rhwp/`에서 파일을 추가하고 추적 상태를 확인하세요.

```sh
cp /path/to/big.pdf pdf-large/big-2022.pdf
git add pdf-large/big-2022.pdf
git lfs ls-files
```

원본 문서, 한컴 버전과 출력 설정을 함께 기록하세요. 기존 기준 자료를 다른 렌더러의 출력으로 덮어쓰지 마세요.
