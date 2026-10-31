/**
 * Where the installed pi package lives, for the tests that read or load pi's
 * own modules.
 *
 * It used to be a literal `/usr/local/lib/node_modules/...`, which is where npm
 * puts a global install on this stack's image and NOT on a GitHub runner
 * (setup-node's prefix is under /opt/hostedtoolcache). So the moment this suite
 * entered CI, every such test failed with ENOENT or "Cannot find module", or
 * skipped. Resolved instead: `pi` on PATH followed to its package.json, then
 * `npm root -g`, then the old literal, so a box without pi behaves as before.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const PACKAGE = "@earendil-works/pi-coding-agent";
const LEGACY = `/usr/local/lib/node_modules/${PACKAGE}`;

function isPiPackage(dir: string): boolean {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name === PACKAGE;
  } catch {
    return false;
  }
}

function fromPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const bin = path.join(dir, "pi");
    if (!existsSync(bin)) continue;
    let d: string;
    try {
      d = path.dirname(realpathSync(bin));
    } catch {
      continue;
    }
    while (d !== path.dirname(d)) {
      if (isPiPackage(d)) return d;
      d = path.dirname(d);
    }
  }
  return null;
}

function fromNpm(): string | null {
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dir = path.join(root, PACKAGE);
    return isPiPackage(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** The pi package directory (the one holding dist/ and node_modules/). */
export const PI_ROOT: string = process.env.PI_PACKAGE_ROOT || fromPath() || fromNpm() || LEGACY;
