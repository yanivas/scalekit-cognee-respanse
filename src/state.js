import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(rootDir, ".hackathon-data");
const stateFile = path.join(dataDir, "state.json");

const initialState = {
  repo: null,
  memory: [],
  run: {
    status: "idle",
    keyword: "agent",
    startedAt: null,
    completedAt: null,
    summary: "Run the workflow to scan Slack and process each task automatically.",
    respan: {
      status: "not_run",
      calls: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      models: [],
      traceName: null,
      threadIdentifier: null,
      steps: []
    }
  },
  tasks: [],
  sourcePulls: {},
  accessDemo: null,
  slackFindings: [],
  jiraTicket: null,
  branch: null,
  pullRequest: null,
  events: [
    {
      title: "Ready",
      detail: "Run the workflow to seed context, scan Slack, create Jira, and prepare branches automatically.",
      createdAt: new Date().toISOString()
    }
  ]
};

export async function loadState() {
  try {
    return normalizeState(JSON.parse(await readFile(stateFile, "utf8")));
  } catch {
    await saveState(initialState);
    return structuredClone(initialState);
  }
}

export async function saveState(state) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

export async function resetState() {
  await rm(stateFile, { force: true });
  await saveState(initialState);
}

function normalizeState(state) {
  return {
    ...structuredClone(initialState),
    ...state,
    run: {
      ...initialState.run,
      ...(state.run || {})
    },
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    sourcePulls: state.sourcePulls && typeof state.sourcePulls === "object" ? state.sourcePulls : {},
    accessDemo: state.accessDemo || null,
    slackFindings: Array.isArray(state.slackFindings) ? state.slackFindings : [],
    events: Array.isArray(state.events) ? state.events : initialState.events
  };
}
