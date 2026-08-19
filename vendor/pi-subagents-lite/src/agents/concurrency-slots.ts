/**
 * concurrency-slots.ts — Forge fork. Who is allowed to run, and how many.
 *
 * ## Why this is its own module
 *
 * The arithmetic lived in `agent-manager.ts`, which imports pi and therefore
 * cannot be loaded by the suite (`node --experimental-strip-types --test`). So
 * the one part of the manager that is pure bookkeeping — a limits table, a
 * precedence rule and a running count — had no test, and it turned out to have a
 * defect that only shows up on a config change while an agent is in flight.
 * Same move, and the same reason, as `turn-tracking.ts` and
 * `declared-resources.ts`. This module imports nothing.
 *
 * ## The defect it was extracted for
 *
 * `getSlot()` caches an auto-created slot under a model key when nothing more
 * specific is configured, and a starting run increments `running` on that
 * object. `setLimits()` (was `setConcurrency`) has to DELETE the slots the new
 * config no longer names — a stale auto-created per-model slot would otherwise
 * shadow a per-provider limit the operator has just added — and it used to throw
 * the running counts away with them. The in-flight agent kept a reference to the
 * dropped object and decremented it where nothing reads it, while a fresh slot
 * reported `running: 0`.
 *
 * On this stack that means two children in flight against `PARALLEL_SLOTS=1`,
 * which is the exact state `default: 1` was measured into existence to prevent:
 * a child that grew to 18k tokens took the parent's next call from 2,117 cached
 * tokens to zero, and from 442 ms to 2,949 ms.
 *
 * It did not need an actual change to fire, either. The deletion keys on
 * presence in `config.models`, not on any difference, so re-confirming the limit
 * the operator already had was enough — and every concurrency write in the
 * `/agents` menu comes through here.
 *
 * ## The rule that fixes it
 *
 * A `running` count is a fact about the world; a `limit` is configuration.
 * Rebuilding the counts after every reconfiguration, from the holders
 * themselves, is what keeps the two from being lost together — and it is what
 * makes a PRECEDENCE change correct rather than merely non-destructive: an agent
 * that started under a per-model slot and finishes under a per-provider one is
 * counted by `recount()` and released by `release()` in the same place, because
 * both ask `slotFor()` which slot serves that model key *now*.
 */

/** One pool: how many may run at once, and how many are. */
export interface ConcurrencySlot {
  limit: number;
  running: number;
}

export interface ConcurrencyConfig {
  /** Default concurrency limit for models not in the models or providers map. */
  default: number;
  /** Per-provider concurrency limits keyed by provider name (e.g. "llamacpp"). */
  providers?: Record<string, number>;
  /** Per-model concurrency limits keyed by "provider/modelId". */
  models?: Record<string, number>;
}

/** The slice of an AgentRecord the table needs. Duck-typed so this imports nothing. */
export interface SlotHolder {
  execution: { modelKey?: string; holdsSlot?: boolean };
}

export class SlotTable {
  /** Per-model slots: configured entries, plus auto-created ones at the default limit. */
  private models = new Map<string, ConcurrencySlot>();

  /** Per-provider slots — a shared pool for every model from that provider. */
  private providers = new Map<string, ConcurrencySlot>();

  private defaultLimit: number;

  constructor(config: ConcurrencyConfig | undefined, fallbackDefault: number) {
    this.defaultLimit = config?.default ?? fallbackDefault;
    for (const [provider, limit] of Object.entries(config?.providers ?? {})) {
      this.applyEntry(this.providers, provider, limit);
    }
    for (const [modelKey, limit] of Object.entries(config?.models ?? {})) {
      this.applyEntry(this.models, modelKey, limit);
    }
  }

  /**
   * The slot that serves this model key.
   *
   * Precedence: per-model ▸ per-provider ▸ default. The default case creates and
   * CACHES a per-model slot, which is what makes the deletion in `setLimits`
   * necessary — an auto-created entry would otherwise outrank a per-provider
   * limit added later.
   */
  slotFor(modelKey: string): ConcurrencySlot {
    const configured = this.models.get(modelKey);
    if (configured) return configured;

    const providerSlot = this.providers.get(modelKey.split("/")[0]);
    if (providerSlot) return providerSlot;

    const created = { limit: safeLimit(this.defaultLimit, 1), running: 0 };
    this.models.set(modelKey, created);
    return created;
  }

