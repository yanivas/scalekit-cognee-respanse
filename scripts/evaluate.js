import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scenariosPath = path.join(rootDir, "evals", "scenarios.json");
const resultsDir = path.join(rootDir, "evals", "results");
const baseUrl = process.env.EVAL_BASE_URL || "http://localhost:3000";

const scenarios = JSON.parse(await readFile(scenariosPath, "utf8"));

await api("/api/reset", { method: "POST" });
await api("/api/run-workflow", {
  method: "POST",
  body: { keyword: "agent" }
});
await api("/api/run-access-demo", {
  method: "POST",
  body: { question: "Which Slack request is ready to ship, and what repo context supports it?" }
});
const state = await api("/api/state");

const results = scenarios.map((scenario) => scoreScenario(scenario, state));
const score = results.filter((result) => result.passed).length;
const report = {
  createdAt: new Date().toISOString(),
  baseUrl,
  score,
  total: results.length,
  passRate: Number((score / results.length).toFixed(3)),
  beforeAccessScore: summarize(results.filter((result) => result.type === "access_before")),
  afterAccessScore: summarize(results.filter((result) => result.type === "access_after")),
  results
};

await mkdir(resultsDir, { recursive: true });
await writeFile(path.join(resultsDir, "latest.json"), JSON.stringify(report, null, 2));

console.log(`Eval score: ${score}/${results.length} (${Math.round(report.passRate * 100)}%)`);
console.log(`Before grant: ${report.beforeAccessScore.score}/${report.beforeAccessScore.total}`);
console.log(`After grant: ${report.afterAccessScore.score}/${report.afterAccessScore.total}`);
for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id}${result.reason ? ` - ${result.reason}` : ""}`);
}

async function api(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${route} failed: ${data.error || response.statusText}`);
  }
  return data;
}

function scoreScenario(scenario, state) {
  const target = targetForScenario(scenario, state);
  const text = JSON.stringify(target);
  const sources = new Set(extractSources(target));
  const missingMentions = (scenario.must_mention || []).filter((item) => !includesText(text, item));
  const forbiddenMentions = (scenario.must_not_mention || []).filter((item) => includesText(text, item));
  const missingSources = (scenario.expected_sources || []).filter((item) => !sources.has(item));
  const actionMissing = scenario.expected_action ? !actionPresent(scenario.expected_action, state) : false;

  const failures = [
    ...missingMentions.map((item) => `missing "${item}"`),
    ...forbiddenMentions.map((item) => `should not mention "${item}"`),
    ...missingSources.map((item) => `missing source ${item}`),
    ...(actionMissing ? [`missing action ${scenario.expected_action}`] : [])
  ];

  return {
    id: scenario.id,
    type: scenario.type,
    as_user: scenario.as_user,
    passed: failures.length === 0,
    reason: failures.join("; "),
    observedSources: Array.from(sources),
    expectedSources: scenario.expected_sources || []
  };
}

function targetForScenario(scenario, state) {
  if (scenario.type === "access_before") {
    return (state.accessDemo?.beforeGrant || []).find((item) => item.user?.email === scenario.as_user) || {};
  }
  if (scenario.type === "access_after") {
    return state.accessDemo?.afterGrant || {};
  }
  return {
    run: state.run,
    tasks: state.tasks,
    sourcePulls: state.sourcePulls,
    accessDemo: state.accessDemo
  };
}

function extractSources(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(extractSources);
  return Object.entries(value).flatMap(([key, item]) => {
    const current = key === "sources" && Array.isArray(item) ? item : [];
    if (Array.isArray(item)) return [...current, ...item.flatMap(extractSources)];
    if (item && typeof item === "object") return [...current, ...extractSources(item)];
    if (typeof item === "string" && item.startsWith("source:")) return [item];
    return current;
  });
}

function actionPresent(action, state) {
  if (action === "jira_ticket") return (state.tasks || []).some((task) => task.jiraTicket?.key);
  if (action === "pull_request_payload") return (state.tasks || []).some((task) => task.pullRequest);
  return false;
}

function includesText(text, expected) {
  return text.toLowerCase().includes(String(expected).toLowerCase());
}

function summarize(items) {
  return {
    score: items.filter((item) => item.passed).length,
    total: items.length
  };
}
