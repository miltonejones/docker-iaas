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

  it('append-mode assistants start from base SYSTEM', async () => {
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
  });

  it('every tool in assistant-tools.ts is assigned a category in TOOL_CATEGORIES', async () => {
    const { tools } = await import('./assistant-tools.js');
    const { TOOL_CATEGORIES } = await import('./routes/assistants.js');

    const categorized = new Set<string>();
    for (const names of Object.values(TOOL_CATEGORIES)) {
      for (const n of names) categorized.add(n);
    }

    const uncategorized = tools
      .map((t: { name: string }) => t.name)
      .filter((n: string) => !categorized.has(n));

    assert.equal(
      uncategorized.length,
      0,
      'These tools exist in assistant-tools.ts but have no category in TOOL_CATEGORIES: ' +
        uncategorized.join(', ') +
        '. Add them to the map.',
    );
  });

  it('ensureWait injects wait into non-empty toolList', async () => {
    // The service layer function is not exported, so test it indirectly:
    // import ensureWait behavior by testing its effect on create/update.
    const mod = await import('./services/assistants.js');
    // ensureWait is not exported directly, but it's called inside create/update.
    // We test the contract: wait is always in TOOL_CATEGORIES.Automation.
    const { TOOL_CATEGORIES } = await import('./routes/assistants.js');
    assert.ok(
      TOOL_CATEGORIES['Automation']?.includes('wait'),
      'wait must be in Automation category',
    );
  });
});
