let appConfig = null;
let state = null;
let selectedTaskId = null;

const $ = (selector) => document.querySelector(selector);

await boot();

async function boot() {
  appConfig = await api("/api/config");
  state = await api("/api/state");
  bindEvents();
  render();
  document.body.classList.remove("app-loading");
}

function bindEvents() {
  $("#reset-btn").addEventListener("click", async () => {
    state = await api("/api/reset", { method: "POST" });
    selectedTaskId = null;
    render();
    toast("Demo state reset.");
  });

  $("#workflow-form").addEventListener("submit", run(async (event) => {
    event.preventDefault();
    state = await api("/api/run-workflow", {
      method: "POST",
      body: { keyword: $("#keyword-input").value }
    });
    selectedTaskId = state.tasks?.[0]?.id || null;
    render();
    toast(state.run.summary);
  }));

  $("#access-demo-btn").addEventListener("click", run(async () => {
    state = await api("/api/run-access-demo", {
      method: "POST",
      body: { question: "Which Slack request is ready to ship, and what repo context supports it?" }
    });
    render();
    toast(state.accessDemo?.status === "complete" ? "Access demo complete." : "Access demo needs attention.");
  }));

  $("#task-menu-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-task-id]");
    if (!button) return;
    selectedTaskId = button.dataset.taskId;
    render();
    document.querySelector("#task-detail-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function render() {
  $("#mode-pill").textContent = appConfig.connectorMode;
  $("#env-status").textContent = [
    appConfig.scalekitReady ? "Scalekit credentials present" : "Scalekit credentials pending",
    appConfig.respanReady ? "Respan AI routing active" : "Deterministic AI fallback"
  ].join(" · ");

  renderSetup();
  renderRun();
  renderTaskMenu();
  renderStageOverview();
  renderAccessDemo();
  renderTaskDetail();
  renderRespanUsage();
  renderTimeline();
}

function renderSetup() {
  const items = [
    {
      title: "Scalekit AgentKit",
      status: appConfig.scalekitReady ? "Ready" : "Needs credentials",
      body: `Connections: ${Object.values(appConfig.connections).join(", ")}`
    },
    {
      title: "Slack source",
      status: "Workflow scan",
      body: `${appConfig.slack.workspaceName} / #${appConfig.slack.channelName} (${appConfig.slack.channelId})`
    },
    {
      title: "Cognee memory",
      status: state.repo ? "Repo remembered" : "Auto-seeded on run",
      body: `${appConfig.memory.provider} provider · ${appConfig.memory.accessControl ? "backend access control on" : "local fallback access"}`
    },
    {
      title: "Jira target",
      status: appConfig.jira.projectKey ? appConfig.jira.projectKey : "Needs project key",
      body: "Tickets are created and advanced to In Progress by the workflow."
    },
    {
      title: "Respan routing",
      status: appConfig.respanReady ? "Active" : "Fallback",
      body: appConfig.respanReady
        ? "Slack classification and Jira drafting route through Respan with usage captured per task."
        : "Set RESPAN_API_KEY to route classification and Jira drafting through Respan."
    },
    {
      title: "GitHub PR",
      status: appConfig.github.owner && appConfig.github.repo ? "Ready" : "Local first",
      body: "The workflow creates a local branch and PR payload before pushing."
    },
    {
      title: "Users",
      status: `${appConfig.users.length} configured`,
      body: appConfig.users.map((user) => `${user.label}: ${user.identifier}`).join(" · ")
    }
  ];

  $("#setup-grid").innerHTML = items.map((item) => `
    <article class="mini-card">
      <div class="finding-meta">
        <span class="tag">${escapeHtml(item.status)}</span>
      </div>
      <h4>${escapeHtml(item.title)}</h4>
      <p>${escapeHtml(item.body)}</p>
    </article>
  `).join("");
}

function renderAccessDemo() {
  const demo = state.accessDemo;
  if (!demo) {
    $("#access-demo").innerHTML = `<div class="ticket-empty">Run the access demo to compare user-scoped recall before and after a dataset grant.</div>`;
    return;
  }

  const before = demo.beforeGrant || [];
  $("#access-demo").innerHTML = `
    <div class="usage-meta">
      <span class="tag ${demo.status === "failed" ? "warn" : ""}">${escapeHtml(demo.status)}</span>
      <span class="tag">question: ${escapeHtml(demo.question)}</span>
    </div>
    <div class="access-grid">
      ${before.map((item) => renderAccessCard(item, "Before grant")).join("")}
      ${demo.afterGrant ? renderAccessCard(demo.afterGrant, "After grant") : ""}
    </div>
    ${demo.error ? `<div class="ticket-empty">${escapeHtml(demo.error)}</div>` : ""}
  `;
}

function renderAccessCard(item, label) {
  return `
    <article class="mini-card">
      <div class="finding-meta">
        <span class="tag">${escapeHtml(label)}</span>
        <span class="tag">${escapeHtml(item.user?.label || item.user?.email || "user")}</span>
      </div>
      <h4>${escapeHtml(item.user?.email || "User")}</h4>
      <p>${escapeHtml(item.answer || "")}</p>
      <div class="route-list">
        ${(item.sources || []).map((source) => `<span class="tag">${escapeHtml(source)}</span>`).join("") || `<span class="tag warn">no source</span>`}
      </div>
    </article>
  `;
}

function renderRun() {
  const run = state.run || {};
  $("#run-status").innerHTML = `
    <span class="tag ${run.status === "failed" || run.status === "needs_attention" ? "warn" : ""}">
      ${escapeHtml(run.status || "idle")}
    </span>
    <span>${escapeHtml(run.summary || "Ready to run.")}</span>
  `;
  $("#keyword-input").value = run.keyword || $("#keyword-input").value || "agent";
}

function renderTaskMenu() {
  const tasks = state.tasks || [];
  if (!tasks.length) {
    $("#task-menu-list").innerHTML = `<span class="task-menu-empty">No tasks yet</span>`;
    return;
  }

  if (!selectedTaskId || !tasks.some((task) => task.id === selectedTaskId)) {
    selectedTaskId = tasks[0].id;
  }

  $("#task-menu-list").innerHTML = tasks.map((task) => `
    <button class="task-menu-item ${task.id === selectedTaskId ? "active" : ""}" data-task-id="${escapeHtml(task.id)}" type="button">
      <span>${escapeHtml(task.jiraTicket?.key || task.type)}</span>
      <strong>${escapeHtml(task.title)}</strong>
      <em>${escapeHtml(task.stage || task.status)}</em>
    </button>
  `).join("");
}

function renderStageOverview() {
  const tasks = state.tasks || [];
  if (!tasks.length) {
    $("#stage-overview").innerHTML = `<div class="ticket-empty">Run the workflow to populate task stage counts.</div>`;
    return;
  }

  const stages = ["Detected", "Processing", "Jira", "Ticket Ready", "In Progress", "Coding", "Complete", "Failed"];
  const counts = tasks.reduce((result, task) => {
    const stage = task.stage || task.status || "Detected";
    result[stage] = (result[stage] || 0) + 1;
    return result;
  }, {});

  $("#stage-overview").innerHTML = `
    <div class="overview-strip">
      <article>
        <span class="metric">${tasks.length}</span>
        <p>Total tasks</p>
      </article>
      <article>
        <span class="metric">${tasks.filter((task) => task.status === "running").length}</span>
        <p>In progress</p>
      </article>
      <article>
        <span class="metric">${tasks.filter((task) => task.status === "complete").length}</span>
        <p>Complete</p>
      </article>
      <article>
        <span class="metric">${tasks.filter((task) => task.status === "failed").length}</span>
        <p>Needs attention</p>
      </article>
    </div>
    <ol class="stage-list">
      ${stages.map((stage) => `
        <li>
          <span>${escapeHtml(stage)}</span>
          <strong>${counts[stage] || 0}</strong>
        </li>
      `).join("")}
    </ol>
  `;
}

function renderTaskDetail() {
  const tasks = state.tasks || [];
  const task = tasks.find((item) => item.id === selectedTaskId) || tasks[0];
  if (!task) {
    $("#task-detail-title").textContent = "Selected task";
    $("#task-detail").innerHTML = `<div class="ticket-empty">Select a task from the sidebar after running the workflow.</div>`;
    return;
  }

  $("#task-detail-title").textContent = task.jiraTicket?.key || task.title;
  $("#task-detail").innerHTML = `
    <div class="task-detail-header">
      <div>
        <div class="finding-meta">
          <span class="tag ${task.type === "Bug" ? "warn" : ""}">${escapeHtml(task.type)}</span>
          <span class="tag">${Math.round((task.finding?.confidence || 0) * 100)}% confidence</span>
          <span class="tag">${escapeHtml(task.stage || task.status)}</span>
        </div>
        <h4>${escapeHtml(task.title)}</h4>
        <p>${escapeHtml(task.finding?.summary || "")}</p>
      </div>
    </div>
    <div class="task-detail-grid">
      ${renderRouting(task)}
      ${renderTicket(task)}
      ${renderCode(task)}
    </div>
    ${renderTaskLog(task)}
  `;
}

function renderRespanUsage() {
  const usage = state.run?.respan || {};
  const isFallback = usage.status === "fallback" || !appConfig.respanReady;
  const steps = usage.steps || [];

  $("#respan-usage").innerHTML = `
    <div class="usage-summary">
      <article>
        <span class="tag ${isFallback ? "warn" : ""}">${escapeHtml(usage.status || "not_run")}</span>
        <h4>${isFallback ? "Deterministic fallback" : "Respan indexed workflow"}</h4>
        <p>${escapeHtml(respanUsageDescription(usage, isFallback))}</p>
      </article>
      <article>
        <span class="metric">${usage.calls || 0}</span>
        <p>model calls</p>
      </article>
      <article>
        <span class="metric">${usage.totalTokens || 0}</span>
        <p>total tokens</p>
      </article>
      <article>
        <span class="metric">${escapeHtml((usage.models || appConfig.respan?.model || []).join?.(", ") || appConfig.respan?.model || "none")}</span>
        <p>model</p>
      </article>
    </div>

    <div class="usage-meta">
      <span class="tag">trace: ${escapeHtml(usage.traceName || appConfig.respan?.traceName || "scalekit-cognee-respanse")}</span>
      <span class="tag">thread: ${escapeHtml(usage.threadIdentifier || "next run")}</span>
      ${usage.routeProvider ? `<span class="tag">provider: ${escapeHtml(usage.routeProvider)}</span>` : ""}
    </div>

    ${steps.length ? `
      <ol class="usage-index">
        ${steps.map((step) => `
          <li>
            <strong>${escapeHtml(step.step)}</strong>
            <span>${escapeHtml(step.taskTitle || step.taskId || "workflow")}</span>
            <span>${escapeHtml(step.model || "model")} ${formatUsage(step.usage)}</span>
          </li>
        `).join("")}
      </ol>
    ` : `<div class="ticket-empty">Run with RESPAN_API_KEY set to populate the Respan usage index.</div>`}
  `;
}

function renderRouting(task) {
  const routes = task.routing || [];
  if (!routes.length) return "";

  return `
    <div class="task-block">
      <h5>Routing</h5>
      <div class="route-list">
        ${routes.map((route) => `
          <span class="tag">
            ${escapeHtml(route.step)}: ${escapeHtml(route.provider)}
            ${route.model ? ` / ${escapeHtml(route.model)}` : ""}
            ${formatUsage(route.usage)}
          </span>
        `).join("")}
      </div>
    </div>
  `;
}

function renderTicket(task) {
  if (!task.jiraTicket) return "";
  const ticket = task.jiraTicket;
  return `
    <div class="task-block">
      <h5>Jira</h5>
      <div class="finding-meta">
        <span class="tag">${escapeHtml(ticket.key)}</span>
        <span class="tag">${escapeHtml(ticket.status)}</span>
        <span class="tag">${escapeHtml(ticket.draft.issue_type)}</span>
      </div>
      <p>${escapeHtml(ticket.draft.summary)}</p>
    </div>
  `;
}

function renderCode(task) {
  if (!task.branch && !task.pullRequest) return "";
  return `
    <div class="task-block">
      <h5>Code</h5>
      <div class="finding-meta">
        <span class="tag">${escapeHtml(task.branch.branch)}</span>
        <span class="tag">${escapeHtml(task.pullRequest.mode)}</span>
      </div>
      <p>Changed files: ${escapeHtml(task.branch.changedFiles.join(", "))}</p>
      <pre>${escapeHtml(JSON.stringify(task.pullRequest, null, 2))}</pre>
    </div>
  `;
}

function renderTaskLog(task) {
  return `
    <div class="task-block">
      <h5>Task log</h5>
      <ol class="task-log">
        ${(task.logs || []).map((item) => `
          <li class="${item.level === "error" ? "error" : ""}">
            <time>${formatTime(item.createdAt)}</time>
            <div>
              <strong>${escapeHtml(item.title)}</strong>
              <span>${escapeHtml(item.detail)}</span>
            </div>
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderTimeline() {
  $("#timeline").innerHTML = (state.events || []).map((item) => `
    <li class="${item.level === "error" ? "error" : ""}">
      <time>${formatTime(item.createdAt)}</time>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </div>
    </li>
  `).join("");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function run(fn) {
  return async (...args) => {
    setBusy(true);
    try {
      await fn(...args);
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(false);
    }
  };
}

function setBusy(isBusy) {
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 3200);
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatUsage(usage) {
  if (!usage) return "";
  const total = usage.total_tokens || usage.totalTokens;
  return total ? ` / ${total} tokens` : "";
}

function respanUsageDescription(usage, isFallback) {
  if (isFallback) {
    return "Respan is part of the workflow contract, but this run used local deterministic classification and Jira drafting because RESPAN_API_KEY is not set.";
  }
  if (usage.calls) {
    return `Workflow calls are grouped under ${usage.threadIdentifier || "the current run"} and indexed by task step.`;
  }
  return "Respan is configured and will index Slack classification and Jira drafting calls on the next workflow run.";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
