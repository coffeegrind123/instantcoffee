---
name: browser-tools
description: Drive a real Chrome with the browser_* tools — open pages, read them as text, click, type, fill forms, read cookies and network logs, get past bot protection. Use when a task needs a live web page rather than a file — reading a URL the user gave you, checking whether a site or endpoint works, scraping content, logging in, or testing a page you just changed. Also use when the user says browser, Chrome, web page, URL, scrape, or "look at this site".
compatibility: The browser starts and restarts itself — there is no setup step. Five tools are native; the other 93 are reached with mcp({ search }).
---

# A real browser, as tools

Five browser tools are always available. The browser opens itself on the first
one you call — there is no start step.

```
browser_navigate({ url: "https://example.com" })
browser_get_text_content({ max_chars: 4000 })      → the page as plain text
browser_get_interaction_tree({ limit: 40 })        → numbered clickable elements
browser_click({ selector: "3" })                   → click element 3
browser_type_text({ selector: "7", text: "hello" })
```

`get_interaction_tree` returns compact records — `{"id":3,"t":"link","l":"Sign in","r":"hdr"}`
is element **3**, a link labelled "Sign in", in the header. Anything that takes a
`selector` accepts that number as a string, or a CSS selector.

You are a text model. **You cannot see screenshots.** Read pages as text.

## The other 93 tools

Tabs, forms, cookies and localStorage, network and console logs, waiting for a
request, request blocking and mocking, JS execution, scrolling, user-agent /
locale / timezone / geolocation overrides, human-like typing, accessibility
snapshots, Cloudflare challenges. They are one hop away:

```
mcp({ search: "cookie" })              → matching tools, with their parameters
mcp({ describe: "browser_set_cookie" })→ one tool's full schema
mcp({ tool: "browser_set_cookie", args: { name: "a", value: "b" } })
```

Names are always prefixed: `browser_get_cookies`, not `get_cookies`. Search
before assuming a capability is missing.

## Several steps in one call

When a job needs a few calls with logic between them, write it as one script
instead of taking a turn per call:

```
mcpScript({ code: `
  const r = await tools.call("browser_navigate", { url: "https://news.ycombinator.com" });
  if (!r.ok) return r;
  const tree = await tools.call("browser_get_interaction_tree", { limit: 30 });
  return tree.data;
` })
```

Each call returns `{ ok: true, data }` or `{ ok: false, error }`, so one failure
does not abandon the rest of the script.

## Keeping output small

A web page is the easiest way to burn this session's whole context.

- `browser_get_text_content` is paginated: `{ max_chars: 4000, offset: 0 }`. The
  reply opens with `[chars 0-4000 of 51234]`, so you know how much is left. Read
  the first page; fetch more only if the answer was not in it.
- **Never call `browser_get_content` to read a page** — that is raw HTML, tens of
  thousands of tokens for the same words. It is for when you specifically need
  markup or attributes, and then with a small `max_chars`.
- `browser_get_interaction_tree({ limit: 40 })` on a large page; it says how many
  it cut.
- Don't call `screenshot` unless the user asked for an image file — you cannot
  read it. With `save_path` it writes a file a human can open.

## Things that will bite you

- **The page persists between calls**, and between your turns. Do not re-navigate
  to a URL you are already on; you would lose scroll position, form state, login.
- **Read before you click.** Element numbers come from the last
  `browser_get_interaction_tree` and change when the page changes. After a click
  that loads new content, read the tree again.
- **`browser_type_text` appends.** Use `mcp({ tool: "browser_clear_input", … })`
  first when replacing a value.
- **A click that navigates needs a moment.** `mcp({ tool: "browser_wait_for_element", args: { selector: "…" } })`
  beats guessing with a sleep.
- **Blocked, or a challenge page?** `mcp({ search: "cloudflare" })` — there is a
  bypass tool and a check for whether a challenge is present.

## You do not manage the browser

There is no start step, no stop step, and no server to check. Chrome is brought
up on the first tool that needs it and restarted if it ever dies. Just call the
tool you want.

If a browser tool returns an error, read the error: it says what went wrong with
that page. Do not try to repair the browser, do not run shell commands to start
or stop it, and do not fall back to `curl` for a page that needs JavaScript — say
the page could not be read and carry on.
