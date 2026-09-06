import './writing-style-calibration.css';

import type { SidebarBridge } from '../../agent/bridge.ts';
import { loadAgentPrefs } from '../../agent/agent-prefs.ts';
import {
  defaultModelForAgent,
  labelForModel,
  modelsForAgent,
  resolveModelForAgent,
} from '../../agent/models.ts';
import { AGENT_LABEL, PROVIDER_ORDER, createProviderIcon } from './providers.ts';
import type {
  AgentName,
  PiStatus,
  ProviderStatusMap,
  SidebarEvent,
  WritingStyleLanguage,
  WritingStyleCatalog,
  WritingStyleProgress,
  WritingStyleProgressState,
  WritingStyleStatus,
  WritingStyleUpload,
} from '../../agent/types.ts';
import { readBlobBytesWithLimit } from '../../core/document-input-limits.ts';

const ACCEPTED_EXTENSIONS = ['txt', 'md', 'markdown', 'pdf', 'docx', 'rtf', 'html', 'htm', 'csv', 'hwp', 'hwpx'];
const MAX_FILES = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const ACK_TIMEOUT_MS = 10_000;
const AGENTS: readonly AgentName[] = PROVIDER_ORDER;

const PROGRESS_STAGES: ReadonlyArray<{
  state: WritingStyleProgressState;
  label: string;
  detail: string;
}> = [
  { state: 'queued', label: '분석 요청 준비', detail: '선택한 문서와 모델을 확인하고 있습니다.' },
  { state: 'reading', label: '문서 읽기', detail: '원고를 안전하게 불러오고 있습니다.' },
  { state: 'extracting', label: '텍스트 추출', detail: '문서 형식에서 분석할 문장을 꺼내고 있습니다.' },
  { state: 'preparing', label: '분석 자료 정돈', detail: '문장 단위를 정리하고 언어를 확인하고 있습니다.' },
  { state: 'analyzing', label: '목소리 읽기', detail: '습관의 목록이 아니라, 글에서 어떤 사람인지를 듣고 있습니다.' },
  { state: 'synthesizing', label: '목소리 담기', detail: '규칙 대신, 이 글을 쓴 사람의 결을 남기고 있습니다.' },
  { state: 'saving', label: '문체 프로필 저장', detail: '다음 글쓰기부터 그 목소리로 쓸 style.md를 준비하고 있습니다.' },
];

type CorpusMode = 'append' | 'replace';
type InstructionNextAction = 'dismiss' | 'append' | 'replace';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(className: string, viewBox = '0 0 24 24'): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('class', className);
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function addSvgShape(
  parent: SVGElement,
  tag: 'path' | 'rect' | 'circle' | 'g',
  attrs: Record<string, string>,
): SVGElement {
  const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
  parent.appendChild(shape);
  return shape;
}

