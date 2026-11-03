import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Small, fast-to-test values — must be set before the dynamic import below.
// A static top-level `import` is hoisted above plain statements in ESM, so
// setting process.env here wouldn't apply by the time a static import of
// lambdaGuard.ts evaluates its module-scoped consts; a dynamic import runs
// in textual order, after these assignments (same pattern as gatewayAudit.test.ts).
process.env.LAMBDA_RATE_LIMIT_MAX = '3';
process.env.LAMBDA_RATE_LIMIT_WINDOW_MS = '200';
process.env.LAMBDA_MAX_CONCURRENT = '2';

const {
  checkRateLimit,
  acquireLambdaSlot,
  reapOrphanedLambdaContainers,
  _resetForTest,
} = await import('./lambdaGuard.js');

describe('checkRateLimit', () => {
  beforeEach(() => _resetForTest());

  it('allows requests up to the max within the window', () => {
    assert.equal(checkRateLimit('1.2.3.4'), true);
    assert.equal(checkRateLimit('1.2.3.4'), true);
    assert.equal(checkRateLimit('1.2.3.4'), true);
  });

  it('rejects once the max is exceeded within the window', () => {
    checkRateLimit('5.6.7.8');
    checkRateLimit('5.6.7.8');
    checkRateLimit('5.6.7.8');
    assert.equal(checkRateLimit('5.6.7.8'), false);
  });

  it('tracks each IP independently', () => {
    checkRateLimit('1.1.1.1');
    checkRateLimit('1.1.1.1');
    checkRateLimit('1.1.1.1');
    assert.equal(checkRateLimit('1.1.1.1'), false);
    // A different IP still has its own fresh budget.
    assert.equal(checkRateLimit('2.2.2.2'), true);
  });

  it('recovers once the window elapses', async () => {
    checkRateLimit('9.9.9.9');
    checkRateLimit('9.9.9.9');
    checkRateLimit('9.9.9.9');
    assert.equal(checkRateLimit('9.9.9.9'), false);

    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(checkRateLimit('9.9.9.9'), true);
  });
});

describe('acquireLambdaSlot', () => {
  beforeEach(() => _resetForTest());

  it('grants slots up to the concurrency cap immediately', async () => {
    const release1 = await acquireLambdaSlot();
    const release2 = await acquireLambdaSlot();
    assert.equal(typeof release1, 'function');
    assert.equal(typeof release2, 'function');
    release1();
    release2();
  });

  it('queues a waiter past the cap and resolves it once a slot is released', async () => {
    const release1 = await acquireLambdaSlot();
    await acquireLambdaSlot(); // fills the cap (MAX_CONCURRENT=2)

    let thirdResolved = false;
    const thirdPromise = acquireLambdaSlot().then((release) => {
      thirdResolved = true;
      release();
    });

    // Give the event loop a tick — the third caller should still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(thirdResolved, false);

    release1();
    await thirdPromise;
    assert.equal(thirdResolved, true);
  });

  it('rejects a waiter that cannot get a slot before the acquire timeout', async () => {
    await acquireLambdaSlot();
    await acquireLambdaSlot(); // cap is full; both slots held, never released

    await assert.rejects(() => acquireLambdaSlot(), /capacity/i);
  });
});

describe('reapOrphanedLambdaContainers', () => {
  function mockDocker(containers: Array<{ Id: string; State: string; Created: number }>) {
    const removed: string[] = [];
    return {
      removed,
      client: {
        listContainers: async () => containers,
        getContainer: (id: string) => ({
          remove: async () => {
            removed.push(id);
          },
        }),
      },
    };
  }

  it('removes stopped ephemeral containers past the grace period', async () => {
    const oldEnough = Math.floor(Date.now() / 1000) - 60; // 60s old
    const { client, removed } = mockDocker([
      { Id: 'dead-1', State: 'exited', Created: oldEnough },
    ]);
    const count = await reapOrphanedLambdaContainers(client);
    assert.equal(count, 1);
    assert.deepEqual(removed, ['dead-1']);
  });

  it('leaves running containers alone regardless of age', async () => {
    const oldEnough = Math.floor(Date.now() / 1000) - 60;
    const { client, removed } = mockDocker([
      { Id: 'running-1', State: 'running', Created: oldEnough },
    ]);
    const count = await reapOrphanedLambdaContainers(client);
    assert.equal(count, 0);
    assert.deepEqual(removed, []);
  });

  it('leaves recently-created stopped containers alone (grace period)', async () => {
    const justNow = Math.floor(Date.now() / 1000);
    const { client, removed } = mockDocker([
      { Id: 'fresh-1', State: 'created', Created: justNow },
    ]);
    const count = await reapOrphanedLambdaContainers(client);
    assert.equal(count, 0);
    assert.deepEqual(removed, []);
  });
});
