import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyJson } from "../src/jsoncheck.ts";
import {
  EnvelopeError,
  normalizeAddress,
  readEnvelope,
  replayEvents,
  type InscriptionEvent,
} from "../src/protocol.ts";
import { outputHash, renderState, sha256, withSnapshot } from "../src/render.ts";
import { scanInscriptions } from "../src/scan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "events.jsonl");
const A = "0x000000000000000000000000000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000000000000000000000000000c";

async function loadFixture(): Promise<InscriptionEvent[]> {
  const text = await readFile(FIXTURE, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => readEnvelope(JSON.parse(line) as unknown));
}

function balance(events: InscriptionEvent[], tick: string, who: string): bigint {
  const state = replayEvents(events);
  return state.ticks.get(tick)?.balances.get(who) ?? 0n;
}

test("two replays of the fixture hash-equal, including a reversed copy", async () => {
  const events = await loadFixture();
  const first = outputHash(renderState(replayEvents(events)));
  const second = outputHash(renderState(replayEvents(events)));
  const reversed = outputHash(renderState(replayEvents([...events].reverse())));
  assert.equal(first, second);
  assert.equal(first, reversed);

  const files = withSnapshot(renderState(replayEvents(events)));
  const again = withSnapshot(renderState(replayEvents([...events].reverse())));
  assert.deepEqual(
    files.map((file) => [file.path, sha256(file.body)]),
    again.map((file) => [file.path, sha256(file.body)]),
  );
});

test("fixture applies deploy, mint, transfer, and whole-inscription ignores", async () => {
  const events = await loadFixture();
  const state = replayEvents(events);

  const suii = state.ticks.get("suii");
  assert.ok(suii);
  assert.equal(suii.max, 21000000n);
  assert.equal(suii.lim, 1000n);
  assert.equal(suii.minted, 2000n);
  assert.equal(suii.deployer, A);
  assert.equal(suii.deployDigest, "deploy-suii");
  assert.equal(suii.balances.get(A), 2000n);
  assert.equal(suii.balances.has(B), false);

  const upper = state.ticks.get("SUII");
  assert.ok(upper);
  assert.notEqual(upper, suii);
  assert.equal(upper.max, 100n);
  assert.equal(upper.lim, 40n);
  assert.equal(upper.minted, 100n);
  assert.equal(upper.deployer, B);
  assert.equal(upper.balances.get(B), 100n);
  assert.equal(upper.balances.has(A), false);

  const suis = state.ticks.get("suis");
  assert.ok(suis);
  assert.equal(suis.minted, 10n);
  assert.equal(suis.balances.get(A), 10n);
  assert.equal(suis.deployer, A);

  const zero = state.ticks.get("zero");
  assert.ok(zero);
  assert.equal(zero.minted, 0n);
  assert.equal(zero.balances.size, 0);
  assert.equal(zero.deployer, C);

  assert.equal(state.ticks.has("abcd"), false);
  assert.equal(state.ticks.has("abce"), false);
  assert.equal(state.ticks.has("abcf"), false);
  assert.equal(state.ticks.has("ordi"), false);
  assert.equal(state.ticks.size, 4);

  const rendered = renderState(state);
  const ticksFile = rendered.find((file) => file.path === "ticks.json");
  assert.ok(ticksFile);
  const ticksJson = JSON.parse(ticksFile.body) as { rules: string; ticks: Record<string, { holder_count: string }> };
  assert.equal(ticksJson.rules, "suis-20-v1");
  assert.deepEqual(Object.keys(ticksJson.ticks), ["SUII", "suii", "suis", "zero"]);
  assert.equal(ticksJson.ticks.zero.holder_count, "0");
  assert.equal(ticksJson.ticks.suii.holder_count, "1");

  const zeroHolders = rendered.find((file) => file.path === "holders/zero.json");
  assert.ok(zeroHolders);
  assert.match(zeroHolders.body, /"holders": \{\}/);
  assert.equal(balance(events, "suii", C), 0n);
});

test("over-limit mint does not partial-fill, and a later sibling still applies", async () => {
  const events = await loadFixture();
  const state = replayEvents(events);
  assert.equal(state.ticks.get("SUII")?.minted, 100n);
  assert.equal(state.ticks.get("suii")?.minted, 2000n);
});