function createCloseIcon(): SVGSVGElement {
  const icon = svg('ag-calibration-close-icon');
  addSvgShape(icon, 'path', { d: 'm7 7 10 10M17 7 7 17', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' });
  return icon;
}

function createUploadIcon(): SVGSVGElement {
  const icon = svg('ag-calibration-upload-icon');
  addSvgShape(icon, 'path', { d: 'M12 15V4m0 0L8 8m4-4 4 4M5 14v4.5h14V14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  return icon;
}

function createCheckIcon(): SVGSVGElement {
  const icon = svg('ag-calibration-result-icon');
  addSvgShape(icon, 'circle', { cx: '12', cy: '12', r: '8.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' });
  addSvgShape(icon, 'path', { d: 'm8 12 2.6 2.6L16.5 9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  return icon;
}

function createPixelFlag(language: WritingStyleLanguage): SVGSVGElement {
  const width = language === 'ko' ? 72 : 96;
  const flag = svg('ag-calibration-flag', `0 0 ${width} 48`);
  flag.setAttribute('shape-rendering', 'crispEdges');
  flag.dataset.language = language;
  addSvgShape(flag, 'rect', { width: String(width), height: '48', fill: '#f1faf8' });
  if (language === 'en') {
    for (const x of [0, 72]) {
      addSvgShape(flag, 'rect', { x: String(x), width: '24', height: '48', fill: '#d80621' });
    }
    // 계단형 윤곽으로 그린 단풍잎과 줄기.
    addSvgShape(flag, 'path', {
      d: 'M48 6h2v4h2v4h2v-2h3v9h2v-3h4v3h4v4h-3v3h-3v3h-4v3h2v3h-9v6h-4v-6h-9v-3h2v-3h-4v-3h-3v-3h-3v-4h4v-3h4v3h2v-9h3v2h2v-4h2V6z',
      fill: '#d80621',
    });
  } else {
    // 건(☰), 감(☵), 리(☲), 곤(☷): 각 괘의 세 효와 끊어진 획을 보존합니다.
    const trigrams = [
      { x: 16, y: 11, angle: -Math.PI / 4, broken: [false, false, false] },
      { x: 56, y: 11, angle: Math.PI / 4, broken: [true, false, true] },
      { x: 16, y: 37, angle: Math.PI / 4, broken: [false, true, false] },
      { x: 56, y: 37, angle: -Math.PI / 4, broken: [true, true, true] },
    ];
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 72; x++) {
        const dx = x + 0.5 - 36;
        const dy = y + 0.5 - 24;
        let fill = '';
        if (dx * dx + dy * dy <= 144) {
          const redLobe = (dx + 6) ** 2 + dy ** 2 <= 36;
          const blueLobe = (dx - 6) ** 2 + dy ** 2 <= 36;
          fill = (dy < 0 && !blueLobe) || redLobe ? '#cd2e3a' : '#0047a0';
        }
        for (const trigram of trigrams) {
          const tx = x + 0.5 - trigram.x;
          const ty = y + 0.5 - trigram.y;
          const u = tx * Math.cos(trigram.angle) + ty * Math.sin(trigram.angle);
          const v = -tx * Math.sin(trigram.angle) + ty * Math.cos(trigram.angle);
          if (Math.abs(u) >= 6) continue;
          for (let line = 0; line < 3; line++) {
            if (Math.abs(v - (line - 1) * 4) < 1 && (!trigram.broken[line] || Math.abs(u) >= 1.5)) fill = '#111';
          }
        }
        if (fill) addSvgShape(flag, 'rect', { x: String(x), y: String(y), width: '1', height: '1', fill });
      }
    }
  }
  // 구름 픽셀 아트처럼 밝은 윗면과 차분한 아래쪽 테두리를 더합니다.
  addSvgShape(flag, 'path', {
    d: `M0 0h${width}v1H1v46H0z`, fill: '#fff', opacity: '.55',
  });
  addSvgShape(flag, 'path', {
    d: `M1 47h${width - 2}v1H1zM${width - 1} 1h1v47h-1z`,
    fill: '#31585e', opacity: '.22',
  });
  return flag;
}

/** 각 서버 단계가 도착할 때 실제로 한 묶음씩 연결되는 지식 지도. */
function createKnowledgeNetwork(): {
  root: HTMLElement;
  edges: SVGPathElement[];
  nodes: SVGGElement[];
} {
  const root = el('div', 'ag-calibration-network-scape');
  const graphic = svg('ag-calibration-network', '0 0 520 250');
  graphic.setAttribute('role', 'img');
  graphic.setAttribute('aria-label', '문서의 표현 관계가 지식 지도로 연결되는 모습');
  graphic.removeAttribute('aria-hidden');

  const edgeLayer = addSvgShape(graphic, 'g', { class: 'ag-calibration-network-edges' });
  const nodeLayer = addSvgShape(graphic, 'g', { class: 'ag-calibration-network-nodes' });
  const edges: SVGPathElement[] = [];
  const nodes: SVGGElement[] = [];
  const edgePaths = [
    'M64 168 C105 159 119 142 154 124',
    'M91 70 C121 80 133 99 154 124',
    'M154 124 C190 94 214 89 246 105',
    'M154 124 C192 151 216 158 249 151',
    'M246 105 C281 112 297 124 323 128',
    'M249 151 C282 154 301 144 323 128',
    'M323 128 C350 95 375 79 414 75',
    'M323 128 C358 136 382 151 421 174',
    'M414 75 C446 88 463 111 464 137',
    'M421 174 C444 166 456 153 464 137',
    'M246 105 C270 73 297 58 330 54',
    'M249 151 C273 183 302 197 338 202',
  ];
  edgePaths.forEach((d, index) => {
    const path = addSvgShape(edgeLayer, 'path', {
      d,
      class: 'ag-calibration-network-edge',
      'data-level': String(Math.min(PROGRESS_STAGES.length - 1, Math.floor(index / 2) + 1)),
      pathLength: '1',
    }) as SVGPathElement;
    edges.push(path);
  });

  const nodePoints = [
    [64, 168], [91, 70], [154, 124], [246, 105], [249, 151], [323, 128],
    [330, 54], [414, 75], [338, 202], [421, 174], [464, 137],
  ];
  const nodeLevels = [0, 0, 1, 2, 2, 3, 4, 4, 5, 5, 6];
  nodePoints.forEach(([cx, cy], index) => {
    const group = addSvgShape(nodeLayer, 'g', {
      class: 'ag-calibration-network-node',
      'data-level': String(nodeLevels[index]),
      transform: `translate(${cx} ${cy})`,
    }) as SVGGElement;
    addSvgShape(group, 'circle', { class: 'ag-calibration-node-orbit', r: index === 5 ? '15' : '11' });
    addSvgShape(group, 'circle', { class: 'ag-calibration-node-core', r: index === 5 ? '5' : '3.5' });
    nodes.push(group);
  });
  root.appendChild(graphic);
  return { root, edges, nodes };
}

function fileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}초`;
  return `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, '0')}초`;
}

function safeProgressCopy(value: string | undefined, fallback: string): string {
  const compact = value?.replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, 180) : fallback;
}

function localizedActivity(value: string | undefined, fallback: string): string {
  const labels: Record<string, string> = {
    'collecting-samples': '보정 자료 모으기',
    'validating-samples': '분석 분량 확인',
    'reading-sample': '문서 읽기',
    'extracting-text': '텍스트 추출',
    'measuring-patterns': '문장 패턴 측정',
    'model-analysis': '목소리 읽기',
    'building-profile': '목소리 담기',
    'saving-profile': '문체 프로필 저장',
  };
  return labels[value ?? ''] ?? safeProgressCopy(value, fallback);
}

function localizedDetail(value: string | undefined, fallback: string): string {
  const text = safeProgressCopy(value, fallback);
  const exact: Record<string, string> = {
    'Combining saved and new writing samples': '현재 보정 자료와 새 문서를 함께 준비하고 있습니다.',
    'Preparing writing samples': '새 문서를 분석할 수 있도록 준비하고 있습니다.',
    'Measuring sentence, paragraph, and formatting patterns': '문장, 문단, 서식의 반복 패턴을 측정하고 있습니다.',
    'Finished deterministic pattern measurements': '문장 패턴 측정을 마쳤습니다.',
    'Listening for how the voice lands': '문장이 떨어지는 방식을 듣고 있습니다.',
    'Noticing temperament and unevenness': '기질과 고르지 않은 결을 짚고 있습니다.',
    'Writing a portrait of the person on the page': '이 글을 쓴 사람의 초상을 남기고 있습니다.',
    'Finished model analysis': '모델 분석을 마쳤습니다.',
    'Building the calibrated writing profile': '규칙이 아니라 목소리로 프로필을 만들고 있습니다.',
    'Finished the calibrated writing profile': '문체 프로필 구성을 마쳤습니다.',
    'Saving the profile and its source samples': '문체 프로필과 보정 자료를 저장하고 있습니다.',
    'Saved the calibrated writing profile': '문체 프로필 저장을 마쳤습니다.',
  };
  if (exact[text]) return exact[text]!;
  const reading = text.match(/^Reading (.+)$/);
  if (reading) return `${reading[1]} 읽는 중`;
  const extracting = text.match(/^Extracting text from (.+)$/);
  if (extracting) return `${extracting[1]}에서 텍스트를 추출하는 중`;
  const prepared = text.match(/^Prepared (\d+) of (\d+) samples$/);
  if (prepared) return `문서 ${prepared[1]} / ${prepared[2]} 준비됨`;
  const preparing = text.match(/^Preparing (\d+) writing samples$/);
  if (preparing) return `문서 ${preparing[1]}개를 확인하고 있습니다.`;
  return text;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
  }
  return btoa(binary);
}

function errorCopy(code: string, fallback: string): string {
  switch (code) {
    case 'INSUFFICIENT_SAMPLE': return '읽을 수 있는 글이 10쪽보다 적습니다. 원고를 더 추가해 다시 분석해 주세요.';
    case 'CODEX_UNAVAILABLE':
    case 'CLAUDE_UNAVAILABLE':
    case 'PI_UNAVAILABLE':
    case 'PROVIDER_UNAVAILABLE': return '선택한 프로바이더를 시작하지 못했습니다. 연결 상태를 확인하거나 다른 프로바이더를 선택해 주세요.';
    case 'MODEL_UNAVAILABLE': return '선택한 모델을 사용할 수 없습니다. 모델 목록에서 다른 모델을 선택해 주세요.';
    case 'CALIBRATION_BUSY': return '다른 문체 분석이 진행 중입니다. 현재 작업이 끝난 뒤 다시 시도해 주세요.';
    case 'TIMEOUT': return '에이전트 쪽 분석이 중단되었습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
    default: return fallback || '문체 분석을 완료하지 못했습니다. 파일과 모델을 확인한 뒤 다시 시도해 주세요.';
  }
}

export interface WritingStyleCalibrationOpenOptions {
  /** 첫 실행 마법사 위에 올릴 때 쌓임 순서를 높인다. */
  elevate?: boolean;
}

export interface WritingStyleCalibrationUi {
  open(): void;
  open(options?: WritingStyleCalibrationOpenOptions): void;
  handleEvent(event: SidebarEvent): void;
  dispose(): void;
}

export function createWritingStyleCalibration(
  bridge: SidebarBridge,
  options?: { onDismiss?: (result: { completed: boolean }) => void },
): WritingStyleCalibrationUi {
  const prefs = loadAgentPrefs();
  const activeAgent = bridge.getActiveAgent();
  let language: WritingStyleLanguage = 'ko';
  let selectedAgent: AgentName = activeAgent ?? prefs.defaultAgent;
  let selectedModel = resolveModelForAgent(
    selectedAgent,
    selectedAgent === prefs.defaultAgent ? prefs.defaultModel : null,
  );
  let selectedFiles: File[] = [];
  let corpusMode: CorpusMode = 'replace';
  let requestId: string | null = null;
  let instructionRequestId: string | null = null;
  let instructionNextAction: InstructionNextAction | null = null;
  let calibrationBaselineUpdatedAt: string | null = null;
  let awaitingReconnectCompletion = false;
  let ackTimer: number | null = null;
  let elapsedTimer: number | null = null;
  let progressStartedAt = 0;
  let networkLevel = 0;
  let connectionState = bridge.getConnectionState();
  let providerStatus: ProviderStatusMap | null = null;
  let piStatus: PiStatus | null = null;
  let calibrationCatalog: WritingStyleCatalog | null = null;
  let activeStatus: WritingStyleStatus | null = null;
  let lastFocus: HTMLElement | null = null;
  let submitting = false;
  let selectionTouched = false;
  let disposed = false;

  const overlay = el('div', 'ag-calibration-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  const dialog = el('section', 'ag-calibration-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ag-calibration-title');
  dialog.tabIndex = -1;

  const chrome = el('div', 'ag-calibration-chrome');
  const stepLabel = el('span', 'ag-calibration-step-label', '1 / 3');
  const close = el('button', 'ag-calibration-close');
  close.type = 'button';
  close.setAttribute('aria-label', '문체 보정 창 닫기');
  close.append(createCloseIcon());
  chrome.append(stepLabel, close);

  const body = el('div', 'ag-calibration-body');
  const panels = [0, 1, 2, 3].map((step) => {
    const panel = el('div', 'ag-calibration-panel');
    panel.dataset.step = String(step);
    body.appendChild(panel);
    return panel;
  });

  const introTitle = el('h2', 'ag-calibration-title', '말투를 맞출까요?');
  introTitle.id = 'ag-calibration-title';
  const introStatement = el('p', 'ag-calibration-statement', '당신이 글에서 말투를 학습해서, 따라합니다');
  const introDetail = el('p', 'ag-calibration-detail', '먼저 분석할 글의 주 언어를 선택하세요.');
  const languageGroup = el('div', 'ag-calibration-language-group');
  languageGroup.setAttribute('role', 'radiogroup');
  languageGroup.setAttribute('aria-label', '캘리브레이션 언어');
  const languageButtons = new Map<WritingStyleLanguage, HTMLButtonElement>();
  for (const [value, label] of [
    ['ko', '한국어'],
    ['en', 'English'],
  ] as const) {
    const langButton = el('button', 'ag-calibration-language');
    langButton.type = 'button';
    langButton.dataset.language = value;
    langButton.setAttribute('role', 'radio');
    const copy = el('span', 'ag-calibration-language-copy');
    copy.append(el('strong', '', label));
    langButton.append(createPixelFlag(value), copy);
    langButton.addEventListener('click', () => setLanguage(value));
    languageButtons.set(value, langButton);
    languageGroup.appendChild(langButton);
  }
  const introActions = el('div', 'ag-calibration-actions');
  const introLater = el('button', 'ag-calibration-secondary', '나중에');
  introLater.type = 'button';
  const introNext = el('button', 'ag-calibration-primary', '계속');
  introNext.type = 'button';
  introActions.append(introLater, introNext);
  panels[0]!.append(introTitle, introStatement, introDetail, languageGroup, introActions);

  const uploadTitle = el('h2', 'ag-calibration-title', '보정할 글과 모델을 선택하세요');
  const uploadStatement = el('p', 'ag-calibration-upload-statement');

  const corpusSection = el('section', 'ag-calibration-corpus');
  corpusSection.setAttribute('aria-labelledby', 'ag-calibration-corpus-title');
  const corpusHead = el('div', 'ag-calibration-corpus-head');
  const corpusHeading = el('h3', 'ag-calibration-section-title', '현재 보정 자료');
  corpusHeading.id = 'ag-calibration-corpus-title';
  const corpusMeta = el('span', 'ag-calibration-corpus-meta');
  corpusHead.append(corpusHeading, corpusMeta);
  const corpusList = el('ul', 'ag-calibration-corpus-list');
  const corpusModes = el('div', 'ag-calibration-corpus-modes');
  corpusModes.setAttribute('role', 'radiogroup');
  corpusModes.setAttribute('aria-label', '기존 보정 자료 처리 방식');
  const corpusModeButtons = new Map<CorpusMode, HTMLButtonElement>();
  for (const [value, label, detail] of [
    ['append', '문서 추가', '현재 자료를 유지하고 새 글을 더합니다.'],
    ['replace', '전체 교체', '현재 자료를 빼고 새 글만 다시 분석합니다.'],
  ] as const) {
    const button = el('button', 'ag-calibration-mode');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.append(el('strong', '', label), el('span', '', detail));
    button.addEventListener('click', () => setCorpusMode(value));
    corpusModeButtons.set(value, button);
    corpusModes.appendChild(button);
  }
  corpusSection.append(corpusHead, corpusList, corpusModes);

  const providerFieldset = el('fieldset', 'ag-calibration-provider-fieldset');
  const providerPicker = document.createElement('details');
  providerPicker.className = 'ag-calibration-provider-picker';
  const providerSummary = document.createElement('summary');
  providerSummary.className = 'ag-calibration-provider-summary';
  const providerSelection = el('span', 'ag-calibration-provider-selection');
  providerSummary.append(el('span', 'ag-calibration-section-title', '분석 모델'), providerSelection);
  providerPicker.appendChild(providerSummary);
  const providerGroup = el('div', 'ag-calibration-provider-group');
  providerGroup.setAttribute('role', 'radiogroup');
  providerGroup.setAttribute('aria-label', '분석 프로바이더');
  const providerButtons = new Map<AgentName, HTMLButtonElement>();
  const providerStatusLabels = new Map<AgentName, HTMLElement>();
  for (const agent of AGENTS) {
    const button = el('button', 'ag-calibration-provider');
    button.type = 'button';
    button.dataset.agent = agent;
    button.setAttribute('role', 'radio');
    const name = el('strong', '', AGENT_LABEL[agent]);
    const health = el('span', 'ag-calibration-provider-health', '확인 중');
    button.append(createProviderIcon(agent), name, health);
    button.addEventListener('click', () => selectAgent(agent));
    providerButtons.set(agent, button);
    providerStatusLabels.set(agent, health);
    providerGroup.appendChild(button);
  }
  const modelRow = el('label', 'ag-calibration-model-row');
  modelRow.appendChild(el('span', '', '모델'));
  const modelSelect = el('select', 'ag-calibration-model-select') as HTMLSelectElement;
  modelSelect.setAttribute('aria-describedby', 'ag-calibration-model-help');
  modelRow.appendChild(modelSelect);
  const modelHelp = el('p', 'ag-calibration-model-help');
  modelHelp.id = 'ag-calibration-model-help';
  modelHelp.setAttribute('aria-live', 'polite');
  providerPicker.append(providerGroup, modelRow, modelHelp);
  providerFieldset.append(providerPicker);

  const uploadInput = el('input', 'ag-calibration-file-input') as HTMLInputElement;
  uploadInput.type = 'file';
  uploadInput.tabIndex = -1;
  uploadInput.multiple = true;
  uploadInput.accept = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');
  uploadInput.id = 'ag-calibration-file-input';
  const dropzone = el('label', 'ag-calibration-dropzone') as HTMLLabelElement;
  dropzone.htmlFor = uploadInput.id;
  dropzone.tabIndex = 0;
  dropzone.append(createUploadIcon(), el('strong', '', '파일을 놓거나 클릭하여 선택'), el('span', '', 'HWP · HWPX · PDF · DOCX · TXT · MD'));
  const fileSummary = el('div', 'ag-calibration-file-summary', '선택된 새 파일 없음');
  fileSummary.setAttribute('aria-live', 'polite');
  const fileList = el('ul', 'ag-calibration-file-list');
  const uploadError = el('div', 'ag-calibration-error');
  uploadError.setAttribute('role', 'alert');
  const uploadActions = el('div', 'ag-calibration-actions');
  const uploadBack = el('button', 'ag-calibration-secondary', '이전');
  uploadBack.type = 'button';
  const analyze = el('button', 'ag-calibration-primary', '분석 시작');
  analyze.type = 'button';
  uploadActions.append(uploadBack, analyze);
  panels[1]!.append(uploadTitle, uploadStatement, corpusSection, providerFieldset, dropzone, uploadInput, fileSummary, fileList, uploadError, uploadActions);

  const progressHead = el('div', 'ag-calibration-progress-head');
  const progressTitle = el('h2', 'ag-calibration-title', '목소리를 읽고 있습니다');
  const progressContext = el('p', 'ag-calibration-progress-context');
  progressHead.append(progressTitle, progressContext);
  const network = createKnowledgeNetwork();
  const progressStatus = el('div', 'ag-calibration-progress-status');
  progressStatus.setAttribute('aria-live', 'polite');
  progressStatus.setAttribute('aria-atomic', 'true');
  const progressActivity = el('strong', 'ag-calibration-progress-activity', PROGRESS_STAGES[0]!.label);
  const progressDetail = el('span', 'ag-calibration-progress-detail', PROGRESS_STAGES[0]!.detail);
  progressStatus.append(progressActivity, progressDetail);
  const deterministicProgress = el('div', 'ag-calibration-determinate');
  deterministicProgress.hidden = true;
  deterministicProgress.setAttribute('role', 'progressbar');
  const deterministicTrack = el('span', 'ag-calibration-determinate-track');
  const deterministicFill = el('span', 'ag-calibration-determinate-fill');
  deterministicTrack.appendChild(deterministicFill);
  const deterministicLabel = el('span', 'ag-calibration-determinate-label');
  deterministicProgress.append(deterministicTrack, deterministicLabel);
  const progressConnection = el('p', 'ag-calibration-progress-connection');
  progressConnection.hidden = true;
  progressConnection.setAttribute('role', 'status');
  const activityHead = el('div', 'ag-calibration-activity-head');
  activityHead.append(el('h3', 'ag-calibration-section-title', '작업 흐름'));
  const elapsed = el('span', 'ag-calibration-elapsed', '0초');
  activityHead.appendChild(elapsed);
  const activityFeed = el('ol', 'ag-calibration-activity-feed');
  panels[2]!.append(progressHead, network.root, progressStatus, deterministicProgress, progressConnection, activityHead, activityFeed);

  const resultIconWrap = el('div', 'ag-calibration-result-icon-wrap');
  resultIconWrap.appendChild(createCheckIcon());
  const resultTitle = el('h2', 'ag-calibration-title', '목소리를 기억했습니다');
  const resultMeta = el('p', 'ag-calibration-result-meta');
  const resultCorpus = el('section', 'ag-calibration-result-corpus');
  const resultCorpusHead = el('div', 'ag-calibration-corpus-head');
  resultCorpusHead.append(el('h3', 'ag-calibration-section-title', '보정에 쓰는 문서'), el('span', 'ag-calibration-corpus-meta'));
  const resultCorpusList = el('ul', 'ag-calibration-corpus-list');
  const replaceCorpus = el('button', 'ag-calibration-text-action', '전체 문서 교체');
  replaceCorpus.type = 'button';
  resultCorpus.append(resultCorpusHead, resultCorpusList, replaceCorpus);
  const instructionLabel = el('label', 'ag-calibration-instruction-label', '에이전트 말투에 추가할 지침');
  const instruction = el('textarea', 'ag-calibration-instruction') as HTMLTextAreaElement;
  instruction.rows = 3;
  instruction.maxLength = 4_000;
  instruction.placeholder = '예: 결론은 단정적으로 쓰되, 독자에게 지시하는 표현은 부드럽게 써 주세요.';
  instructionLabel.appendChild(instruction);
  const instructionHint = el('p', 'ag-calibration-instruction-hint', '기억한 목소리 위에 별도로 적용됩니다.');
  const resultError = el('div', 'ag-calibration-error');
  resultError.setAttribute('role', 'alert');
  const resultActions = el('div', 'ag-calibration-actions');
  const done = el('button', 'ag-calibration-secondary', '닫기');
  done.type = 'button';
  const addDocuments = el('button', 'ag-calibration-primary', '새 문서 추가');
  addDocuments.type = 'button';
  resultActions.append(done, addDocuments);
  panels[3]!.append(resultIconWrap, resultTitle, resultMeta, resultCorpus, instructionLabel, instructionHint, resultError, resultActions);

  dialog.append(chrome, body);
  overlay.appendChild(dialog);

  function setLanguage(next: WritingStyleLanguage): void {
    language = next;
    for (const [value, button] of languageButtons) {
      const active = value === next;
      button.classList.toggle('ag-selected', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  function setStep(step: number): void {
    dialog.dataset.step = String(step);
    stepLabel.textContent = step === 3 ? '완료' : `${Math.min(step + 1, 3)} / 3`;
    panels.forEach((panel, index) => {
      const active = index === step;
      panel.classList.toggle('ag-active', active);
      panel.setAttribute('aria-hidden', active ? 'false' : 'true');
      panel.inert = !active;
    });
    window.setTimeout(() => {
      const focusTarget = panels[step]?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]');
      focusTarget?.focus();
    }, 180);
  }

  function hasActiveCorpus(): boolean {
    return activeStatus?.active === true && storedCorpusCount(activeStatus) > 0;
  }

  /** 실제 원본이 허브에 남아 있어 append가 가능한 문서 수. */
  function storedCorpusCount(status: WritingStyleStatus): number {
    if (typeof status.savedSourceCount === 'number') return status.savedSourceCount;
    if (status.sources) return status.sources.length;
    if (status.sourceDocuments) return status.sourceDocuments.length;
    return 0;
  }

  /** 구형 프로필도 당시 분석한 파일 수는 결과 화면에 보존한다. */
  function displayCorpusCount(status: WritingStyleStatus): number {
    return storedCorpusCount(status) || status.sourceCount;
  }

  function setCorpusModeButtons(): void {
    for (const [value, button] of corpusModeButtons) {
      const active = value === corpusMode;
      button.classList.toggle('ag-selected', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  function setCorpusMode(mode: CorpusMode): void {
    corpusMode = hasActiveCorpus() ? mode : 'replace';
    setCorpusModeButtons();
    renderUploadContext();
  }

  function renderCorpusList(list: HTMLElement, status: WritingStyleStatus | null): void {
    list.replaceChildren();
    const sources = status?.sources ?? [];
    if (sources.length === 0) {
      const count = status ? displayCorpusCount(status) : 0;
      if (count > 0) {
        const copy = status && storedCorpusCount(status) === 0
          ? `기존 보정은 ${count}개 파일로 분석되었습니다. 저장된 원본은 없습니다.`
          : `${count}개 문서가 보정 자료에 포함되어 있습니다.`;
        list.appendChild(el('li', 'ag-calibration-corpus-fallback', copy));
      }
      return;
    }
    sources.forEach((source) => {
      const item = el('li', 'ag-calibration-corpus-item');
      item.append(el('span', '', source.name));
      if (typeof source.size === 'number') item.append(el('small', '', formatBytes(source.size)));
      list.appendChild(item);
    });
  }

  function renderUploadContext(): void {
    const active = hasActiveCorpus();
    corpusSection.hidden = !active;
    if (active && activeStatus) {
      corpusMeta.textContent = `${storedCorpusCount(activeStatus)}개 · 약 ${activeStatus.pageEstimate}쪽`;
      renderCorpusList(corpusList, activeStatus);
    }
    if (!active) corpusMode = 'replace';
    uploadStatement.textContent = active && corpusMode === 'append'
      ? '현재 보정 자료 위에 새 문서를 더합니다. 직접 쓴 글을 선택해 주세요.'
      : '직접 쓴 글을 총합 10쪽 이상 선택해 주세요.';
    setCorpusModeButtons();
    updateAnalyzeButton();
  }

  function providerAvailability(agent: AgentName): { available: boolean; pending: boolean; label: string; reason: string } {
    if (connectionState !== 'connected') return { available: false, pending: true, label: '연결 대기', reason: '로컬 에이전트 연결을 복구하면 모델을 확인합니다.' };
    const catalogProvider = calibrationCatalog?.providers.find((provider) => provider.id === agent);
    if (catalogProvider) {
      if (!catalogProvider.available) {
        const piReason = agent === 'pi' ? '설정의 Pi 연결에서 OpenRouter 키와 모델을 먼저 선택해 주세요.' : '';
        const rauReason = agent === 'rau' ? '설정의 Rau 카드에서 체험 크레딧을 먼저 연결해 주세요.' : '';
        return { available: false, pending: false, label: (agent === 'pi' || agent === 'rau') ? '설정 필요' : '사용 불가', reason: piReason || rauReason || catalogProvider.error || `${catalogProvider.name} 실행 환경을 찾지 못했습니다.` };
      }
      if (catalogProvider.models.length === 0) return { available: false, pending: false, label: '모델 없음', reason: `${catalogProvider.name}에서 사용할 수 있는 모델이 없습니다.` };
      return { available: true, pending: false, label: '연결됨', reason: '' };
    }
    // 카탈로그가 도착했는데 목록에 없으면 허브가 보정을 돌릴 수 없는 프로바이더다.
    if (calibrationCatalog) return { available: false, pending: false, label: '사용 불가', reason: '글쓰기 보정에 사용할 수 있는 프로바이더가 아닙니다.' };
    const health = providerStatus?.[agent];
    if (!health) return { available: false, pending: true, label: '확인 중', reason: `${AGENT_LABEL[agent]} 연결을 확인하고 있습니다.` };
    if (!health.available) {
      return { available: false, pending: false, label: '사용 불가', reason: health.error || `${AGENT_LABEL[agent]} 실행 환경을 찾지 못했습니다. 설정에서 연결 상태를 확인해 주세요.` };
    }
    if (agent === 'pi') {
      if (!piStatus) return { available: false, pending: true, label: '확인 중', reason: 'Pi 설정과 선택 모델을 확인하고 있습니다.' };
      if (!piStatus.setupComplete) return { available: false, pending: false, label: '설정 필요', reason: '설정의 Pi 연결에서 OpenRouter 키와 모델을 먼저 선택해 주세요.' };
      if (modelsForAgent('pi').length === 0) return { available: false, pending: false, label: '모델 없음', reason: '설정의 Pi 연결에서 분석에 쓸 모델을 선택해 주세요.' };
    }
    return { available: true, pending: false, label: health.version ? `연결됨 · ${health.version}` : '연결됨', reason: '' };
  }

  function calibrationModels(agent: AgentName): Array<{ id: string; label: string }> {
    const provider = calibrationCatalog?.providers.find((entry) => entry.id === agent);
    if (provider) return provider.models.map((model) => ({ id: model.id, label: model.name }));
    // 구형 허브에서는 Studio의 공용 모델 레지스트리를 사용한다. Pi 목록은
    // pi-status가 채우므로 사용자가 설정에서 고른 모델과 정확히 같다.
    return modelsForAgent(agent).map((model) => ({ id: model.id, label: model.label }));
  }

  function selectAgent(agent: AgentName): void {
    if (!providerAvailability(agent).available || requestId || submitting) return;
    selectionTouched = true;
    selectedAgent = agent;
    selectedModel = resolveModelForAgent(agent, agent === prefs.defaultAgent ? prefs.defaultModel : null);
    renderProviderCatalogue();
  }

  function renderProviderSelection(): void {
    const label = modelSelect.selectedOptions[0]?.textContent ?? selectedModel;
    providerSelection.replaceChildren(createProviderIcon(selectedAgent), document.createTextNode(`${AGENT_LABEL[selectedAgent]} · ${label}`));
  }

  function renderProviderCatalogue(): void {
    for (const agent of AGENTS) {
      const button = providerButtons.get(agent)!;
      const health = providerAvailability(agent);
      const active = selectedAgent === agent;
      button.disabled = !health.available || requestId !== null || submitting;
      button.classList.toggle('ag-selected', active);
      button.classList.toggle('ag-pending', health.pending);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
      button.title = health.available ? '' : health.reason;
      providerStatusLabels.get(agent)!.textContent = health.label;
    }

    const options = calibrationModels(selectedAgent);
    const preferredModel = selectedAgent === prefs.defaultAgent ? prefs.defaultModel : null;
    const serverDefault = calibrationCatalog?.defaultSelection?.agent === selectedAgent
      ? calibrationCatalog.defaultSelection.model
      : null;
    if (!options.some((option) => option.id === selectedModel)) {
      selectedModel = options.find((option) => option.id === preferredModel)?.id
        ?? options.find((option) => option.id === serverDefault)?.id
        ?? options[0]?.id
        ?? '';
    }
    modelSelect.replaceChildren();
    if (options.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = selectedAgent === 'pi' ? '설정된 Pi 모델 없음' : '사용 가능한 모델 없음';
      modelSelect.appendChild(option);
      selectedModel = '';
    } else {
      options.forEach((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.label;
        modelSelect.appendChild(option);
      });
      if (!selectedModel) selectedModel = options[0]?.id ?? defaultModelForAgent(selectedAgent);
      modelSelect.value = selectedModel;
    }
    const availability = providerAvailability(selectedAgent);
    modelSelect.disabled = !availability.available || options.length === 0 || requestId !== null || submitting;
    modelHelp.textContent = availability.reason;
    modelHelp.hidden = !availability.reason;
    renderProviderSelection();
    updateAnalyzeButton();
  }

  function updateAnalyzeButton(): void {
    const availability = providerAvailability(selectedAgent);
    const busy = requestId !== null || submitting;
    analyze.disabled = selectedFiles.length === 0 || !availability.available || !selectedModel || busy;
    analyze.textContent = selectedModel
      ? `${labelForModel(selectedAgent, selectedModel)}로 ${corpusMode === 'append' ? '추가 분석' : '분석 시작'}`
      : '분석 시작';
    if (selectedFiles.length === 0) analyze.title = '새로 분석할 파일을 선택해 주세요.';
    else if (!availability.available) analyze.title = availability.reason;
    else if (!selectedModel) analyze.title = '분석할 모델을 선택해 주세요.';
    else analyze.removeAttribute('title');
  }

  function renderFiles(): void {
    fileList.replaceChildren();
    const total = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    fileSummary.textContent = selectedFiles.length ? `새 문서 ${selectedFiles.length}개 · ${formatBytes(total)}` : '선택된 새 파일 없음';
    selectedFiles.forEach((file, index) => {
      const item = el('li', 'ag-calibration-file-item');
      const copy = el('span', 'ag-calibration-file-copy');
      copy.append(el('strong', '', file.name), el('span', '', formatBytes(file.size)));
      const remove = el('button', 'ag-calibration-file-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `${file.name} 제거`);
      remove.append(createCloseIcon());
      remove.addEventListener('click', () => {
        selectedFiles.splice(index, 1);
        renderFiles();
      });
      item.append(copy, remove);
      fileList.appendChild(item);
    });
    updateAnalyzeButton();
  }

  function addFiles(files: File[]): void {
    uploadError.textContent = '';
    for (const file of files) {
      if (!ACCEPTED_EXTENSIONS.includes(fileExtension(file.name))) {
        uploadError.textContent = `${file.name}: 지원하지 않는 파일 형식입니다.`;
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        uploadError.textContent = `${file.name}: 파일 하나는 20 MB 이하여야 합니다.`;
        continue;
      }
      const duplicate = selectedFiles.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified);
      if (!duplicate) selectedFiles.push(file);
    }
    if (selectedFiles.length > MAX_FILES) {
      selectedFiles = selectedFiles.slice(0, MAX_FILES);
      uploadError.textContent = `한 번에 최대 ${MAX_FILES}개까지 올릴 수 있습니다.`;
    }
    while (selectedFiles.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      selectedFiles.pop();
      uploadError.textContent = '전체 파일 용량은 50 MB 이하여야 합니다.';
    }
    renderFiles();
  }

  function progressStage(state: WritingStyleProgressState): { index: number; label: string; detail: string } {
    const index = Math.max(0, PROGRESS_STAGES.findIndex((stage) => stage.state === state));
    const stage = PROGRESS_STAGES[index] ?? PROGRESS_STAGES[0]!;
    return { index, label: stage.label, detail: stage.detail };
  }

  function activateNetwork(level: number): void {
    networkLevel = Math.max(networkLevel, level);
    network.edges.forEach((edge) => {
      const edgeLevel = Number(edge.dataset.level ?? 0);
      edge.classList.toggle('ag-on', edgeLevel <= networkLevel);
      edge.classList.toggle('ag-live', edgeLevel === level);
    });
    network.nodes.forEach((node) => {
      const nodeLevel = Number(node.dataset.level ?? 0);
      node.classList.toggle('ag-on', nodeLevel <= networkLevel);
      node.classList.toggle('ag-live', nodeLevel === level);
    });
  }

  function updateElapsed(): void {
    if (progressStartedAt) elapsed.textContent = formatElapsed(Date.now() - progressStartedAt);
  }

  function startElapsedTimer(): void {
    if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
    elapsedTimer = window.setInterval(updateElapsed, 1_000);
    updateElapsed();
  }

  function stopElapsedTimer(): void {
    if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  function beginProgress(startedAt?: string, elapsedMs?: number): void {
    const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
    progressStartedAt = Number.isFinite(parsed)
      ? parsed
      : Date.now() - Math.max(0, elapsedMs ?? 0);
    if (overlay.isConnected && document.visibilityState === 'visible') startElapsedTimer();
    else stopElapsedTimer();
    activityFeed.replaceChildren();
    networkLevel = 0;
    activateNetwork(0);
    deterministicProgress.hidden = true;
    updateProgressConnection();
  }

  function appendActivity(label: string, detail: string, stageIndex: number): void {
    const previous = activityFeed.lastElementChild as HTMLElement | null;
    if (previous?.dataset.label === label && previous?.dataset.detail === detail) return;
    const item = el('li', 'ag-calibration-activity-item');
    item.dataset.label = label;
    item.dataset.detail = detail;
    item.style.setProperty('--ag-activity-level', String(stageIndex));
    item.append(el('span', 'ag-calibration-activity-dot'), el('strong', '', label), el('span', '', detail));
    activityFeed.appendChild(item);
    while (activityFeed.childElementCount > 7) activityFeed.firstElementChild?.remove();
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    item.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function updateProgress(progress: WritingStyleProgress): void {
    const stage = progressStage(progress.state);
    const activity = localizedActivity(progress.activity, stage.label);
    const detail = localizedDetail(progress.detail, stage.detail);
    progressActivity.textContent = activity;
    progressDetail.textContent = detail;
    const progressAgent = progress.agent ?? selectedAgent;
    progressContext.textContent = `${AGENT_LABEL[progressAgent]} · ${labelForModel(progressAgent, progress.model ?? selectedModel)}`;
    activateNetwork(stage.index);
    appendActivity(activity, detail, stage.index);

    const deterministic = typeof progress.completed === 'number' && typeof progress.total === 'number' && progress.total > 0;
    deterministicProgress.hidden = !deterministic;
    if (deterministic) {
      const completed = Math.min(progress.completed!, progress.total!);
      deterministicProgress.setAttribute('aria-valuemin', '0');
      deterministicProgress.setAttribute('aria-valuemax', String(progress.total));
      deterministicProgress.setAttribute('aria-valuenow', String(completed));
      deterministicFill.style.transform = `scaleX(${completed / progress.total!})`;
      deterministicLabel.textContent = `${completed} / ${progress.total}`;
    }
  }

  function updateProgressConnection(): void {
    progressConnection.hidden = connectionState === 'connected';
    progressConnection.textContent = connectionState === 'replaced'
      ? '다른 탭이 연결을 사용 중입니다. 이 탭을 다시 연결하면 진행 상황을 이어받습니다.'
      : '로컬 에이전트에 다시 연결하고 있습니다. 분석 작업은 허브에서 계속됩니다.';
  }

  function renderResultCorpus(status: WritingStyleStatus): void {
    const meta = resultCorpusHead.querySelector<HTMLElement>('.ag-calibration-corpus-meta');
    if (meta) meta.textContent = `${displayCorpusCount(status)}개 · 약 ${status.pageEstimate}쪽`;
    renderCorpusList(resultCorpusList, status);
  }

  function showResult(status: WritingStyleStatus): void {
    clearRequestTimers();
    submitting = false;
    activeStatus = status;
    requestId = null;
    instructionRequestId = null;
    instructionNextAction = null;
    calibrationBaselineUpdatedAt = status.updatedAt;
    awaitingReconnectCompletion = false;
    language = status.language;
    instruction.value = status.additionalInstruction ?? '';
    resultError.textContent = '';
    done.disabled = false;
    addDocuments.disabled = false;
    replaceCorpus.disabled = false;
    done.textContent = '닫기';
    resultMeta.textContent = `${displayCorpusCount(status)}개 파일 · 약 ${status.pageEstimate}쪽 · ${status.language === 'ko' ? '한국어' : 'English'}`;
    addDocuments.textContent = storedCorpusCount(status) > 0 ? '새 문서 추가' : '새 문서로 교체';
    renderResultCorpus(status);
    setStep(3);
  }

  function clearRequestTimers(): void {
    if (ackTimer !== null) window.clearTimeout(ackTimer);
    if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
    ackTimer = null;
    elapsedTimer = null;
  }

  function failRequest(message: string): void {
    clearRequestTimers();
    requestId = null;
    submitting = false;
    awaitingReconnectCompletion = false;
    setStep(1);
    uploadError.textContent = message;
    renderProviderCatalogue();
  }

  function requestRuntimeStatus(): void {
    if (connectionState !== 'connected') return;
    void bridge.requestProviderStatus();
    void bridge.requestPiStatus();
    void bridge.requestWritingStyleCatalog();
    bridge.requestWritingStyleStatus();
  }

  function open(openOptions?: WritingStyleCalibrationOpenOptions): void {
    if (disposed || overlay.isConnected) return;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.toggle('ag-elevated', openOptions?.elevate === true);
    document.body.appendChild(overlay);
    overlay.setAttribute('aria-hidden', 'false');
    requestRuntimeStatus();
    if (requestId || submitting) {
      setStep(2);
      if (progressStartedAt) startElapsedTimer();
    }
    else if (activeStatus?.active) showResult(activeStatus);
    else setStep(0);
    requestAnimationFrame(() => overlay.classList.add('ag-open'));
  }

  function dismiss(): void {
    if (!overlay.isConnected) return;
    stopElapsedTimer();
    lastFocus?.focus();
    overlay.classList.remove('ag-open');
    overlay.setAttribute('aria-hidden', 'true');
    options?.onDismiss?.({ completed: activeStatus?.active === true });
    window.setTimeout(() => overlay.remove(), 180);
  }

  async function analyzeFiles(): Promise<void> {
    const availability = providerAvailability(selectedAgent);
    if (selectedFiles.length === 0 || !availability.available || !selectedModel || requestId || submitting) return;
    uploadError.textContent = '';
    submitting = true;
    renderProviderCatalogue();
    setStep(2);
    beginProgress();
    updateProgress({ state: 'queued', activity: '분석 요청 준비', detail: `${selectedFiles.length}개 새 문서를 ${AGENT_LABEL[selectedAgent]}에 전달하고 있습니다.`, agent: selectedAgent, model: selectedModel });
    try {
      const files: WritingStyleUpload[] = [];
      for (const file of selectedFiles) {
        const bytes = await readBlobBytesWithLimit(file, MAX_FILE_BYTES, '문체 분석 문서');
        files.push({ name: file.name, type: file.type, size: file.size, content: toBase64(bytes) });
      }
      requestId = bridge.calibrateWritingStyle({ language, files, agent: selectedAgent, model: selectedModel, append: corpusMode === 'append' && hasActiveCorpus() });
      calibrationBaselineUpdatedAt = activeStatus?.updatedAt ?? null;
      awaitingReconnectCompletion = false;
      submitting = false;
      ackTimer = window.setTimeout(() => failRequest('에이전트가 요청을 확인하지 못했습니다. 연결을 복구한 뒤 다시 시도해 주세요.'), ACK_TIMEOUT_MS);
    } catch (error) {
      failRequest(error instanceof Error ? error.message : String(error));
    }
  }

  function beginCorpusUpdate(mode: CorpusMode): void {
    selectedFiles = [];
    renderFiles();
    setCorpusMode(mode);
    setStep(1);
  }

  function saveInstructionThen(nextAction: InstructionNextAction): void {
    if (!activeStatus) return;
    const nextInstruction = instruction.value.trim();
    if (nextInstruction === (activeStatus.additionalInstruction ?? '')) {
      if (nextAction === 'dismiss') dismiss();
      else beginCorpusUpdate(nextAction);
      return;
    }
    if (connectionState !== 'connected') {
      resultError.textContent = '연결을 복구한 뒤 추가 지침을 저장해 주세요.';
      return;
    }
    resultError.textContent = '';
    done.disabled = true;
    addDocuments.disabled = true;
    replaceCorpus.disabled = true;
    instructionNextAction = nextAction;
    instructionRequestId = bridge.setWritingStyleInstruction(nextInstruction);
  }

  function trapFocus(event: KeyboardEvent): void {
    if (!overlay.isConnected) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      .filter((node) => !node.closest('[aria-hidden="true"]'));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onVisibilityChange(): void {
    const visible = document.visibilityState === 'visible';
    network.root.classList.toggle('ag-paused', !visible);
    if (!visible) stopElapsedTimer();
    else if (requestId && overlay.isConnected) startElapsedTimer();
  }

  close.addEventListener('click', dismiss);
  introLater.addEventListener('click', dismiss);
  introNext.addEventListener('click', () => setStep(1));
  uploadBack.addEventListener('click', () => setStep(hasActiveCorpus() ? 3 : 0));
  analyze.addEventListener('click', () => { void analyzeFiles(); });
  modelSelect.addEventListener('change', () => {
    selectionTouched = true;
    selectedModel = resolveModelForAgent(selectedAgent, modelSelect.value);
    renderProviderSelection();
    updateAnalyzeButton();
  });
  instruction.addEventListener('input', () => {
    done.textContent = instruction.value.trim() === (activeStatus?.additionalInstruction ?? '') ? '닫기' : '지침 저장';
  });
  done.addEventListener('click', () => saveInstructionThen('dismiss'));
  addDocuments.addEventListener('click', () => saveInstructionThen('append'));
  replaceCorpus.addEventListener('click', () => saveInstructionThen('replace'));
  uploadInput.addEventListener('change', () => {
    addFiles([...(uploadInput.files ?? [])]);
    uploadInput.value = '';
  });
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      uploadInput.click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('ag-dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('ag-dragging');
    });
  }
  dropzone.addEventListener('drop', (event) => addFiles([...(event.dataTransfer?.files ?? [])]));
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) dismiss();
  });
  document.addEventListener('keydown', trapFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);

  setLanguage(language);
  setCorpusModeButtons();
  renderUploadContext();
  renderFiles();
  renderProviderCatalogue();
  requestRuntimeStatus();

  return {
    open,
    handleEvent(event: SidebarEvent): void {
      if (event.type === 'connection') {
        connectionState = event.state;
        if (requestId && event.state !== 'connected') {
          awaitingReconnectCompletion = true;
          if (ackTimer !== null) window.clearTimeout(ackTimer);
          ackTimer = null;
        } else if (event.state === 'connected') {
          requestRuntimeStatus();
        }
        updateProgressConnection();
        renderProviderCatalogue();
        return;
      }
      if (event.type === 'provider-status') {
        providerStatus = event.providers;
        renderProviderCatalogue();
        return;
      }
      if (event.type === 'pi-status') {
        piStatus = event.status;
        if (selectedAgent === 'pi') selectedModel = resolveModelForAgent('pi', selectedModel || event.status.defaultModelId);
        renderProviderCatalogue();
        return;
      }
      if (event.type === 'writing-style-catalog') {
        calibrationCatalog = event.catalog;
        if (!selectionTouched && event.catalog.defaultSelection) {
          const selection = event.catalog.defaultSelection;
          const provider = event.catalog.providers.find((entry) => entry.id === selection.agent && entry.available);
          if (provider?.models.some((model) => model.id === selection.model)) {
            selectedAgent = selection.agent;
            selectedModel = selection.model;
          }
        }
        // 기본 프로바이더가 보정 대상이 아니면(예: 문서 편집용으로만 쓰는 CLI)
        // 아직 손대지 않은 선택은 쓸 수 있는 첫 프로바이더로 옮긴다.
        if (!selectionTouched && !providerAvailability(selectedAgent).available) {
          const fallback = AGENTS.find((agent) => providerAvailability(agent).available);
          if (fallback) {
            selectedAgent = fallback;
            selectedModel = resolveModelForAgent(
              fallback,
              fallback === prefs.defaultAgent ? prefs.defaultModel : null,
            );
          }
        }
        renderProviderCatalogue();
        return;
      }
      if (event.type === 'writing-style-status') {
        activeStatus = event.status;
        if (event.status.active) {
          language = event.status.language;
          setLanguage(language);
          if (!requestId && !submitting) corpusMode = 'append';
        }
        renderUploadContext();
        if (
          requestId
          && event.status.active
          && event.status.updatedAt !== calibrationBaselineUpdatedAt
          && awaitingReconnectCompletion
        ) {
          showResult(event.status);
          renderProviderCatalogue();
          return;
        }
        if (instructionRequestId && event.requestId === instructionRequestId) {
          const nextAction = instructionNextAction;
          instructionRequestId = null;
          instructionNextAction = null;
          done.disabled = false;
          addDocuments.disabled = false;
          replaceCorpus.disabled = false;
          if (nextAction === 'dismiss') dismiss();
          else if (nextAction) beginCorpusUpdate(nextAction);
        }
        return;
      }
      if (event.type === 'writing-style-progress') {
        if (!event.requestId || (requestId && event.requestId !== requestId)) return;
        if (!requestId) {
          // 연결 직후 허브가 재생한 실행 중 작업을 이어받아 중복 분석을 막는다.
          requestId = event.requestId;
          submitting = false;
          if (!progressStartedAt) beginProgress(event.startedAt, event.elapsedMs);
          if (overlay.isConnected) setStep(2);
        }
        if (ackTimer !== null) window.clearTimeout(ackTimer);
        ackTimer = null;
        if (!progressStartedAt) beginProgress(event.startedAt, event.elapsedMs);
        updateProgress(event);
        renderProviderCatalogue();
        return;
      }
      if (event.type === 'writing-style-result' && event.requestId === requestId) {
        showResult(event.status);
        renderProviderCatalogue();
        return;
      }
      if (event.type === 'writing-style-error' && event.requestId === requestId) {
        failRequest(errorCopy(event.code, event.message));
        uploadError.title = event.message;
        return;
      }
      if (event.type === 'writing-style-error' && event.requestId === instructionRequestId) {
        instructionRequestId = null;
        instructionNextAction = null;
        done.disabled = false;
        addDocuments.disabled = false;
        replaceCorpus.disabled = false;
        resultError.textContent = event.message || '추가 지침을 저장하지 못했습니다.';
      }
    },
    dispose(): void {
      disposed = true;
      clearRequestTimers();
      document.removeEventListener('keydown', trapFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      overlay.remove();
    },
  };
}
