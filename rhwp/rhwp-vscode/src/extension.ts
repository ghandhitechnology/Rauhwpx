import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as vscode from "vscode";
import { HwpEditorProvider } from "./hwp-editor-provider";
import { initWasmHost, HwpDocument } from "./wasm-host";

export function activate(context: vscode.ExtensionContext) {
  const { provider, disposable } = HwpEditorProvider.register(context);
  context.subscriptions.push(disposable);

  // rhwp.exportSvg — SVG 내보내기
  context.subscriptions.push(
    vscode.commands.registerCommand("rhwp.exportSvg", async (uri?: vscode.Uri) => {
      const target = resolveUri(uri);
      if (!target) return;
      await cmdExportSvg(target, provider);
    })
  );

  // rhwp.debugOverlay — 디버그 오버레이
  context.subscriptions.push(
    vscode.commands.registerCommand("rhwp.debugOverlay", async (uri?: vscode.Uri) => {
      const target = resolveUri(uri);
      if (!target) return;
      await cmdDebugOverlay(target, provider);
    })
  );

  // rhwp.dumpParagraph — 문단 덤프
  const dumpChannel = vscode.window.createOutputChannel("HWP Dump");
  context.subscriptions.push(dumpChannel);
  context.subscriptions.push(
    vscode.commands.registerCommand("rhwp.dumpParagraph", async (uri?: vscode.Uri) => {
      const target = resolveUri(uri);
      if (!target) return;
      await cmdDumpParagraph(target, context.extensionPath, dumpChannel);
    })
  );
}

export function deactivate() {}

/** 컨텍스트 메뉴에서 전달된 uri, 또는 현재 활성 편집기의 uri를 반환 */
function resolveUri(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri) return uri;
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) return activeUri;
  return undefined;
}

// ── SVG 내보내기 ─────────────────────────────────────────────────

async function cmdExportSvg(uri: vscode.Uri, provider: HwpEditorProvider): Promise<void> {
  const defaultDir = vscode.Uri.file(path.dirname(uri.fsPath));
  const folders = await vscode.window.showOpenDialog({
    defaultUri: defaultDir,
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "이 폴더에 SVG 저장",
  });
  if (!folders || folders.length === 0) return;
  const outDir = folders[0].fsPath;
  const baseName = path.basename(uri.fsPath, path.extname(uri.fsPath));

  vscode.window.showInformationMessage(`SVG 렌더링 중... (${path.basename(uri.fsPath)})`);

  await provider.sendExportSvg(uri, async (svgs) => {
    for (let i = 0; i < svgs.length; i++) {
      const outPath = path.join(outDir, `${baseName}_p${i + 1}.svg`);
      fs.writeFileSync(outPath, svgs[i], "utf8");
    }
    const outDirUri = vscode.Uri.file(outDir);
    const sel = await vscode.window.showInformationMessage(
      `SVG ${svgs.length}개 저장 완료 → ${outDir}`,
      "폴더 열기"
    );
    if (sel === "폴더 열기") {
      vscode.commands.executeCommand("revealFileInOS", outDirUri);
    }
  });
}

// ── 디버그 오버레이 ───────────────────────────────────────────────

async function cmdDebugOverlay(uri: vscode.Uri, provider: HwpEditorProvider): Promise<void> {
  const baseName = path.basename(uri.fsPath);
  const hash = crypto.createHash("md5").update(uri.fsPath).digest("hex").slice(0, 8);
  const tmpFile = path.join(os.tmpdir(), `rhwp-debug-${hash}.html`);

  await provider.sendDebugOverlay(uri, (svgs) => {
    const pageHtml = svgs
      .map(
        (svg, i) =>
          `<div class="page"><div class="page-label">Page ${i + 1}</div>${svg}</div>`
      )
      .join("\n");

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>Debug Overlay — ${baseName}</title>
<style>
  body { background: #555; margin: 0; padding: 16px; font-family: sans-serif; }
  .page { background: white; margin: 0 auto 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); width: fit-content; position: relative; }
  .page-label { position: absolute; top: 4px; right: 8px; font-size: 11px; color: #888; background: rgba(255,255,255,0.8); padding: 1px 4px; border-radius: 3px; }
  svg { display: block; }
</style>
</head>
<body>
${pageHtml}
</body>
</html>`;

    fs.writeFileSync(tmpFile, html, "utf8");
    vscode.commands.executeCommand("vscode.open", vscode.Uri.file(tmpFile));
  });
}

// ── 문단 덤프 ─────────────────────────────────────────────────────

async function cmdDumpParagraph(
  uri: vscode.Uri,
  extensionPath: string,
  dumpChannel: vscode.OutputChannel
): Promise<void> {
  try {
    initWasmHost(extensionPath);

    const fileBytes = fs.readFileSync(uri.fsPath);
    const doc: InstanceType<typeof HwpDocument> = new HwpDocument(new Uint8Array(fileBytes));
    doc.setClipEnabled(false);

    const secCount = doc.getSectionCount();

    // 섹션 선택
    const secItems = Array.from({ length: secCount }, (_, i) => {
      const pCount = doc.getParagraphCount(i);
      return { label: `섹션 ${i}`, description: `문단 ${pCount}개` };
    });
    const secPick = await vscode.window.showQuickPick(secItems, {
      placeHolder: "섹션을 선택하세요",
    });
    if (!secPick) return;
    const sec = secItems.indexOf(secPick);

    // 문단 선택
    const paraCount = doc.getParagraphCount(sec);
    const paraItems = Array.from({ length: paraCount }, (_, i) => ({
      label: `문단 ${i}`,
      description: `섹션 ${sec}`,
    }));
    const paraPick = await vscode.window.showQuickPick(paraItems, {
      placeHolder: "문단을 선택하세요",
    });
    if (!paraPick) return;
    const para = paraItems.indexOf(paraPick);

    // ParaShape + LINE_SEG 정보 조회
    const paraProps = JSON.parse(doc.getParaPropertiesAt(sec, para));
    const lineInfo = JSON.parse(doc.getLineInfo(sec, para, 0));

    doc.free();

    // Output 채널에 출력 (CLI dump와 유사한 포맷)
    dumpChannel.clear();
    dumpChannel.appendLine(`--- 문단 ${sec}.${para} --- (${path.basename(uri.fsPath)})`);
    dumpChannel.appendLine("");
    dumpChannel.appendLine("[ParaShape]");
    dumpChannel.appendLine(formatJson(paraProps));
    dumpChannel.appendLine("");
    dumpChannel.appendLine("[LineInfo (char_offset=0)]");
    dumpChannel.appendLine(formatJson(lineInfo));
    dumpChannel.show(true);
  } catch (err: any) {
    vscode.window.showErrorMessage(`문단 덤프 실패: ${err.message ?? err}`);
  }
}

/** JSON 객체를 들여쓰기 포함하여 key=value 형식으로 출력 */
function formatJson(obj: Record<string, unknown>, indent = "  "): string {
  return Object.entries(obj)
    .map(([k, v]) => {
      if (typeof v === "object" && v !== null) {
        return `${indent}${k}:\n${formatJson(v as Record<string, unknown>, indent + "  ")}`;
      }
      return `${indent}${k} = ${v}`;
    })
    .join("\n");
}