test("duplicate event positions are rejected", async () => {
  const events = await loadFixture();
  assert.throws(() => replayEvents([...events, events[0]!]), EnvelopeError);
});

test("duplicate JSON keys and the wrong protocol id do not deploy", () => {
  assert.equal(classifyJson('{"a":1,"a":2}'), "dup");
  const sender = A;
  const base = {
    checkpoint: 1n,
    txIndex: 0,
    eventIndex: 0,
    digest: "x",
    sender,
  };
  const dup = replayEvents([
    {
      ...base,
      payload: '{"p":"suis-20","op":"deploy","tick":"dupk","max":"1","lim":"1","p":"suis-20"}',
    },
  ]);
  assert.equal(dup.ticks.size, 0);
  const uint = replayEvents([
    {
      ...base,
      payload: '{"p":"suis-20","op":"deploy","tick":"bigm","max":"340282366920938463463374607431768211456","lim":"1"}',
    },
  ]);
  assert.equal(uint.ticks.size, 0);
});

test("address normalization pads and lowercases", () => {
  assert.equal(normalizeAddress("0xA"), A);
  assert.equal(normalizeAddress("0X1"), null);
  assert.equal(normalizeAddress("0x"), null);
});

test("cli replay twice writes byte-identical trees", async () => {
  const left = await mkdtemp(path.join(tmpdir(), "suis-a-"));
  const right = await mkdtemp(path.join(tmpdir(), "suis-b-"));
  const cli = path.join(HERE, "..", "src", "cli.ts");
  try {
    for (const dir of [left, right]) {
      const run = spawnSync(
        process.execPath,
        ["--experimental-strip-types", cli, "replay", "--input", FIXTURE, "--out", dir],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
    }
    const ticksA = await readFile(path.join(left, "ticks.json"));
    const ticksB = await readFile(path.join(right, "ticks.json"));
    assert.ok(ticksA.equals(ticksB));
    const snapA = await readFile(path.join(left, "snapshot.sha256"), "utf8");
    const snapB = await readFile(path.join(right, "snapshot.sha256"), "utf8");
    assert.equal(snapA, snapB);
    assert.match(snapA, /^# suis-20-v1\n/);
    for (const name of ["SUII", "suii", "suis", "zero"]) {
      const body = await readFile(path.join(left, "holders", `${name}.json`));
      const other = await readFile(path.join(right, "holders", `${name}.json`));
      assert.ok(body.equals(other));
    }
  } finally {
    await rm(left, { recursive: true, force: true });
    await rm(right, { recursive: true, force: true });
  }
});

test("scan decodes vector<u8> payloads and orders by checkpoint transactions", async () => {
  const payload = '{"p":"suis-20","op":"deploy","tick":"scan","max":"5","lim":"1"}';
  const bytes = [...new TextEncoder().encode(payload)];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "suix_queryEvents") {
      return Response.json({
        result: {
          data: [
            {
              id: { txDigest: "D2", eventSeq: "0" },
              sender: A,
              checkpoint: "8",
              parsedJson: {
                sender: A,
                payload: [...new TextEncoder().encode('{"p":"suis-20","op":"mint","tick":"scan","amt":"1"}')],
              },
            },
            {
              id: { txDigest: "D1", eventSeq: "1" },
              sender: A,
              checkpoint: "7",
              parsedJson: { sender: A, payload: bytes },
            },
          ],
          hasNextPage: false,
        },
      });
    }
    if (body.method === "sui_getCheckpoint") {
      const params = (JSON.parse(String(init?.body)) as { params: string[] }).params;
      const txs = params[0] === "7" ? ["D0", "D1"] : ["D2"];
      return Response.json({ result: { transactions: txs } });
    }
    return Response.json({ error: { message: "unexpected" } });
  };

  const events = await scanInscriptions({
    rpcUrl: "http://rpc.test",
    packageId: "0xabc",
    fetchImpl,
  });
  const state = replayEvents(events);
  assert.equal(state.ticks.get("scan")?.minted, 1n);
  assert.equal(state.ticks.get("scan")?.deployTxIndex, 1);
  assert.equal(state.ticks.get("scan")?.deployEventIndex, 1);
  assert.equal(events[0]?.digest, "D1");
  assert.equal(events[1]?.digest, "D2");
});