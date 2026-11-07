import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractToolArgsPreview, toolArgsKey } from "../../src/shared/utils.ts";
import { PROPERTY_CASES, intBetween, pick, seededRandom, shuffled, type Rng } from "../support/seeded-random.ts";

// Property tests for the digest that decides whether two tool calls are the same call (loop detection).
// The model below is an independent definition of "same arguments": JSON value equality where object key
// order does not matter and a property whose value is `undefined` is absent, as JSON.stringify treats it.

const KEYS = ["command", "path", "a", "b", "", "x y", "__proto__", "ключ", "10", "-"];
const STRINGS = ["", "ls -la", "a.ts", 'say "hi"', "two\nlines", "tab\t", "ünï", "\u0000", "\ud83d", "a.ts "];
const NUMBERS = [0, -0, 1, -1, 0.5, 1e21, 2 ** 31, -7.25];

type Args = Record<string, unknown>;

function isObject(value: unknown): value is Args {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Own data property, so a key such as "__proto__" stays a key instead of setting the prototype.
function setOwn(target: Args, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function randomScalar(next: Rng): unknown {
	switch (intBetween(next, 0, 3)) {
		case 0: return pick(next, STRINGS);
		case 1: return pick(next, NUMBERS);
		case 2: return next() < 0.5;
		default: return null;
	}
}

function randomValue(next: Rng, depth: number): unknown {
	if (depth <= 0 || next() < 0.5) return randomScalar(next);
	if (next() < 0.5) return Array.from({ length: intBetween(next, 0, 3) }, () => randomValue(next, depth - 1));
	return randomArgs(next, depth - 1);
}

function randomArgs(next: Rng, depth: number): Args {
	const args: Args = {};
	for (let count = intBetween(next, 0, 4); count > 0; count--) {
		// A JS-side `undefined` property: present on the object, absent in the JSON model.
		const value = next() < 0.12 ? undefined : randomValue(next, depth);
		setOwn(args, pick(next, KEYS), value);
	}
	return args;
}

function withShuffledKeys(next: Rng, value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => withShuffledKeys(next, item));
	if (!isObject(value)) return value;
	const out: Args = {};
	for (const key of shuffled(next, Object.keys(value))) setOwn(out, key, withShuffledKeys(next, value[key]));
	return out;
}

function clone(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clone);
	if (!isObject(value)) return value;
	const out: Args = {};
	for (const key of Object.keys(value)) setOwn(out, key, clone(value[key]));
	return out;
}

type Slot = { container: Args | unknown[]; key: string | number };

function slotsOf(value: unknown, out: Slot[] = []): Slot[] {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			out.push({ container: value, key: index });
			slotsOf(item, out);
		});
	} else if (isObject(value)) {
		for (const key of Object.keys(value)) {
			out.push({ container: value, key });
			slotsOf(value[key], out);
		}
	}
	return out;
}

/** One small edit somewhere in the arguments: a changed leaf, a removed or added key, or a swap. */
function perturb(next: Rng, root: Args): Args {
	const copy = clone(root) as Args;
	const slots = slotsOf(copy);
	if (slots.length === 0) {
		setOwn(copy, "added", 1);
		return copy;
	}
	const { container, key } = pick(next, slots);
	const marker = `edit-${Math.floor(next() * 1e9)}`;
	if (Array.isArray(container)) {
		const other = intBetween(next, 0, container.length - 1);
		if (next() < 0.5 && container.length > 1) [container[key as number], container[other]] = [container[other], container[key as number]];
		else container[key as number] = marker;
		return copy;
	}
	const op = intBetween(next, 0, 2);
	if (op === 0) container[key as string] = marker;
	else if (op === 1) delete container[key as string];
	else container[key as string] = undefined;
	return copy;
}

function definedKeys(object: Args): string[] {
	return Object.keys(object).filter((key) => object[key] !== undefined);
}

function modelEqual(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => modelEqual(item, b[index]));
	}
	if (isObject(a) || isObject(b)) {
		if (!isObject(a) || !isObject(b)) return false;
		const keys = definedKeys(a);
		if (keys.length !== definedKeys(b).length) return false;
		return keys.every((key) => b[key] !== undefined && Object.hasOwn(b, key) && modelEqual(a[key], b[key]));
	}
	return a === b;
}

describe("tool argument digest (property tests)", () => {
	it("property: the digest ignores object key order at every depth", () => {
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const args = randomArgs(next, 3);
			assert.equal(toolArgsKey(withShuffledKeys(next, args) as Args), toolArgsKey(args), `seed ${seed}: key order changed the digest`);
		}
	});

	it("property: two argument objects share a digest exactly when the model says they are equal", () => {
		let equal = 0;
		let different = 0;
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const a = randomArgs(next, 3);
			const mode = intBetween(next, 0, 3);
			const b = mode === 0 ? withShuffledKeys(next, a) as Args
				: mode === 1 ? perturb(next, a)
					: mode === 2 ? randomArgs(next, 3)
						: perturb(next, withShuffledKeys(next, a) as Args);
			const same = modelEqual(a, b);
			same ? equal++ : different++;
			const keyA = toolArgsKey(a);
			assert.match(keyA, /^[0-9a-f]{16}$/, `seed ${seed}: digest shape`);
			assert.equal(toolArgsKey(b) === keyA, same, `seed ${seed}: digest equality disagrees with the model for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
		}
		assert.ok(equal >= 40 && different >= 40, `generator coverage too thin: ${equal} equal pairs, ${different} different pairs`);
	});

	it("property: JS-side undefined properties are absent, as JSON.stringify treats them", () => {
		assert.equal(toolArgsKey({ a: 1, b: undefined }), toolArgsKey({ a: 1 }));
		assert.equal(toolArgsKey({ nested: { gone: undefined } }), toolArgsKey({ nested: {} }));
		assert.notEqual(toolArgsKey({ a: null }), toolArgsKey({}));
		assert.notEqual(toolArgsKey({ items: [1, 2] }), toolArgsKey({ items: [2, 1] }));
	});

	it("property: calls with the same display preview but different full arguments get different digests", () => {
		const heads: Args[] = [{ command: "ls" }, { path: "a.ts" }, { query: "q" }, { url: "https://example.test" }, { prompt: "p" }];
		const extras = ["timeout", "offset", "content", "limit"];
		for (let seed = 1; seed <= PROPERTY_CASES; seed++) {
			const next = seededRandom(seed);
			const head = pick(next, heads);
			const extra = pick(next, extras);
			const [first, second] = next() < 0.5 ? [1, 2] : ["x", "y"];
			const a: Args = { ...head, [extra]: first };
			const b: Args = { ...head, [extra]: second };
			assert.equal(extractToolArgsPreview(a), extractToolArgsPreview(b), `seed ${seed}: the premise is that the preview drops ${extra}`);
			assert.notEqual(toolArgsKey(a), toolArgsKey(b), `seed ${seed}: ${extra} ${String(first)} vs ${String(second)} shares a digest`);
		}
	});
});
