export async function scalekitToken(config) {
  assertScalekit(config);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.scalekit.clientId,
    client_secret: config.scalekit.clientSecret
  });

  const response = await fetch(`${config.scalekit.environmentUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return parseResponse(response, "Scalekit token request failed").then((json) => json.access_token);
}

export async function scalekitAuthorizationLink(config, connectionName, identifier = config.scalekit.identifier) {
  const token = await scalekitToken(config);
  const response = await fetch(`${config.scalekit.environmentUrl}/api/v1/connected_accounts/magic_link`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      connector: connectionName,
      identifier,
      state: `hackathon-${Date.now()}`
    })
  });
  return parseResponse(response, "Scalekit authorization link failed");
}

export async function scalekitExecuteTool(config, { connector, toolName, toolInput, identifier = config.scalekit.identifier }) {
  const token = await scalekitToken(config);
  const response = await fetch(`${config.scalekit.environmentUrl}/api/v1/execute_tool`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      tool_name: toolName,
      connector,
      identifier,
      params: toolInput,
      agent_run_id: `respanse-${Date.now()}`
    })
  });
  return parseResponse(response, `Scalekit tool call failed: ${toolName}`);
}

export async function scalekitListScopedTools(config, connectionName) {
  const token = await scalekitToken(config);
  const url = new URL(`${config.scalekit.environmentUrl}/api/v1/tools/scoped`);
  url.searchParams.set("identifier", config.scalekit.identifier);
  url.searchParams.set("filter.connection_names", connectionName);
  url.searchParams.set("page_size", "100");

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return parseResponse(response, "Scalekit scoped tools request failed");
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

function assertScalekit(config) {
  if (!config.scalekit.environmentUrl || !config.scalekit.clientId || !config.scalekit.clientSecret) {
    throw new Error("Missing Scalekit env vars. Copy .env.example to .env and fill SCALEKIT_* values.");
  }
}

async function parseResponse(response, message) {
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${message}: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}
