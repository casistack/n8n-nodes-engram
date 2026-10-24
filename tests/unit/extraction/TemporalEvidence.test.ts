import { resolveTemporalDay } from '../../../src/extraction/TemporalEvidence';
describe('source-anchored temporal evidence', () => {
  it('resolves against the original source day, not the worker date', () => {
    expect(resolveTemporalDay('Watch a game tomorrow', '2026-04-09T12:00:00Z', 'UTC')).toEqual({
      status: 'resolved',
      start: '2026-04-10T00:00:00.000Z',
      end: '2026-04-11T00:00:00.000Z',
      precision: 'day',
    });
  });
  it.each([
    ['2026-03-28T12:00:00Z', '2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z'],
    ['2026-10-24T12:00:00Z', '2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z'],
  ])('uses the explicit London calendar through DST for %s', (source, start, end) => {
    expect(resolveTemporalDay('Watch a game tomorrow', source, 'Europe/London')).toEqual({
      status: 'resolved',
      start,
      end,
      precision: 'day',
    });
  });
  it.each([
    ['next Tuesday', '2026-04-09T12:00:00Z', 'UTC'],
    ['tomorrow', '2026-04-09T12:00:00Z', undefined],
    ['today or tomorrow', '2026-04-09T12:00:00Z', 'UTC'],
    ['tomorrow on 2026-04-20', '2026-04-09T12:00:00Z', 'UTC'],
    ['on 2026-02-30', undefined, 'UTC'],
    ['on 2026-04-10 and 2026-04-11', undefined, 'UTC'],
    ['on 2011-12-30', undefined, 'Pacific/Apia'],
  ])('retains ambiguity for %s', (text, source, zone) =>
    expect(resolveTemporalDay(text, source, zone)).toEqual({ status: 'uncertain' }),
  );
});
