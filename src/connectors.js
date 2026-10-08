import { scalekitAuthorizationLink, scalekitExecuteTool } from "./scalekit.js";

const mockSlackMessages = [
  {
    id: "slack-1",
    author: "Maya",
    ts: "2026-10-07T15:01:00.000Z",
    text: "bug: the issue parser ignores messages that say 'can't login' unless the word bug is included."
  },
  {
    id: "slack-2",
    author: "Ravi",
    ts: "2026-10-07T15:04:00.000Z",
    text: "feature request: should support creating a Jira Story when someone asks for a new workflow."
  },
  {
    id: "slack-3",
    author: "Nina",
    ts: "2026-10-07T15:05:00.000Z",
    text: "Lunch is upstairs after demos."
  }
];

export async function getAuthorizationLink(config, connectionName, identifier = config.primaryUser.identifier) {
  if (config.connectorMode !== "real") {
    return {
      link: "mock://scalekit/authorize",
      expiry: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      note: "Switch CONNECTOR_MODE=real after adding Scalekit credentials."
    };
  }
  return scalekitAuthorizationLink(config, connectionName, identifier);
}

export async function scanSlack(config, keyword = "", options = {}) {
  const identifier = options.identifier || config.primaryUser.identifier;
  if (config.connectorMode !== "real") {
    const query = keyword.trim().toLowerCase();
    return query
      ? mockSlackMessages.filter((message) => message.text.toLowerCase().includes(query) || query.includes("agent"))
      : mockSlackMessages;
  }

  const result = await scalekitExecuteTool(config, {
    connector: config.scalekit.connections.slack,
    toolName: config.scalekit.tools.slackHistory,
    identifier,
    toolInput: {
      channel: config.slack.channelId,
      channel_id: config.slack.channelId,
      limit: 20
    }
  });

  return normalizeSlackResult(result.data || result);
}

export async function postSlackThreadUpdate(config, thread, text) {
  if (!thread?.threadTs || !text) return null;

  if (config.connectorMode !== "real") {
    return {
      mode: "mock",
      channel: thread.channel || config.slack.channelId,
      thread_ts: thread.threadTs,
      text
    };
  }

  const result = await scalekitExecuteTool(config, {
    connector: config.scalekit.connections.slack,
    toolName: config.scalekit.tools.slackSend,
    identifier: thread.identifier || config.primaryUser.identifier,
    toolInput: {
      channel: thread.channel || config.slack.channelId,
      text,
      thread_ts: thread.threadTs,
      reply_broadcast: false,
      unfurl_links: false,
      unfurl_media: false
    }
  });

  return result.data || result;
}

export async function createJiraIssue(config, draft) {
  const issueInput = stripInternalFields(draft);

  if (config.connectorMode !== "real") {
    return {
      id: `mock-${Date.now()}`,
      key: `${issueInput.project_key || config.jira.projectKey}-${Date.now().toString().slice(-6)}`,
      url: null,
      status: "To Do"
    };
  }

  const result = await scalekitExecuteTool(config, {
    connector: config.scalekit.connections.jira,
    toolName: config.scalekit.tools.jiraCreate,
    identifier: draft.identifier || config.primaryUser.identifier,
    toolInput: issueInput
  });

  const data = result.data || result;
  return {
    id: data.id || data.issue?.id,
    key: data.key || data.issue?.key,
    url: data.self || data.url || null,
    status: "To Do",
    raw: data
  };
}

export async function getJiraIssue(config, issueKey) {
  if (config.connectorMode !== "real") return null;

  const result = await scalekitExecuteTool(config, {
    connector: config.scalekit.connections.jira,
    toolName: config.scalekit.tools.jiraGet,
    toolInput: { issueIdOrKey: issueKey, issue_id_or_key: issueKey }
  });
  const data = result.data || result;
  return {
    status: data.fields?.status?.name || data.status?.name || data.status,
    raw: data
  };
}

export async function createGitHubPullRequest(config, draft) {
  if (config.connectorMode !== "real") {
    return {
      mode: "local",
      title: draft.title,
      body: draft.body,
      base: draft.base,
      head: draft.head,
      note: "Local-only PR payload. Push branch and switch CONNECTOR_MODE=real to create it through Scalekit."
    };
  }

  const result = await scalekitExecuteTool(config, {
    connector: config.scalekit.connections.github,
    toolName: config.scalekit.tools.githubPr,
    identifier: draft.identifier || config.primaryUser.identifier,
    toolInput: draft
  });
  return {
    mode: "github",
    ...draft,
    raw: result.data || result
  };
}

export async function fetchGitHubContext(config, options = {}) {
  const identifier = options.identifier || config.primaryUser.identifier;

  if (config.connectorMode !== "real") {
    return [
      {
        id: "github-readme",
        source: "github",
        title: "demo-issue-router README.md",
        body: "Known bug: the parser misses contractions such as can't login unless the word bug is present.",
        nodeSet: ["source:github", "repo:demo-issue-router", "file:README.md"]
      },
      {
        id: "github-issue-17",
        source: "github",
        title: "GitHub issue 17: classify login failures",
        body: "Support asked the issue router to classify can't login reports as Bugs and open a PR with parser tests.",
        nodeSet: ["source:github", "repo:demo-issue-router", "issue:17"]
      }
    ];
  }

  const items = [];
  if (config.github.owner && config.github.repo && config.github.contextPath) {
    const fileResult = await scalekitExecuteTool(config, {
      connector: config.scalekit.connections.github,
      toolName: config.scalekit.tools.githubFile,
      identifier,
      toolInput: {
        owner: config.github.owner,
        repo: config.github.repo,
        path: config.github.contextPath
      }
    });
    const data = fileResult.data || fileResult;
    items.push({
      id: `github-file-${config.github.contextPath}`,
      source: "github",
      title: `${config.github.repo}/${config.github.contextPath}`,
      body: decodeGitHubContent(data.content) || JSON.stringify(data),
      nodeSet: ["source:github", `repo:${config.github.repo}`, `file:${config.github.contextPath}`]
    });
  }

  const issueResult = await scalekitExecuteTool(config, {
    connector: config.scalekit.connections.github,
    toolName: config.scalekit.tools.githubIssues,
    identifier,
    toolInput: {
      owner: config.github.owner,
      repo: config.github.repo,
      state: "open",
      per_page: 10
    }
  });
  const issues = issueResult.data?.issues || issueResult.data || issueResult.items || issueResult.results || [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    items.push({
      id: issue.id || issue.number || issue.url,
      source: "github",
      title: issue.title || `GitHub issue ${issue.number}`,
      body: [issue.title, issue.body].filter(Boolean).join("\n\n"),
      nodeSet: ["source:github", `repo:${config.github.repo}`, `issue:${issue.number || issue.id}`]
    });
  }

  return items;
}

function normalizeSlackResult(data) {
  const messages = data.messages || data.items || data.results || [];
  return messages.map((message, index) => ({
    id: message.client_msg_id || message.id || message.ts || `slack-${index}`,
    author: message.user || message.username || "slack-user",
    ts: message.ts || message.timestamp || new Date().toISOString(),
    text: message.text || message.message || ""
  }));
}

function stripInternalFields(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.startsWith("_"))
  );
}

function decodeGitHubContent(content) {
  if (!content) return "";
  try {
    return Buffer.from(String(content).replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return String(content);
  }
}
