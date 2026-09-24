/**
 * The extension's only time source, so the replay test can run a recorded
 * session on its recorded clock instead of the wall clock.
 */

let source: () => number = Date.now;

export function now(): number {
	return source();
}

/** Tests only. */
export function setClock(fn: () => number): void {
	source = fn;
}
