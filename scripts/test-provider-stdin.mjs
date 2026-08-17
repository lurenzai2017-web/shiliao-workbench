const [appOrigin = "http://localhost:3011", baseUrl, modelsArg] = process.argv.slice(2);
if (!baseUrl || !modelsArg) throw new Error("用法：node test-provider-stdin.mjs <本地站> <API 地址> <模型1,模型2>");

let apiKey = "";
for await (const chunk of process.stdin) apiKey += chunk;
apiKey = apiKey.trim();
if (!apiKey) throw new Error("标准输入中没有 API Key");

const results = [];
for (const model of modelsArg.split(",").map((value) => value.trim()).filter(Boolean)) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${appOrigin}/api/llm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "test",
        providerId: "dashscope",
        baseUrl,
        model,
        apiKey,
      }),
    });
    const data = await response.json();
    results.push({
      model,
      ok: response.ok,
      status: response.status,
      message: response.ok ? data.message : data.error,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    results.push({
      model,
      ok: false,
      status: null,
      message: error instanceof Error ? error.message : "连接失败",
      elapsedMs: Date.now() - startedAt,
    });
  }
}

apiKey = "";
console.log(JSON.stringify({
  endpointHost: new URL(baseUrl).host,
  results,
}, null, 2));
