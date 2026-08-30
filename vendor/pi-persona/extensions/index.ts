// persona for pi — a character persona over invariant engineering.
//
// A port of openclaude's /identity persona system (coffeegrind123/openclaude,
// src/services/identity/* and getIdentitySection() in src/constants/prompts.ts).
// See ../FORK.md for what changed and why; the short version is that openclaude
// is a Claude Code fork with React TUI dialogs and a fixed tool surface, and pi
// has neither, so the flow is the same and the coupling is entirely different.
//
// Every decision lives in ../src/*.ts, which import nothing from pi so they can
// be tested with bare node. This file is the pi coupling and nothing else — the
// same split vendor/rtk-pi uses.
//
// The window cost, measured (see FORK.md): with no persona active this
// extension contributes ZERO tokens — before_agent_start returns undefined and
// nothing is registered on the tool surface. With one active it prepends a
// block of ~3,584 tokens (`full`) or ~2,311 (`lean`) that is byte-stable across
// turns, so it costs one prefix re-prefill at activation and nothing after.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"

import {
  downloadCard,
  isSortMode,
  PAGE_SIZE,
  searchCharacters,
  SORT_HINT,
  SORT_MODES,
} from "../src/chub.ts"
import {
  IMMERSION_MODES,
  isImmersionMode,
  maybeAppendMarker,
  type PriorMessage,
} from "../src/immersion.ts"
import {
  buildPersonaSection,
  estimateTokens,
  isPromptMode,
  PROMPT_MODES,
} from "../src/prompt.ts"
import {
  buildProcessPrompt,
  inlineThresholdBytes,
  isProcessPrompt,
} from "../src/processor.ts"
import { loadSettings, saveSettings, type PersonaSettings } from "../src/settings.ts"
import { describeCard, flattenCardForViewer } from "../src/sections.ts"
import {
  clearActive,
  getActivePersonaName,
  getActivePersonaPath,
  invalidateNameCache,
  listLocalPersonas,
  listLooseCardJsonFiles,
  parsePersonaName,
  readActivePersona,
  readCard,
  resolveActivePersonaPath,
  stageCardForProcessing,
} from "../src/storage.ts"
import type { CharaCardV2, ChubSearchNode, SortMode } from "../src/types.ts"

const COMMAND = "persona"
const STATUS_KEY = "persona"
const NETWORK_TIMEOUT_MS = 15_000

const SUBCOMMANDS = [
  "local",
  "chub",
  "search",
  "random",
  "show",
  "status",
  "clear",
  "immersion",
  "prompt",
] as const

