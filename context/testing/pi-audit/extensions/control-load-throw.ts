/**
 * Control: an extension that throws while loading. pi must refuse to start
 * with "Failed to load extension ... CONTROL-LOAD-THROW" and exit 1. If a run
 * with this loaded starts anyway, load errors are being swallowed and a clean
 * stderr from the real extension set means nothing.
 */
export default function (_pi: unknown) {
  throw new Error("CONTROL-LOAD-THROW");
}
