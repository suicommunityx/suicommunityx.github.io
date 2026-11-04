import { createHash } from "node:crypto";
import type { ReplayState, TickState } from "./protocol.ts";
import { RULES_VERSION } from "./protocol.ts";

export interface RenderedFile {
  path: string;
  body: string;
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tickObject(tick: TickState): Record<string, unknown> {
  return {
    tick: tick.tick,
    max: tick.max.toString(10),
    lim: tick.lim.toString(10),
    minted: tick.minted.toString(10),
    holder_count: tick.balances.size.toString(10),
    deployer: tick.deployer,
    deploy_checkpoint: tick.deployCheckpoint.toString(10),
    deploy_tx_index: tick.deployTxIndex,
    deploy_event_index: tick.deployEventIndex,
    deploy_digest: tick.deployDigest,
  };
}

function holdersObject(tick: TickState): Record<string, string> {
  const addresses = [...tick.balances.keys()].sort(cmp);
  const holders: Record<string, string> = {};
  for (const address of addresses) {
    holders[address] = tick.balances.get(address)!.toString(10);
  }
  return holders;
}

/** Canonical files. Paths are relative and use `/`. */
export function renderState(state: ReplayState): RenderedFile[] {
  const names = [...state.ticks.keys()].sort(cmp);
  const ticks: Record<string, unknown> = {};
  for (const name of names) ticks[name] = tickObject(state.ticks.get(name)!);

  const files: RenderedFile[] = [
    {
      path: "ticks.json",
      body: json({ rules: RULES_VERSION, ticks }),
    },
  ];
  for (const name of names) {
    const tick = state.ticks.get(name)!;
    files.push({
      path: `holders/${name}.json`,
      body: json({
        rules: RULES_VERSION,
        tick: name,
        minted: tick.minted.toString(10),
        holders: holdersObject(tick),
      }),
    });
  }
  files.sort((a, b) => cmp(a.path, b.path));
  return files;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `snapshot.sha256` covers every other rendered file, in path order. */
export function renderSnapshot(files: RenderedFile[]): string {
  const lines = [`# ${RULES_VERSION}`];
  for (const file of [...files].sort((a, b) => cmp(a.path, b.path))) {
    lines.push(`${sha256(file.body)}  ${file.path}`);
  }
  return `${lines.join("\n")}\n`;
}

export function withSnapshot(files: RenderedFile[]): RenderedFile[] {
  return [...files, { path: "snapshot.sha256", body: renderSnapshot(files) }];
}

/** One hash of the full output, including snapshot.sha256. */
export function outputHash(files: RenderedFile[]): string {
  const all = withSnapshot(files);
  const joined = all
    .sort((a, b) => cmp(a.path, b.path))
    .map((file) => `${file.path}\n${file.body}`)
    .join("");
  return sha256(joined);
}