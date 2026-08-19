#!/usr/bin/env node
/**
 * _sidecar.mjs — a stand-in for the prinny sidecar that a PROBE can drive.
 *
 * `vendor/prinny-channel/tests/fixtures/fake-sidecar.mjs` speaks the same
 * protocol and is the right tool for its own suite, but it sends exactly one
 * inbound message, at a moment it chooses, and it throws its tool calls away.
 * A probe about what happens to the SECOND message — a `/compact` arriving
 * mid-turn while the first is still owed an answer — can do neither.
 *
 * So this one is driven by two files, named by the environment:
 *
 *   PROBE_INBOX   a JSONL file the probe appends `ChannelMessage` params to.
 *                 Each new line is sent as a `notifications/claude/channel`
 *                 notification. Polled, because the probe and the sidecar are
 *                 different processes and a pipe in that direction would mean
 *                 inventing a second protocol.
 *   PROBE_OUTBOX  a JSONL file this appends every `tools/call` to, so the probe
 *                 can read what the extension said to Matrix and in what order.
 *
 * Everything else is `fake-sidecar.mjs`'s behaviour, unchanged: the handshake,
 * the tool list, and an `isError` result for the tool named `refuse`.
 */

import { appendFileSync, readFileSync } from 'node:fs';

const INBOX = process.env.PROBE_INBOX;
const OUTBOX = process.env.PROBE_OUTBOX;

let buffer = '';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(entry) {
  if (!OUTBOX) return;
  try {
    appendFileSync(OUTBOX, `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
  } catch {
    // The probe reads what it gets.
  }
}

let delivered = 0;
function pollInbox() {
  if (!INBOX) return;
  let lines = [];
  try {
    lines = readFileSync(INBOX, 'utf8').split('\n').filter((line) => line.trim());
  } catch {
    return; // not written yet
  }
  for (const line of lines.slice(delivered)) {
    delivered += 1;
    send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: JSON.parse(line) });
  }
}

function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'probe-sidecar', version: '0.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // The real sidecar reports its Matrix login on stderr, and the extension
    // reads that line to decide it is connected — which the permission relay
    // requires. Say it once.
    process.stderr.write('connected as @bot:example.org\n');
    setInterval(pollInbox, 20).unref?.();
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'reply' },
          { name: 'react' },
          { name: 'edit_message' },
          { name: 'download_attachment' },
          { name: 'fetch_messages' },
          { name: 'search' },
          { name: 'typing' },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    record({ kind: 'call', name, arguments: params?.arguments ?? {} });
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `${name}:ok` }] },
    });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (err) {
        process.stderr.write(`probe sidecar could not parse: ${line} (${err})\n`);
      }
    }
    index = buffer.indexOf('\n');
  }
});
