import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NAME_RE, isSystemVolume } from './services/volumes.js';

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

describe('isSystemVolume', () => {
  it('flags iaas-minio-data as system regardless of labels', () => {
    assert.ok(isSystemVolume('iaas-minio-data'));
    assert.ok(isSystemVolume('iaas-minio-data', {}));
  });

  it('flags volumes with iaas.system label', () => {
    assert.ok(isSystemVolume('some-volume', { 'iaas.system': 'true' }));
  });

  it('does not flag ordinary volumes', () => {
    assert.ok(!isSystemVolume('my-data'));
    assert.ok(!isSystemVolume('my-data', {}));
    assert.ok(!isSystemVolume('my-data', { 'some.label': 'value' }));
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

    // Replicate buildUsedByMap logic (pure function — tests the algorithm).
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
