---
name: browser
description: Drive a real Chrome from the shell with ./scripts/browser.sh — open pages, read them as text, click, type, fill forms, read cookies and network logs, and get past bot protection. Use when a task needs a live web page rather than a file — reading a URL the user gave you, checking whether a site or endpoint works, scraping content, logging in, or testing a page you just changed. Also use when the user says browser, Chrome, web page, URL, scrape, or "look at this site".
compatibility: Needs python3 and a Zendriver MCP checkout (ZENDRIVER_MCP_DIR in .env). The server starts itself on first use and keeps running until you stop it.
---

# A browser, from the shell

`./scripts/browser.sh` drives a real Chrome over CDP. The browser is a **long-lived
server**: a page you open in one command is still open in the next one, so build up
state across calls instead of trying to do everything at once.

You are a text model. **You cannot see screenshots.** Read pages with
`get_text_content` and interact through `get_interaction_tree`.

## The loop

```bash
./scripts/browser.sh navigate --url https://example.com   # starts Chrome if needed
./scripts/browser.sh get_text_content                     # the page as plain text
./scripts/browser.sh get_interaction_tree                 # numbered clickable elements
./scripts/browser.sh click --selector 3                   # click element 3
./scripts/browser.sh type_text --selector 7 --text hello  # type into element 7
./scripts/browser.sh press_enter
./scripts/browser.sh down                                 # when the task is done
```

`get_interaction_tree` returns compact records — `{"id":3,"t":"link","l":"Sign in","r":"hdr"}`
is element **3**, a link labelled "Sign in", in the header. Every tool that takes a
`--selector` accepts that number as well as a CSS selector.

There are 98 tools. Find the rest when you need them:

```bash
./scripts/browser.sh --search cookie      # tools whose name or purpose matches
./scripts/browser.sh --list --compact     # every name, ~2 tokens each
./scripts/browser.sh <tool> --help        # that one tool's parameters
```

Beyond the loop above, there are tools for tabs, forms, cookies and localStorage,
network and console logs, request blocking and mocking, waiting for a request,
JS execution, geolocation/timezone/user-agent overrides, human-like typing and
mouse movement, accessibility snapshots, and Cloudflare challenges. Search before
assuming something is missing.

## Keeping output small

A web page is the single easiest way to burn this session's whole context.

- **Never call `get_content` to read a page.** That is raw HTML — tens of thousands
  of tokens for the same words `get_text_content` gives you without the markup. It
  is for when you specifically need markup or attributes, and then with a small
  `--max_chars`.
- Both paginate: `--max_chars 4000 --offset 0`. The reply starts with
  `[chars 0-4000 of 51234]`, so you know what you have and where to continue.
  Read the first page, and only fetch more if the answer is not in it.
- `get_interaction_tree --limit 40` when a page is large; it says how many were cut.
- `--head N` truncates any command's output to N lines.
- **Do not call `screenshot`** unless the user asked for an image file — you cannot
  read it, and the reply says so rather than dumping base64. With `--save_path
  /tmp/x.png` it writes a file a human can open.

## Things that will bite you

- **The page persists between calls.** Do not re-navigate to a URL you are already
  on; you will lose scroll position, form state and login.
- **Read before you click.** Element numbers come from the last
  `get_interaction_tree`, and they change when the page changes. After a click that
  loads new content, get the tree again.
- **`type_text` appends.** Call `clear_input` first when replacing a value.
- **A click that navigates needs a moment.** `wait_for_element --selector ...` or
  `wait --seconds 2` is more reliable than reading immediately.
- **Blocked, or a challenge page?** `--search cloudflare` — there is a bypass tool
  and a check for whether a challenge is present. `set_user_agent`, `set_locale`,
  `set_timezone` and `set_geolocation` exist for sites that fingerprint.
- **You do not manage the browser.** It starts itself on the first command and
  restarts itself if it dies. There is no setup step and nothing to check.

## When something fails

- **`no tool named 'x'`** — the message lists near names; or `--search <word>`.
- **`Browser not started`** or a connection error — handled automatically: the
  browser is opened (or replaced) and the call retried. If the same error comes
  back twice, report it and move on.
- **A tool returns an error string** — report it and move on. Do not retry the same
  call repeatedly, and do not fall back to `curl` for a page that needs JavaScript;
  say the page could not be read instead.
