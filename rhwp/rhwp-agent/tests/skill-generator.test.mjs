import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSkillDraft } from '../skill-generator.mjs';

function skillMarkdown(name = 'draft-skill') {
  return `---\nname: ${name}\ndescription: Test draft validation\n---\n\nFollow these instructions.`;
}

test('generated skill drafts use canonical root path and frontmatter validation', () => {
  assert.deepEqual(validateSkillDraft({
    name: 'draft-skill',
    files: [
      { path: './SKILL.md', content: skillMarkdown() },
      { path: 'references//guide.md', content: 'Guide' },
    ],
  }), {
    name: 'draft-skill',
    files: [
      { path: 'SKILL.md', content: skillMarkdown() },
      { path: 'references/guide.md', content: 'Guide' },
    ],
  });

  const malformed = [
    {
      label: 'nested SKILL.md',
      files: [{ path: 'nested/SKILL.md', content: skillMarkdown() }],
      error: /SKILL\.md is required/,
    },
    {
      label: 'absolute path',
      files: [{ path: '/tmp/SKILL.md', content: skillMarkdown() }],
      error: /Invalid skill file path/,
    },
    {
      label: 'Windows absolute path',
      files: [{ path: 'C:/temp/SKILL.md', content: skillMarkdown() }],
      error: /Invalid skill file path/,
    },
    {
      label: 'backslash path',
      files: [{ path: 'nested\\SKILL.md', content: skillMarkdown() }],
      error: /Invalid skill file path/,
    },
    {
      label: 'internal traversal',
      files: [{ path: 'nested/../SKILL.md', content: skillMarkdown() }],
      error: /cannot contain traversal/,
    },
    {
      label: 'normalized duplicate',
      files: [
        { path: 'SKILL.md', content: skillMarkdown() },
        { path: 'references//guide.md', content: 'One' },
        { path: 'references/guide.md', content: 'Two' },
      ],
      error: /Duplicate skill file paths/,
    },
    {
      label: 'Windows case alias',
      files: [
        { path: 'SKILL.md', content: skillMarkdown() },
        { path: 'skill.md', content: 'overwrite' },
      ],
      error: /platform-aliased paths/,
    },
    {
      label: 'Windows nested case alias',
      files: [
        { path: 'SKILL.md', content: skillMarkdown() },
        { path: 'references/Guide.md', content: 'One' },
        { path: 'references/guide.md', content: 'Two' },
      ],
      error: /platform-aliased paths/,
    },
    {
      label: 'Windows trailing-dot alias',
      files: [
        { path: 'SKILL.md', content: skillMarkdown() },
        { path: 'references/guide.md.', content: 'No' },
      ],
      error: /not portable/,
    },
    {
      label: 'Windows alternate data stream',
      files: [
        { path: 'SKILL.md', content: skillMarkdown() },
        { path: 'references/guide.md:secret', content: 'No' },
      ],
      error: /not portable/,
    },
    {
      label: 'Windows DOS device name',
      files: [
        { path: 'SKILL.md', content: skillMarkdown() },
        { path: 'references/CON.txt', content: 'No' },
      ],
      error: /not portable/,
    },
    {
      label: 'frontmatter name mismatch',
      files: [{ path: 'SKILL.md', content: skillMarkdown('different-skill') }],
      error: /must match folder "draft-skill"/,
    },
    {
      label: 'missing frontmatter',
      files: [{ path: 'SKILL.md', content: 'Follow these instructions.' }],
      error: /must start with YAML frontmatter/,
    },
  ];

  for (const entry of malformed) {
    assert.throws(
      () => validateSkillDraft({ name: 'draft-skill', files: entry.files }),
      entry.error,
      entry.label,
    );
  }
});
