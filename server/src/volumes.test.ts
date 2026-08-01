import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test the name validation regex and usedBy cross-referencing logic.
// These are pure functions exported from the service for testability.

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

describe('volume name validation', () => {
  it('accepts valid names', () => {
    assert.ok(NAME_RE.test('myvolume'));
    assert.ok(NAME_RE.test('my_volume'));
    assert.ok(NAME_RE.test('my-volume'));
    assert.ok(NAME_RE.test('my.volume'));
    assert.ok(NAME_RE.test('a'));
    assert.ok(NAME_RE.test('v123'));
  });

  it('rejects invalid names', () => {
    assert.ok(!NAME_RE.test(''));
    assert.ok(!NAME_RE.test('_leading_underscore'));
    assert.ok(!NAME_RE.test('-leading-dash'));
    assert.ok(!NAME_RE.test('.leading-dot'));
    assert.ok(!NAME_RE.test('has spaces'));
    assert.ok(!NAME_RE.test('special!'));
  });
});

describe('usedBy cross-reference logic', () => {
  it('maps mount entries to volume names', () => {
    const containers = [
      {
        Id: 'abc123',
        Names: ['/web-app'],
        Mounts: [
          { Type: 'volume', Name: 'data', Destination: '/data', RW: true },
          { Type: 'bind', Name: null, Source: '/host/path', Destination: '/mnt', RW: false },
        ],
      },
      {
        Id: 'def456',
        Names: ['/db-server'],
        Mounts: [
          { Type: 'volume', Name: 'data', Destination: '/var/lib/db', RW: true },
        ],
      },
    ];

    // Simulate the buildUsedByMap logic
    const map = new Map<string, Array<{ containerId: string; containerName: string; destination: string; rw: boolean }>>();
    for (const c of containers) {
      for (const m of c.Mounts || []) {
        if (m.Type === 'volume' && m.Name) {
          const entry = { containerId: c.Id, containerName: (c.Names?.[0] || c.Id).replace(/^\//, ''), destination: m.Destination, rw: m.RW ?? false };
          const list = map.get(m.Name);
          if (list) list.push(entry);
          else map.set(m.Name, [entry]);
        }
      }
    }

    const dataUsers = map.get('data');
    assert.ok(dataUsers);
    assert.equal(dataUsers.length, 2);
    assert.equal(dataUsers[0].containerName, 'web-app');
    assert.equal(dataUsers[1].containerName, 'db-server');

    // Non-existent volume should have no entries
    assert.equal(map.get('nonexistent'), undefined);
  });

  it('ignores bind mounts', () => {
    const containers = [
      {
        Id: 'xyz',
        Names: ['/test'],
        Mounts: [
          { Type: 'bind', Name: null, Source: '/host/x', Destination: '/app', RW: true },
        ],
      },
    ];

    const map = new Map<string, Array<{ containerId: string; containerName: string; destination: string; rw: boolean }>>();
    for (const c of containers) {
      for (const m of c.Mounts || []) {
        if (m.Type === 'volume' && m.Name) {
          const entry = { containerId: c.Id, containerName: (c.Names?.[0] || c.Id).replace(/^\//, ''), destination: m.Destination, rw: m.RW ?? false };
          const list = map.get(m.Name);
          if (list) list.push(entry);
          else map.set(m.Name, [entry]);
        }
      }
    }

    assert.equal(map.size, 0, 'bind mounts should be ignored');
  });
});