export default function personaExtension(pi: ExtensionAPI) {
  // Resolved once. getAgentDir() honours pi's own ENV_AGENT_DIR, so a session
  // pointed at a different agent home gets that home's library — which is the
  // point of Dockerfile.pi giving each pi session a home of its own.
  const root = getAgentDir()
  let settings: PersonaSettings = loadSettings(root)

  // ── status line ──────────────────────────────────────────────────────────
  // The one visible sign that a persona is on. Without it a session that
  // adopted a persona three compactions ago looks exactly like one that did
  // not, and the model's voice is the only evidence.
  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return
    const name = getActivePersonaName(root)
    ctx.ui.setStatus(STATUS_KEY, name ? `✦ ${name}` : undefined)
  }

  pi.on("session_start", async (_event, ctx) => {
    settings = loadSettings(root)
    refreshStatus(ctx)
  })

  // ── the system-prompt block ──────────────────────────────────────────────
  // Prepended, not appended. openclaude places the persona FIRST for a measured
  // reason it writes down next to the call site: the harness intro otherwise
  // anchors the model on "neutral coding assistant" and the persona is read as
  // decoration on top of that. pi hands us the whole built prompt, so first
  // means concatenating in front of it.
  pi.on("before_agent_start", async event => {
    try {
      const body = readActivePersona(root)
      if (!body) return undefined
      const name = parsePersonaName(body) ?? "Custom"
      const section = buildPersonaSection({
        name,
        body,
        // pi's own view of what is on the surface this turn. The block names
        // real tools or omits the guidance that would need one; see
        // ../src/prompt.ts.
        tools: event.systemPromptOptions?.selectedTools,
        mode: settings.promptMode,
        commandName: COMMAND,
      })
      if (!section) return undefined
      return { systemPrompt: `${section}\n\n${event.systemPrompt}` }
    } catch (err) {
      // Fail open. A persona that cannot be built must not be the reason a turn
      // does not run — the session degrades to a normal one, loudly enough to
      // find in a log and quietly enough not to eat the turn.
      console.warn("[persona] could not build the persona block; running without it", err)
      return undefined
    }
  })

  // ── the immersion marker ─────────────────────────────────────────────────
  // Off unless asked for, on anything that is not DeepSeek. See ../src/immersion.ts.
  pi.on("input", async (event, ctx) => {
    try {
      if (event.source === "extension") return { action: "continue" as const }
      if (settings.immersionMode === "off") return { action: "continue" as const }
      const hasPersona = resolveActivePersonaPath(root) !== null
      if (!hasPersona) return { action: "continue" as const }

      const prior = priorUserMessages(ctx)
      const next = maybeAppendMarker(
        event.text,
        prior,
        settings.immersionMode,
        hasPersona,
        ctx.model,
      )
      if (next === event.text) return { action: "continue" as const }
      return { action: "transform" as const, text: next }
    } catch (err) {
      console.warn("[persona] immersion marker skipped", err)
      return { action: "continue" as const }
    }
  })

  /**
   * Prior user-authored messages, in session order.
   *
   * The extraction turn is delivered with sendUserMessage() and therefore lands
   * as a user message; it is marked synthetic so it does not consume the first
   * turn the marker is documented to attach to.
   */
  function priorUserMessages(ctx: ExtensionContext): PriorMessage[] {
    const out: PriorMessage[] = []
    let entries: readonly unknown[] = []
    try {
      entries = ctx.sessionManager.getEntries()
    } catch {
      return out
    }
    for (const raw of entries) {
      const e = raw as { type?: string; message?: { role?: string; content?: unknown } }
      if (e?.type !== "message") continue
      const role = e.message?.role
      if (role !== "user") continue
      out.push({ role: "user", synthetic: isProcessPrompt(messageText(e.message?.content)) })
    }
    return out
  }

  function messageText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    for (const part of content) {
      const p = part as { type?: string; text?: unknown }
      if (p?.type === "text" && typeof p.text === "string") return p.text
    }
    return ""
  }

  // ── activation ───────────────────────────────────────────────────────────

  /** Copy a library persona straight to the active slot. No model turn. */
  function activateCached(personaPath: string): string {
    const body = readFileSync(personaPath, "utf8")
    writeFileSync(getActivePersonaPath(root), body, "utf8")
    invalidateNameCache()
    return parsePersonaName(body) ?? "Custom"
  }

  /**
   * Hand the card to the model as an ordinary turn, which extracts the persona
   * and writes both copies. openclaude's design, and the reason a persona reads
   * like a voice profile rather than a dump of card fields.
   */
  function processCard(
    ctx: ExtensionContext,
    card: CharaCardV2,
    source: { sourceUrl?: string; projectId?: number; avatarUrl?: string },
  ): void {
    const staged = stageCardForProcessing(root, card, source)
    const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? null
    const prompt = buildProcessPrompt({
      card,
      stagedCardPath: staged.cardPath,
      libraryPersonaPath: staged.personaPath,
      activePersonaPath: getActivePersonaPath(root),
      cardName: card.data.name,
      contextWindow,
      commandName: COMMAND,
    })
    const size = JSON.stringify(card, null, 2).length
    const threshold = inlineThresholdBytes(contextWindow)
    ctx.ui.notify(
      `Extracting ${card.data.name} (${size} B card, ${size > threshold ? "jq walk" : "inlined"})…`,
      "info",
    )
    pi.sendUserMessage(prompt)
  }

  // ── pickers ──────────────────────────────────────────────────────────────

  const BACK = "← back"
  const CANCEL_HINT = "Esc cancels"

  async function pickLocal(ctx: ExtensionContext): Promise<void> {
    const entries = listLocalPersonas(root)
    const loose = listLooseCardJsonFiles(root)
    if (entries.length === 0 && loose.length === 0) {
      ctx.ui.notify(
        `No personas yet. Drop a chara_card_v2 card.json into ${getActivePersonaPath(root).replace(/PERSONA\.md$/, "personas/")} or use /${COMMAND} chub.`,
        "warning",
      )
      return
    }
    const labels: string[] = []
    const actions: Array<() => Promise<void> | void> = []
    for (const e of entries) {
      const name = e.meta?.originalName ?? e.slug
      const mark = e.isActive ? "● " : "  "
      const cached = e.personaPath ? "extracted" : "card only"
      labels.push(`${mark}${name} — ${cached}`)
      actions.push(async () => {
        if (e.personaPath) {
          const choice = await ctx.ui.select(`${name}`, [
            "Activate the extracted persona (no model turn)",
            "Re-extract from the card (costs a turn)",
            "View the card",
            BACK,
          ])
          if (!choice || choice === BACK) return
          if (choice.startsWith("Activate")) {
            const activated = activateCached(e.personaPath!)
            refreshStatus(ctx)
            ctx.ui.notify(`Active persona: ${activated}. It takes effect next turn.`, "info")
            return
          }
          if (choice.startsWith("View")) {
            await viewCard(ctx, readCard(e.cardPath))
            return
          }
        }
        processCard(ctx, readCard(e.cardPath), {
          sourceUrl: e.meta?.sourceUrl,
          projectId: e.meta?.projectId,
          avatarUrl: e.meta?.avatarUrl,
        })
      })
    }
    for (const path of loose) {
      labels.push(`  ${basename(path)} — loose card.json`)
      actions.push(() => processCard(ctx, readCard(path), {}))
    }
    labels.push(BACK)
    actions.push(() => {})

    const picked = await ctx.ui.select(`Local persona library — ${CANCEL_HINT}`, labels)
    if (!picked) return
    const idx = labels.indexOf(picked)
    if (idx < 0 || picked === BACK) return
    await actions[idx]!()
  }

  async function pickSort(ctx: ExtensionContext): Promise<SortMode | null> {
    const labels = SORT_MODES.map(s => `${s} — ${SORT_HINT[s]}`)
    labels.push(BACK)
    const picked = await ctx.ui.select(`chub.ai — sort — ${CANCEL_HINT}`, labels)
    if (!picked || picked === BACK) return null
    const sort = picked.split(" — ")[0] ?? ""
    return isSortMode(sort) ? sort : null
  }

  async function browseChub(
    ctx: ExtensionContext,
    sort: SortMode,
    search?: string,
  ): Promise<void> {
    let page = 1
    for (;;) {
      ctx.ui.setStatus(STATUS_KEY, `chub.ai — fetching page ${page}…`)
      let nodes: ChubSearchNode[]
      try {
        const res = await searchCharacters({
          sort,
          page,
          search,
          signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
        })
        nodes = res.data.nodes ?? []
      } catch (err) {
        refreshStatus(ctx)
        ctx.ui.notify(`chub.ai search failed: ${message(err)}`, "error")
        return
      }
      refreshStatus(ctx)
      if (nodes.length === 0) {
        ctx.ui.notify(page === 1 ? "chub.ai returned nothing for that." : "No more results.", "warning")
        if (page === 1) return
        page -= 1
        continue
      }

      const labels = nodes.map(n => {
        const tagline = (n.tagline || n.description || "").replace(/\s+/g, " ").slice(0, 60)
        return `${n.name} — ★${n.starCount} · ${n.nTokens} tok${tagline ? ` · ${tagline}` : ""}`
      })
      if (nodes.length === PAGE_SIZE) labels.push("→ next page")
      if (page > 1) labels.push("← previous page")
      labels.push(BACK)

      const picked = await ctx.ui.select(
        `chub.ai · ${search ? `search "${search}"` : sort} · page ${page} — ${CANCEL_HINT}`,
        labels,
      )
      if (!picked || picked === BACK) return
      if (picked === "→ next page") {
        page += 1
        continue
      }
      if (picked === "← previous page") {
        page -= 1
        continue
      }
      const node = nodes[labels.indexOf(picked)]
      if (!node) return

      ctx.ui.setStatus(STATUS_KEY, `chub.ai — downloading ${node.name}…`)
      let card: CharaCardV2
      try {
        card = await downloadCard(node.id, AbortSignal.timeout(NETWORK_TIMEOUT_MS))
      } catch (err) {
        refreshStatus(ctx)
        ctx.ui.notify(`Could not download ${node.name}: ${message(err)}`, "error")
        continue
      }
      refreshStatus(ctx)
      const accepted = await viewCard(ctx, card)
      if (accepted) {
        processCard(ctx, card, {
          sourceUrl: `https://chub.ai/characters/${node.id}`,
          projectId: node.id,
          avatarUrl: node.avatar_url || node.max_res_url || undefined,
        })
        return
      }
    }
  }

  /**
   * The card viewer. openclaude renders this as a React pane with a section
   * list and a detail view; pi's dialog vocabulary is select + editor, so the
   * section list is a select and each section opens in the editor, which is the
   * only dialog here that scrolls. Empty sections are labelled rather than
   * hidden — "this card has no mes_example" is the kind of thing you want to
   * see before spending a turn extracting from it.
   *
   * Returns true when the user accepted the card.
   */
  async function viewCard(ctx: ExtensionContext, card: CharaCardV2): Promise<boolean> {
    const sections = flattenCardForViewer(card)
    for (;;) {
      const labels = [`✓ Use this card — ${describeCard(card)}`]
      for (const s of sections) {
        labels.push(
          s.isEmpty
            ? `  ${s.name} — (empty)`
            : `  ${s.name} — ${s.kind}, ~${s.tokenCount} tok`,
        )
      }
      labels.push(BACK)
      const picked = await ctx.ui.select(`${card.data.name} — ${CANCEL_HINT}`, labels)
      if (!picked || picked === BACK) return false
      if (picked.startsWith("✓ Use this card")) return true
      const section = sections[labels.indexOf(picked) - 1]
      if (!section) continue
      if (section.isEmpty) {
        ctx.ui.notify(`${section.name} is empty on this card.`, "info")
        continue
      }
      await ctx.ui.editor(`${card.data.name} · ${section.name}`, section.content)
    }
  }

  async function pickRandom(ctx: ExtensionContext): Promise<void> {
    // 'random' sort plus a random page, for variety. Upstream's shape, including
    // the fall back to page 1 when the deep page comes back empty.
    ctx.ui.setStatus(STATUS_KEY, "chub.ai — fetching a random persona…")
    try {
      const page = 1 + Math.floor(Math.random() * 15)
      let nodes = (
        await searchCharacters({ sort: "random", page, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
      ).data.nodes
      if (!nodes || nodes.length === 0) {
        nodes = (
          await searchCharacters({ sort: "random", page: 1, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
        ).data.nodes
      }
      refreshStatus(ctx)
      if (!nodes || nodes.length === 0) {
        ctx.ui.notify("chub.ai returned no personas right now — try again in a moment.", "warning")
        return
      }
      const node = nodes[Math.floor(Math.random() * nodes.length)]!
      const card = await downloadCard(node.id, AbortSignal.timeout(NETWORK_TIMEOUT_MS))
      processCard(ctx, card, {
        sourceUrl: `https://chub.ai/characters/${node.id}`,
        projectId: node.id,
        avatarUrl: node.avatar_url || node.max_res_url || undefined,
      })
    } catch (err) {
      refreshStatus(ctx)
      ctx.ui.notify(`Could not fetch a random persona: ${message(err)}`, "error")
    }
  }

  // ── status, show, settings ───────────────────────────────────────────────

  function statusLines(ctx: ExtensionContext): string[] {
    const name = getActivePersonaName(root)
    const body = readActivePersona(root)
    const lines: string[] = []
    lines.push(name ? `Active persona: ${name}` : "Active persona: none")
    if (body) {
      const section = buildPersonaSection({
        name: name ?? "Custom",
        body,
        tools: undefined,
        mode: settings.promptMode,
        commandName: COMMAND,
      })
      if (section) {
        lines.push(
          `Block: ${settings.promptMode}, ~${estimateTokens(section)} tokens of every request`,
        )
      }
      lines.push(`File: ${resolveActivePersonaPath(root)}`)
    } else {
      lines.push(`Block: none (0 tokens). Prompt mode is '${settings.promptMode}' when one is active.`)
    }
    const model = ctx.model
    const marker = settings.immersionMode
    lines.push(
      `Immersion: ${marker}${marker === "auto" ? ` (resolves to off unless the model is DeepSeek; this one is ${model?.provider ?? "unknown"}/${model?.id ?? "unknown"})` : ""}`,
    )
    lines.push(`Library: ${listLocalPersonas(root).length} extracted, ${listLooseCardJsonFiles(root).length} loose card.json`)
    return lines
  }

  async function settingsMenu(ctx: ExtensionContext): Promise<void> {
    const picked = await ctx.ui.select(`/${COMMAND} settings — ${CANCEL_HINT}`, [
      `Prompt block: ${settings.promptMode}`,
      `Immersion marker: ${settings.immersionMode}`,
      BACK,
    ])
    if (!picked || picked === BACK) return
    if (picked.startsWith("Prompt block")) {
      const mode = await ctx.ui.select("Persona prompt block", [...PROMPT_MODES, BACK])
      if (!mode || mode === BACK || !isPromptMode(mode)) return
      settings = { ...settings, promptMode: mode }
      saveSettings(root, settings)
      ctx.ui.notify(`Persona block: ${mode}.`, "info")
      return
    }
    const mode = await ctx.ui.select("Immersion marker", [...IMMERSION_MODES, BACK])
    if (!mode || mode === BACK || !isImmersionMode(mode)) return
    settings = { ...settings, immersionMode: mode }
    saveSettings(root, settings)
    ctx.ui.notify(`Immersion marker: ${mode}.`, "info")
  }

  async function mainMenu(ctx: ExtensionContext): Promise<void> {
    const hasActive = resolveActivePersonaPath(root) !== null
    const options = [
      "Local library",
      "chub.ai — browse",
      "chub.ai — search",
      "chub.ai — random",
      "Status",
      "Settings",
    ]
    if (hasActive) {
      options.splice(4, 0, "Show the active persona")
      options.push("Clear the active persona")
    }
    const picked = await ctx.ui.select(`/${COMMAND} — ${CANCEL_HINT}`, options)
    if (!picked) return
    switch (picked) {
      case "Local library":
        return pickLocal(ctx)
      case "chub.ai — browse": {
        const sort = await pickSort(ctx)
        if (sort) await browseChub(ctx, sort)
        return
      }
      case "chub.ai — search": {
        const q = (await ctx.ui.input("chub.ai search", "character name or keyword"))?.trim()
        if (q) await browseChub(ctx, "trending", q)
        return
      }
      case "chub.ai — random":
        return pickRandom(ctx)
      case "Show the active persona":
        return showActive(ctx)
      case "Status":
        ctx.ui.notify(statusLines(ctx).join("\n"), "info")
        return
      case "Settings":
        return settingsMenu(ctx)
      case "Clear the active persona": {
        const removed = clearActive(root)
        refreshStatus(ctx)
        ctx.ui.notify(
          removed ? "Cleared. The neutral voice returns next turn." : "There was no active persona.",
          "info",
        )
        return
      }
    }
  }

  async function showActive(ctx: ExtensionContext): Promise<void> {
    const body = readActivePersona(root)
    if (!body) {
      ctx.ui.notify("No active persona.", "warning")
      return
    }
    await ctx.ui.editor(`Active persona — ${getActivePersonaName(root) ?? "Custom"}`, body)
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  // ── the command ──────────────────────────────────────────────────────────

  pi.registerCommand(COMMAND, {
    description: "Adopt a character persona for the assistant voice (local library or chub.ai)",
    getArgumentCompletions: prefix => {
      const p = prefix.trim()
      const [head, ...rest] = p.split(/\s+/)
      if (head === "immersion" && rest.length <= 1) {
        return IMMERSION_MODES.filter(m => m.startsWith(rest[0] ?? "")).map(m => ({
          value: `immersion ${m}`,
          label: `immersion ${m}`,
        }))
      }
      if (head === "prompt" && rest.length <= 1) {
        return PROMPT_MODES.filter(m => m.startsWith(rest[0] ?? "")).map(m => ({
          value: `prompt ${m}`,
          label: `prompt ${m}`,
        }))
      }
      if (head === "chub" && rest.length <= 1) {
        return SORT_MODES.filter(m => m.startsWith(rest[0] ?? "")).map(m => ({
          value: `chub ${m}`,
          label: `chub ${m} — ${SORT_HINT[m]}`,
        }))
      }
      if (rest.length > 0) return null
      return SUBCOMMANDS.filter(s => s.startsWith(head ?? "")).map(s => ({ value: s, label: s }))
    },
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim()
      const [sub, ...rest] = trimmed ? trimmed.split(/\s+/) : []
      const tail = rest.join(" ")

      // Non-interactive modes (-p / --json) have no dialogs. Everything that
      // does not need one still answers; everything that does says so rather
      // than hanging on a prompt nobody can see.
      if (!ctx.hasUI && sub !== "status" && sub !== "clear") {
        console.log(statusLines(ctx).join("\n"))
        return
      }

      try {
        switch (sub) {
          case undefined:
          case "":
            return await mainMenu(ctx)
          case "local":
            return await pickLocal(ctx)
          case "chub": {
            const sort = tail && isSortMode(tail) ? tail : await pickSort(ctx)
            if (sort) await browseChub(ctx, sort)
            return
          }
          case "search": {
            const q = tail || (await ctx.ui.input("chub.ai search", "character name or keyword"))?.trim()
            if (q) await browseChub(ctx, "trending", q)
            return
          }
          case "random":
            return await pickRandom(ctx)
          case "show":
            return await showActive(ctx)
          case "status": {
            const text = statusLines(ctx).join("\n")
            if (ctx.hasUI) ctx.ui.notify(text, "info")
            else console.log(text)
            return
          }
          case "clear": {
            const removed = clearActive(root)
            refreshStatus(ctx)
            const text = removed
              ? "Cleared. The neutral voice returns next turn."
              : "There was no active persona."
            if (ctx.hasUI) ctx.ui.notify(text, "info")
            else console.log(text)
            return
          }
          case "immersion": {
            if (!tail) {
              ctx.ui.notify(`Immersion marker: ${settings.immersionMode}`, "info")
              return
            }
            if (!isImmersionMode(tail)) {
              ctx.ui.notify(`Not a mode: ${tail}. One of ${IMMERSION_MODES.join(", ")}.`, "error")
              return
            }
            settings = { ...settings, immersionMode: tail }
            saveSettings(root, settings)
            ctx.ui.notify(`Immersion marker: ${tail}.`, "info")
            return
          }
          case "prompt": {
            if (!tail) {
              ctx.ui.notify(`Persona block: ${settings.promptMode}`, "info")
              return
            }
            if (!isPromptMode(tail)) {
              ctx.ui.notify(`Not a mode: ${tail}. One of ${PROMPT_MODES.join(", ")}.`, "error")
              return
            }
            settings = { ...settings, promptMode: tail }
            saveSettings(root, settings)
            ctx.ui.notify(`Persona block: ${tail}.`, "info")
            return
          }
          default:
            ctx.ui.notify(
              `Unknown: /${COMMAND} ${sub}. One of ${SUBCOMMANDS.join(", ")}, or /${COMMAND} on its own.`,
              "error",
            )
            return
        }
      } catch (err) {
        // A slash command that throws takes the dialog down with it and says
        // nothing useful. Everything here is reported in place.
        ctx.ui.notify(`/${COMMAND} failed: ${message(err)}`, "error")
      }
    },
  })

  // A persona written by the model lands on disk between turns, so the status
  // line has to notice the file rather than the command. Cheap: one stat, once
  // per settled agent run.
  pi.on("agent_settled", async (_event, ctx) => {
    refreshStatus(ctx)
  })

  // pi's own PI_CODING_AGENT_DIR can point at a home that has not been created
  // yet (Dockerfile.pi gives each pi session a home of its own). Said once at
  // load rather than as an exception per turn.
  if (!existsSync(root)) {
    console.warn(`[persona] agent dir ${root} does not exist yet — the library will be created on first use`)
  }
}
