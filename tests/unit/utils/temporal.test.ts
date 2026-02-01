import {
  isFactCurrent,
  isWithinDateRange,
  isOlderThanDays,
  temporalRangesOverlap,
  resolveContradiction,
  nowIso,
} from '../../../src/utils/temporal';

describe('temporal utilities', () => {
  describe('isWithinDateRange', () => {
    const date = '2026-01-15T12:00:00.000Z';

    it('returns true when date is within range', () => {
      expect(isWithinDateRange(date, '2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.999Z')).toBe(
        true,
      );
    });

    it('returns false when date is before range', () => {
      expect(isWithinDateRange(date, '2026-01-20T00:00:00.000Z', '2026-01-31T23:59:59.999Z')).toBe(
        false,
      );
    });

    it('returns false when date is after range', () => {
      expect(isWithinDateRange(date, '2026-01-01T00:00:00.000Z', '2026-01-10T23:59:59.999Z')).toBe(
        false,
      );
    });

    it('returns true when only from is specified and date is after', () => {
      expect(isWithinDateRange(date, '2026-01-01T00:00:00.000Z')).toBe(true);
    });

    it('returns false when only from is specified and date is before', () => {
      expect(isWithinDateRange(date, '2026-02-01T00:00:00.000Z')).toBe(false);
    });

    it('returns true when only to is specified and date is before', () => {
      expect(isWithinDateRange(date, undefined, '2026-01-31T23:59:59.999Z')).toBe(true);
    });

    it('returns false when only to is specified and date is after', () => {
      expect(isWithinDateRange(date, undefined, '2026-01-10T00:00:00.000Z')).toBe(false);
    });

    it('returns true when both from and to are undefined', () => {
      expect(isWithinDateRange(date)).toBe(true);
    });

    it('returns false when dateStr is null', () => {
      expect(isWithinDateRange(null, '2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.999Z')).toBe(
        false,
      );
    });

    it('handles exact boundary (date equals from)', () => {
      expect(isWithinDateRange(date, date, '2026-01-31T23:59:59.999Z')).toBe(true);
    });

    it('handles exact boundary (date equals to)', () => {
      expect(isWithinDateRange(date, '2026-01-01T00:00:00.000Z', date)).toBe(true);
    });
  });

  describe('isFactCurrent', () => {
    it('returns true for active edge (no expired_at, no invalid_at)', () => {
      expect(isFactCurrent({ expired_at: null, invalid_at: null })).toBe(true);
    });

    it('returns false for expired edge', () => {
      expect(isFactCurrent({ expired_at: '2026-01-01T00:00:00.000Z', invalid_at: null })).toBe(
        false,
      );
    });

    it('returns false for invalidated edge in the past', () => {
      expect(isFactCurrent({ expired_at: null, invalid_at: '2020-01-01T00:00:00.000Z' })).toBe(
        false,
      );
    });

    it('returns true for edge with future invalid_at', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      expect(isFactCurrent({ expired_at: null, invalid_at: future })).toBe(true);
    });
  });

  describe('nowIso', () => {
    it('returns a valid ISO string', () => {
      const result = nowIso();
      expect(() => new Date(result)).not.toThrow();
      expect(new Date(result).toISOString()).toBe(result);
    });
  });
});
