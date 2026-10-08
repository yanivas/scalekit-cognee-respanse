import { askRespan } from "./respan.js";

const actionableWords = /\b(bug|broken|breaks|feature|request|cannot|can't|should support|error|failing|fails)\b/i;

export async function classifySlackMessages(config, messages, options = {}) {
  const candidates = messages.filter((message) => actionableWords.test(message.text));

  const llm = await askRespan(config, {
    json: true,
    step: "slack_classification",
    runId: options.runId,
    system: "You classify Slack messages into actionable software bug or feature requests. Return JSON only.",
    user: JSON.stringify({
      instruction: "Return {items:[{id,type,title,summary,confidence,sourceText}]} using only actionable messages.",
      messages: candidates
    })
  });

  if (llm?.content) {
    try {
      const parsed = JSON.parse(llm.content);
      if (Array.isArray(parsed.items)) {
        return parsed.items.map((item, index) => ({
          ...normalizeFinding(item, candidates[index] || candidates[0]),
          routing: routeInfo("classification", llm)
        }));
      }
    } catch {
      // Fall back to deterministic classification.
    }
  }

  return candidates.map((message) => ({
    ...normalizeFinding({
    id: message.id,
    type: /bug|broken|error|failing|fails|cannot|can't/i.test(message.text) ? "Bug" : "Story",
    title: titleFromText(message.text),
    summary: message.text,
    confidence: 0.86,
    sourceText: message.text
    }, message),
    routing: routeInfo("classification", null)
  }));
}

export async function draftJiraIssue(config, finding, context, options = {}) {
  const contextText = context.map((item) => `# ${item.title}\n${item.body}`).join("\n\n");
  const llm = await askRespan(config, {
    json: true,
    step: "jira_issue_draft",
    taskId: finding.id,
    runId: options.runId,
    system: "You write concise Jira issues for engineering agents. Return JSON only.",
    user: JSON.stringify({
      projectKey: config.jira.projectKey,
      finding,
      context: contextText,
      schema: {
        project_key: "string",
        issue_type: "Bug | Story | Task",
        summary: "string",
        description: "string",
        labels: ["string"]
      }
    })
  });

  if (llm?.content) {
    try {
      return {
        ...coerceJiraDraft(config, JSON.parse(llm.content), finding),
        _routing: routeInfo("jira_draft", llm)
      };
    } catch {
      // Deterministic fallback below.
    }
  }

  return {
    ...coerceJiraDraft(config, {
    issue_type: finding.type === "Bug" ? "Bug" : "Story",
    summary: finding.title,
    description: [
      `Slack request from #${config.slack.channelName}:`,
      finding.sourceText || finding.summary,
      "",
      "Repo context:",
      contextText.slice(0, 1200)
    ].join("\n"),
    labels: ["agent-created", "hackathon"]
    }, finding),
    _routing: routeInfo("jira_draft", null)
  };
}

export async function draftPrPayload(config, ticket, branchResult) {
  const body = [
    `Fixes ${ticket.key}`,
    "",
    "## What changed",
    ...branchResult.changedFiles.map((file) => `- Updated ${file}`),
    "",
    "## Agent context",
    `- Triggered when Jira moved to ${ticket.status}`,
    `- Branch: ${branchResult.branch}`,
    "- Generated locally for demo safety"
  ].join("\n");

  return {
    owner: config.github.owner || "YOUR_GITHUB_OWNER",
    repo: config.github.repo || "YOUR_GITHUB_REPO",
    base: "main",
    head: branchResult.branch,
    title: `${ticket.key}: ${ticket.draft.summary}`,
    body,
    draft: false
  };
}

function normalizeFinding(item, source) {
  return {
    id: item.id || source?.id || `finding-${Date.now()}`,
    type: item.type === "Bug" ? "Bug" : item.type === "Task" ? "Task" : "Story",
    title: item.title || titleFromText(item.sourceText || source?.text || "Slack request"),
    summary: item.summary || item.sourceText || source?.text || "",
    confidence: Number(item.confidence || 0.8),
    sourceText: item.sourceText || source?.text || item.summary || "",
    author: source?.author || "slack-user",
    ts: source?.ts || new Date().toISOString()
  };
}

function coerceJiraDraft(config, draft, finding) {
  return {
    project_key: draft.project_key || config.jira.projectKey,
    issue_type: ["Bug", "Story", "Task"].includes(draft.issue_type) ? draft.issue_type : finding.type,
    summary: draft.summary || finding.title,
    description: draft.description || finding.summary,
    labels: Array.isArray(draft.labels) ? draft.labels : ["agent-created", "hackathon"]
  };
}

function titleFromText(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/^.*?(bug|feature request|feature|broken|cannot|can't)[:\s-]*/i, "")
    .trim()
    .slice(0, 88) || "Slack request";
}

function routeInfo(step, llm) {
  if (!llm) {
    return {
      step,
      provider: "deterministic",
      model: null,
      usage: null
    };
  }

  return {
    step,
    provider: "respan",
    callId: llm.id,
    model: llm.model,
    usage: llm.usage,
    traceName: llm.respan?.trace_name,
    threadIdentifier: llm.respan?.thread_identifier,
    customIdentifier: llm.respan?.custom_identifier,
    spanName: llm.respan?.span_name
  };
}
