import { rejectUnauthorizedApi } from "../../invite-auth";

type LlmRequest = {
  operation?: "test" | "plan" | "estimate" | "analyze";
  providerId?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  question?: string;
  plan?: unknown;
  chunks?: Array<{ id?: string; source?: string; locator?: string; text?: string }>;
  sourceSummary?: {
    fileCount?: number;
    readableCharacters?: number;
    sampleCharacters?: number;
    sampleSegments?: number;
    plannedBatchCharacters?: number;
  };
  pricing?: { inputPerMillion?: number; outputPerMillion?: number };
};

const MAX_ERROR_LENGTH = 360;
const PROVIDER_TIMEOUT_MS = 90_000;

function safeEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API 地址格式不正確。");
  }
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && isLocal)) {
    throw new Error("遠端模型服務必須使用 HTTPS。");
  }
  if (!isLocal && (/^(\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal"))) {
    throw new Error("不接受內部網路或裸 IP 的遠端地址。");
  }
  return url.toString().replace(/\/+$/, "");
}

function jsonFromText(value: string) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("模型沒有返回可讀的 JSON。");
  return JSON.parse(candidate);
}

function cleanError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value || "模型服務發生錯誤");
  if (/timeout|timed out|aborted due to timeout|operation was aborted/i.test(message)) {
    return "模型判讀超過 90 秒仍未返回；系統會縮小批次後重試。";
  }
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[已隱藏金鑰]").slice(0, MAX_ERROR_LENGTH);
}

function boundedNumber(value: unknown, fallback: number, minimum = 0, maximum = 2_000_000_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(maximum, Math.max(minimum, parsed)));
}

function estimateCost(inputTokens: number, outputTokens: number, inputPrice: number, outputPrice: number) {
  if (inputPrice <= 0 && outputPrice <= 0) return null;
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
}

async function providerFetch(baseUrl: string, apiKey: string, path: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const raw = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw: raw.slice(0, 600) };
  }
  if (!response.ok) {
    const nested = data.error as { message?: string } | undefined;
    throw new Error(nested?.message || `模型服務返回 HTTP ${response.status}`);
  }
  return data;
}

async function chat(baseUrl: string, apiKey: string, model: string, system: string, user: string) {
  const data = await providerFetch(baseUrl, apiKey, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
    }),
  });
  const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content || "";
  if (!content) throw new Error("模型沒有返回文字內容。");
  return { content, usage: data.usage || null };
}

