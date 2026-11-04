import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readEnvelope, replayEvents, type InscriptionEvent } from "./protocol.ts";
import { renderState, withSnapshot } from "./render.ts";
import { scanInscriptions } from "./scan.ts";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function usage(): string {
  return `suis-indexer

  replay --input events.jsonl --out DIR
  scan --rpc URL --package 0xPKG --out DIR [--page-size N] [--max-pages N]
  bytes '{"p":"suis-20","op":"mint","tick":"suii","amt":"1000"}'

replay reads a JSON array or JSONL file of InscriptionEvent envelopes.
scan reads sui_getCheckpoint + suix_queryEvents. It does not credit
Operation, OrderDeal, airdrops, or validator callbacks.
`;
}

async function loadRows(file: string): Promise<unknown[]> {
  const text = await readFile(file, "utf8");
  if (file.endsWith(".jsonl")) {
    const rows: unknown[] = [];
    const lines = text.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        rows.push(JSON.parse(line) as unknown);
      } catch {
        throw new Error(`${file}:${i + 1} is not JSON`);
      }
    }
    return rows;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("JSON input must be an array");
  return parsed;
}

async function writeOutput(dir: string, events: InscriptionEvent[]) {
  const files = withSnapshot(renderState(replayEvents(events)));
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const full = path.join(dir, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.body);
  }
  process.stdout.write(`wrote ${files.length} files to ${dir}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === "replay") {
    const input = arg("--input");
    const out = arg("--out");
    if (!input || !out) {
      process.stderr.write(usage());
      process.exitCode = 2;
      return;
    }
    const rows = await loadRows(input);
    await writeOutput(out, rows.map(readEnvelope));
    return;
  }
  if (command === "scan") {
    const rpc = arg("--rpc");
    const packageId = arg("--package");
    const out = arg("--out");
    if (!rpc || !packageId || !out) {
      process.stderr.write(usage());
      process.exitCode = 2;
      return;
    }
    const pageSize = arg("--page-size");
    const maxPages = arg("--max-pages");
    const events = await scanInscriptions({
      rpcUrl: rpc,
      packageId,
      pageSize: pageSize ? Number(pageSize) : undefined,
      maxPages: maxPages ? Number(maxPages) : undefined,
    });
    await writeOutput(out, events);
    return;
  }
  if (command === "bytes") {
    const payload = process.argv[3];
    if (!payload) {
      process.stderr.write(usage());
      process.exitCode = 2;
      return;
    }
    const bytes = [...new TextEncoder().encode(payload)];
    process.stdout.write(`${JSON.stringify(bytes)}\n`);
    return;
  }
  process.stderr.write(usage());
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});