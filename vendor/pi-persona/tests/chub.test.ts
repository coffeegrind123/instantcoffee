import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildCardUrl,
  buildSearchUrl,
  downloadCard,
  isSortMode,
  PAGE_SIZE,
  searchCharacters,
  SORT_HINT,
  SORT_MODES,
  sortParams,
} from "../src/chub.ts"
import type { CharaCardV2 } from "../src/types.ts"

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const CARD: CharaCardV2 = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Nadia",
    description: "",
    personality: "",
    first_mes: "",
    mes_example: "",
    scenario: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "",
    character_version: "1",
  },
}

test("every sort mode has params and a hint", () => {
  for (const s of SORT_MODES) {
    assert.ok(sortParams(s).length > 0, `${s} has no params`)
    assert.ok(SORT_HINT[s]?.length > 0, `${s} has no hint`)
  }
})

test("isSortMode rejects anything that is not a sort", () => {
  assert.ok(isSortMode("trending"))
  assert.ok(!isSortMode("popular"))
  assert.ok(!isSortMode(""))
})

test("the search URL carries the page, the query and the sort's own params", () => {
  const url = buildSearchUrl({ sort: "underrated", page: 3, search: "cat girl" })
  assert.ok(url.startsWith("https://gateway.chub.ai/search?"))
  assert.ok(url.includes("page=3"))
  assert.ok(url.includes(`first=${PAGE_SIZE}`))
  assert.ok(url.includes("search=cat+girl"))
  assert.ok(url.includes("min_ai_rating=90"))
  assert.ok(url.includes("namespace=characters"))
})

test("nsfw defaults on and is overridable", () => {
  assert.ok(buildSearchUrl({ sort: "trending" }).includes("nsfw=true"))
  assert.ok(buildSearchUrl({ sort: "trending", nsfw: false }).includes("nsfw=false"))
})

test("the card URL pins ref=main and the blob response type", () => {
  const url = buildCardUrl(1234)
  assert.ok(url.includes("/projects/1234/repository/files/card.json/raw"))
  assert.ok(url.includes("ref=main"))
  assert.ok(url.includes("response_type=blob"))
})

// http.sys and friends reject a bodyless POST before the handler sees it, and
// upstream sends `{}`. Dropping it would be a change nobody notices until the
// gateway starts answering 411.
test("search POSTs a body and the gateway key headers", async () => {
  let seen: RequestInit | undefined
  await searchCharacters({
    sort: "trending",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen = init
      return jsonResponse({ data: { nodes: [], count: 0, page: 1, cursor: null, previous_cursor: null } })
    }) as unknown as typeof fetch,
  })
  assert.equal(seen?.method, "POST")
  assert.equal(seen?.body, "{}")
  const headers = seen?.headers as Record<string, string>
  assert.ok(headers["ch-api-key"])
  assert.equal(headers.samwise, headers["ch-api-key"])
  assert.ok(seen?.signal)
})

test("a non-ok search is an error naming the status, not an empty result", async () => {
  await assert.rejects(
    searchCharacters({
      sort: "trending",
      fetchImpl: (async () => jsonResponse({ error: "nope" }, false, 503)) as unknown as typeof fetch,
    }),
    /chub search failed: 503/,
  )
})

test("a search that answers with an unexpected shape is an error, not a crash later", async () => {
  await assert.rejects(
    searchCharacters({
      sort: "trending",
      fetchImpl: (async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch,
    }),
    /unexpected shape/,
  )
})

test("downloadCard validates the card before returning it", async () => {
  const ok = await downloadCard(1, undefined, (async () => jsonResponse(CARD)) as unknown as typeof fetch)
  assert.equal(ok.data.name, "Nadia")
  await assert.rejects(
    downloadCard(2, undefined, (async () => jsonResponse({ data: {} })) as unknown as typeof fetch),
    /unexpected shape/,
  )
  await assert.rejects(
    downloadCard(3, undefined, (async () => jsonResponse({}, false, 404)) as unknown as typeof fetch),
    /chub card download failed \(3\): 404/,
  )
})

// A hung gateway inside a slash command hangs the TUI, and the only clue is a
// cursor that stopped blinking.
test("every request carries an abort signal", async () => {
  let searchSignal: unknown
  let cardSignal: unknown
  await searchCharacters({
    sort: "trending",
    fetchImpl: (async (_u: string, i: RequestInit) => {
      searchSignal = i.signal
      return jsonResponse({ data: { nodes: [], count: 0, page: 1, cursor: null, previous_cursor: null } })
    }) as unknown as typeof fetch,
  })
  await downloadCard(1, undefined, (async (_u: string, i: RequestInit) => {
    cardSignal = i.signal
    return jsonResponse(CARD)
  }) as unknown as typeof fetch)
  assert.ok(searchSignal instanceof AbortSignal)
  assert.ok(cardSignal instanceof AbortSignal)
})
