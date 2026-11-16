// Phase 0 project-persistence test.
// Creates a throwaway Supabase user, then exercises the projects API
// end-to-end over HTTP and the table directly (RLS checks).
// Usage: node scripts/test-projects.mjs [baseUrl]   (dev server must be running)

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BASE = process.argv[2] ?? "http://localhost:3000";
if (!URL_ || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_* in .env.local");
  process.exit(1);
}

const anon = createClient(URL_, KEY, { auth: { persistSession: false } });
const email = `nova-test-${Date.now()}@example.com`;
const password = "Test!23456789";

let results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

// ---- auth ----
let token = null;
const { data: su } = await anon.auth.signUp({ email, password });
token = su.session?.access_token ?? null;
if (!token) {
  const { data: si } = await anon.auth.signInWithPassword({ email, password });
  token = si.session?.access_token ?? null;
}
check("test user authenticated", Boolean(token));
if (!token) {
  console.error("No session — email confirmation may be required.");
  process.exit(1);
}
const uid = su.user?.id;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// ---- create ----
let r = await api("POST", "/projects", { title: "Phase0 test", width: 800, height: 600, background: "#ffeedd", fps: 24 });
check("POST /api/projects → 201", r.status === 201, JSON.stringify(r.json).slice(0, 80));
const pid = r.json.project?.id;
check("project has uuid + document", /^[0-9a-f-]{36}$/.test(pid ?? "") && r.json.project?.document?.version === 1);

// ---- validation ----
r = await api("POST", "/projects", { width: 0, height: 600 });
check("width=0 rejected", r.status === 400, r.json.error);
r = await api("POST", "/projects", { width: 100, height: 99999 });
check("height>8192 rejected", r.status === 400, r.json.error);
r = await api("POST", "/projects", { width: 640 });
check("missing height rejected", r.status === 400, r.json.error);
r = await api("POST", "/projects", { width: 640, height: 480, background: "red" });
check("non-hex background rejected", r.status === 400, r.json.error);

// ---- retrieve / list ----
r = await api("GET", "/projects");
check("GET /api/projects lists it", r.status === 200 && r.json.projects?.some((p) => p.id === pid));
r = await api("GET", `/projects/${pid}`);
check("GET /api/projects/:id returns full row", r.status === 200 && r.json.project?.width === 800);

// ---- update + restore cycle ----
r = await api("PATCH", `/projects/${pid}`, {
  title: "Renamed",
  background: "#123456",
  fps: 30,
  document: { version: 1, layers: [{ name: "L1" }], frames: [{ ms: 100 }] },
});
check("PATCH saves fields", r.status === 200 && r.json.project?.title === "Renamed");
r = await api("GET", `/projects/${pid}`);
const p2 = r.json.project;
check(
  "restore returns saved values",
  p2?.title === "Renamed" && p2?.background === "#123456" && p2?.fps === 30 &&
    p2?.document?.layers?.length === 1 && p2?.document?.frames?.[0]?.ms === 100
);
r = await api("PATCH", `/projects/${pid}`, { width: -5 });
check("PATCH invalid field rejected", r.status === 400, r.json.error);
r = await api("PATCH", `/projects/${pid}`, {});
check("PATCH empty rejected", r.status === 400, r.json.error);

// ---- ownership / RLS (direct table access) ----
const asUser = createClient(URL_, KEY, {
  global: { headers: { Authorization: `Bearer ${token}` } },
  auth: { persistSession: false },
});
const email2 = `nova-test2-${Date.now()}@example.com`;
const { data: su2 } = await anon.auth.signUp({ email: email2, password });
let token2 = su2.session?.access_token;
if (!token2) {
  const { data: si2 } = await anon.auth.signInWithPassword({ email: email2, password });
  token2 = si2.session?.access_token;
}
const other = createClient(URL_, KEY, {
  global: { headers: { Authorization: `Bearer ${token2}` } },
  auth: { persistSession: false },
});
const { data: stolen, error: stolenErr } = await other.from("projects").select("*").eq("id", pid);
check("other user cannot read project (RLS)", !stolenErr && (stolen ?? []).length === 0);
const { data: stolenPatch } = await other.from("projects").update({ title: "hacked" }).eq("id", pid).select();
check("other user cannot update project (RLS)", (stolenPatch ?? []).length === 0);
r = await api("GET", `/projects/${pid}`, undefined);
const { status: otherGet } = await fetch(`${BASE}/api/projects/${pid}`, {
  headers: { Authorization: `Bearer ${token2}` },
}).then((x) => x.json().then((j) => ({ status: x.status, json: j })));
check("API denies other user", otherGet === 404);

// ---- delete ----
r = await api("DELETE", `/projects/${pid}`);
check("DELETE removes project", r.status === 200);
r = await api("GET", `/projects/${pid}`);
check("deleted project → 404", r.status === 404);
const { data: gone } = await asUser.from("projects").select("id").eq("id", pid);
check("row gone from table", (gone ?? []).length === 0);

// ---- unauthenticated ----
r = await fetch(`${BASE}/api/projects`).then((x) => ({ status: x.status }));
check("unauthenticated → 401", r.status === 401);

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
