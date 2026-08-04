#!/bin/bash
# rhwp-vscode 퍼블리쉬 스크립트
# VS Code Marketplace + Open VSX 동시 배포
#
# 사용법:
#   cd rhwp-vscode
#   ./publish.sh
#
# 사전 조건:
#   - ../.env 파일에 VSCE_PAT, OVSX_PAT 설정
#   - WASM 빌드 완료 (pkg/)
#   - media/rhwp.js, media/rhwp_bg.wasm 복사 완료

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# .env에서 PAT 읽기 (source 대신 grep으로 안전하게)
ENV_FILE="../.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ .env 파일이 없습니다: $ENV_FILE"
  exit 1
fi

VSCE_PAT=$(grep '^VSCE_PAT=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
OVSX_PAT=$(grep '^OVSX_PAT=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')

if [ -z "$VSCE_PAT" ]; then
  echo "❌ VSCE_PAT가 .env에 설정되지 않았습니다"
  exit 1
fi
if [ -z "$OVSX_PAT" ]; then
  echo "❌ OVSX_PAT가 .env에 설정되지 않았습니다"
  exit 1
fi

# 로고 복사 (assets/logo → media/icon.png)
echo "📦 로고 복사..."
cp ../assets/logo/logo-128.png media/icon.png

# WASM 파일 복사
echo "📦 WASM 파일 복사..."
cp ../pkg/rhwp_bg.wasm media/
cp ../pkg/rhwp.js media/

# 버전 확인
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: "\(.*\)".*/\1/')
echo "📌 버전: v$VERSION"

# 빌드
echo "🔨 빌드 중..."
npm run compile

# VS Code Marketplace 배포
echo ""
echo "🚀 VS Code Marketplace 배포 중..."
npx vsce publish -p "$VSCE_PAT"

# Open VSX 배포
echo ""
echo "🚀 Open VSX 배포 중..."
npx ovsx publish -p "$OVSX_PAT"

echo ""
echo "✅ v$VERSION 배포 완료!"
echo "   - VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=edwardkim.rhwp-vscode"
echo "   - Open VSX: https://open-vsx.org/extension/edwardkim/rhwp-vscode"
