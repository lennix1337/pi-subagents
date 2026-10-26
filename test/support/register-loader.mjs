/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Handles two issues:
 * 1. Source files use .js import extensions (TypeScript ESM convention) but
 *    files on disk are .ts — the loader rewrites .js → .ts at resolve time.
 * 2. Source stays within Node's erasable TypeScript syntax so the supported
 *    --experimental-strip-types path is sufficient.
 *
 * The hook runs in-thread through registerHooks (Node >= 22.15): the off-thread
 * module.register worker made every import of index.ts take ~1.0 s instead of
 * ~0.6 s, and many tests spawn one child per case.
 */

import * as nodeModule from "node:module";
import "./isolated-temp-root.mjs";
import { resolve } from "./ts-loader.mjs";

if (nodeModule.registerHooks) nodeModule.registerHooks({ resolve });
else nodeModule.register(new URL("./ts-loader.mjs", import.meta.url));
