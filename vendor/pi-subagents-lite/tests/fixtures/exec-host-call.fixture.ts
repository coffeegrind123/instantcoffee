/**
 * exec-host-call.fixture.ts — the scan's own control (Forge fork).
 *
 * Not a test file (the `*.test.ts` glob never picks it up) and not product code
 * (nothing imports it). It exists so `tests/exec-verdicts.test.ts` can prove its
 * scanner still finds a host `pi.exec` call, without borrowing a call site from
 * a tree another branch is allowed to shrink — deleting `.pi/extensions/stack.ts`
 * removed every host call under `.pi/extensions`, and the old `.pi/extensions`
 * control asserted "at least five", so it rotted the moment that legitimate
 * deletion landed.
 *
 * It carries exactly one host-style call — `pi.exec(…)`, the receiver shape this
 * fork uses — and no regex `.exec`. See the "discriminates a host exec from a
 * RegExp-literal exec" control in the test for the negative shapes this file
 * deliberately does not exercise.
 */
declare const pi: { exec(cmd: string, args: string[], opts: { timeout: number }): Promise<unknown> };

export async function runProbe(): Promise<void> {
  await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5_000 });
}
