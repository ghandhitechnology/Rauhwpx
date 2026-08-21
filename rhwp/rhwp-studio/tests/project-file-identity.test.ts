import test from 'node:test';
import assert from 'node:assert/strict';

import type { FileSystemFileHandleLike } from '../src/command/file-system-access.ts';
import {
  judgeCandidate,
  type CandidateFacts,
  type DocumentDigest,
  type IdentityVerdict,
  type ProjectFileClaim,
} from '../src/project-file/identity.ts';

const DIGEST_A = 'blake3:aaa' as const satisfies DocumentDigest;
const DIGEST_B = 'blake3:bbb' as const satisfies DocumentDigest;

function claim(overrides: Partial<ProjectFileClaim> = {}): ProjectFileClaim {
  return {
    documentId: 'doc-1',
    displayName: '보고서.hwp',
    knownDigest: DIGEST_A,
    liveHandle: null,
    recentId: 'r1',
    ...overrides,
  };
}

function facts(overrides: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    digest: DIGEST_A,
    entry: 'uncomparable',
    location: 'unknown',
    ...overrides,
  };
}

function handle(name: string): FileSystemFileHandleLike {
  return { kind: 'file', name } as FileSystemFileHandleLike;
}

const cases: readonly {
  name: string;
  claim: ProjectFileClaim;
  facts: CandidateFacts;
  expected: IdentityVerdict;
}[] = [
  {
    name: '같은 엔트리면 위치·바이트와 무관하게 확인한다',
    claim: claim({ liveHandle: handle('보고서.hwp'), knownDigest: DIGEST_B }),
    facts: facts({ entry: 'same', location: 'not-remembered', digest: DIGEST_B }),
    expected: { kind: 'confirmed', evidence: 'same-entry' },
  },
  {
    name: '엔트리가 다르면 digest가 같아도 거절한다',
    claim: claim({ liveHandle: handle('보고서.hwp') }),
    facts: facts({ entry: 'different', location: 'remembered', digest: DIGEST_A }),
    expected: { kind: 'refuted', by: 'handle-comparison' },
  },
  {
    name: '엔트리가 다르면 기억된 위치여도 거절한다',
    claim: claim(),
    facts: facts({ entry: 'different', location: 'remembered', digest: DIGEST_B }),
    expected: { kind: 'refuted', by: 'handle-comparison' },
  },
  {
    name: '기억된 위치는 바이트가 달라도 제자리 편집으로 확인한다',
    claim: claim({ knownDigest: DIGEST_A }),
    facts: facts({ entry: 'uncomparable', location: 'remembered', digest: DIGEST_B }),
    expected: { kind: 'confirmed', evidence: 'same-location' },
  },
  {
    name: '기억된 위치는 알려진 digest가 없어도 확인한다',
    claim: claim({ knownDigest: null }),
    facts: facts({ entry: 'uncomparable', location: 'remembered', digest: DIGEST_B }),
    expected: { kind: 'confirmed', evidence: 'same-location' },
  },
  {
    name: 'digest가 이 claim의 알려진 값과 같으면 확인한다',
    claim: claim({ knownDigest: DIGEST_A }),
    facts: facts({ entry: 'uncomparable', location: 'not-remembered', digest: DIGEST_A }),
    expected: { kind: 'confirmed', evidence: 'same-bytes' },
  },
  {
    name: '위치가 미지여도 digest가 같으면 확인한다',
    claim: claim({ knownDigest: DIGEST_A }),
    facts: facts({ entry: 'uncomparable', location: 'unknown', digest: DIGEST_A }),
    expected: { kind: 'confirmed', evidence: 'same-bytes' },
  },
  {
    name: '알려진 digest가 없으면 미확정이다',
    claim: claim({ knownDigest: null }),
    facts: facts({ entry: 'uncomparable', location: 'not-remembered', digest: DIGEST_A }),
    expected: { kind: 'inconclusive', why: 'no-known-digest' },
  },
  {
    name: 'digest가 다르면 미확정이다',
    claim: claim({ knownDigest: DIGEST_A }),
    facts: facts({ entry: 'uncomparable', location: 'not-remembered', digest: DIGEST_B }),
    expected: { kind: 'inconclusive', why: 'bytes-differ' },
  },
  {
    name: '위치가 미지고 digest가 달라도 미확정이다',
    claim: claim({ knownDigest: DIGEST_A }),
    facts: facts({ entry: 'uncomparable', location: 'unknown', digest: DIGEST_B }),
    expected: { kind: 'inconclusive', why: 'bytes-differ' },
  },
  {
    name: '파일명은 판정에 쓰이지 않는다',
    claim: claim({ displayName: '다른이름.hwp', knownDigest: DIGEST_A }),
    facts: facts({
      entry: 'uncomparable',
      location: 'not-remembered',
      digest: DIGEST_B,
    }),
    expected: { kind: 'inconclusive', why: 'bytes-differ' },
  },
];

for (const row of cases) {
  test(row.name, () => {
    assert.deepEqual(judgeCandidate(row.claim, row.facts), row.expected);
  });
}
