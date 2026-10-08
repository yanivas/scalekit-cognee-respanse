import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadConfig() {
  loadDotEnv(path.join(rootDir, ".env"));
  const githubTarget = parseGitHubTarget(process.env.GITHUB_OWNER || "", process.env.GITHUB_REPO || "");
  const users = parseUsers(process.env.HACKATHON_USERS || "");

  return {
    rootDir,
    port: Number(process.env.PORT || 3000),
    isDev: process.env.NODE_ENV !== "production",
    connectorMode: process.env.CONNECTOR_MODE || "mock",
    scalekit: {
      environmentUrl: trimTrailingSlash(process.env.SCALEKIT_ENVIRONMENT_URL || ""),
      clientId: process.env.SCALEKIT_CLIENT_ID || "",
      clientSecret: process.env.SCALEKIT_CLIENT_SECRET || "",
      identifier: process.env.SCALEKIT_USER_IDENTIFIER || "hackathon-demo-user",
      connections: {
        slack: process.env.SCALEKIT_SLACK_CONNECTION || "slack",
        jira: process.env.SCALEKIT_JIRA_CONNECTION || "jira",
        github: process.env.SCALEKIT_GITHUB_CONNECTION || "github"
      },
      tools: {
        slackHistory: process.env.SCALEKIT_SLACK_HISTORY_TOOL || "slack_fetch_conversation_history",
        slackSend: process.env.SCALEKIT_SLACK_SEND_TOOL || "slack_send_message",
        jiraCreate: process.env.SCALEKIT_JIRA_CREATE_TOOL || "jira_issue_create",
        jiraGet: process.env.SCALEKIT_JIRA_GET_TOOL || "jira_issue_get",
        githubPr: process.env.SCALEKIT_GITHUB_PR_TOOL || "github_pull_request_create",
        githubFile: process.env.SCALEKIT_GITHUB_FILE_TOOL || "github_file_contents_get",
        githubIssues: process.env.SCALEKIT_GITHUB_ISSUES_TOOL || "github_issues_list"
      }
    },
    users,
    primaryUser: users[0],
    sharedUser: users[1] || users[0],
    slack: {
      workspaceName: process.env.SLACK_WORKSPACE_NAME || "hackathon",
      channelName: process.env.SLACK_CHANNEL_NAME || "all-hackathon",
      channelId: process.env.SLACK_CHANNEL_ID || "C0C74K67AAK"
    },
    jira: {
      projectKey: process.env.JIRA_PROJECT_KEY || "HACK"
    },
    github: {
      owner: githubTarget.owner,
      repo: githubTarget.repo,
      contextPath: process.env.GITHUB_CONTEXT_PATH || "README.md"
    },
    memory: {
      provider: process.env.MEMORY_PROVIDER || "local",
      pythonBin: process.env.COGNEE_PYTHON_BIN || process.env.PYTHON_BIN || "python3",
      datasetPrefix: process.env.COGNEE_DATASET_PREFIX || "company-brain",
      accessControl: process.env.ENABLE_BACKEND_ACCESS_CONTROL === "true",
      demoPassword: process.env.COGNEE_DEMO_PASSWORD || "hackathon-pw"
    },
    respan: {
      apiKey: process.env.RESPAN_API_KEY || "",
      model: process.env.RESPAN_MODEL || "gpt-4o-mini",
      customerIdentifier: process.env.RESPAN_CUSTOMER_IDENTIFIER || "hackathon-demo",
      traceName: process.env.RESPAN_TRACE_NAME || "scalekit-cognee-respanse",
      routeProvider: process.env.RESPAN_ROUTE_PROVIDER || ""
    }
  };
}

export function publicConfig(config) {
  return {
    appName: "Scalekit Cognee Respanse",
    connectorMode: config.connectorMode,
    scalekitReady: Boolean(config.scalekit.environmentUrl && config.scalekit.clientId && config.scalekit.clientSecret),
    respanReady: Boolean(config.respan.apiKey),
    respan: {
      model: config.respan.model,
      customerIdentifier: config.respan.customerIdentifier,
      traceName: config.respan.traceName,
      routeProvider: config.respan.routeProvider
    },
    slack: config.slack,
    jira: { projectKey: config.jira.projectKey },
    github: {
      owner: config.github.owner,
      repo: config.github.repo
    },
    connections: config.scalekit.connections,
    tools: config.scalekit.tools,
    users: config.users.map(publicUser),
    memory: {
      provider: config.memory.provider,
      accessControl: config.memory.accessControl,
      datasetPrefix: config.memory.datasetPrefix
    }
  };
}

function loadDotEnv(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env is optional. The app runs in mock mode without it.
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function parseGitHubTarget(owner, repo) {
  const repoValue = repo.trim();
  const match = repoValue.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return { owner: owner.trim(), repo: repoValue };
  return {
    owner: owner.trim() || match[1],
    repo: match[2]
  };
}

function parseUsers(value) {
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const defaults = ["alice@acme.example", "bob@acme.example"];
  const identifiers = parsed.length ? parsed : defaults;
  return identifiers.map((identifier, index) => ({
    identifier,
    email: identifier.includes("@") ? identifier : `${identifier}@demo.local`,
    label: index === 0 ? "Alice" : index === 1 ? "Bob" : `User ${index + 1}`
  }));
}

function publicUser(user) {
  return {
    identifier: user.identifier,
    email: user.email,
    label: user.label
  };
}
