import { cosineSimilarity } from '../../../src/embeddings/cosine';

describe('cosineSimilarity', () => {
	it('should return 1 for identical vectors', () => {
		const v = [1, 2, 3, 4, 5];
		expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
	});

	it('should return -1 for opposite vectors', () => {
		const a = [1, 0, 0];
		const b = [-1, 0, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
	});

	it('should return 0 for orthogonal vectors', () => {
		const a = [1, 0, 0];
		const b = [0, 1, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
	});

	it('should return 0 when either vector is all zeros', () => {
		const a = [0, 0, 0];
		const b = [1, 2, 3];
		expect(cosineSimilarity(a, b)).toBe(0);
		expect(cosineSimilarity(b, a)).toBe(0);
	});

	it('should return 0 for two zero vectors', () => {
		expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
	});

	it('should throw on dimension mismatch', () => {
		expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(
			'Vector dimension mismatch: 2 vs 3',
		);
	});

	it('should handle high-dimensional vectors', () => {
		const dim = 1536;
		const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
		const b = Array.from({ length: dim }, (_, i) => Math.sin(i + 0.1));
		const score = cosineSimilarity(a, b);
		// Similar but not identical — should be close to 1 but not exactly 1
		expect(score).toBeGreaterThan(0.99);
		expect(score).toBeLessThan(1.0);
	});

	it('should be commutative', () => {
		const a = [0.5, -0.3, 0.8, 0.1];
		const b = [0.2, 0.7, -0.1, 0.9];
		expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
	});

	it('should be scale-invariant', () => {
		const a = [1, 2, 3];
		const b = [4, 5, 6];
		const bScaled = [40, 50, 60];
		expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(a, bScaled), 10);
	});
});
