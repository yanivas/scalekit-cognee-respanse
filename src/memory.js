import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(rootDir, ".hackathon-data");
const memoryFile = path.join(dataDir, "memory.json");
const bridgePath = path.join(rootDir, "scripts", "cognee_bridge.py");

export async function rememberRepo(config, repoPath, options = {}) {
  const docs = [];
  for (const filename of ["AGENTS.md", "README.md", "package.json"]) {
    try {
      docs.push({
        type: "repo_doc",
        source: "github",
        title: filename,
        body: await readFile(path.join(repoPath, filename), "utf8"),
        nodeSet: ["source:github", "repo:demo-issue-router", `file:${filename}`]
      });
    } catch {
      // Optional repo context file.
    }
  }
  await rememberDocuments(config, docs, {
    datasetName: datasetName(config, options.userEmail || config.primaryUser.email, "engineering"),
    userEmail: options.userEmail || config.primaryUser.email
  });
  return docs;
}

export async function rememberDocuments(config, documents, options = {}) {
  const normalized = documents.map((item) => ({
    type: item.type || "document",
    source: item.source || "unknown",
    title: item.title || "Untitled",
    body: item.body || "",
    nodeSet: item.nodeSet || [`source:${item.source || "unknown"}`],
    userEmail: options.userEmail || item.userEmail || config.primaryUser.email,
    datasetName: options.datasetName || item.datasetName || datasetName(config, options.userEmail || config.primaryUser.email, "brain"),
    createdAt: new Date().toISOString()
  }));

  if (usesCognee(config)) {
    return cogneeBridge(config, "remember", { documents: normalized });
  }

  const memory = await loadMemory();
  await saveMemory([...normalized, ...memory].slice(0, 500));
  return { provider: "local", remembered: normalized.length };
}

export async function recallContext(config, query, options = {}) {
  if (usesCognee(config)) {
    try {
      return await cogneeBridge(config, "recall", {
        query,
        userEmail: options.userEmail || config.primaryUser.email,
        datasets: options.datasets || [datasetName(config, options.userEmail || config.primaryUser.email, "engineering")]
      });
    } catch (error) {
      if (config.memory.provider === "cognee") throw error;
    }
  }

  const memory = await loadMemory();
  const terms = new Set(tokenize(query));
  const allowedDatasets = new Set(options.datasets || []);
  const userEmail = options.userEmail || null;
  return memory
    .filter((item) => !userEmail || item.userEmail === userEmail || item.sharedWith?.includes(userEmail))
    .filter((item) => !allowedDatasets.size || allowedDatasets.has(item.datasetName))
    .map((item) => ({
      ...item,
      score: tokenize(`${item.title} ${item.body} ${(item.nodeSet || []).join(" ")}`).filter((term) => terms.has(term)).length
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit || 5);
}

export async function improveMemory(config, item, options = {}) {
  const document = {
    ...item,
    type: item.type || "agent_feedback",
    source: item.source || "agent",
    nodeSet: item.nodeSet || ["source:agent", "memory:improvement"],
    userEmail: options.userEmail || config.primaryUser.email,
    datasetName: options.datasetName || datasetName(config, options.userEmail || config.primaryUser.email, "engineering")
  };

  if (usesCognee(config)) {
    await cogneeBridge(config, "improve", { document });
    return { provider: "cognee", improved: true };
  }

  const memory = await loadMemory();
  memory.unshift({ ...document, createdAt: new Date().toISOString() });
  await saveMemory(memory.slice(0, 500));
  return { provider: "local", improved: true };
}

export async function shareDataset(config, { datasetName: name, ownerEmail, targetEmail }) {
  if (usesCognee(config)) {
    try {
      return await cogneeBridge(config, "share", { datasetName: name, ownerEmail, targetEmail });
    } catch (error) {
      if (config.memory.provider === "cognee") throw error;
    }
  }

  const memory = await loadMemory();
  const updated = memory.map((item) => {
    if (item.datasetName !== name || item.userEmail !== ownerEmail) return item;
    return {
      ...item,
      sharedWith: Array.from(new Set([...(item.sharedWith || []), targetEmail]))
    };
  });
  await saveMemory(updated);
  return { provider: "local", shared: true, datasetName: name, ownerEmail, targetEmail };
}

export async function resetMemory(config) {
  if (usesCognee(config)) {
    return { provider: "cognee", reset: "manual_forget_required" };
  }
  await rm(memoryFile, { force: true });
  return { provider: "local", reset: true };
}

export function datasetName(config, userEmail, suffix) {
  const safeUser = String(userEmail || "demo")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${config.memory.datasetPrefix}-${safeUser}-${suffix}`;
}

async function cogneeBridge(config, command, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.memory.pythonBin, [bridgePath, command], {
      cwd: rootDir,
      env: {
        ...process.env,
        ENABLE_BACKEND_ACCESS_CONTROL: config.memory.accessControl ? "true" : process.env.ENABLE_BACKEND_ACCESS_CONTROL,
        COGNEE_DEMO_PASSWORD: config.memory.demoPassword,
        LLM_PROVIDER: envValue("LLM_PROVIDER", "custom"),
        LLM_ENDPOINT: envValue("LLM_ENDPOINT", "https://api.respan.ai/api"),
        LLM_API_KEY: envValue("LLM_API_KEY", config.respan.apiKey),
        LLM_MODEL: envValue("LLM_MODEL", config.respan.model),
        EMBEDDING_PROVIDER: envValue("EMBEDDING_PROVIDER", "custom"),
        EMBEDDING_ENDPOINT: envValue("EMBEDDING_ENDPOINT", "https://api.respan.ai/api"),
        EMBEDDING_API_KEY: envValue("EMBEDDING_API_KEY", config.respan.apiKey),
        EMBEDDING_MODEL: envValue("EMBEDDING_MODEL", "openai/text-embedding-3-small"),
        EMBEDDING_DIMENSIONS: envValue("EMBEDDING_DIMENSIONS", "1536")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Cognee bridge failed: ${stderr || `exit ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(lastJsonLine(stdout)));
      } catch (error) {
        reject(new Error(`Cognee bridge returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function lastJsonLine(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...lines].reverse().find((line) => line.startsWith("{") || line.startsWith("[")) || "null";
}

function envValue(key, fallback) {
  const value = process.env[key];
  if (!value || /^\$\{[A-Z0-9_]+\}$/.test(value)) return fallback;
  return value;
}

function usesCognee(config) {
  return config.memory.provider === "cognee";
}

async function loadMemory() {
  try {
    return JSON.parse(await readFile(memoryFile, "utf8"));
  } catch {
    return [];
  }
}

async function saveMemory(memory) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(memoryFile, JSON.stringify(memory, null, 2));
}

function tokenize(value) {
  return String(value).toLowerCase().match(/[a-z0-9_]+/g) || [];
}
