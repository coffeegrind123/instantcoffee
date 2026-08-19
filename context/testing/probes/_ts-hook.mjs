/**
 * _ts-hook.mjs — resolve `./foo.js` to `./foo.ts` when only the .ts exists.
 *
 * `vendor/pi-subagents-lite/src` uses `.js` internal specifiers (correct under
 * pi's loader and under a bundler), which plain node cannot resolve because the
 * files on disk are `.ts`. The test suite works around it by testing only the
 * modules whose specifiers are already `.ts`; a probe that wants to drive
 * `agent-discovery.ts` or `agent-types.ts` needs this instead.
 *
 * It only ever rewrites a RELATIVE specifier, and only when the .ts file is
 * really there, so nothing outside the package is affected.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try {
      const resolved = await next(specifier.slice(0, -3) + ".ts", context);
      if (existsSync(fileURLToPath(resolved.url))) return resolved;
    } catch {
      // fall through to the normal resolution and its normal error
    }
  }
  return next(specifier, context);
}
