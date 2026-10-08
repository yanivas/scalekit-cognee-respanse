export async function askRespan(config, {
  system,
  user,
  temperature = 0.2,
  json = false,
  step = "llm_call",
  taskId = null,
  runId = null
}) {
  if (!config.respan.apiKey) return null;

  const respanParams = {
    customer_identifier: config.respan.customerIdentifier,
    trace_name: config.respan.traceName,
    thread_identifier: runId || "hackathon-demo",
    custom_identifier: taskId || step,
    span_name: step,
    metadata: {
      app: "scalekit-cognee-respanse",
      workflow_run_id: runId || "manual",
      task_id: taskId || "workflow",
      step
    }
  };

  const response = await fetch("https://api.respan.ai/api/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.respan.apiKey}`,
      "Content-Type": "application/json",
      ...(config.respan.routeProvider ? { "X-Respan-Route-Provider": config.respan.routeProvider } : {})
    },
    body: JSON.stringify({
      model: config.respan.model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
      request_breakdown: true,
      respan_params: respanParams
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Respan request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const content = data.choices?.[0]?.message?.content || "";
  return {
    id: data.id || null,
    content,
    usage: data.usage || null,
    model: data.model || config.respan.model,
    requestBreakdown: data.request_breakdown || data.requestBreakdown || null,
    respan: respanParams
  };
}
