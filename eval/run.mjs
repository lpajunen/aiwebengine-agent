#!/usr/bin/env node
// Runs the evaluation suite against a deployed agent.
//
//   ENGINE_URL=https://engine.example ENGINE_COOKIE='__Host-session=...' \
//     node eval/run.mjs [--only site-01,tool-02] [--keep] [--timeout 600]
//
// For each task it deletes any leftover script, sends the request to the
// agent as a prompt, approves what the run asks to be approved, waits for it
// to finish, then judges the result with what the run never saw: the
// acceptance tests, the registrations `check_script` reports, the files the
// task names and HTTP probes. The probes run after the runner itself
// deploys head, so a draft the agent left pinned behind a stub is judged on
// what it wrote.
//
// The person whose cookie this is must hold the editor role, have stored an
// Anthropic key and granted the agent permission to work while they are away
// (the page at /agent does both).

import {
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const engine = (process.env.ENGINE_URL ?? "").replace(/\/$/, "");
// `/engine/*` answers only on the engine's management hosts, which is usually
// not the host that serves the agent page.
const manage = (process.env.MANAGE_URL ?? engine).replace(/\/$/, "");
const agentScript = process.env.AGENT_SCRIPT ?? "agent";
const cookie = process.env.ENGINE_COOKIE ?? "";
if (!engine || !cookie) {
  console.error(
    "Set ENGINE_URL and ENGINE_COOKIE (the signed-in session cookie).",
  );
  process.exit(2);
}
const only = option("only", "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const timeoutMs = Number(option("timeout", "600")) * 1000;
const keep = flag("keep");
// "author" runs build a script with the authoring tools; "chat" is today's
// general agent, for comparing against.
const kind = option("kind", "author");

async function call(path, init = {}) {
  const base = path.startsWith("/engine/") ? manage : engine;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      cookie,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const operation = (name, body) =>
  call(`/engine/${name}`, { method: "POST", body: JSON.stringify(body) });

function loadTasks() {
  const root = join(here, "tasks");
  return readdirSync(root)
    .sort()
    .filter((id) => !only.length || only.includes(id))
    .map((id) => {
      const task = JSON.parse(
        readFileSync(join(root, id, "task.json"), "utf8"),
      );
      const acceptance = join(root, id, "acceptance.test.ts");
      task.acceptance = existsSync(acceptance)
        ? readFileSync(acceptance, "utf8")
        : null;
      return task;
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the run and carry it to the end, approving plans as they are asked. */
async function runAgent(task) {
  const prompt = `${task.request}\n\nCall the script "${task.script}".`;
  const started = await call("/agent/prompt", {
    method: "POST",
    body: JSON.stringify({ prompt, kind }),
  });
  if (started.status !== 202) {
    return {
      ok: false,
      reason: `prompt refused: ${JSON.stringify(started.body)}`,
    };
  }
  const runId = started.body.runId;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const { body } = await call("/agent/history");
    last = body;
    if (body.runId !== runId) continue;
    if (body.pendingPlan) {
      await call("/agent/decide", {
        method: "POST",
        body: JSON.stringify({ runId, decision: "approve" }),
      });
      continue;
    }
    if (body.runState === "done" || body.runState === "cancelled") break;
  }
  if (!last || last.runState === "running" || last.runState === "waiting") {
    await call("/agent/cancel", {
      method: "POST",
      body: JSON.stringify({ runId }),
    });
    return { ok: false, reason: "timed out", runId, history: last };
  }
  const errors = (last.activities ?? []).filter(
    (a) => a.runId === runId && a.kind === "error",
  );
  return {
    ok: errors.length === 0,
    reason: errors.map((e) => e.message).join("; "),
    runId,
    history: last,
  };
}

function costOf(history) {
  const spend = history?.spend;
  const prices = history?.pricing;
  if (!spend) return { turns: 0, tokens: 0, cost: null };
  const tokens = spend.cached + spend.wrote + spend.fresh + spend.output;
  let cost = null;
  if (prices && typeof prices.freshPerM === "number") {
    cost =
      (spend.fresh * prices.freshPerM +
        spend.output * prices.outputPerM +
        spend.cached * prices.cacheReadPerM +
        spend.wrote * prices.cacheWritePerM) /
      1e6;
  }
  return { turns: spend.turns, tokens, cost };
}

async function probe(p) {
  const init = { method: p.method };
  if (p.json !== undefined) init.body = JSON.stringify(p.json);
  // Probes are what an anonymous visitor would send.
  const response = await fetch(`${engine}${p.path}`, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  const text = await response.text();
  const failures = [];
  if (response.status !== p.status)
    failures.push(`status ${response.status}, wanted ${p.status}`);
  for (const needle of p.bodyIncludes ?? []) {
    if (!text.includes(needle))
      failures.push(`body lacks ${JSON.stringify(needle)}`);
  }
  for (const needle of p.bodyExcludes ?? []) {
    if (text.includes(needle))
      failures.push(`body contains ${JSON.stringify(needle)}`);
  }
  if (p.jsonEquals !== undefined) {
    try {
      if (
        JSON.stringify(sorted(JSON.parse(text))) !==
        JSON.stringify(sorted(p.jsonEquals))
      ) {
        failures.push(
          `json ${text.slice(0, 200)}, wanted ${JSON.stringify(p.jsonEquals)}`,
        );
      }
    } catch {
      failures.push("body is not JSON");
    }
  }
  return { probe: `${p.method} ${p.path}`, failures };
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}

async function judge(task) {
  const failures = [];
  const exists = await operation("list_files", { script: task.script });
  if (exists.status !== 200) return ["the script does not exist"];

  // The acceptance tests go in after the run, so the run cannot have seen
  // them, and come out again afterwards.
  if (task.acceptance) {
    await operation("write_file", {
      script: task.script,
      path: "acceptance.test.ts",
      text: task.acceptance,
      reinit: "never",
    });
  }
  const tests = await operation("run_tests", { script: task.script });
  if (task.acceptance) {
    await operation("delete_file", {
      script: task.script,
      path: "acceptance.test.ts",
    });
  }
  const report = tests.body ?? {};
  if (report.success !== true) {
    const failed = (report.cases ?? []).filter((c) => c.status !== "passed");
    failures.push(
      `tests: ${report.passed ?? 0}/${report.total ?? 0} passed` +
        (failed[0]
          ? `; first failure: ${failed[0].name}: ${String(failed[0].error).slice(0, 200)}`
          : ""),
    );
  } else if (
    (report.total ?? 0) <
    (task.minTests ?? 0) + (task.acceptance ? 1 : 0)
  ) {
    failures.push(
      `only ${report.total} test cases; the task asks for its own tests too`,
    );
  }

  const check = await operation("check_script", { script: task.script });
  const registrations = check.body?.registrations ?? [];
  if (check.body?.ok !== true) {
    const errors = (check.body?.diagnostics ?? []).filter(
      (d) => d.severity === "error",
    );
    failures.push(
      `check_script: ${errors
        .map((d) => `${d.code}: ${d.message}`)
        .join(" | ")
        .slice(0, 300)}`,
    );
  }
  for (const want of task.registrations ?? []) {
    const found = registrations.some(
      (r) =>
        r.kind === want.kind &&
        r.name === want.name &&
        (!want.method || r.method === want.method),
    );
    if (!found)
      failures.push(
        `no ${want.kind} ${want.method ?? ""} ${want.name} registered`,
      );
  }

  for (const want of task.files ?? []) {
    const file = await operation("read_file", {
      script: task.script,
      path: want.path,
    });
    const content = String(file.body?.content ?? "");
    if (file.status !== 200) failures.push(`${want.path} is missing`);
    for (const needle of want.contains ?? []) {
      if (file.status === 200 && !content.includes(needle)) {
        failures.push(`${want.path} lacks ${JSON.stringify(needle)}`);
      }
    }
  }

  if (task.probes?.length) {
    // The evaluation approves the deploy; a draft behind a pinned stub is
    // judged on what it wrote, not on the stub.
    await operation("deploy_script", { script: task.script, revision: "head" });
    await sleep(1500);
    for (const p of task.probes) {
      const result = await probe(p);
      for (const failure of result.failures)
        failures.push(`${result.probe}: ${failure}`);
    }
  }
  return failures;
}

/** path -> updatedAt for the agent script's own files. */
async function agentFiles() {
  const listed = await operation("list_files", { script: agentScript });
  return new Map((listed.body?.files ?? []).map((f) => [f.uri, f.updatedAt]));
}

/**
 * A run may write skills into the agent itself, which then shape every later
 * run. Remove the ones this task added; say so when it changed one that
 * existed, which only a pull from the repository restores.
 */
async function cleanAgent(before) {
  const notes = [];
  const after = await agentFiles();
  for (const [path, updatedAt] of after) {
    if (!before.has(path) && path.startsWith("skills/")) {
      await operation("delete_file", { script: agentScript, path });
      notes.push(`removed ${path}`);
    } else if (before.has(path) && before.get(path) !== updatedAt) {
      notes.push(`${path} was modified; pull_from_git force restores it`);
    }
  }
  return notes;
}

const results = [];
const agentBefore = await agentFiles();
for (const task of loadTasks()) {
  console.log(`\n== ${task.id}: ${task.title}`);
  await operation("delete_script", { script: task.script });
  const started = Date.now();
  const run = await runAgent(task);
  const failures = run.runId ? await judge(task) : [run.reason];
  if (!run.ok) failures.unshift(`run: ${run.reason}`);
  const finished = (run.history?.activities ?? []).filter(
    (a) => a.runId === run.runId && a.kind === "done",
  );
  const endReason = finished.length
    ? finished[finished.length - 1].message
    : null;
  const cleaned = await cleanAgent(agentBefore);
  const spend = costOf(run.history);
  const row = {
    id: task.id,
    shape: task.shape,
    passed: failures.length === 0,
    escalated: !run.ok,
    endReason,
    cleaned,
    seconds: Math.round((Date.now() - started) / 1000),
    ...spend,
    failures,
  };
  results.push(row);
  console.log(row.passed ? "PASS" : `FAIL\n  - ${failures.join("\n  - ")}`);
  console.log(
    `  turns ${row.turns}, tokens ${row.tokens}, cost ${row.cost === null ? "?" : "$" + row.cost.toFixed(3)}`,
  );
  if (!keep) await operation("delete_script", { script: task.script });
}

const passed = results.filter((r) => r.passed);
const sum = (rows, key) => rows.reduce((total, r) => total + (r[key] ?? 0), 0);
const summary = {
  tasks: results.length,
  passed: passed.length,
  passRate: results.length ? passed.length / results.length : 0,
  turnsPerPassed: passed.length ? sum(passed, "turns") / passed.length : null,
  costPerPassed: passed.length ? sum(passed, "cost") / passed.length : null,
  escalated: results.filter((r) => r.escalated).length,
};
console.log("\n" + JSON.stringify(summary, null, 2));

mkdirSync(join(here, "results"), { recursive: true });
const file = join(
  here,
  "results",
  `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(file, JSON.stringify({ summary, results }, null, 2) + "\n");
console.log(`written ${file}`);
