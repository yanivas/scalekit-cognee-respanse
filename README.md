# Scalekit Cognee Respanse

Funny working name: **Scalekit Cognee Respanse**.

This is a hackathon PoC for an agent that:

1. Reads Slack bug or feature request messages.
2. Pulls GitHub repo/issue context as a second source.
3. Remembers Slack + GitHub context in user-scoped memory.
4. Creates or drafts a Jira ticket per task.
5. Advances each task to `In Progress`.
6. Creates a local branch and PR payload for each task.
7. Shows an Alice/Bob access demo and a before/after eval score.

The app is dependency-light and runs with Node.js built-ins so the demo is not blocked by package installation. It has a mock mode for table demos and real connector paths for Scalekit AgentKit, Cognee, and Respan.

## Scalekit setup

On the onboarding screen, choose:

**Connect my agents to MCP tools & APIs (AgentKit)**

Then in Scalekit:

1. Open **Developers > Settings > API Credentials** and copy:
   - `SCALEKIT_ENVIRONMENT_URL`
   - `SCALEKIT_CLIENT_ID`
   - generate and copy `SCALEKIT_CLIENT_SECRET`
2. Open **AgentKit > Connections** and create connections for:
   - Slack
   - Jira
   - GitHub
3. Put their connection names in `.env`.
4. Set `HACKATHON_USERS` to two Scalekit identifiers, for example:

   ```bash
   HACKATHON_USERS=alice@acme.com,bob@acme.com
   ```

5. Start in `CONNECTOR_MODE=mock`; switch to `real` once the accounts are authorized.

In real mode the app pulls Slack and GitHub through Scalekit and writes Jira, Slack updates, and GitHub PR payloads through Scalekit with the acting user's identifier.

## Cognee memory

The default `MEMORY_PROVIDER=local` keeps demos deterministic. To use real Cognee:

```bash
uv venv && source .venv/bin/activate
uv pip install "cognee>=1.6.3"

MEMORY_PROVIDER=cognee
COGNEE_PYTHON_BIN=.venv/bin/python
ENABLE_BACKEND_ACCESS_CONTROL=true
npm start
```

The Node app calls `scripts/cognee_bridge.py`, which uses `cognee.remember(...)`, `cognee.recall(...)`, and a best-effort dataset share for the Alice/Bob access story. Source provenance is carried in `node_set` tags such as `source:slack`, `source:github`, `channel:all-hackathon`, and `repo:demo-issue-router`.

## Run

```bash
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

## Demo flow

1. Enter a Slack keyword.
2. Click **Run Workflow**.
3. Use the sidebar task menu to switch between tasks.
4. Click **Run Access Demo** to show Alice's cross-source recall, Bob's limited recall, and Bob's result after Alice grants access.
5. Review the overview dashboard for task counts by stage, then inspect the selected task for its Jira ticket, branch/PR payload, routing details, and task log.

In mock mode, all side effects are local and visible. In real mode, Slack/Jira/GitHub calls go through Scalekit AgentKit where implemented by configured tool names.

## Evaluation

The scenario set lives in `evals/scenarios.json`. The scorer is independent of the agent: it runs the workflow through HTTP, checks expected facts/actions/source tags, and writes `evals/results/latest.json`.

Run the app in one terminal:

```bash
npm start
```

Then score it from another terminal:

```bash
npm run eval
```

For a non-default port:

```bash
PORT=3100 npm start
EVAL_BASE_URL=http://localhost:3100 npm run eval
```

The access portion reports before-grant and after-grant scores so the demo can show how a permission change affects the answer.

## Respan usage

`RESPAN_API_KEY` is optional because the demo has deterministic fallbacks. When the key is present, Slack classification and Jira issue drafting route through Respan, and the dashboard shows a run-level usage index plus model/token usage on each task card. Without it, those same steps use local deterministic logic so the table demo still runs.

Each run is indexed in Respan with:

- `trace_name`: `RESPAN_TRACE_NAME`
- `thread_identifier`: the workflow run timestamp
- `span_name`: `slack_classification` or `jira_issue_draft`
- `custom_identifier`: the task id or workflow step
- `metadata`: app name, workflow run id, task id, and step

Use `RESPAN_ROUTE_PROVIDER` only when you want to pin a supported model slug to a specific provider.
