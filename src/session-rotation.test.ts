import { describe, it, expect } from 'vitest';

import { shouldRotateSession } from './session-rotation.js';

describe('shouldRotateSession', () => {
  const NOW = 1_000_000_000_000;
  const MIN = 60_000;

  it('rotates when lastTurnAt is null (first turn ever)', () => {
    expect(shouldRotateSession(null, NOW, 15)).toBe(true);
  });

  it('does not rotate when elapsed < timeout', () => {
    expect(shouldRotateSession(NOW - 1 * MIN, NOW, 15)).toBe(false);
  });

  it('does not rotate when elapsed equals timeout exactly', () => {
    expect(shouldRotateSession(NOW - 15 * MIN, NOW, 15)).toBe(false);
  });

  it('rotates when elapsed > timeout', () => {
    expect(shouldRotateSession(NOW - 16 * MIN, NOW, 15)).toBe(true);
  });

  it('rotates after a long gap', () => {
    expect(shouldRotateSession(NOW - 24 * 60 * MIN, NOW, 15)).toBe(true);
  });

  it('respects a custom timeout', () => {
    expect(shouldRotateSession(NOW - 5 * MIN, NOW, 10)).toBe(false);
    expect(shouldRotateSession(NOW - 11 * MIN, NOW, 10)).toBe(true);
  });
});
