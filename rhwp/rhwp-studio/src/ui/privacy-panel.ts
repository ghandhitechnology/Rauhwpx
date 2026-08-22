/**
 * 보안·개인정보 안내 DOM.
 * 환경 설정 탭과 에이전트 설정이 같은 문구를 그린다.
 */
import {
  buildPrivacyDisclosure,
  type PrivacyDisclosure,
  type PrivacySnapshot,
} from '../core/privacy-disclosure.ts';

export function renderPrivacyDisclosure(root: HTMLElement, disclosure: PrivacyDisclosure): void {
  root.replaceChildren();
  root.classList.add('privacy-disclosure');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', '보안과 개인정보');

  const lead = document.createElement('p');
  lead.className = 'privacy-disclosure-lead';
  lead.textContent = disclosure.lead;
  root.appendChild(lead);

  for (const section of disclosure.sections) {
    const block = document.createElement('section');
    block.className = 'privacy-disclosure-section';
    block.dataset.privacy = section.id;
    const title = document.createElement('h3');
    title.className = 'privacy-disclosure-title';
    title.textContent = section.title;
    const body = document.createElement('p');
    body.className = 'privacy-disclosure-body';
    body.textContent = section.body;
    block.append(title, body);
    root.appendChild(block);
  }
}

export function renderPrivacySnapshot(root: HTMLElement, snapshot: PrivacySnapshot): PrivacyDisclosure {
  const disclosure = buildPrivacyDisclosure(snapshot);
  renderPrivacyDisclosure(root, disclosure);
  return disclosure;
}
