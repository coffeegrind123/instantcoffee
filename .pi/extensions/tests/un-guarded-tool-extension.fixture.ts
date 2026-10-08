/**
 * un-guarded-tool-extension.fixture.ts — a probe for the denylist scan.
 *
 * A synthetic extension that registers a model-visible tool with NO
 * `__PI_SUBAGENT_SPAWN_DEPTH__` guard — exactly the shape
 * `.pi/extensions/stack.ts` had before it was removed, and the shape
 * `tests/subagent-denylist.test.ts` exists to catch if it reappears. It lives
 * under `.pi/extensions/tests/`, which has no `index.ts`/`index.js` and so is
 * never an entry point pi discovers, which is why it is safe to keep a violator
 * here.
 *
 * `tests/subagent-denylist.test.ts` drives its detection over this file, so the
 * "does anything register a tool any more?" control is a positive assertion
 * against a fixture the test owns rather than a count of the real directory —
 * that count legitimately reached zero when `stack.ts` was deleted.
 */
declare const pi: { registerTool(name: string): void };

export default function fixtureExtension(): void {
  pi.registerTool("fixture_status");
}
