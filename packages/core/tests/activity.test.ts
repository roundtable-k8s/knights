import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  activitySubject,
  boundText,
  classifyError,
  containsSecret,
  encodeEvent,
  getActivity,
  listInflight,
  MAX_ARGS_CHARS,
  MAX_EVENT_BYTES,
  MAX_EVENTS_PER_SEC,
  MAX_PREVIEW_CHARS,
  natsPrefix,
  podIdentity,
  redactSecrets,
  SECRET_RULES,
  summarizeArgs,
  TaskActivity,
  type TaskActivityInit,
} from "../src/activity.ts";

type Pub = { subject: string; raw: string; ev: Record<string, any> };

function make(out: Pub[], extra: Partial<TaskActivityInit> = {}) {
  return new TaskActivity({
    knight: "Galahad",
    prefix: "rt",
    taskId: "t1",
    identity: { pod: "pod-a", node: "node-1" },
    runId: "run-1",
    model: "m",
    publish: (subject, raw) => out.push({ subject, raw, ev: JSON.parse(raw) }),
    now: () => 1_000_000,
    ...extra,
  });
}

// ─── Redaction: one case per pattern (union of pi-knight hooks.ts and claude-knight activity.ts) ───

const LEAKS: Array<[name: string, input: string, secret: string]> = [
  ["PEM private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretbody\n-----END RSA PRIVATE KEY-----", "MIIEsecretbody"],
  ["PEM block cut before END", "-----BEGIN PRIVATE KEY-----\nMIIEtruncatedbody", "MIIEtruncatedbody"],
  ["PEM BEGIN line (pi-knight)", "-----BEGIN OPENSSH PRIVATE KEY-----", "BEGIN OPENSSH PRIVATE KEY"],
  ["Authorization header", "Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["Proxy-Authorization header", "Proxy-Authorization: Basic cHJveHk6cGFzcw==", "cHJveHk6cGFzcw"],
  ["Bearer token", "curl -H 'x: Bearer abcdefghijklmnop1234'", "abcdefghijklmnop1234"],
  ["Anthropic key", "key sk-ant-api03-abcdefghijklmnop", "sk-ant-api03"],
  ["OpenAI-style key", "key sk-proj_abcdefghijklmnopqr", "sk-proj_abcdefghijklmnopqr"],
  ["OpenAI key, 40+ chars (pi-knight)", `x=sk-${"A".repeat(48)}`, "A".repeat(40)],
  ["GitHub token gh[pousr]_", `gho_${"b".repeat(30)}`, "gho_bbbb"],
  ["GitHub PAT with underscores (pi-knight)", `ghp_${"c".repeat(20)}_${"c".repeat(20)}`, "c".repeat(20)],
  ["GitHub app token (pi-knight)", `ghs_${"d".repeat(36)}`, "ghs_dddd"],
  ["fine-grained GitHub PAT", `github_pat_${"e".repeat(30)}`, "github_pat_eee"],
  ["Slack token", "xoxp-1234567890-abcdef", "xoxp-1234567890"],
  ["short Slack bot token (pi-knight)", "xoxb-12345", "xoxb-12345"],
  ["AWS access key id", "AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ["AWS access key id inside a word (pi-knight)", "idAKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz", "eyJhbGciOiJIUzI1NiJ9"],
  ["credentials in a URL", "https://user:pa55word@example.com/x", "pa55word"],
  ["TOKEN=value env line", "CLAUDE_CODE_OAUTH_TOKEN=oauth-value-123", "oauth-value-123"],
  ["JSON password field", '{"password": "hunter2hunter2"}', "hunter2"],
  ["api_key = long value (pi-knight)", `bearer=${"Z".repeat(24)}`, "Z".repeat(20)],
];

for (const [name, input, secret] of LEAKS) {
  test(`redactSecrets: ${name}`, () => {
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
    assert.match(out, /\[REDACTED\]/);
    assert.equal(containsSecret(input), true);
  });
}

test("every secret rule has a redaction case above", () => {
  for (const { re } of SECRET_RULES) {
    const hit = LEAKS.some(([, input]) => {
      re.lastIndex = 0;
      return re.test(input);
    });
    assert.ok(hit, `no test case for ${re}`);
  }
});

test("redaction keeps the header name, URL scheme and key", () => {
  assert.equal(redactSecrets("Authorization: Bearer abcdefghij"), "Authorization: [REDACTED]");
  assert.equal(redactSecrets("https://u:p@h/x"), "https://[REDACTED]@h/x");
  assert.equal(redactSecrets("GITHUB_TOKEN=xyz"), "GITHUB_TOKEN=[REDACTED]");
});

test("redaction is stable across repeated calls (global regex lastIndex)", () => {
  const text = `token ghp_${"a".repeat(36)}`;
  for (let i = 0; i < 4; i++) assert.equal(containsSecret(text), true, `call ${i}`);
  assert.equal(containsSecret("nothing to see"), false);
});

test("the tokens scope redacts token-shaped secrets but not key=value context", () => {
  assert.equal(redactSecrets(`a ghp_${"b".repeat(36)} b AKIAABCDEFGHIJKLMNOP`, "tokens"), "a [REDACTED] b [REDACTED]");
  const code = "password = os.environ['PASSWORD']\nAuthorization: header";
  assert.equal(redactSecrets(code, "tokens"), code);
  assert.notEqual(redactSecrets(code), code);
});

// ─── Bounds ───

test("boundText truncates to the limit and flags it", () => {
  const p = boundText("x".repeat(2000), MAX_PREVIEW_CHARS);
  assert.equal(p.text.length, 500);
  assert.equal(p.truncated, true);
  assert.deepEqual(boundText("short", MAX_PREVIEW_CHARS), { text: "short", truncated: false });
});

test("boundText never leaves half a surrogate pair at the cut", () => {
  for (const text of ["a".repeat(9) + "😀" + "b".repeat(20), "😀".repeat(50)]) {
    const p = boundText(text, 10);
    assert.equal(p.truncated, true);
    assert.ok(!p.text.includes("\ufffd"));
    assert.ok(!/[\ud800-\udbff]$/.test(p.text));
    assert.ok(p.text.length <= 10);
  }
  // The pre-cut at max * 8 lands inside a pair as well.
  const pre = boundText("a".repeat(79) + "😀" + "b".repeat(50), 10);
  assert.equal(pre.text, "a".repeat(10)); // the lone high half at index 79 (the pre-cut at 80 ends just after it) is dropped, not kept
});

test("a secret straddling the preview limit is not half-leaked", () => {
  const text = "a".repeat(MAX_PREVIEW_CHARS - 10) + ` api_key=${"Z".repeat(40)}`;
  assert.ok(!boundText(text, MAX_PREVIEW_CHARS).text.includes("ZZZZ"));
});

test("summarizeArgs prefers the telling field and never includes file content or credentials", () => {
  assert.deepEqual(summarizeArgs({ command: "npm test", env: { SECRET: "s" } }), { text: "npm test", truncated: false });
  const s = summarizeArgs({ dest: "/a", content: "SECRET BODY", headers: { Authorization: "x" } }).text;
  assert.ok(s.includes("dest=/a"));
  assert.ok(!s.includes("SECRET BODY") && !s.includes("Authorization"));
  assert.equal(summarizeArgs({ command: "y".repeat(5000) }).text.length, MAX_ARGS_CHARS);
});

test("oversized events are shed below 8 KiB", () => {
  const json = encodeEvent({ v: 1, type: "tool.finished", ts: "t", knight: "k", pod: "p", taskId: "t", seq: 1, outputPreview: "x".repeat(20_000) });
  assert.ok(Buffer.byteLength(json) <= MAX_EVENT_BYTES);
  assert.equal(JSON.parse(json).truncated, true);
  assert.equal(JSON.parse(json).outputPreview, undefined);
  const huge = encodeEvent({ v: 1, type: "task.started", ts: "t", knight: "k", pod: "p", taskId: "t", seq: 1, model: "m".repeat(20_000) });
  assert.ok(Buffer.byteLength(huge) <= MAX_EVENT_BYTES);
});

// ─── Identity, subjects, error classes ───

test("podIdentity: pod falls back to the hostname, node is omitted when unset", () => {
  assert.deepEqual(podIdentity({}, "h"), { pod: "h" });
  assert.deepEqual(podIdentity({ POD_NAME: "p", NODE_NAME: "n" }, "h"), { pod: "p", node: "n" });
});

test("natsPrefix and activitySubject", () => {
  assert.equal(natsPrefix({ natsResultsPrefix: "rt-dev.results" }), "rt-dev");
  assert.equal(activitySubject("rt", "Galahad", "chain-dev-plan-123"), "rt.activity.Galahad.chain-dev-plan-123");
  assert.equal(activitySubject("rt", "Gala had", "a.b*>"), "rt.activity.Gala_had.a_b__");
});

test("classifyError maps to the v1 errorClass values", () => {
  assert.equal(classifyError("Task timed out after 30m"), "timeout");
  assert.equal(classifyError("The operation was aborted"), "cancelled");
  assert.equal(classifyError("429 rate limit from provider"), "model_error");
  assert.equal(classifyError("tool failed"), "tool_error");
  assert.equal(classifyError("boom"), "other");
});

// ─── TaskActivity ───

test("events carry identity and a seq starting at 1; previews are redacted and bounded", () => {
  const out: Pub[] = [];
  const a = make(out, { chainName: "c", stepName: "s", slot: 0, concurrency: 2, queuedFor: 15 });
  a.started();
  a.toolStarted("u1", "Bash", { command: "echo ghp_" + "z".repeat(40) + " " + "y".repeat(5000), env: { SECRET: "s3cr3t" } });
  a.toolFinished("u1", "Bash", false, "o".repeat(20000));
  a.assistantMessage("hello Authorization: Bearer abcdefghijklmnop1234");
  a.addUsage({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cost: 0.25 });
  a.heartbeat();
  a.finished({ success: true, cost: 0.5, tokens: { input: 20, output: 7 }, turns: 3 });
  assert.deepEqual(out.map((o) => o.ev.type), ["task.started", "tool.started", "tool.finished", "assistant.message", "task.heartbeat", "task.finished"]);
  assert.deepEqual(out.map((o) => o.ev.seq), [1, 2, 3, 4, 5, 6]);
  for (const { subject, raw, ev } of out) {
    assert.equal(subject, "rt.activity.Galahad.t1");
    assert.equal(ev.pod, "pod-a");
    assert.equal(ev.node, "node-1");
    assert.equal(ev.runId, "run-1");
    assert.ok(Buffer.byteLength(raw) <= MAX_EVENT_BYTES);
  }
  const all = JSON.stringify(out);
  for (const leak of ["s3cr3t", "abcdefghijklmnop1234", "ghp_zzz"]) assert.ok(!all.includes(leak), `leaked ${leak}`);
  assert.deepEqual([out[0]!.ev.slot, out[0]!.ev.concurrency, out[0]!.ev.queuedFor], [0, 2, 15]);
  assert.ok(out[1]!.ev.argsSummary.length <= MAX_ARGS_CHARS);
  assert.equal(out[2]!.ev.outputPreview.length, MAX_PREVIEW_CHARS);
  assert.equal(out[2]!.ev.truncated, true);
  assert.deepEqual([out[4]!.ev.turns, out[4]!.ev.inputTokens, out[4]!.ev.outputTokens, out[4]!.ev.cacheWriteTokens, out[4]!.ev.costUsd], [1, 10, 5, 3, 0.25]);
  const fin = out[5]!.ev;
  assert.deepEqual([fin.success, fin.turns, fin.inputTokens, fin.outputTokens, fin.costUsd, fin.errorClass], [true, 3, 20, 7, 0.5, undefined]);
  assert.equal(fin.cacheWriteTokens, undefined);
});

test("heartbeats omit token counters until usage is known", () => {
  const out: Pub[] = [];
  const a = make(out);
  a.heartbeat();
  assert.equal(out[0]!.ev.turns, 0);
  assert.equal(out[0]!.ev.inputTokens, undefined);
  assert.equal(out[0]!.ev.costUsd, undefined);
});

test("rate limit drops tool events above 20/s, never lifecycle events, and consumes no seq", () => {
  const out: Pub[] = [];
  const a = make(out);
  a.started();
  for (let i = 0; i < 50; i++) a.toolStarted(`u${i}`, "Read", { file_path: "/x" });
  a.heartbeat();
  a.finished({ success: false, error: "timed out" });
  assert.equal(out.filter((o) => o.ev.type === "tool.started").length, MAX_EVENTS_PER_SEC);
  assert.equal(out.at(-2)!.ev.type, "task.heartbeat");
  assert.equal(out.at(-1)!.ev.type, "task.finished");
  assert.equal(out.at(-1)!.ev.errorClass, "timeout");
  assert.deepEqual(out.map((o) => o.ev.seq), out.map((_, i) => i + 1));
});

test("the rate limit refills over time", () => {
  const out: Pub[] = [];
  let t = 1_000_000;
  const a = make(out, { now: () => t });
  for (let i = 0; i < 30; i++) a.toolStarted(`a${i}`, "Read", {});
  t += 1000;
  for (let i = 0; i < 30; i++) a.toolStarted(`b${i}`, "Read", {});
  assert.equal(out.length, 2 * MAX_EVENTS_PER_SEC);
});

test("content none omits previews and argument summaries but keeps counters", () => {
  const out: Pub[] = [];
  const a = make(out, { content: "none" });
  a.toolStarted("u", "Bash", { command: "ls" });
  a.toolFinished("u", "Bash", true, "secret output");
  a.assistantMessage("hi");
  a.finished({ success: false, error: "secret error text" });
  for (const { ev } of out) {
    for (const k of ["argsSummary", "outputPreview", "preview", "error"]) assert.equal(ev[k], undefined, `${ev.type}.${k}`);
  }
  assert.equal(out[1]!.ev.isError, true);
  assert.equal(out[3]!.ev.errorClass, "other");
});

test("finished is emitted once; explicit errorClass wins", () => {
  const out: Pub[] = [];
  const a = make(out);
  a.finished({ success: false, error: "timed out", errorClass: "internal" });
  a.finished({ success: false, error: "again" });
  a.heartbeat();
  assert.equal(out.length, 1);
  assert.equal(out[0]!.ev.errorClass, "internal");
});

test("publish failures never throw", () => {
  const a = make([], { publish: () => { throw new Error("down"); } });
  assert.doesNotThrow(() => {
    a.started();
    a.toolStarted("u", "Bash", {});
    a.heartbeat();
    a.finished({ success: false });
  });
});

test("in-flight registry: started registers, finished and close unregister", () => {
  const a = make([], { taskId: "A", chainName: "c", stepName: "s", workDir: "work" });
  const b = make([], { taskId: "B" });
  a.started();
  b.started();
  assert.equal(getActivity("A"), a);
  assert.deepEqual(listInflight().map((t) => t.taskId).sort(), ["A", "B"]);
  const i = listInflight().find((t) => t.taskId === "A")!;
  assert.deepEqual(
    { ...i },
    { taskId: "A", runId: "run-1", chainName: "c", stepName: "s", model: "m", startedAt: new Date(1_000_000).toISOString(), lastHeartbeatAt: new Date(1_000_000).toISOString(), workDir: "work" },
  );
  a.finished({ success: true });
  b.close();
  b.close();
  assert.equal(listInflight().length, 0);
  assert.equal(getActivity("A"), undefined);
});

test("attach follows a session until detach, and listener errors never escape", () => {
  const listeners = new Set<(e: string) => void>();
  const session = { subscribe: (l: (e: string) => void) => (listeners.add(l), () => void listeners.delete(l)) };
  const out: Pub[] = [];
  const a = make(out);
  a.attach(session, (e) => {
    if (e === "bad") throw new Error("mapping");
    a.assistantMessage(e);
  });
  for (const l of listeners) l("one");
  for (const l of listeners) assert.doesNotThrow(() => l("bad"));
  a.detach();
  assert.equal(listeners.size, 0);
  assert.equal(out.length, 1);
  a.attach({}, () => {}); // sessions without subscribe are a no-op
});

// ─── v1 wire format ───

test("every event type the core emits validates against the v1 JSON schema", () => {
  const schema = JSON.parse(readFileSync(new URL("./fixtures/task-activity-events.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  const validate = ajv.compile(schema);

  const out: Pub[] = [];
  const runs: Array<(a: TaskActivity) => void> = [
    (a) => {
      a.started();
      a.toolStarted("c1", "Bash", { command: "x".repeat(1000) });
      a.toolFinished("c1", "Bash", false, "y".repeat(1000));
      a.assistantMessage("z".repeat(1000));
      a.addUsage({ input: 1.5, output: 2, cost: 0.01 });
      a.heartbeat();
      a.toolStarted("c2", "Read", { file_path: "/f" });
      a.heartbeat(); // with currentTool
      a.finished({ success: false, error: "timed out", tokens: { input: 3, output: 4 }, cost: 0.02, turns: 1 });
    },
    (a) => {
      a.started();
      a.toolStarted("c1", "Bash", { command: "ls" });
      a.toolFinished("c1", "Bash", true, "fail");
      a.assistantMessage("hi");
      a.heartbeat();
      a.finished({ success: true });
    },
    (a) => {
      a.started();
      a.toolFinished("c9", "Edit", false, "o".repeat(20_000), 3.7);
      a.finished({ success: true });
    },
  ];
  runs.forEach((run, n) => run(make(out, { taskId: `s${n}`, slot: 1, concurrency: 2, queuedFor: 3.2, chainName: "c", stepName: "s", ...(n === 1 ? { content: "none" as const, identity: { pod: "p" } } : {}) })));

  const types = new Set(out.map((o) => o.ev.type));
  assert.deepEqual([...types].sort(), ["assistant.message", "task.finished", "task.heartbeat", "task.started", "tool.finished", "tool.started"]);
  for (const { raw, ev } of out) {
    assert.ok(validate(ev), `${ev.type} invalid: ${ajv.errorsText(validate.errors)}\n${raw}`);
    assert.ok(Buffer.byteLength(raw) <= MAX_EVENT_BYTES);
  }
});

test("events carry the table when set and omit it otherwise", () => {
  const withTable: Pub[] = [];
  make(withTable, { table: "dev" }).started();
  assert.equal(withTable[0]!.ev["table"], "dev");
  const without: Pub[] = [];
  make(without).started();
  assert.equal("table" in without[0]!.ev, false);
});

test("events carry the traceId when given, identical across the task, and omit it otherwise", () => {
  const id = "4bf92f3577b34da6a3ce929d0e0e4736";
  const out: Pub[] = [];
  const a = make(out, { traceId: id });
  a.started();
  a.toolStarted("c1", "bash", { command: "ls" });
  a.toolFinished("c1", "bash", false, "ok");
  a.finished({ success: true });
  assert.ok(out.length >= 4);
  for (const { ev } of out) assert.equal(ev["traceId"], id);
  const none: Pub[] = [];
  make(none).started();
  assert.equal("traceId" in none[0]!.ev, false);
  const bad: Pub[] = [];
  make(bad, { traceId: "nope" }).started();
  assert.equal("traceId" in bad[0]!.ev, false);
});

test("setTraceId applies to later events and never overwrites", () => {
  const out: Pub[] = [];
  const a = make(out);
  a.setTraceId("4bf92f3577b34da6a3ce929d0e0e4736");
  a.setTraceId("00000000000000000000000000000001");
  a.started();
  assert.equal(out[0]!.ev["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
});

test("task.started carries attempt only for a retry (#36)", () => {
  const out: Pub[] = [];
  make(out, { attempt: 2 }).started();
  assert.equal(out[0]!.ev.attempt, 2);
  const first: Pub[] = [];
  make(first, { attempt: 1 }).started();
  assert.ok(!("attempt" in first[0]!.ev));
  const none: Pub[] = [];
  make(none, {}).started();
  assert.ok(!("attempt" in none[0]!.ev));
});

test("finished carries cacheWriteTokens from the result tokens, and omits them when zero", () => {
  const withWrites: Pub[] = [];
  make(withWrites).finished({ success: true, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  assert.equal(withWrites[0]!.ev.cacheWriteTokens, 4);
  const none: Pub[] = [];
  make(none).finished({ success: true, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 } });
  assert.equal(none[0]!.ev.cacheWriteTokens, undefined);
});
