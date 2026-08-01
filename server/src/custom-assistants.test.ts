import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('custom assistant tests', () => {
  it('SYSTEM has correct blank-line separator between persona and core', async () => {
    const { SYSTEM } = await import('./routes/assistant.js');
    assert.ok(
      SYSTEM.includes('resolve the name to an ID.\n\nA knowledge base bucket'),
      'SYSTEM must have double-newline separating persona from core',
    );
    assert.ok(
      !SYSTEM.includes('to an ID.A knowledge'),
      'SYSTEM must NOT fuse persona into core without separator',
    );
  });

  it('append-mode assistants start from base SYSTEM, not fused', async () => {
    const { SYSTEM } = await import('./routes/assistant.js');
    const composed = SYSTEM + '\n\n## Custom instructions for this assistant\nBe helpful.';
    assert.ok(
      composed.startsWith('You are the Dockyard.ai assistant.'),
      'Append mode starts with persona',
    );
    assert.ok(
      composed.includes('resolve the name to an ID.\n\nA knowledge base bucket'),
      'Append mode preserves blank-line between persona and core',
    );
    assert.ok(
      composed.endsWith('Be helpful.'),
      'Custom instructions appended at end',
    );
  });
});
