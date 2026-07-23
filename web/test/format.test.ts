import { describe, it, expect } from 'vitest';
import { bytes, timeAgo } from '../src/format';

// ---------------------------------------------------------------------------
// bytes — human-readable byte formatting
// ---------------------------------------------------------------------------

describe('bytes', () => {
  it('formats zero', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(null)).toBe('0 B');
    expect(bytes(undefined)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(bytes(1)).toBe('1 B');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1023)).toBe('1023 B');
  });

  it('formats kilobytes', () => {
    expect(bytes(1024)).toBe('1.0 KB');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(1024 * 10)).toBe('10 KB');
  });

  it('formats megabytes', () => {
    expect(bytes(1024 * 1024)).toBe('1.0 MB');
    expect(bytes(1024 * 1024 * 2.5)).toBe('2.5 MB');
  });

  it('formats gigabytes', () => {
    expect(bytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(bytes(1024 * 1024 * 1024 * 3.2)).toBe('3.2 GB');
  });

  it('formats terabytes', () => {
    expect(bytes(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB');
  });

  it('handles negative values', () => {
    expect(bytes(-1)).toBe('0 B');
    expect(bytes(-500)).toBe('0 B');
  });
});

// ---------------------------------------------------------------------------
// timeAgo — relative time formatting
// ---------------------------------------------------------------------------

describe('timeAgo', () => {
  it('returns "just now" for recent timestamps', () => {
    const now = Date.now() / 1000;
    expect(timeAgo(now)).toBe('just now');
    expect(timeAgo(now - 30)).toBe('just now');
    expect(timeAgo(now - 59)).toBe('just now');
  });

  it('returns minutes', () => {
    const now = Date.now() / 1000;
    expect(timeAgo(now - 60)).toBe('1m ago');
    expect(timeAgo(now - 120)).toBe('2m ago');
    expect(timeAgo(now - 3599)).toBe('59m ago');
  });

  it('returns hours', () => {
    const now = Date.now() / 1000;
    expect(timeAgo(now - 3600)).toBe('1h ago');
    expect(timeAgo(now - 7200)).toBe('2h ago');
    expect(timeAgo(now - 86399)).toBe('23h ago');
  });

  it('returns days', () => {
    const now = Date.now() / 1000;
    expect(timeAgo(now - 86400)).toBe('1d ago');
    expect(timeAgo(now - 86400 * 7)).toBe('7d ago');
    expect(timeAgo(now - 86400 * 365)).toBe('365d ago');
  });

  it('handles future timestamps gracefully', () => {
    const future = Date.now() / 1000 + 3600;
    expect(timeAgo(future)).toBe('just now');
  });
});
