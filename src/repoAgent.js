import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function createOrLoadDemoRepo(config) {
  const repoPath = path.join(config.rootDir, "demo-repo");
  await mkdir(path.join(repoPath, "src"), { recursive: true });

  await writeIfMissing(path.join(repoPath, "AGENTS.md"), `# Agent Instructions

This repo is intentionally small for the hackathon demo.

- Treat Slack requests containing "bug", "broken", "cannot", "can't", or "error" as bugs.
- Treat Slack requests containing "feature request" or "should support" as stories.
- Keep fixes small and add a short comment in code only when it clarifies parsing intent.
- Branches from automation should use agent/JIRA-123-short-title.
`);

  await writeIfMissing(path.join(repoPath, "README.md"), `# Demo Issue Router

Tiny app used by Scalekit Cognee Respanse.

Known bug: the parser misses contractions such as "can't login" unless the word "bug" is present.
`);

  await writeIfMissing(path.join(repoPath, "package.json"), JSON.stringify({
    name: "demo-issue-router",
    version: "0.0.1",
    type: "module",
    scripts: {
      test: "node src/issueParser.test.js"
    }
  }, null, 2));

  await writeIfMissing(path.join(repoPath, "src", "issueParser.js"), `export function classifyIssue(text) {
  const normalized = String(text).toLowerCase();
  if (normalized.includes("bug") || normalized.includes("broken") || normalized.includes("error")) {
    return "Bug";
  }
  if (normalized.includes("feature request") || normalized.includes("should support")) {
    return "Story";
  }
  return "Task";
}
`);

  await writeIfMissing(path.join(repoPath, "src", "issueParser.test.js"), `import { classifyIssue } from "./issueParser.js";

const cases = [
  ["bug: save button is broken", "Bug"],
  ["feature request: export CSV", "Story"],
  ["please update the docs", "Task"]
];

for (const [input, expected] of cases) {
  const actual = classifyIssue(input);
  if (actual !== expected) {
    throw new Error(\`Expected \${expected} for "\${input}", got \${actual}\`);
  }
}

console.log("issueParser tests passed");
`);

  await ensureGitRepo(repoPath);
  return {
    path: repoPath,
    contextFiles: ["AGENTS.md", "README.md", "package.json", "src/issueParser.js"],
    defaultBranch: "main"
  };
}

export async function applyLocalFix(config, repoPath, ticket, context) {
  const branch = branchName(ticket);
  await git(repoPath, ["checkout", "main"]);
  await git(repoPath, ["checkout", "-B", branch]);

  const parserPath = path.join(repoPath, "src", "issueParser.js");
  const testPath = path.join(repoPath, "src", "issueParser.test.js");
  const parser = await readFile(parserPath, "utf8");
  const test = await readFile(testPath, "utf8");

  const isStory = ticket.draft.issue_type === "Story";
  const updatedParser = isStory
    ? updateStoryParser(parser)
    : updateBugParser(parser);
  const updatedTest = isStory
    ? updateStoryTest(test)
    : updateBugTest(test);

  await writeFile(parserPath, updatedParser);
  await writeFile(testPath, updatedTest);
  await exec("npm", ["test"], { cwd: repoPath });
  await git(repoPath, ["add", "src/issueParser.js", "src/issueParser.test.js"]);
  await git(repoPath, ["commit", "-m", `${ticket.key}: improve Slack issue classification`]);

  return {
    branch,
    repoPath,
    changedFiles: ["src/issueParser.js", "src/issueParser.test.js"],
    commitMessage: `${ticket.key}: improve Slack issue classification`,
    contextUsed: context.map((item) => item.title)
  };
}

async function writeIfMissing(filePath, content) {
  try {
    await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, content);
  }
}

async function ensureGitRepo(repoPath) {
  const hasOwnGitDir = await pathExists(path.join(repoPath, ".git"));
  if (!hasOwnGitDir) {
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "agent@example.local"]);
    await git(repoPath, ["config", "user.name", "Scalekit Cognee Respanse"]);
  }

  try {
    await git(repoPath, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "Seed demo issue router"]);
  }
}

async function git(cwd, args) {
  return exec("git", args, { cwd });
}

function branchName(ticket) {
  const slug = ticket.draft.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `agent/${ticket.key}-${slug}`;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function updateBugParser(parser) {
  if (parser.includes("can't")) return parser;
  return parser.replace(
    `normalized.includes("bug") || normalized.includes("broken") || normalized.includes("error")`,
    `normalized.includes("bug") || normalized.includes("broken") || normalized.includes("error") || normalized.includes("cannot") || normalized.includes("can't")`
  );
}

function updateStoryParser(parser) {
  if (parser.includes("new workflow")) return parser;
  return parser.replace(
    `normalized.includes("feature request") || normalized.includes("should support")`,
    `normalized.includes("feature request") || normalized.includes("should support") || normalized.includes("new workflow")`
  );
}

function updateBugTest(test) {
  if (test.includes("can't login")) return test;
  return test.replace(
    `["feature request: export CSV", "Story"],`,
    `["feature request: export CSV", "Story"],\n  ["can't login after password reset", "Bug"],`
  );
}

function updateStoryTest(test) {
  if (test.includes("new workflow")) return test;
  return test.replace(
    `["feature request: export CSV", "Story"],`,
    `["feature request: export CSV", "Story"],\n  ["can we add a new workflow", "Story"],`
  );
}
