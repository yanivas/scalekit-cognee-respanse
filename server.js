import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, publicConfig } from "./src/config.js";
import { createOrLoadDemoRepo, applyLocalFix } from "./src/repoAgent.js";
import { datasetName, rememberDocuments, rememberRepo, recallContext, improveMemory, resetMemory, shareDataset } from "./src/memory.js";
import { classifySlackMessages, draftJiraIssue, draftPrPayload } from "./src/agent.js";
import {
  getAuthorizationLink,
  fetchGitHubContext,
  scanSlack,
  postSlackThreadUpdate,
  createJiraIssue,
  getJiraIssue,
  createGitHubPullRequest
} from "./src/connectors.js";
import { loadState, saveState, resetState } from "./src/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const config = loadConfig();
let workflowQueue = Promise.resolve();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message, stack: config.isDev ? error.stack : undefined });
  }
});

server.listen(config.port, () => {
  console.log(`Scalekit Cognee Respanse running at http://localhost:${config.port}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, publicConfig(config));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, await loadState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    await resetMemory(config);
    await resetState();
    sendJson(res, 200, await loadState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run-workflow") {
    const body = await readJson(req);
    const state = await enqueueWorkflow({
      keyword: body.keyword || "agent"
    }, { wait: true });
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run-access-demo") {
    const body = await readJson(req);
    const state = await runAccessDemo({ question: body.question || "Which Slack request is ready to ship, and what repo context supports it?" });
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/demo-repo") {
    const repo = await createOrLoadDemoRepo(config);
    await rememberRepo(config, repo.path);
    const state = await loadState();
    state.repo = repo;
    state.memory = await recallContext(config, "AGENTS bug feature request issue parser");
    await announce(state, "Cognee memory loaded", "AGENTS.md and demo repo context are now indexed.");
    await saveState(state);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth-link") {
    const body = await readJson(req);
    const link = await getAuthorizationLink(config, body.connectionName, body.identifier || config.primaryUser.identifier);
    sendJson(res, 200, link);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scan-slack") {
    const body = await readJson(req);
    const rawMessages = await scanSlack(config, body.keyword || "", { identifier: body.identifier || config.primaryUser.identifier });
    const classified = await classifySlackMessages(config, rawMessages);
    const state = await loadState();
    state.slackFindings = classified;
    await announce(state, "Slack scan complete", `${classified.length} actionable message(s) found in #${config.slack.channelName}.`);
    await saveState(state);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/create-ticket") {
    const body = await readJson(req);
    const state = await loadState();
    const finding = state.slackFindings.find((item) => item.id === body.findingId);
    if (!finding) throw new Error("Finding not found");

    const context = await recallContext(config, `${finding.title} ${finding.summary}`);
    const issueDraft = await draftJiraIssue(config, finding, context);
    const createdIssue = await createJiraIssue(config, issueDraft);
    const slackThread = {
      channel: config.slack.channelId,
      threadTs: finding.ts,
      sourceText: finding.sourceText
    };
    state.jiraTicket = { ...createdIssue, draft: issueDraft, status: "To Do", comments: [], slackThread };
    await announce(
      state,
      "Jira ticket ready",
      `${state.jiraTicket.key} created/drafted as ${issueDraft.issue_type}.`,
      `:ticket: Created Jira *${state.jiraTicket.key}* (${issueDraft.issue_type}): ${issueDraft.summary}`
    );
    await saveState(state);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/add-comment") {
    const body = await readJson(req);
    const state = await loadState();
    const task = body.taskId ? state.tasks.find((item) => item.id === body.taskId) : null;
    const ticket = task?.jiraTicket || state.jiraTicket;
    if (!ticket) throw new Error("Create a Jira ticket first");
    ticket.comments.push({
      author: body.author || "Jira user",
      body: body.body || "",
      createdAt: new Date().toISOString()
    });
    if (task) {
      taskLog(task, "Jira comment observed", "The latest comment is attached to this task log.");
    }
    await announce(
      state,
      "Jira comment observed",
      "The agent will use the latest comments when coding starts.",
      `:speech_balloon: Jira comment observed from ${body.author || "Jira user"}. I will include it when coding starts.`
    );
    await saveState(state);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sync-slack-thread") {
    const state = await loadState();
    if (!state.slackFindings?.length) throw new Error("Scan Slack first");
    const activeEvents = eventsForActiveRun(state);
    const lines = activeEvents
      .slice()
      .reverse()
      .map((item) => `• ${item.title}: ${item.detail}`)
      .join("\n");
    await postSlackThreadUpdate(
      config,
      slackThreadForState(state),
      `:memo: *Agent status log*\n${lines || "No status events yet."}`
    );
    await announce(state, "Slack thread synced", "Posted the current agent status log back to the original Slack thread.");
    await saveState(state);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/move-ticket") {
    const state = await loadState();
    if (!state.jiraTicket) throw new Error("Create a Jira ticket first");
    state.jiraTicket.status = "In Progress";
    await announce(
      state,
      "Status trigger fired",
      `${state.jiraTicket.key} moved from To Do to In Progress.`,
      `:rocket: *${state.jiraTicket.key}* moved to *In Progress*. Starting implementation when asked.`
    );
    await saveState(state);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/poll-ticket") {
    const state = await loadState();
    if (!state.jiraTicket) throw new Error("Create a Jira ticket first");
    const remote = await getJiraIssue(config, state.jiraTicket.key);
    if (remote?.status) state.jiraTicket.status = remote.status;
    await announce(
      state,
      "Jira status checked",
      `${state.jiraTicket.key} is ${state.jiraTicket.status}.`,
      `:mag: Checked Jira: *${state.jiraTicket.key}* is *${state.jiraTicket.status}*.`
    );
    await saveState(state);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/start-coding") {
    const state = await loadState();
    if (!state.repo?.path) throw new Error("Seed the demo repo first");
    if (!state.jiraTicket) throw new Error("Create a Jira ticket first");
    if (state.jiraTicket.status !== "In Progress") {
      throw new Error("Ticket must be In Progress before the agent writes code");
    }

    await announce(
      state,
      "Coding started",
      `Starting local code work for ${state.jiraTicket.key}.`,
      `:hammer_and_wrench: Starting code work for *${state.jiraTicket.key}*. I am using repo context and Jira details now.`
    );
    const context = await recallContext(config, `${state.jiraTicket.draft.summary} ${state.jiraTicket.draft.description}`);
    const result = await applyLocalFix(config, state.repo.path, state.jiraTicket, context);
    await improveMemory(config, {
      type: "code_change",
      title: state.jiraTicket.draft.summary,
      body: `Branch ${result.branch} changed ${result.changedFiles.join(", ")}`
    });
    const prDraft = await draftPrPayload(config, state.jiraTicket, result);
    let pr;
    try {
      pr = await createGitHubPullRequest(config, prDraft);
    } catch (error) {
      pr = {
        mode: "local",
        ...prDraft,
        note: "Local branch is ready. Push it before creating the GitHub PR.",
        githubError: error.message
      };
      await announce(
        state,
        "GitHub PR deferred",
        "The branch is local, so the app saved a PR payload instead of failing the coding step.",
        `:twisted_rightwards_arrows: Code is committed locally on \`${result.branch}\`. PR creation is deferred until that branch is pushed to GitHub.`
      );
    }

    state.branch = result;
    state.pullRequest = pr;
    await announce(
      state,
      "Local branch ready",
      `${result.branch} contains a focused fix and PR payload.`,
      `:white_check_mark: Local branch ready: \`${result.branch}\`. Changed files: ${result.changedFiles.join(", ")}. Tests passed and PR payload is prepared.`
    );
    await saveState(state);
    sendJson(res, 200, state);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream" });
    res.end(data);
  } catch {
    const data = await readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  }
}

async function readJson(req) {
  const raw = await readText(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function event(title, detail, level = "info") {
  return { title, detail, level, createdAt: new Date().toISOString() };
}

async function announce(state, title, detail, slackText = null) {
  state.events.unshift(event(title, detail));
  if (!slackText) return;

  try {
    await postSlackThreadUpdate(config, slackThreadForState(state), slackText);
  } catch (error) {
    console.warn(`Slack thread update failed for "${title}": ${error.message}`);
  }
}

function enqueueWorkflow(input, options = {}) {
  const run = workflowQueue.then(
    () => runWorkflow(input),
    () => runWorkflow(input)
  );
  workflowQueue = run.catch((error) => {
    console.error(`Queued workflow failed: ${error.message}`);
  });
  return options.wait ? run : run.catch((error) => {
    console.error(`Background workflow failed: ${error.message}`);
  });
}

async function runWorkflow({ keyword = "agent" }) {
  const state = await loadState();
  const startedAt = new Date().toISOString();

  state.run = {
    status: "running",
    keyword,
    startedAt,
    completedAt: null,
    summary: "Scanning Slack and processing tasks.",
    respan: emptyRespanSummary(config, "running", startedAt)
  };
  state.tasks = [];
  state.slackFindings = [];
  state.jiraTicket = null;
  state.branch = null;
  state.pullRequest = null;
  state.events = [];

  try {
    await announce(state, "Workflow started", `Scanning #${config.slack.channelName} for "${keyword}".`);

    if (!state.repo?.path) {
      const repo = await createOrLoadDemoRepo(config);
      await rememberRepo(config, repo.path, { userEmail: config.primaryUser.email });
      state.repo = repo;
      state.memory = await recallContext(config, "AGENTS bug feature request issue parser", { userEmail: config.primaryUser.email });
      await announce(state, "Cognee memory loaded", "AGENTS.md and demo repo context are indexed.");
    }

    const rawMessages = await scanSlack(config, keyword, { identifier: config.primaryUser.identifier });
    const githubContext = await fetchGitHubContext(config, { identifier: config.primaryUser.identifier });
    await rememberWorkflowSources(state, rawMessages, githubContext, config.primaryUser);
    const classified = await classifySlackMessages(config, rawMessages, { runId: startedAt });
    state.slackFindings = classified;
    await announce(state, "Slack scan complete", `${classified.length} actionable message(s) found in #${config.slack.channelName}.`);

    for (const finding of classified) {
      const task = createTask(finding);
      state.tasks.push(task);
      await processTask(state, task, finding, startedAt);
    }

    const failedCount = state.tasks.filter((task) => task.status === "failed").length;
    state.run.respan = summarizeRespanUsage(state.tasks, config, startedAt);
    state.run.status = failedCount ? "needs_attention" : "complete";
    state.run.completedAt = new Date().toISOString();
    state.run.summary = failedCount
      ? `${state.tasks.length - failedCount}/${state.tasks.length} task(s) completed; ${failedCount} need attention.`
      : `${state.tasks.length} task(s) completed automatically.`;
    state.run.summary = `${state.run.summary} ${respanSummaryText(state.run.respan)}`;
    await announce(state, "Workflow complete", state.run.summary);
  } catch (error) {
    state.run.respan = summarizeRespanUsage(state.tasks, config, startedAt);
    state.run.status = "failed";
    state.run.completedAt = new Date().toISOString();
    state.run.summary = error.message;
    await announce(state, "Workflow failed", error.message);
  }

  await saveState(state);
  return state;
}

async function runAccessDemo({ question }) {
  const state = await loadState();
  const startedAt = new Date().toISOString();
  const [alice, bob] = [config.primaryUser, config.sharedUser];
  const aliceDataset = datasetName(config, alice.email, "engineering");
  const bobDataset = datasetName(config, bob.email, "engineering");

  state.accessDemo = {
    status: "running",
    question,
    startedAt,
    completedAt: null,
    users: [alice, bob],
    beforeGrant: [],
    afterGrant: null,
    datasets: { alice: aliceDataset, bob: bobDataset }
  };

  try {
    if (!state.repo?.path) {
      state.repo = await createOrLoadDemoRepo(config);
    }

    const aliceSlack = await scanSlack(config, "agent", { identifier: alice.identifier });
    const aliceGitHub = await fetchGitHubContext(config, { identifier: alice.identifier });
    await rememberWorkflowSources(state, aliceSlack, aliceGitHub, alice);

    const bobSlack = await scanSlack(config, "feature", { identifier: bob.identifier });
    await rememberWorkflowSources(state, bobSlack, [], bob);

    const aliceContext = await recallContext(config, question, { userEmail: alice.email, datasets: [aliceDataset] });
    const bobContext = await recallContext(config, question, { userEmail: bob.email, datasets: [bobDataset] });

	    state.accessDemo.beforeGrant = [
	      {
	        user: alice,
	        dataset: aliceDataset,
	        answer: answerFromContext(question, aliceContext),
	        sources: Array.from(new Set([...sourceTags(aliceContext), ...sourcePullTags(state, alice.email)]))
	      },
	      {
	        user: bob,
	        dataset: bobDataset,
	        answer: answerFromContext(question, bobContext),
	        sources: Array.from(new Set([...sourceTags(bobContext), ...sourcePullTags(state, bob.email)]))
	      }
	    ];

	    const grant = await shareDataset(config, {
	      datasetName: aliceDataset,
	      ownerEmail: alice.email,
	      targetEmail: bob.email
	    });
	    const bobAfterContext = await recallContext(config, question, {
	      userEmail: bob.email
	    });
	    state.accessDemo.afterGrant = {
	      user: bob,
	      grant,
	      answer: answerFromContext(question, bobAfterContext),
	      sources: Array.from(new Set([...sourceTags(bobAfterContext), ...sourcePullTags(state, bob.email), ...sourcePullTags(state, alice.email)]))
	    };
    state.accessDemo.status = "complete";
    state.accessDemo.completedAt = new Date().toISOString();
    await announce(state, "Access demo complete", `${bob.label} sees GitHub context only after ${alice.label}'s dataset is shared.`);
  } catch (error) {
    state.accessDemo.status = "failed";
    state.accessDemo.completedAt = new Date().toISOString();
    state.accessDemo.error = error.message;
    await announce(state, "Access demo failed", error.message);
  }

  await saveState(state);
  return state;
}

async function rememberWorkflowSources(state, rawMessages, githubContext, user) {
  const dataset = datasetName(config, user.email, "engineering");
  const slackDocs = rawMessages.map((message) => ({
    type: "slack_message",
    source: "slack",
    title: `Slack ${message.id}`,
    body: `[slack #${config.slack.channelName} · ${message.author} · ${message.ts}] ${message.text}`,
    nodeSet: ["source:slack", `channel:${config.slack.channelName}`, `author:${message.author}`]
  }));
  const githubDocs = githubContext.map((item) => ({
    ...item,
    type: item.type || "github_context",
    nodeSet: item.nodeSet || ["source:github"]
  }));

  await rememberDocuments(config, [...slackDocs, ...githubDocs], {
    datasetName: dataset,
    userEmail: user.email
  });

  state.sourcePulls = {
    ...(state.sourcePulls || {}),
	    [user.email]: {
	      dataset,
	      slack: slackDocs.length,
	      github: githubDocs.length,
	      sources: [
	        ...(slackDocs.length ? ["source:slack"] : []),
	        ...(githubDocs.length ? ["source:github"] : [])
	      ],
	      updatedAt: new Date().toISOString()
	    }
	  };
}

function answerFromContext(question, context) {
  const sources = sourceTags(context);
  if (!context.length) {
    return `No authorized memory was recalled for: ${question}`;
  }

  const titles = context
    .slice(0, 3)
    .map((item) => item.title)
    .filter(Boolean)
    .join("; ");
  const sourceText = sources.length ? ` Sources: ${sources.join(", ")}.` : "";
  return `Recalled ${context.length} authorized memory item(s): ${titles || "context available"}.${sourceText}`;
}

function sourceTags(context) {
  return Array.from(new Set(
    context.flatMap((item) => {
      if (Array.isArray(item.nodeSet)) return item.nodeSet;
      if (Array.isArray(item.source)) return item.source;
      if (item.source) return [String(item.source)];
      return [];
    })
      .filter((tag) => String(tag).startsWith("source:"))
	  ));
}

function sourcePullTags(state, userEmail) {
  return state.sourcePulls?.[userEmail]?.sources || [];
}

async function processTask(state, task, finding, runId) {
  task.status = "running";
  task.stage = "Processing";
  taskLog(task, "Task started", `Processing Slack message from ${finding.author}.`);

  try {
    task.stage = "Jira";
    const context = await recallContext(config, `${finding.title} ${finding.summary}`, {
      userEmail: config.primaryUser.email,
      datasets: [datasetName(config, config.primaryUser.email, "engineering")]
    });
    const issueDraft = await draftJiraIssue(config, finding, context, { runId });
    task.routing = [finding.routing, issueDraft._routing].filter(Boolean);
    const publicDraft = stripInternalFields(issueDraft);
    const createdIssue = await createJiraIssue(config, issueDraft);
    const slackThread = {
      channel: config.slack.channelId,
      threadTs: finding.ts,
      sourceText: finding.sourceText
    };
    const ticket = { ...createdIssue, draft: publicDraft, status: "To Do", comments: [], slackThread };
    task.jiraTicket = ticket;
    task.stage = "Ticket Ready";
    state.jiraTicket = ticket;
    await announceTask(
      state,
      task,
      "Jira ticket ready",
      `${ticket.key} created/drafted as ${publicDraft.issue_type}.`,
      `:ticket: Created Jira *${ticket.key}* (${publicDraft.issue_type}): ${publicDraft.summary}`
    );

    ticket.status = "In Progress";
    task.stage = "In Progress";
    await announceTask(
      state,
      task,
      "Jira status advanced",
      `${ticket.key} moved to In Progress automatically.`,
      `:rocket: *${ticket.key}* moved to *In Progress*. Starting implementation automatically.`
    );

    await announceTask(
      state,
      task,
      "Coding started",
      `Starting local code work for ${ticket.key}.`,
      `:hammer_and_wrench: Starting code work for *${ticket.key}*. I am using repo context and Jira details now.`
    );
    task.stage = "Coding";
    const codeContext = await recallContext(config, `${ticket.draft.summary} ${ticket.draft.description}`, {
      userEmail: config.primaryUser.email,
      datasets: [datasetName(config, config.primaryUser.email, "engineering")]
    });
    const result = await applyLocalFix(config, state.repo.path, ticket, codeContext);
    await improveMemory(config, {
      type: "code_change",
      title: ticket.draft.summary,
      body: `Branch ${result.branch} changed ${result.changedFiles.join(", ")}`
    });
    const prDraft = await draftPrPayload(config, ticket, result);
    let pr;
    try {
      pr = await createGitHubPullRequest(config, prDraft);
    } catch (error) {
      pr = {
        mode: "local",
        ...prDraft,
        note: "Local branch is ready. Push it before creating the GitHub PR.",
        githubError: error.message
      };
      await announceTask(
        state,
        task,
        "GitHub PR deferred",
        "The branch is local, so the app saved a PR payload instead of failing the coding step.",
        `:twisted_rightwards_arrows: Code is committed locally on \`${result.branch}\`. PR creation is deferred until that branch is pushed to GitHub.`
      );
    }

    task.branch = result;
    task.pullRequest = pr;
    task.status = "complete";
    task.stage = "Complete";
    task.completedAt = new Date().toISOString();
    state.branch = result;
    state.pullRequest = pr;
    await announceTask(
      state,
      task,
      "Local branch ready",
      `${result.branch} contains a focused fix and PR payload.`,
      `:white_check_mark: Local branch ready: \`${result.branch}\`. Changed files: ${result.changedFiles.join(", ")}. Tests passed and PR payload is prepared.`
    );
  } catch (error) {
    task.status = "failed";
    task.stage = "Failed";
    task.error = error.message;
    task.completedAt = new Date().toISOString();
    taskLog(task, "Task failed", error.message, "error");
    state.events.unshift(event("Task failed", `${task.title}: ${error.message}`, "error"));
  }
}

function createTask(finding) {
  return {
    id: finding.id,
    title: finding.title,
    type: finding.type,
    status: "queued",
    stage: "Detected",
    finding,
    routing: finding.routing ? [finding.routing] : [],
    jiraTicket: null,
    branch: null,
    pullRequest: null,
    logs: [
      event("Finding detected", `${finding.type} with ${Math.round(finding.confidence * 100)}% confidence.`)
    ],
    createdAt: new Date().toISOString(),
    completedAt: null
  };
}

async function announceTask(state, task, title, detail, slackText = null) {
  taskLog(task, title, detail);
  state.events.unshift(event(title, `${task.title}: ${detail}`));
  if (!slackText) return;

  try {
    await postSlackThreadUpdate(config, slackThreadForTask(task), slackText);
  } catch (error) {
    console.warn(`Slack thread update failed for "${title}": ${error.message}`);
  }
}

function taskLog(task, title, detail, level = "info") {
  task.logs.unshift(event(title, detail, level));
}

function slackThreadForState(state) {
  return state.jiraTicket?.slackThread || {
    channel: config.slack.channelId,
    threadTs: state.slackFindings?.[0]?.ts
  };
}

function slackThreadForTask(task) {
  return task.jiraTicket?.slackThread || {
    channel: config.slack.channelId,
    threadTs: task.finding?.ts
  };
}

function stripInternalFields(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.startsWith("_"))
  );
}

function emptyRespanSummary(config, status, runId = null) {
  return {
    status: config.respan.apiKey ? status : "fallback",
    calls: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    models: config.respan.apiKey ? [config.respan.model] : [],
    traceName: config.respan.traceName,
    threadIdentifier: runId,
    routeProvider: config.respan.routeProvider || null,
    steps: []
  };
}

function summarizeRespanUsage(tasks, config, runId) {
  const summary = emptyRespanSummary(config, config.respan.apiKey ? "active" : "fallback", runId);
  const seen = new Set();

  for (const task of tasks) {
    for (const route of task.routing || []) {
      if (route.provider !== "respan") continue;
      const callKey = route.callId || `${route.step}:${task.id}`;
      if (seen.has(callKey)) continue;
      seen.add(callKey);

      const usage = route.usage || {};
      summary.calls += 1;
      summary.totalTokens += Number(usage.total_tokens || usage.totalTokens || 0);
      summary.promptTokens += Number(usage.prompt_tokens || usage.promptTokens || 0);
      summary.completionTokens += Number(usage.completion_tokens || usage.completionTokens || 0);
      if (route.model && !summary.models.includes(route.model)) summary.models.push(route.model);
      summary.traceName = route.traceName || summary.traceName;
      summary.threadIdentifier = route.threadIdentifier || summary.threadIdentifier;
      summary.steps.push({
        taskId: task.id,
        taskTitle: task.title,
        step: route.step,
        spanName: route.spanName,
        customIdentifier: route.customIdentifier,
        model: route.model,
        usage: route.usage
      });
    }
  }

  if (config.respan.apiKey && summary.calls === 0) {
    summary.status = "configured_no_calls";
  }

  return summary;
}

function respanSummaryText(summary) {
  if (!summary) return "";
  if (summary.status === "fallback") return "Respan fallback used.";
  if (summary.status === "configured_no_calls") return "Respan configured, but no model calls were needed.";
  const tokenText = summary.totalTokens ? `, ${summary.totalTokens} token(s)` : "";
  return `Respan logged ${summary.calls} call(s)${tokenText}.`;
}

function eventsForActiveRun(state) {
  const activeKey = state.jiraTicket?.key;
  const currentScanIndex = state.events.findIndex((item) =>
    item.title === "Slack scan complete" &&
    item.detail.includes(`${state.slackFindings?.length || 0} actionable`)
  );
  const scopedEvents = currentScanIndex === -1
    ? state.events
    : state.events.slice(0, currentScanIndex + 1);

  if (!activeKey) return scopedEvents;

  return scopedEvents.filter((item) =>
    item.detail.includes(activeKey) ||
    ["Slack scan complete", "GitHub PR deferred", "Local branch ready", "Coding started"].includes(item.title)
  );
}
