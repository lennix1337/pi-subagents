/**
 * Seeded generator for property tests. Case `seed` always produces the same inputs, so a failing
 * assertion reproduces from the seed it names.
 */
export type Rng = () => number;

export const PROPERTY_CASES = 200;

export function seededRandom(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function intBetween(next: Rng, min: number, max: number): number {
	return min + Math.floor(next() * (max - min + 1));
}

export function pick<T>(next: Rng, items: readonly T[]): T {
	return items[Math.floor(next() * items.length)]!;
}

export function shuffled<T>(next: Rng, items: readonly T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}
