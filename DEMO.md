# Demo Runbook

Use mock connector mode for the live demo unless the room explicitly wants to inspect real OAuth connections. Mock mode is deterministic and still shows the full Pull -> Remember -> Act -> Evaluate loop.

## Slack Messages

The demo seeds two actionable Slack messages and one non-actionable message:

```text
Maya: can't login after password reset; the issue parser should classify this as a Bug even when I do not say the word bug.
Ravi: feature request: when support asks for a new workflow, create a Jira Story and prepare a PR payload automatically.
Nina: Lunch is upstairs after demos.
```

## Before You Present

```bash
cd /Users/savinay/Documents/ChatGPT/hackathon
git status --short
npm start
```

Open `http://localhost:3000`.

For the eval, use a second terminal:

```bash
cd /Users/savinay/Documents/ChatGPT/hackathon
npm run eval
```

## Live Demo Steps

1. Start on the dashboard and point out the mode pill: `mock`, `cognee` or `local`, and Respan readiness.
2. Click **Reset** so the state starts clean.
3. In **Workflow**, keep the keyword as `agent`, then click **Run Workflow**.
4. In **Tasks**, open Maya's login task. Show:
   - Slack source text.
   - Jira ticket drafted as a Bug.
   - GitHub context from README / issue context.
   - Branch and PR payload.
   - Respan routing details if the key is enabled.
5. Open Ravi's workflow task. Show that it became a Story and also produced a Jira ticket plus PR payload.
6. In **Overview**, show completed task counts and stage progression.
7. In **Access**, click **Run Access Demo**. Narrate:
   - Alice sees Slack + GitHub context.
   - Bob initially sees Slack-only context.
   - Alice grants read access.
   - Bob's answer now includes GitHub context.
8. In a terminal, run `npm run eval` and show `8/8`.

## 3-Minute Talk Track

```text
This is a Company Brain for engineering support triage.

Pull: Scalekit is the access layer. The app pulls Slack requests and GitHub context as the acting user, and can write back to Jira, Slack, and GitHub.

Remember: Cognee is the memory layer. Slack and GitHub facts are remembered with user-scoped datasets and provenance tags like source:slack and source:github.

Act: The agent classifies Slack requests, drafts Jira issues, moves work forward, prepares a local branch/change, and creates a PR payload.

Evaluate: Respan routes the LLM calls and the evaluator checks eight scenarios, including the access-control story. Current score is 8/8.
```

## If Something Fails

Switch to deterministic mode:

```bash
CONNECTOR_MODE=mock MEMORY_PROVIDER=local RESPAN_API_KEY= npm start
```

Then run:

```bash
EVAL_BASE_URL=http://localhost:3000 CONNECTOR_MODE=mock MEMORY_PROVIDER=local RESPAN_API_KEY= npm run eval
```