export async function POST(request: Request) {
  const unauthorized = await rejectUnauthorizedApi(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json() as LlmRequest;
    const operation = body.operation;
    const baseUrl = safeEndpoint(String(body.baseUrl || ""));
    const model = String(body.model || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    if (!operation || !["test", "plan", "estimate", "analyze"].includes(operation)) throw new Error("未知的模型操作。");
    if (!model) throw new Error("請填寫模型名稱。");
    if (body.providerId !== "ollama" && !apiKey) throw new Error("請填寫 API Key。");

    if (operation === "test") {
      const result = await chat(
        baseUrl,
        apiKey,
        model,
        "你是連接測試助手。",
        "只回答：連接正常",
      );
      return Response.json({ ok: true, message: `${model} 連接正常`, usage: result.usage });
    }

    if (operation === "plan") {
      const question = String(body.question || "").trim().slice(0, 8000);
      if (!question) throw new Error("請先輸入研究問題。");
      const system = `你是嚴謹的中國史數位人文研究方法助手。請把研究者的自然語言需求轉成可執行、可複核的史料判讀規約。只返回合法 JSON，不要 Markdown。不得假設研究者未說明的朝代、文類或結論。規約必須強調原文證據、來源位置、不確定性與不改寫史料。\n\n固定 JSON 結構：\n{"title":"","objective":"","include":[""],"exclude":[""],"fields":[""],"evidenceRule":"","prompt":""}`;
      const { content, usage } = await chat(baseUrl, apiKey, model, system, question);
      const parsed = jsonFromText(content) as Record<string, unknown>;
      const plan = {
        title: String(parsed.title || "史料判讀研究規約"),
        objective: String(parsed.objective || question),
        include: Array.isArray(parsed.include) ? parsed.include.map(String).slice(0, 8) : [],
        exclude: Array.isArray(parsed.exclude) ? parsed.exclude.map(String).slice(0, 8) : [],
        fields: Array.isArray(parsed.fields) ? parsed.fields.map(String).slice(0, 16) : [],
        evidenceRule: String(parsed.evidenceRule || "保留完整原文與來源位置，不改寫史料。"),
        prompt: String(parsed.prompt || question),
      };
      return Response.json({ plan, usage });
    }

    if (operation === "estimate") {
      const summary = {
        fileCount: boundedNumber(body.sourceSummary?.fileCount, 0, 0, 100000),
        readableCharacters: boundedNumber(body.sourceSummary?.readableCharacters, 0),
        sampleCharacters: boundedNumber(body.sourceSummary?.sampleCharacters, 0),
        sampleSegments: boundedNumber(body.sourceSummary?.sampleSegments, 0, 0, 32),
        plannedBatchCharacters: boundedNumber(body.sourceSummary?.plannedBatchCharacters, 7000, 1000, 100000),
        questionCharacters: String(body.question || "").length,
        protocolCharacters: JSON.stringify(body.plan || {}).length,
        outputFields: Array.isArray((body.plan as { fields?: unknown[] } | undefined)?.fields) ? (body.plan as { fields: unknown[] }).fields.length : 0,
      };
      const inputPrice = Math.max(0, Number(body.pricing?.inputPerMillion) || 0);
      const outputPrice = Math.max(0, Number(body.pricing?.outputPerMillion) || 0);
      const system = `你是 AI 批次文本分析的用量預算助手。根據數字摘要估算中文史料抽取工作所需的輸入與輸出 token 範圍。不可要求或假裝已閱讀原始史料，不可自行提供價格。要考慮每批重複的研究問題、規約、系統指令，以及符合材料密度造成的輸出差異。只返回合法 JSON，不要 Markdown。\n\n固定結構：\n{"sample":{"calls":1,"inputLow":0,"inputHigh":0,"outputLow":0,"outputHigh":0},"full":{"calls":1,"inputLow":0,"inputHigh":0,"outputLow":0,"outputHigh":0},"assumptions":[""]}`;
      const user = `模型：${model}\n任務摘要：${JSON.stringify(summary)}\n\n請估算：sample 代表自適應試跑上限，最多 32 段、每批最多 4 段，請求次數按 sampleSegments 除以 4 向上取整；若提前找到足夠候選，實際用量會更低。遇到超時時，系統會把批次自動拆成 2 段或 1 段，可能增加請求次數。full 代表按 plannedBatchCharacters 分批處理全部可讀字元。中文、標點、異體字和不同 tokenizer 會造成差異，請給出合理的上下界。`;
      const { content, usage } = await chat(baseUrl, apiKey, model, system, user);
      const parsed = jsonFromText(content) as Record<string, unknown>;
      const normalize = (value: unknown, label: string, fallbackCharacters: number, explicitFallbackCalls?: number) => {
        const scope = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
        const fallbackCalls = Math.max(1, explicitFallbackCalls || Math.ceil(Math.max(fallbackCharacters, 1) / summary.plannedBatchCharacters));
        const calls = boundedNumber(scope.calls, fallbackCalls, 1, 1000000);
        const inputLow = boundedNumber(scope.inputLow, Math.ceil(fallbackCharacters * 0.75), 1);
        const inputHigh = Math.max(inputLow, boundedNumber(scope.inputHigh, Math.ceil(fallbackCharacters * 1.45), inputLow));
        const outputLow = boundedNumber(scope.outputLow, Math.max(200, calls * 350), 1);
        const outputHigh = Math.max(outputLow, boundedNumber(scope.outputHigh, Math.max(1200, calls * 1200), outputLow));
        return {
          label,
          calls,
          inputLow,
          inputHigh,
          outputLow,
          outputHigh,
          totalLow: inputLow + outputLow,
          totalHigh: inputHigh + outputHigh,
          costLow: estimateCost(inputLow, outputLow, inputPrice, outputPrice),
          costHigh: estimateCost(inputHigh, outputHigh, inputPrice, outputPrice),
        };
      };
      const usageRecord = usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
      const estimatorTokens = usageRecord?.total_tokens || ((usageRecord?.prompt_tokens || 0) + (usageRecord?.completion_tokens || 0)) || null;
      return Response.json({
        estimate: {
          sample: normalize(parsed.sample, "本次自適應試跑上限", summary.sampleCharacters, Math.ceil(Math.max(summary.sampleSegments, 1) / 4)),
          full: normalize(parsed.full, "完整資料集規劃值", summary.readableCharacters),
          assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String).filter(Boolean).slice(0, 4) : ["不同模型的切詞方式與材料命中率會影響實際用量。"],
          generatedBy: "ai",
          estimatorTokens,
        },
      });
    }

    const chunks = (body.chunks || []).slice(0, 8).map((chunk, index) => ({
      id: String(chunk.id || `chunk-${index + 1}`),
      source: String(chunk.source || "上傳史料"),
      locator: String(chunk.locator || `第 ${index + 1} 段`),
      text: String(chunk.text || "").slice(0, 5000),
    })).filter((chunk) => chunk.text.trim());
    if (!chunks.length) throw new Error("目前沒有可試跑的文字段落。");
    const system = `你是嚴謹的中國史史料整理助手。只依據提供的史料段落和研究規約判讀，不使用外部知識。不得改寫、翻譯或修正原文。每個結果都必須附上原文證據與來源位置；不確定時降低相關度並在理由中說明。只返回合法 JSON，不要 Markdown。\n\n固定結構：\n{"items":[{"id":"","relevance":"高|中|低","category":"","title":"","source":"","locator":"","people":[""],"time":"","topic":"","excerpt":"","evidenceTerms":[""],"reason":"","note":""}]}`;
    const user = `研究問題：\n${String(body.question || "").slice(0, 5000)}\n\n研究規約：\n${JSON.stringify(body.plan || {}).slice(0, 12000)}\n\n待判讀段落：\n${JSON.stringify(chunks)}`;
    const { content, usage } = await chat(baseUrl, apiKey, model, system, user);
    const parsed = jsonFromText(content) as { items?: unknown[] };
    return Response.json({ items: Array.isArray(parsed.items) ? parsed.items.slice(0, 40) : [], usage });
  } catch (error) {
    return Response.json({ error: cleanError(error) }, { status: 400 });
  }
}
