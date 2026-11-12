// Regression test: a meta-goal must produce instructions for the user — not
// fake execution, invented context, or off-topic web sources.
// Run: node scripts/test-meta-goal.mjs   (dev server must be running)

const GOAL =
  "Run a quick test of the pipeline. Send 3 requests to /api/tasks and report the results. Do it.";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

async function main() {
  console.log(`POST ${BASE}/api/tasks`);
  console.log(`goal: ${GOAL}\n`);

  const res = await fetch(`${BASE}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: GOAL }),
  });
  if (!res.ok) {
    console.error(`FAIL: HTTP ${res.status} — ${await res.text()}`);
    process.exit(1);
  }

  const raw = await res.text();
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch {}
  }

  const run = events.find((e) => e.id?.startsWith("task_"));
  const final = run?.final ?? events.find((e) => e.type === "final")?.text ?? "";
  const subtasks = run?.subtasks ?? [];
  const sources = run?.sources ?? [];
  const warnings = run?.warnings ?? [];

  console.log("=== EVENTS ===");
  for (const e of events) {
    if (e.type) console.log(`  ${e.type}${e.id ? ` ${e.id}` : ""}${e.reason ? ` (${e.reason.slice(0, 80)})` : ""}${e.error ? ` (${e.error.slice(0, 80)})` : ""}`);
  }
  console.log("\n=== SUBTASKS ===");
  for (const s of subtasks) console.log(`  ${s.id} ${s.agent} → ${s.status}`);
  console.log("\n=== WARNINGS ===");
  warnings.forEach((w) => console.log(`  - ${w}`));
  console.log("\n=== SOURCES ===");
  sources.forEach((s, i) => console.log(`  [${i + 1}] ${s.title} — ${s.url}`));
  console.log("\n=== FINAL ANSWER ===");
  console.log(final);
  console.log("\n=== CHECKS ===");

  const checks = [];
  const allText = JSON.stringify(run ?? {});

  checks.push(["final answer arrived", Boolean(final.trim())]);
  checks.push([
    "no off-topic sources (songs/music/lyrics)",
    !sources.some((s) => /song|lyric|music|spotify|doit\.intl/i.test(`${s.title} ${s.url}`)),
  ]);
  checks.push([
    "no S3/bucket mentions",
    !/s3|bucket/i.test(allText),
  ]);
  checks.push([
    "no credential asks in final",
    !/(provide|enter|give|share|send|tell me|what is|need(ed)?)\s+(us\s+|me\s+|your\s+|the\s+)?(api[_ ]?key|secret|credential|password|token|bucket)/i.test(final),
  ]);
  checks.push([
    "no fake execution claims in final",
    !/\bI (ran|sent|executed|tested|called|invoked|curl)/i.test(final) &&
      !/POST \/api\/tasks 20\d/i.test(final),
  ]);
  checks.push([
    "final frames steps as user-run instructions",
    /(you|the user)\s+(must|need|should|can|have to)|to be run by (the )?user|run (these|the) (steps|commands|requests)|follow (these|the) steps|instructions? (for|to) (the )?user/i.test(final),
  ]);

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) fail++;
  }
  console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} CHECK(S) FAILED`}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