  /** True when a spawn for this model key would have to queue. */
  isFull(modelKey: string): boolean {
    const slot = this.slotFor(modelKey);
    return slot.running >= slot.limit;
  }

  /** Take a slot for this holder. A holder with no model key never takes one. */
  reserve(holder: SlotHolder): void {
    const modelKey = holder.execution.modelKey;
    if (!modelKey) return;
    this.slotFor(modelKey).running++;
    holder.execution.holdsSlot = true;
  }

  /**
   * Give the slot back, on whatever slot serves the holder's model key now.
   *
   * Deliberately not the slot object captured at reservation time: a
   * `setLimits()` in between may have replaced it, and decrementing the old one
   * puts the count somewhere nothing reads.
   */
  release(holder: SlotHolder): void {
    if (!holder.execution.holdsSlot) return;
    holder.execution.holdsSlot = false;
    const modelKey = holder.execution.modelKey;
    if (!modelKey) return;
    const slot = this.slotFor(modelKey);
    if (slot.running > 0) slot.running--;
  }

  /**
   * Apply a new configuration, then rebuild every running count from `holders`.
   *
   * `holders` is every record the manager knows about; the ones that are not
   * holding a slot are skipped. `holdsSlot` is the authority rather than
   * `status === "running"`, because the slot is held right through the
   * verification window, where the status has already gone terminal — counting
   * by status would free the slot early and let a queued subagent start while
   * the previous one's judge is still on the provider.
   */
  setLimits(config: ConcurrencyConfig, holders: Iterable<SlotHolder>): void {
    // Forge fork: `this.defaultLimit = config.default` with no guard.
    //
    // A partial config — one written by hand, or by a caller that only meant to
    // set `models` — leaves `default` undefined, and `slotFor()` then does
    // `Math.max(1, undefined)` = NaN. `isFull()` compares `running >= NaN`,
    // which is FALSE for every value, so every spawn starts immediately: the
    // limit does not become large, it stops existing. On a one-slot llama server
    // that is the exact state `default: 1` was measured into existence to
    // prevent. An unreadable limit keeps the one already in force.
    this.defaultLimit = safeLimit(config.default, this.defaultLimit);

    // The deletion tests PRESENCE, not truthiness. `!config.models[key]` is also
    // true for `0` and for `NaN`, so a limit of 0 — which `applyEntry` has just
    // clamped to 1, deliberately, because a zero limit would stall every spawn
    // forever — was applied and then immediately deleted, dropping the entry
    // back to the default. An operator writing `0` to mean "stop this model
    // spawning" got the default instead, silently.
    const providerConfig = config.providers ?? {};
    for (const [provider, limit] of Object.entries(providerConfig)) {
      this.applyEntry(this.providers, provider, limit);
    }
    for (const key of [...this.providers.keys()]) {
      if (!(key in providerConfig)) this.providers.delete(key);
    }

    const modelConfig = config.models ?? {};
    for (const [modelKey, limit] of Object.entries(modelConfig)) {
      this.applyEntry(this.models, modelKey, limit);
    }
    for (const key of [...this.models.keys()]) {
      if (!(key in modelConfig)) this.models.delete(key);
    }

    this.recount(holders);
  }

  /** Re-derive every slot's `running` from the holders that actually hold one. */
  recount(holders: Iterable<SlotHolder>): void {
    for (const slot of this.models.values()) slot.running = 0;
    for (const slot of this.providers.values()) slot.running = 0;
    for (const holder of holders) {
      if (!holder.execution.holdsSlot) continue;
      if (!holder.execution.modelKey) continue;
      this.slotFor(holder.execution.modelKey).running++;
    }
  }

  private applyEntry(map: Map<string, ConcurrencySlot>, key: string, limit: number): void {
    const existing = map.get(key);
    // Same reasoning as setLimits: an unreadable per-model or per-provider limit
    // keeps the one already in force rather than becoming NaN, which reads as
    // "no limit" everywhere it is compared.
    const value = safeLimit(limit, existing?.limit ?? 1);
    if (existing) existing.limit = value;
    else map.set(key, { limit: value, running: 0 });
  }
}

/**
 * A limit that can actually bound something: at least 1, and never NaN.
 *
 * `Math.max(1, undefined)` is NaN, and `running >= NaN` is false for every
 * `running` — so an unreadable limit silently removes the bound instead of
 * tightening it. Falls back to the value already in force.
 */
function safeLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return Math.max(1, fallback);
  return Math.max(1, Math.floor(limit));
}
