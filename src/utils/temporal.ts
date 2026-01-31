/**
 * Temporal field helpers for managing fact validity over time.
 *
 * The temporal model uses three fields on EntityEdge:
 * - valid_at: When the fact became true (semantic time)
 * - invalid_at: When the fact stopped being true (semantic time)
 * - expired_at: When the edge was superseded in the graph (system time)
 */

export function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Determines if a fact edge is currently valid (not expired and not invalidated).
 */
export function isFactCurrent(edge: {
	expired_at: string | null;
	invalid_at: string | null;
}): boolean {
	if (edge.expired_at !== null) return false;
	if (edge.invalid_at !== null) {
		const invalidDate = new Date(edge.invalid_at);
		return invalidDate > new Date();
	}
	return true;
}

/**
 * Checks if two temporal ranges overlap.
 * Used for contradiction detection between facts.
 */
export function temporalRangesOverlap(
	a: { valid_at: string | null; invalid_at: string | null },
	b: { valid_at: string | null; invalid_at: string | null },
): boolean {
	const aStart = a.valid_at ? new Date(a.valid_at).getTime() : 0;
	const aEnd = a.invalid_at ? new Date(a.invalid_at).getTime() : Infinity;
	const bStart = b.valid_at ? new Date(b.valid_at).getTime() : 0;
	const bEnd = b.invalid_at ? new Date(b.invalid_at).getTime() : Infinity;

	return aStart < bEnd && bStart < aEnd;
}

/**
 * Resolves a contradiction between an existing edge and a new edge.
 * Returns updated temporal fields for the old edge.
 *
 * Logic (from Graphiti):
 * - If old edge started before new edge: old edge ends when new one begins
 * - If new edge started before old edge: new edge ends when old one begins
 */
export function resolveContradiction(
	existingEdge: { valid_at: string | null; invalid_at: string | null },
	newEdge: { valid_at: string | null },
): { invalid_at: string; expired_at: string } | null {
	const existingStart = existingEdge.valid_at
		? new Date(existingEdge.valid_at).getTime()
		: 0;
	const newStart = newEdge.valid_at ? new Date(newEdge.valid_at).getTime() : Date.now();

	// Old edge started before new edge: old fact ended when new one began
	if (existingStart < newStart) {
		return {
			invalid_at: newEdge.valid_at ?? nowIso(),
			expired_at: nowIso(),
		};
	}

	// New edge started before old edge: the new fact is actually the older one
	// This shouldn't typically happen in conversational flow, return null to skip
	return null;
}

/**
 * Check if an episode is older than a given number of days.
 */
export function isOlderThanDays(createdAt: string, days: number): boolean {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - days);
	return new Date(createdAt) < cutoff;
}
