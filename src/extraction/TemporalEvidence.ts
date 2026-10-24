import type { ResolvedDay } from '../schemas/ExtractionPolicy.schema';
/** Calendar-day evidence only; recording time never substitutes for an unresolved event. */
export function resolveTemporalDay(
  text: string,
  referenceTime: string | undefined,
  timeZone: string | undefined,
): ResolvedDay {
  if (!timeZone) return { status: 'uncertain' };
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = (time: number) => {
      const value: Record<string, number> = {};
      for (const part of formatter.formatToParts(new Date(time)))
        if (part.type !== 'literal') value[part.type] = Number(part.value);
      return value;
    };
    const midnight = (year: number, month: number, day: number): number | null => {
      const nominal = Date.UTC(year, month - 1, day);
      let guess = nominal;
      for (let i = 0; i < 4; i++) {
        const p = parts(guess),
          offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
        const next = nominal - offset;
        if (next === guess) break;
        guess = next;
      }
      const matches = (time: number) => {
        const p = parts(time);
        return (
          p.year === year &&
          p.month === month &&
          p.day === day &&
          p.hour === 0 &&
          p.minute === 0 &&
          p.second === 0
        );
      };
      if (!matches(guess)) return null;
      // Repeated midnight is ambiguous; do not silently select a fold side.
      if (
        [-180, -120, -90, -60, -30, 30, 60, 90, 120, 180].some((minutes) =>
          matches(guess + minutes * 60000),
        )
      )
        return null;
      return guess;
    };
    const dates = [...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
    const relative = [
      ...new Set(
        [...text.toLowerCase().matchAll(/\b(today|tomorrow|yesterday)\b/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    if (new Set(dates).size > 1 || relative.length > 1) return { status: 'uncertain' };
    let calendar: string | undefined = dates[0];
    if (relative.length) {
      if (!referenceTime || !Number.isFinite(Date.parse(referenceTime)))
        return { status: 'uncertain' };
      const p = parts(Date.parse(referenceTime)),
        date = new Date(
          Date.UTC(p.year, p.month - 1, p.day) +
            (relative[0] === 'tomorrow' ? 1 : relative[0] === 'yesterday' ? -1 : 0) * 86400000,
        )
          .toISOString()
          .slice(0, 10);
      if (calendar && calendar !== date) return { status: 'uncertain' };
      calendar = date;
    }
    if (!calendar) return { status: 'uncertain' };
    const nominal = Date.parse(calendar + 'T00:00:00Z');
    if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 10) !== calendar)
      return { status: 'uncertain' };
    const date = new Date(nominal),
      next = new Date(nominal + 86400000),
      start = midnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
      end = midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
    if (start === null || end === null || end <= start) return { status: 'uncertain' };
    return {
      status: 'resolved',
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      precision: 'day',
    };
  } catch {
    return { status: 'uncertain' };
  }
}
