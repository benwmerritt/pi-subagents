#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const RUNS_DIR = process.env.SUBPI_RUNS_DIR || join(homedir(), ".pi", "agent", "subpi-runs");

function usage() {
  console.log(`subpi / pi-subagent - shell CLI for delegating work to Pi subagents

Usage:
  pi-subagent run [--bg] [--cwd DIR] [--model MODEL] [--context fresh|fork] <agent> <task...>
  pi-subagent parallel [--bg] [--cwd DIR] <agent: task> [<agent: task> ...]
  pi-subagent status [id]
  pi-subagent logs <id> [-n lines]
  pi-subagent result <id>

Examples:
  pi-subagent run scout "map the auth flow"
  pi-subagent run --bg worker "implement the approved plan in docs/plan.md"
  pi-subagent parallel --bg "scout: inspect frontend" "reviewer: review current diff"

Foreground is default. Use --bg to detach and inspect later with status/logs/result.
Runs are tracked under: ${RUNS_DIR}`);
}

function die(message, code = 1) {
  console.error(`pi-subagent: ${message}`);
  process.exit(code);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parseCommon(args) {
  const out = { bg: false, cwd: process.cwd(), model: "", context: "", rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--bg" || arg === "--background") out.bg = true;
    else if (arg === "--cwd") out.cwd = resolve(args[++i] || die("--cwd requires a value", 2));
    else if (arg === "--model") out.model = args[++i] || die("--model requires a value", 2);
    else if (arg === "--context") out.context = args[++i] || die("--context requires fresh or fork", 2);
    else if (arg === "--") out.rest.push(...args.slice(i + 1)), i = args.length;
    else out.rest.push(arg);
  }
  if (out.context && !["fresh", "fork"].includes(out.context)) die("--context must be fresh or fork", 2);
  return out;
}

function promptForRun({ agent, task, context }) {
  const contextLine = context ? `Requested context mode: ${context}.` : "";
  return `You are a delegated Pi subagent launched by the pi-subagent CLI.\n\nRole: ${agent}\n${contextLine}\nTask:\n${task}\n\nRole guidance:\n- scout: read-only codebase reconnaissance; report key files, flows, risks, and open questions.\n- researcher: external/docs research with sources; report evidence, confidence, and gaps.\n- planner: read-only implementation planning; report concrete steps, files, validation, and risks.\n- worker: bounded implementation; edit only within approved scope; stop for unapproved product/security/architecture decisions.\n- reviewer: inspect code/diff; prefer no edits unless explicitly asked; report evidence-backed findings and smallest safe fixes.\n- context-builder: build structured handoff context and meta-prompt material.\n- oracle: challenge assumptions and recommend safest next move without editing.\n- delegate: complete the requested bounded task directly.\n\nOutput requirements:\n- Be concise but complete.\n- Include files inspected/changed, commands run, validation outcome, and residual risks when relevant.\n- If blocked, state the blocker and the exact decision or input needed.`;
}

function promptForParallel({ items }) {
  const lines = items.map((item, index) => `${index + 1}. Agent ${JSON.stringify(item.agent)}: ${item.task}`).join("\n");
  return `You are a thin parent Pi session launched by the pi-subagent CLI.\n\nRun these Pi subagent tasks in parallel using the native pi-subagents capability if available (subagent tool or /parallel equivalent):\n${lines}\n\nRules for this parent session:\n- Delegate the tasks; do not do them yourself unless subagents are unavailable.\n- Return a concise synthesis plus each child result and artifact/session paths if any.`;
}

function piArgsFor(prompt, { model }) {
  const args = ["--name", "subpi", "-p", prompt];
  if (model) args.splice(2, 0, "--model", model);
  return args;
}

function runForeground(prompt, opts) {
  const result = spawnSync("pi", piArgsFor(prompt, opts), { cwd: opts.cwd, stdio: "inherit", env: process.env });
  if (result.error) die(result.error.message);
  process.exit(result.status ?? 1);
}

function ensureRunsDir() {
  mkdirSync(RUNS_DIR, { recursive: true });
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function startBackground(prompt, opts, { print = true } = {}) {
  ensureRunsDir();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const id = `${stamp}-${randomBytes(3).toString("hex")}`;
  const dir = join(RUNS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "output.log");
  const status = join(dir, "status.json");
  const runner = join(dir, "run.sh");
  writeFileSync(join(dir, "prompt.txt"), prompt);
  writeJson(status, { id, state: "starting", cwd: opts.cwd, startedAt: new Date().toISOString(), log });
  const piArgs = piArgsFor(prompt, opts).map(shellQuote).join(" ");
  writeFileSync(runner, `#!/usr/bin/env bash
set -uo pipefail
cd ${shellQuote(opts.cwd)} || exit 1
node -e 'const fs=require("fs"); const p=process.argv[1]; const pid=Number(process.argv[2]); const s=JSON.parse(fs.readFileSync(p,"utf8")); s.state="running"; s.pid=pid; s.startedAt=s.startedAt||new Date().toISOString(); fs.writeFileSync(p, JSON.stringify(s,null,2)+"\\n")' ${shellQuote(status)} $$
pi ${piArgs} > ${shellQuote(log)} 2>&1
code=$?
node -e 'const fs=require("fs"); const p=process.argv[1]; const code=Number(process.argv[2]); const s=JSON.parse(fs.readFileSync(p,"utf8")); s.state=code===0?"completed":"failed"; s.exitCode=code; s.finishedAt=new Date().toISOString(); fs.writeFileSync(p, JSON.stringify(s,null,2)+"\\n")' ${shellQuote(status)} "$code"
exit "$code"
`);
  const child = spawn("bash", [runner], { detached: true, stdio: "ignore" });
  child.unref();
  const s = JSON.parse(readFileSync(status, "utf8"));
  s.launcherPid = child.pid;
  writeJson(status, s);
  const launch = { id, state: "starting", cwd: opts.cwd, log, result: log, status };
  if (print) console.log(JSON.stringify(launch, null, 2));
  return launch;
}

function readStatus(id) {
  const path = join(RUNS_DIR, id, "status.json");
  if (!existsSync(path)) die(`unknown run id: ${id}`, 2);
  return JSON.parse(readFileSync(path, "utf8"));
}

function listStatuses() {
  ensureRunsDir();
  return readdirSync(RUNS_DIR)
    .map((id) => join(RUNS_DIR, id, "status.json"))
    .filter(existsSync)
    .map((p) => JSON.parse(readFileSync(p, "utf8")))
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
}

function handleRun(args) {
  const opts = parseCommon(args);
  const [agent, ...taskParts] = opts.rest;
  if (!agent || taskParts.length === 0) die("run requires <agent> and <task>", 2);
  const prompt = promptForRun({ agent, task: taskParts.join(" "), context: opts.context });
  if (opts.bg) startBackground(prompt, opts);
  else runForeground(prompt, opts);
}

function handleParallel(args) {
  const opts = parseCommon(args);
  if (opts.rest.length === 0) die("parallel requires at least one 'agent: task' item", 2);
  const items = opts.rest.map((raw) => {
    const idx = raw.indexOf(":");
    if (idx === -1) die(`parallel item must look like 'agent: task': ${raw}`, 2);
    return { agent: raw.slice(0, idx).trim(), task: raw.slice(idx + 1).trim() };
  });
  if (opts.bg) {
    const launches = items.map((item) => startBackground(promptForRun({ agent: item.agent, task: item.task, context: opts.context }), opts, { print: false }));
    console.log(JSON.stringify(launches, null, 2));
    return;
  }
  const prompt = promptForParallel({ items });
  runForeground(prompt, opts);
}

function handleLogs(args) {
  const id = args[0] || die("logs requires <id>", 2);
  let lines = 120;
  for (let i = 1; i < args.length; i++) if (args[i] === "-n") lines = Number(args[++i] || lines);
  const s = readStatus(id);
  if (!existsSync(s.log)) die(`log not found: ${s.log}`);
  spawnSync("tail", ["-n", String(lines), s.log], { stdio: "inherit" });
}

function handleResult(args) {
  const id = args[0] || die("result requires <id>", 2);
  const s = readStatus(id);
  if (!existsSync(s.log)) die(`result log not found: ${s.log}`);
  process.stdout.write(readFileSync(s.log, "utf8"));
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help") usage();
else if (cmd === "run") handleRun(args);
else if (cmd === "parallel") handleParallel(args);
else if (cmd === "status") {
  if (args[0]) console.log(JSON.stringify(readStatus(args[0]), null, 2));
  else console.log(JSON.stringify(listStatuses(), null, 2));
} else if (cmd === "logs") handleLogs(args);
else if (cmd === "result") handleResult(args);
else die(`unknown command: ${cmd}`, 2);
