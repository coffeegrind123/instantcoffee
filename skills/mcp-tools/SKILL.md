---
name: mcp-tools
description: Call MCP (Model Context Protocol) servers from the shell via ./scripts/mcp.sh, which wraps mcp2cli. Use when a task needs a capability this agent does not have built in and an MCP server provides it — issue trackers, browsers, databases, reverse-engineering tools, cloud APIs — or when the user mentions MCP, a named MCP server, or asks what external tools are available.
compatibility: Needs uv on PATH and the repo's mcp/servers.json. First call installs a pinned mcp2cli automatically.
---

# MCP tools from the shell

This agent has no MCP support, and that is deliberate: one MCP server can publish
hundreds of tool schemas, and on a 32K window they would be spent before you read
your first file. `./scripts/mcp.sh` gives you the same servers through the shell,
so a schema only costs you tokens at the moment you decide to use that one tool.

**Never run `--list` without `--compact`, and never dump a whole server's schema
into the conversation.** That throws away the entire reason this exists.

## The loop

Work from cheapest to most expensive. Stop as soon as you have what you need.

```bash
# 1. Which servers exist? (one line each)
./scripts/mcp.sh --servers

# 2. Which tool on that server? Search first — it is far cheaper than listing.
./scripts/mcp.sh <server> --search <word>

#    Only if search finds nothing: names only, about 2 tokens per tool.
./scripts/mcp.sh <server> --list --compact

# 3. What arguments does that one tool take?
./scripts/mcp.sh <server> <tool> --help

# 4. Call it.
./scripts/mcp.sh <server> <tool> --some-arg value
```

Real example, end to end, against the reference server:

```bash
$ ./scripts/mcp.sh everything --search sum
Tools matching 'sum':
  get-sum                                   Returns the sum of two numbers

$ ./scripts/mcp.sh everything get-sum --help
usage: mcp2cli get-sum [-h] [--stdin] [--a A] [--b B]
Returns the sum of two numbers
  --a A       First number
  --b B       Second number

$ ./scripts/mcp.sh everything get-sum --a 20 --b 22
The sum of 20 and 22 is 42.
```

## Keeping the output small

Every flag after `<server>` goes straight to `mcp2cli`, so these all work:

| Flag | Use it when |
| --- | --- |
| `--compact` | listing tools — names only, ~2 tokens each |
| `--search PATTERN` | you have a rough idea of the tool's name or purpose |
| `--top N` | a server has many tools and you only want the most-used |
| `--head N` | a call returns a long array or a lot of text |
| `--json` | you need to parse the result rather than read it |
| `--stdin` | an argument is large or awkward to quote — pipe JSON in |

`--json` prints the full MCP envelope (`content`, `structuredContent`, `isError`)
on **stdout**; progress lines like `Starting default (STDIO) server...` go to
**stderr**. So `2>/dev/null` gives you clean, parseable output.

Avoid `--list --json`: it emits every tool's full parameter schema, which is the
expensive thing this skill exists to avoid.

## Adding a server

Servers live in `mcp/servers.json`. Add an entry, then it is addressable by name:

```json
{
  "servers": {
    "linear": {
      "url": "https://mcp.linear.app/sse",
      "description": "Linear issues and projects.",
      "auth_header": "Authorization:env:LINEAR_TOKEN"
    },
    "local-fs": {
      "stdio": "npx -y @modelcontextprotocol/server-filesystem /srv/data",
      "description": "Filesystem access under /srv/data."
    }
  }
}
```

Use `stdio` for a command, `url` for an HTTP/SSE endpoint — one or the other, not
both. **Never write a token into this file**: the value of `auth_header` accepts
`env:VAR` and `file:/path` prefixes, so the secret stays outside version control.
`env` (an object) passes environment variables to a stdio server.

## When something fails

- **`unknown server`** — check `./scripts/mcp.sh --servers` for the exact name.
- **`uv is required`** — install uv, then `./scripts/mcp.sh --install`.
- **`AttributeError: 'Tool' object has no attribute 'inputSchema'`** — the mcp
  SDK pin was lost. Repair it with `./scripts/mcp.sh --install`, which reinstalls
  mcp2cli with the SDK version this repo pins.
- **A stdio server takes seconds to answer.** Expected: each call spawns the
  server. Batch your questions into one call rather than making several.
  (`--session-start` exists in mcp2cli but did not work when tested here, so do
  not reach for it.)
- **An MCP call fails or the server is unreachable.** Report that plainly and
  carry on with the task by other means. Do not retry the same call repeatedly.
