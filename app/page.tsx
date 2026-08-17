"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

type StepId = "sources" | "question" | "provider" | "protocol" | "results" | "full";

type SourceFile = {
  id: string;
  name: string;
  size: number;
  characters: number;
  type: string;
  text: string;
  status: "ready" | "pending";
  locator?: string;
  originUrl?: string;
};

type ProviderPreset = {
  id: string;
  label: string;
  region: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  note: string;
  inputPrice: number | null;
  outputPrice: number | null;
};

type ResearchPlan = {
  title: string;
  objective: string;
  include: string[];
  exclude: string[];
  fields: string[];
  evidenceRule: string;
  prompt: string;
};

type ProtocolTemplate = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  plan: ResearchPlan;
};

type EvidenceItem = {
  id: string;
  relevance: "高" | "中" | "低";
  category: string;
  title: string;
  source: string;
  locator: string;
  people: string[];
  time: string;
  topic: string;
  excerpt: string;
  evidenceTerms: string[];
  reason: string;
  note: string;
  review: "採用" | "待核" | "排除";
};

type TextChunk = {
  id: string;
  source: string;
  locator: string;
  text: string;
};

type RunProgress = {
  processed: number;
  total: number;
  batches: number;
  message: string;
};

type ExportScope = "accepted" | "high" | "high-accepted" | "not-excluded" | "current" | "all";

type ResilientAnalysisOutcome = {
  items: Array<Partial<EvidenceItem>>;
  completed: number;
  calls: number;
  retries: number;
  usage: number;
  error?: string;
};

const ANALYSIS_BATCH_SIZE = 4;
const PROTOCOL_TEMPLATES_KEY = "shiliao-protocol-templates-v1";
const PROVIDER_SETTINGS_KEY = "shiliao-provider-settings-v1";
const SESSION_API_KEY_PREFIX = "shiliao-api-key-session-v1:";
const ENCRYPTED_API_KEYS_KEY = "shiliao-encrypted-api-keys-v1";

const exportScopes: Array<{ id: ExportScope; label: string }> = [
  { id: "accepted", label: "已採用" },
  { id: "high", label: "高相關（不含已排除）" },
  { id: "high-accepted", label: "高相關且已採用" },
  { id: "not-excluded", label: "全部（不含已排除）" },
  { id: "current", label: "目前篩選結果" },
  { id: "all", label: "全部結果（含已排除）" },
];

type EncryptedApiKey = {
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
  updatedAt: string;
};

type ProviderSettings = {
  providerId: string;
  baseUrl: string;
  model: string;
  inputPrice: string;
  outputPrice: string;
};

type AnalysisCheckpoint = {
  id: "active-analysis";
  version: 1;
  updatedAt: string;
  phase: "sample" | "full";
  pendingBatchIds: string[];
  sources: SourceFile[];
  question: string;
  plan: ResearchPlan;
  providerSettings: ProviderSettings;
  results: EvidenceItem[];
  sampleResults: EvidenceItem[];
  runState: "idle" | "working" | "ready" | "error";
  sampleProgress: RunProgress;
  sampleError: string;
  sampledChunkIds: string[];
  fullRunState: "idle" | "working" | "paused" | "stopped" | "completed" | "error";
  fullProgress: RunProgress;
  fullCursor: number;
  fullError: string;
  runUsageTokens: number;
  sampleUsageTokens: number;
};

const CHECKPOINT_DB_NAME = "shiliao-workbench-local";
const CHECKPOINT_STORE_NAME = "analysis-checkpoints";

function openCheckpointDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(CHECKPOINT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHECKPOINT_STORE_NAME)) database.createObjectStore(CHECKPOINT_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("無法開啟本機斷點資料庫"));
  });
}

async function writeAnalysisCheckpoint(checkpoint: AnalysisCheckpoint) {
  const database = await openCheckpointDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(CHECKPOINT_STORE_NAME, "readwrite");
      transaction.objectStore(CHECKPOINT_STORE_NAME).put(checkpoint);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("本機斷點寫入失敗"));
      transaction.onabort = () => reject(transaction.error || new Error("本機斷點寫入中止"));
    });
  } finally {
    database.close();
  }
}

async function readAnalysisCheckpoint() {
  const database = await openCheckpointDatabase();
  try {
    return await new Promise<AnalysisCheckpoint | null>((resolve, reject) => {
      const transaction = database.transaction(CHECKPOINT_STORE_NAME, "readonly");
      const request = transaction.objectStore(CHECKPOINT_STORE_NAME).get("active-analysis");
      request.onsuccess = () => resolve((request.result as AnalysisCheckpoint | undefined) || null);
      request.onerror = () => reject(request.error || new Error("本機斷點讀取失敗"));
    });
  } finally {
    database.close();
  }
}

async function deleteAnalysisCheckpoint() {
  const database = await openCheckpointDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(CHECKPOINT_STORE_NAME, "readwrite");
      transaction.objectStore(CHECKPOINT_STORE_NAME).delete("active-analysis");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("本機斷點刪除失敗"));
    });
  } finally {
    database.close();
  }
}

type EstimateScope = {
  label: string;
  calls: number;
  inputLow: number;
  inputHigh: number;
  outputLow: number;
  outputHigh: number;
  totalLow: number;
  totalHigh: number;
  costLow: number | null;
  costHigh: number | null;
};

type UsageEstimate = {
  sample: EstimateScope;
  full: EstimateScope;
  assumptions: string[];
  generatedBy: "ai" | "local";
  estimatorTokens?: number | null;
};

const providers: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    region: "國際",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-terra",
    needsKey: true,
    note: "適合複雜規約生成與高要求史料判讀。",
    inputPrice: 2,
    outputPrice: 12,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    region: "中國大陸",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    needsKey: true,
    note: "OpenAI-compatible，適合中國大陸網路環境。",
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: "dashscope",
    label: "阿里雲百煉",
    region: "中國大陸",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    needsKey: true,
    note: "通義千問及多種第三方模型的統一入口。",
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: "kimi",
    label: "Kimi",
    region: "中國大陸",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.5",
    needsKey: true,
    note: "兼容 OpenAI Chat Completions，長文本友好。",
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: "mimo",
    label: "MiMo",
    region: "中國大陸",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.5-pro",
    needsKey: true,
    note: "與本專案既有批次史料流程相容。",
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: "custom",
    label: "自訂兼容服務",
    region: "自訂",
    baseUrl: "",
    model: "",
    needsKey: true,
    note: "輸入任何 OpenAI-compatible HTTPS 服務。",
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: "ollama",
    label: "Ollama 本地模型",
    region: "本機",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:8b",
    needsKey: false,
    note: "資料在本機處理；適合未來桌面版。",
    inputPrice: 0,
    outputPrice: 0,
  },
];

const initialPlan: ResearchPlan = {
  title: "宋代士大夫朋黨指控材料辨析",
  objective: "找出因私人交遊、薦舉、門生故舊或政治依附而被指為朋黨的史料，保留可回查的完整原文證據。",
  include: [
    "明確出現結黨、朋黨、黨人、黨籍或氣類等政治性表述",
    "交遊、薦舉、門生故舊與彈劾、貶黜、禁錮等政治後果相連",
    "為當事人辨誣，或批評以朋黨名目陷害士人的材料",
  ],
  exclude: [
    "僅指鄉黨、親族、姻親、盜賊黨伙或一般同伴",
    "只有目錄、題名、頁碼或校勘說明而沒有正文",
    "依靠外部知識推斷、但原文無法支持的關係",
  ],
  fields: ["相關度", "材料類型", "人物", "時間", "地點", "主題", "原文證據", "判定理由", "研究札記"],
  evidenceRule: "照錄完整自然段或包含上下文的完整句群；保留繁簡、異體、OCR 疑字與校勘符號，不改寫原文。",
  prompt: `你是嚴謹的中國史史料整理助手。請只依據給定文本，判斷其中是否存在與士大夫朋黨指控、政治結社、薦舉網絡或黨禁相關的材料。\n\n每一條結果必須附上可回查的完整原文證據；不得翻譯、改寫或補入外部知識。若文本只涉及鄉黨、親族或一般同伴，應予排除。對不確定的材料標記為「待核」，不可強行下結論。`,
};

const steps: Array<{ id: StepId; number: string; label: string; hint: string }> = [
  { id: "sources", number: "01", label: "匯入史料", hint: "建立可回查來源" },
  { id: "question", number: "02", label: "研究問題", hint: "用自然語言描述" },
  { id: "provider", number: "03", label: "選擇 AI", hint: "使用自己的模型" },
  { id: "protocol", number: "04", label: "研究規約", hint: "確認 Prompt 與口徑" },
  { id: "results", number: "05", label: "樣本結果", hint: "閱讀、複核、修訂" },
  { id: "full", number: "06", label: "完整判讀", hint: "處理全文並匯出" },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function fileKind(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() || "file";
  return extension === "md" ? "Markdown" : extension.toUpperCase();
}

function renderExcerpt(excerpt: string, terms: string[]) {
  const matches = terms
    .map((term) => ({ term, index: excerpt.indexOf(term) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (!matches.length) return excerpt;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    parts.push(excerpt.slice(cursor, match.index));
    parts.push(<mark key={`${match.term}-${match.index}`}>{match.term}</mark>);
    cursor = match.index + match.term.length;
  }
  parts.push(excerpt.slice(cursor));
  return parts;
}

function draftPlan(question: string): ResearchPlan {
  const concise = question.trim() || initialPlan.objective;
  const firstSentence = concise.replace(/\s+/g, " ").split(/[。！？；;\n]/)[0].trim();
  const shortTitle = firstSentence.length > 24 ? `${firstSentence.slice(0, 24)}…` : firstSentence;
  return {
    ...initialPlan,
    title: shortTitle || "未命名史料研究",
    objective: concise,
    prompt: `${initialPlan.prompt}\n\n本次研究問題：${concise}`,
  };
}

function normalizeResearchPlan(value: unknown): ResearchPlan | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ResearchPlan>;
  const prompt = String(candidate.prompt || "").trim();
  if (!prompt) return null;
  const stringList = (items: unknown) => Array.isArray(items) ? items.map(String).map((item) => item.trim()).filter(Boolean) : [];
  return {
    title: String(candidate.title || "匯入的研究規約").trim() || "匯入的研究規約",
    objective: String(candidate.objective || "依照固定 Prompt 判讀多筆史料。").trim(),
    include: stringList(candidate.include),
    exclude: stringList(candidate.exclude),
    fields: stringList(candidate.fields),
    evidenceRule: String(candidate.evidenceRule || "保留可回查的原文證據與來源位置，不改寫史料。").trim(),
    prompt,
  };
}

function textChunks(sources: SourceFile[]): TextChunk[] {
  return sources
    .filter((source) => source.text.trim())
    .flatMap((source) => {
      const parts = source.text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
      const grouped: string[] = [];
      let buffer = "";
      const flush = () => {
        if (buffer.trim()) grouped.push(buffer.trim());
        buffer = "";
      };
      for (const part of parts) {
        if (part.length > 2400) {
          flush();
          for (let offset = 0; offset < part.length; offset += 1800) grouped.push(part.slice(offset, offset + 1800));
        } else if (buffer && buffer.length + part.length + 2 > 1800) {
          flush();
          buffer = part;
        } else {
          buffer = buffer ? `${buffer}\n\n${part}` : part;
        }
      }
      flush();
      return grouped.map((text, index) => ({
        id: `${source.id}-${index + 1}`,
        source: source.name,
        locator: source.locator ? `${source.locator} · 第 ${index + 1} 段` : `第 ${index + 1} 段`,
        text,
      }));
    });
}

function stratifiedChunks(chunks: TextChunk[], limit: number) {
  const count = Math.min(limit, chunks.length);
  if (!count) return [];
  const available = chunks.map((_, index) => index);
  const selected: TextChunk[] = [];
  while (selected.length < count) {
    const batchSize = Math.min(ANALYSIS_BATCH_SIZE, count - selected.length);
    const positions = Array.from({ length: batchSize }, (_, index) => Math.min(available.length - 1, Math.floor(((index + 0.5) * available.length) / batchSize)));
    for (const position of positions) selected.push(chunks[available[position]]);
    for (const position of [...positions].sort((left, right) => right - left)) available.splice(position, 1);
  }
  return selected;
}

function mapEvidenceItems(items: Array<Partial<EvidenceItem>> = [], prefix = "model") {
  return items.map((item, index): EvidenceItem => ({
    id: `${prefix}-${index + 1}-${item.id || "item"}`,
    relevance: ["高", "中", "低"].includes(String(item.relevance)) ? item.relevance as EvidenceItem["relevance"] : "中",
    category: item.category || "未分類",
    title: item.title || item.topic || "未命名材料",
    source: item.source || "上傳史料",
    locator: item.locator || "位置待核",
    people: Array.isArray(item.people) ? item.people : [],
    time: item.time || "",
    topic: item.topic || "",
    excerpt: item.excerpt || "",
    evidenceTerms: Array.isArray(item.evidenceTerms) ? item.evidenceTerms : [],
    reason: item.reason || "",
    note: item.note || "",
    review: "待核",
  }));
}

function mergeEvidence(current: EvidenceItem[], additions: EvidenceItem[]) {
  const seen = new Set(current.map((item) => `${item.source}\n${item.locator}\n${item.excerpt}`));
  return [...current, ...additions.filter((item) => {
    const key = `${item.source}\n${item.locator}\n${item.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}

function projectedScope(label: string, characters: number, overheadCharacters: number, fields: number, inputPrice: number, outputPrice: number, callsOverride?: number): EstimateScope {
  const batchCharacters = 7000;
  const calls = Math.max(1, callsOverride || Math.ceil(Math.max(characters, 1) / batchCharacters));
  const billedCharacters = characters + overheadCharacters * calls;
  const inputLow = Math.max(1, Math.ceil(billedCharacters * 0.75));
  const inputHigh = Math.max(inputLow, Math.ceil(billedCharacters * 1.45));
  const outputLow = Math.max(200, calls * Math.max(350, fields * 45));
  const outputHigh = Math.max(outputLow, calls * Math.max(1200, fields * 150));
  const hasPrice = Number.isFinite(inputPrice) && Number.isFinite(outputPrice) && (inputPrice > 0 || outputPrice > 0);
  return {
    label,
    calls,
    inputLow,
    inputHigh,
    outputLow,
    outputHigh,
    totalLow: inputLow + outputLow,
    totalHigh: inputHigh + outputHigh,
    costLow: hasPrice ? (inputLow * inputPrice + outputLow * outputPrice) / 1_000_000 : null,
    costHigh: hasPrice ? (inputHigh * inputPrice + outputHigh * outputPrice) / 1_000_000 : null,
  };
}

function formatTokens(value: number) {
  if (value < 1000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatCost(value: number | null) {
  if (value === null) return "待填單價";
  if (value > 0 && value < 0.01) return "< US$0.01";
  return `US$${value.toFixed(2)}`;
}

function formatCostRange(low: number | null, high: number | null) {
  if (low === null || high === null) return "待填單價";
  return `${formatCost(low)}–${formatCost(high)}`;
}

function usageTokens(value: unknown) {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!usage) return null;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total > 0) return total;
  const combined = Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0);
  return combined > 0 ? combined : null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

type ZipFile = {
  name: string;
  content: string;
};

function littleEndian(value: number, bytes: 2 | 4) {
  const output = new Uint8Array(bytes);
  const view = new DataView(output.buffer);
  if (bytes === 2) view.setUint16(0, value, true);
  else view.setUint32(0, value >>> 0, true);
  return output;
}

function joinBytes(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function createZipArchive(files: ZipFile[]) {
  const encoder = new TextEncoder();
  const createdAt = zipDateTime(new Date());
  const localParts: Uint8Array[] = [];
  const directoryParts: Uint8Array[] = [];
  let localOffset = 0;

  files.forEach((file) => {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const checksum = crc32(content);
    const localHeader = joinBytes([
      littleEndian(0x04034b50, 4), littleEndian(20, 2), littleEndian(0x0800, 2), littleEndian(0, 2),
      littleEndian(createdAt.time, 2), littleEndian(createdAt.date, 2), littleEndian(checksum, 4),
      littleEndian(content.length, 4), littleEndian(content.length, 4), littleEndian(name.length, 2), littleEndian(0, 2), name,
    ]);
    localParts.push(localHeader, content);
    directoryParts.push(joinBytes([
      littleEndian(0x02014b50, 4), littleEndian(20, 2), littleEndian(20, 2), littleEndian(0x0800, 2), littleEndian(0, 2),
      littleEndian(createdAt.time, 2), littleEndian(createdAt.date, 2), littleEndian(checksum, 4),
      littleEndian(content.length, 4), littleEndian(content.length, 4), littleEndian(name.length, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 4), littleEndian(localOffset, 4), name,
    ]));
    localOffset += localHeader.length + content.length;
  });

  const directory = joinBytes(directoryParts);
  const end = joinBytes([
    littleEndian(0x06054b50, 4), littleEndian(0, 2), littleEndian(0, 2), littleEndian(files.length, 2),
    littleEndian(files.length, 2), littleEndian(directory.length, 4), littleEndian(localOffset, 4), littleEndian(0, 2),
  ]);
  const archive = joinBytes([...localParts, directory, end]);
  return new Blob([toArrayBuffer(archive)], { type: "application/zip" });
}

function safeFileName(value: string) {
  const cleaned = Array.from(value.trim(), (character) => character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? "-" : character).join("");
  return cleaned.replace(/\s+/g, " ").slice(0, 72) || "未命名史料研究";
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character] || character);
}

function buildMarkdownReport(items: EvidenceItem[], reportTitle: string, projectTitle: string, question: string, scopeLabel: string, tokens: number) {
  const lines = [`# ${projectTitle}｜${reportTitle}`, "", `研究問題：${question}`, `匯出範圍：${scopeLabel}（${items.length} 條）`, "", `累計模型用量：${tokens ? `${tokens.toLocaleString()} Token` : "供應商未返回用量"}`, ""];
  items.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.title}（${item.relevance}／${item.review}）`, "", `- 來源：${item.source}｜${item.locator}`);
    if (item.people.length) lines.push(`- 人物：${item.people.join("、")}`);
    if (item.time) lines.push(`- 時間：${item.time}`);
    if (item.topic) lines.push(`- 主題：${item.topic}`);
    lines.push(`- 判定：${item.reason}`);
    if (item.note) lines.push(`- 研究札記：${item.note}`);
    lines.push("", `> ${item.excerpt.replace(/\n/g, "\n> ")}`, "");
  });
  return lines.join("\n");
}

function buildOfflineReport(items: EvidenceItem[], projectTitle: string, question: string, plan: ResearchPlan, scopeLabel: string, tokens: number) {
  const cards = items.map((item, index) => {
    const searchText = [item.title, item.source, item.locator, item.people.join(" "), item.time, item.topic, item.excerpt, item.reason, item.note].join(" ").toLowerCase();
    return `<article class="evidence" data-relevance="${escapeHtml(item.relevance)}" data-review="${escapeHtml(item.review)}" data-search="${escapeHtml(searchText)}"><div class="index">${String(index + 1).padStart(2, "0")}</div><div class="body"><div class="topline"><div><span class="tag relevance ${item.relevance === "高" ? "high" : item.relevance === "中" ? "medium" : "low"}">${escapeHtml(item.relevance)}相關</span><span class="tag">${escapeHtml(item.review)}</span><span class="tag">${escapeHtml(item.category)}</span></div><span>${escapeHtml(item.source)} · ${escapeHtml(item.locator)}</span></div><h2>${escapeHtml(item.title)}</h2><div class="meta">${item.time ? `<span>時間：${escapeHtml(item.time)}</span>` : ""}${item.people.length ? `<span>人物：${escapeHtml(item.people.join("、"))}</span>` : ""}${item.topic ? `<span>主題：${escapeHtml(item.topic)}</span>` : ""}</div><blockquote>${escapeHtml(item.excerpt)}</blockquote><div class="analysis"><div><b>判定理由</b><p>${escapeHtml(item.reason)}</p></div><div><b>研究札記</b><p>${escapeHtml(item.note || "—")}</p></div></div></div></article>`;
  }).join("");
  const includeItems = plan.include.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const excludeItems = plan.exclude.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const exportedAt = new Date().toLocaleString("zh-TW");
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(projectTitle)}｜研究成果</title><style>
  :root{--paper:#f8f5ee;--card:#fffdf8;--ink:#20302b;--muted:#727872;--line:#d7cdbd;--jade:#355f52;--rust:#a34b36}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Noto Serif TC","Songti TC","STSong",serif;line-height:1.75}header{padding:48px max(24px,calc((100vw - 1120px)/2));border-bottom:1px solid var(--line);background:linear-gradient(135deg,#f5efe3,#eef2ec)}.eyebrow{font:600 12px/1.4 system-ui;letter-spacing:.18em;color:var(--rust)}h1{max-width:900px;margin:12px 0 8px;font-size:clamp(34px,5vw,64px);line-height:1.12;font-weight:500}header p{max-width:800px;margin:0;color:var(--muted)}main{max-width:1120px;margin:auto;padding:28px 24px 80px}.summary{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);background:var(--card);margin-bottom:20px}.summary div{padding:18px;border-right:1px solid var(--line)}.summary div:last-child{border:0}.summary span{display:block;color:var(--muted);font:12px system-ui}.summary strong{font-size:28px;font-weight:500}.protocol{margin-bottom:20px;border:1px solid var(--line);background:var(--card);padding:4px 18px}.protocol summary{cursor:pointer;padding:13px 0;font-weight:600}.protocol-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px;padding:4px 0 18px}.protocol h3{font-size:14px}.protocol li,.protocol p{font-size:14px;color:#53605b}.toolbar{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 0;background:rgba(248,245,238,.94);backdrop-filter:blur(8px)}.filters{display:flex;flex-wrap:wrap;gap:6px}.filters button{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 13px;border-radius:999px;cursor:pointer}.filters button.active{background:var(--jade);border-color:var(--jade);color:#fff}.search{min-width:230px;padding:10px 13px;border:1px solid var(--line);background:#fff;font:14px system-ui}.count{margin:6px 0 14px;color:var(--muted);font:13px system-ui}.evidence{display:grid;grid-template-columns:58px 1fr;margin-bottom:14px;border:1px solid var(--line);background:var(--card)}.index{padding:22px 10px;text-align:center;color:var(--rust);font-size:19px;border-right:1px solid var(--line)}.body{padding:20px 24px}.topline{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font:12px system-ui}.tag{display:inline-block;margin-right:6px;padding:3px 8px;border:1px solid var(--line);border-radius:99px}.relevance.high{background:#dde9e2;color:#254f43}.relevance.medium{background:#f2ead6;color:#775d20}.relevance.low{background:#eeeae3;color:#706d67}h2{margin:13px 0 4px;font-size:25px;font-weight:500}.meta{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:13px}blockquote{margin:18px 0;padding:16px 18px;border-left:3px solid var(--jade);background:#f4f0e7;white-space:pre-wrap}.analysis{display:grid;grid-template-columns:1fr 1fr;gap:18px}.analysis b{font:600 12px system-ui;color:var(--rust)}.analysis p{margin:4px 0;font-size:14px}.empty{padding:60px;text-align:center;color:var(--muted);border:1px dashed var(--line)}footer{padding:18px;text-align:center;color:var(--muted);font:12px system-ui}@media(max-width:720px){header{padding:32px 20px}.summary{grid-template-columns:1fr 1fr}.summary div:nth-child(2){border-right:0}.protocol-grid,.analysis{grid-template-columns:1fr}.toolbar{align-items:stretch;flex-direction:column}.search{width:100%}.evidence{grid-template-columns:42px 1fr}.body{padding:16px}.topline{display:block}.topline>span{display:block;margin-top:8px}}@media print{.toolbar{display:none}body{background:#fff}.evidence{break-inside:avoid}}
  </style></head><body><header><span class="eyebrow">史料研析台 · 離線研究成果</span><h1>${escapeHtml(projectTitle)}</h1><p>${escapeHtml(question)}</p></header><main><section class="summary"><div><span>匯出材料</span><strong>${items.length}</strong></div><div><span>高相關</span><strong>${items.filter((item) => item.relevance === "高").length}</strong></div><div><span>已採用</span><strong>${items.filter((item) => item.review === "採用").length}</strong></div><div><span>模型用量</span><strong>${tokens ? escapeHtml(tokens.toLocaleString()) : "—"}</strong></div></section><details class="protocol"><summary>查看研究規約與匯出資訊</summary><div class="protocol-grid"><div><h3>納入標準</h3><ol>${includeItems}</ol><h3>排除標準</h3><ol>${excludeItems}</ol></div><div><h3>證據規則</h3><p>${escapeHtml(plan.evidenceRule)}</p><h3>匯出資訊</h3><p>範圍：${escapeHtml(scopeLabel)}<br>時間：${escapeHtml(exportedAt)}<br>此檔案可離線閱讀，不會連接模型或上傳史料。</p></div></div></details><div class="toolbar"><div class="filters">${["全部", "高", "中", "低", "採用", "待核", "排除"].map((filter) => `<button type="button" data-filter="${filter}"${filter === "全部" ? ' class="active"' : ""}>${filter}</button>`).join("")}</div><input class="search" type="search" placeholder="搜尋人物、來源或原文" aria-label="搜尋研究成果"></div><div class="count" aria-live="polite"></div><section class="results">${cards || '<div class="empty">這個項目包沒有可顯示的材料。</div>'}</section></main><footer>由史料研析台匯出 · ${escapeHtml(exportedAt)}</footer><script>
  (function(){var active='全部';var query='';var cards=Array.from(document.querySelectorAll('.evidence'));var count=document.querySelector('.count');function render(){var shown=0;cards.forEach(function(card){var matchesFilter=active==='全部'||card.dataset.relevance===active||card.dataset.review===active;var matchesSearch=!query||(card.dataset.search||'').indexOf(query)>-1;var visible=matchesFilter&&matchesSearch;card.hidden=!visible;if(visible)shown+=1});count.textContent='顯示 '+shown+'／'+cards.length+' 條'}document.querySelectorAll('[data-filter]').forEach(function(button){button.addEventListener('click',function(){active=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(item){item.classList.toggle('active',item===button)});render()})});document.querySelector('.search').addEventListener('input',function(event){query=event.target.value.trim().toLowerCase();render()});render()})();
  </script></body></html>`;
}

function readEncryptedApiKeys() {
  try {
    const raw = window.localStorage.getItem(ENCRYPTED_API_KEYS_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {} as Record<string, EncryptedApiKey>;
    return parsed as Record<string, EncryptedApiKey>;
  } catch {
    return {} as Record<string, EncryptedApiKey>;
  }
}

async function deriveCredentialKey(passphrase: string, salt: ArrayBuffer) {
  const encoder = new TextEncoder();
  const material = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 240_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptApiKey(secret: string, passphrase: string, providerId: string): Promise<EncryptedApiKey> {
  const encoder = new TextEncoder();
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveCredentialKey(passphrase, toArrayBuffer(salt));
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(encoder.encode(`shiliao:${providerId}:v1`)) },
    key,
    toArrayBuffer(encoder.encode(secret)),
  );
  return {
    version: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    updatedAt: new Date().toISOString(),
  };
}

async function decryptApiKey(record: EncryptedApiKey, passphrase: string, providerId: string) {
  const encoder = new TextEncoder();
  const salt = base64ToBytes(record.salt);
  const iv = base64ToBytes(record.iv);
  const key = await deriveCredentialKey(passphrase, toArrayBuffer(salt));
  const plaintext = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(encoder.encode(`shiliao:${providerId}:v1`)) },
    key,
    toArrayBuffer(base64ToBytes(record.ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}

function retryableBatchError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value || "");
  return /超過 90 秒|timeout|timed out|aborted|context length|maximum context|too large|payload|HTTP (408|413|504|524)/i.test(message);
}

export default function Home() {
  const [activeStep, setActiveStep] = useState<StepId>("sources");
  const [sources, setSources] = useState<SourceFile[]>([]);
  const [question, setQuestion] = useState("找出宋代士大夫因私人交遊、薦舉或門生故舊而被指為朋黨的材料；排除單純的鄉黨、親族與一般同伴。每條結果要保留完整原文、來源位置與判定理由。");
  const [providerId, setProviderId] = useState("openai");
  const [baseUrl, setBaseUrl] = useState(providers[0].baseUrl);
  const [model, setModel] = useState(providers[0].model);
  const [apiKey, setApiKey] = useState("");
  const [providerSettingsReady, setProviderSettingsReady] = useState(false);
  const [credentialPassphrase, setCredentialPassphrase] = useState("");
  const [credentialStorageState, setCredentialStorageState] = useState<"idle" | "working" | "error">("idle");
  const [credentialStorageMessage, setCredentialStorageMessage] = useState("API Key 會在本頁工作階段內自動記住；關閉本頁後清除。");
  const [hasEncryptedCredential, setHasEncryptedCredential] = useState(false);
  const [inputPrice, setInputPrice] = useState(String(providers[0].inputPrice ?? ""));
  const [outputPrice, setOutputPrice] = useState(String(providers[0].outputPrice ?? ""));
  const [connectionState, setConnectionState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [connectionMessage, setConnectionMessage] = useState("尚未測試");
  const [plan, setPlan] = useState<ResearchPlan>(initialPlan);
  const [planState, setPlanState] = useState<"idle" | "working" | "ready">("idle");
  const [results, setResults] = useState<EvidenceItem[]>([]);
  const [sampleResults, setSampleResults] = useState<EvidenceItem[]>([]);
  const [runState, setRunState] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [sampleTarget, setSampleTarget] = useState<1 | 3>(3);
  const [sampleProgress, setSampleProgress] = useState<RunProgress>({ processed: 0, total: 0, batches: 0, message: "尚未開始試跑" });
  const [sampleError, setSampleError] = useState("");
  const [sampledChunkIds, setSampledChunkIds] = useState<string[]>([]);
  const [fullRunState, setFullRunState] = useState<"idle" | "working" | "paused" | "stopped" | "completed" | "error">("idle");
  const [fullProgress, setFullProgress] = useState<RunProgress>({ processed: 0, total: 0, batches: 0, message: "等待確認樣本" });
  const [fullCursor, setFullCursor] = useState(0);
  const [fullError, setFullError] = useState("");
  const [runUsageTokens, setRunUsageTokens] = useState(0);
  const [sampleUsageTokens, setSampleUsageTokens] = useState(0);
  const [estimateState, setEstimateState] = useState<"idle" | "working" | "ready">("idle");
  const [usageEstimate, setUsageEstimate] = useState<UsageEstimate | null>(null);
  const [resultFilter, setResultFilter] = useState("全部");
  const [exportScope, setExportScope] = useState<ExportScope>("accepted");
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([]);
  const [recoverableCheckpoint, setRecoverableCheckpoint] = useState<AnalysisCheckpoint | null>(null);
  const [checkpointPromptVisible, setCheckpointPromptVisible] = useState(false);
  const [checkpointMessage, setCheckpointMessage] = useState("開始判讀後，每個批次都會自動保存本機斷點。");
  const [protocolTemplates, setProtocolTemplates] = useState<ProtocolTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateMessage, setTemplateMessage] = useState("模板仅保存在这台设备；可导出后交给其他研究者。");
  const [toast, setToast] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const pauseFullRunRef = useRef(false);
  const stopFullRunRef = useRef(false);
  const reviewOverridesRef = useRef(new Map<string, EvidenceItem["review"]>());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(PROVIDER_SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) as Partial<ProviderSettings> : null;
        const restoredProvider = providers.find((provider) => provider.id === parsed?.providerId) || providers[0];
        const restoredProviderId = restoredProvider.id;
        setProviderId(restoredProviderId);
        setBaseUrl(typeof parsed?.baseUrl === "string" ? parsed.baseUrl : restoredProvider.baseUrl);
        setModel(typeof parsed?.model === "string" ? parsed.model : restoredProvider.model);
        setInputPrice(typeof parsed?.inputPrice === "string" ? parsed.inputPrice : String(restoredProvider.inputPrice ?? ""));
        setOutputPrice(typeof parsed?.outputPrice === "string" ? parsed.outputPrice : String(restoredProvider.outputPrice ?? ""));
        const sessionKey = window.sessionStorage.getItem(`${SESSION_API_KEY_PREFIX}${restoredProviderId}`) || "";
        setApiKey(sessionKey);
        const encrypted = Boolean(readEncryptedApiKeys()[restoredProviderId]);
        setHasEncryptedCredential(encrypted);
        if (sessionKey) setCredentialStorageMessage("已恢復本頁工作階段中的 API Key。");
        else if (encrypted) setCredentialStorageMessage("這台設備有已加密的 Key；輸入解鎖密碼即可恢復。");
      } catch {
        setCredentialStorageMessage("模型設定無法讀取；請重新填寫。API Key 沒有被載入。");
      } finally {
        setProviderSettingsReady(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!window.indexedDB) {
        setCheckpointMessage("目前瀏覽器不支援本機斷點；請勿在工作中刷新或關閉頁面。");
        return;
      }
      void readAnalysisCheckpoint().then((checkpoint) => {
        if (!checkpoint || checkpoint.version !== 1 || !Array.isArray(checkpoint.sources)) return;
        setRecoverableCheckpoint(checkpoint);
        setCheckpointPromptVisible(true);
        setCheckpointMessage("發現一個可恢復的本機任務。");
      }).catch(() => {
        setCheckpointMessage("本機斷點暫時無法讀取；目前頁面仍可正常判讀。");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!providerSettingsReady) return;
    const settings: ProviderSettings = { providerId, baseUrl, model, inputPrice, outputPrice };
    try {
      window.localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // The page remains usable when browser storage is unavailable.
    }
  }, [baseUrl, inputPrice, model, outputPrice, providerId, providerSettingsReady]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(PROTOCOL_TEMPLATES_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return;
        const restored = parsed.flatMap((item, index): ProtocolTemplate[] => {
          if (!item || typeof item !== "object") return [];
          const record = item as Partial<ProtocolTemplate>;
          const restoredPlan = normalizeResearchPlan(record.plan);
          if (!restoredPlan) return [];
          const now = new Date().toISOString();
          return [{
            id: String(record.id || `restored-${index}-${Date.now()}`),
            name: String(record.name || restoredPlan.title),
            createdAt: String(record.createdAt || now),
            updatedAt: String(record.updatedAt || record.createdAt || now),
            plan: restoredPlan,
          }];
        }).slice(0, 100);
        setProtocolTemplates(restored);
        if (restored[0]) setSelectedTemplateId(restored[0].id);
      } catch {
        setTemplateMessage("本机模板记录无法读取；您仍可重新保存或导入模板文件。");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const selectedProvider = providers.find((provider) => provider.id === providerId) || providers[0];
  const visibleResults = activeStep === "full" ? results : sampleResults;
  const visibleUsageTokens = activeStep === "full" ? runUsageTokens : sampleUsageTokens;
  const filteredResults = useMemo(
    () => visibleResults.filter((item) => resultFilter === "全部" || item.relevance === resultFilter || item.review === resultFilter),
    [resultFilter, visibleResults],
  );
  const exportableResults = useMemo(() => {
    if (exportScope === "accepted") return visibleResults.filter((item) => item.review === "採用");
    if (exportScope === "high") return visibleResults.filter((item) => item.relevance === "高" && item.review !== "排除");
    if (exportScope === "high-accepted") return visibleResults.filter((item) => item.relevance === "高" && item.review === "採用");
    if (exportScope === "not-excluded") return visibleResults.filter((item) => item.review !== "排除");
    if (exportScope === "current") return filteredResults;
    return visibleResults;
  }, [exportScope, filteredResults, visibleResults]);
  const selectedVisibleIds = useMemo(() => {
    const visibleIds = new Set(visibleResults.map((item) => item.id));
    return selectedResultIds.filter((id) => visibleIds.has(id));
  }, [selectedResultIds, visibleResults]);

  const sourceStats = useMemo(() => ({
    files: sources.length,
    characters: sources.reduce((sum, source) => sum + source.characters, 0),
    ready: sources.filter((source) => source.status === "ready").length,
  }), [sources]);
  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const buildAnalysisCheckpoint = (phase: AnalysisCheckpoint["phase"], overrides: Partial<AnalysisCheckpoint> = {}): AnalysisCheckpoint => ({
    phase,
    pendingBatchIds: [],
    sources,
    question,
    plan,
    providerSettings: { providerId, baseUrl, model, inputPrice, outputPrice },
    results,
    sampleResults,
    runState,
    sampleProgress,
    sampleError,
    sampledChunkIds,
    fullRunState,
    fullProgress,
    fullCursor,
    fullError,
    runUsageTokens,
    sampleUsageTokens,
    ...overrides,
    id: "active-analysis",
    version: 1,
    updatedAt: new Date().toISOString(),
  });

  const persistAnalysisCheckpoint = async (phase: AnalysisCheckpoint["phase"], overrides: Partial<AnalysisCheckpoint> = {}) => {
    if (!window.indexedDB) return;
    try {
      const checkpoint = buildAnalysisCheckpoint(phase, overrides);
      await writeAnalysisCheckpoint(checkpoint);
      setCheckpointMessage(`斷點已自動保存：${checkpoint.phase === "full" ? checkpoint.fullProgress.processed : checkpoint.sampleProgress.processed}／${checkpoint.phase === "full" ? checkpoint.fullProgress.total : checkpoint.sampleProgress.total} 段`);
    } catch {
      setCheckpointMessage("本機斷點保存失敗；請保持頁面開啟，並儘快匯出目前結果。");
    }
  };

  const clearLocalCheckpoint = async () => {
    try {
      await deleteAnalysisCheckpoint();
      setRecoverableCheckpoint(null);
      setCheckpointPromptVisible(false);
      setCheckpointMessage("本機斷點已清除；下一次判讀會重新建立。");
      showToast("已清除本機斷點");
    } catch {
      setCheckpointMessage("本機斷點無法清除，請稍後再試。");
    }
  };

  const restoreLocalCheckpoint = () => {
    const checkpoint = recoverableCheckpoint;
    if (!checkpoint) return;
    setSources(checkpoint.sources.map((source) => ({ ...source })));
    setQuestion(checkpoint.question);
    setPlan({ ...checkpoint.plan, include: [...checkpoint.plan.include], exclude: [...checkpoint.plan.exclude], fields: [...checkpoint.plan.fields] });
    setPlanState("ready");
    setProviderId(checkpoint.providerSettings.providerId);
    setBaseUrl(checkpoint.providerSettings.baseUrl);
    setModel(checkpoint.providerSettings.model);
    setInputPrice(checkpoint.providerSettings.inputPrice);
    setOutputPrice(checkpoint.providerSettings.outputPrice);
    const restoredProvider = providers.find((provider) => provider.id === checkpoint.providerSettings.providerId) || providers[0];
    const restoredKey = window.sessionStorage.getItem(`${SESSION_API_KEY_PREFIX}${restoredProvider.id}`) || "";
    setApiKey(restoredKey);
    setHasEncryptedCredential(Boolean(readEncryptedApiKeys()[restoredProvider.id]));
    setConnectionState("idle");
    setConnectionMessage(restoredKey || !restoredProvider.needsKey ? "請重新測試連接" : "請解鎖或輸入 API Key");
    setResults(checkpoint.results.map((item) => ({ ...item, people: [...item.people], evidenceTerms: [...item.evidenceTerms] })));
    setSampleResults(checkpoint.sampleResults.map((item) => ({ ...item, people: [...item.people], evidenceTerms: [...item.evidenceTerms] })));
    setSampledChunkIds([...checkpoint.sampledChunkIds]);
    setSampleProgress({ ...checkpoint.sampleProgress, message: checkpoint.phase === "sample" ? "已從本機斷點恢復；可重試未完成樣本。" : checkpoint.sampleProgress.message });
    setSampleError(checkpoint.phase === "sample" && checkpoint.runState === "working" ? "上次工作在批次中斷；將從最後確認的段落繼續。" : checkpoint.sampleError);
    setRunState(checkpoint.phase === "sample" && checkpoint.runState === "working" ? "error" : checkpoint.runState);
    const restoredFullState = checkpoint.fullRunState === "completed" ? "completed" : checkpoint.phase === "full" ? "paused" : checkpoint.fullRunState;
    setFullRunState(restoredFullState);
    setFullProgress({ ...checkpoint.fullProgress, message: checkpoint.phase === "full" && checkpoint.fullRunState !== "completed" ? "已從本機斷點恢復；可從下一個未完成批次繼續。" : checkpoint.fullProgress.message });
    setFullCursor(checkpoint.fullCursor);
    setFullError(checkpoint.pendingBatchIds.length ? "上次中斷時有一批狀態未明；繼續時可能重新判讀該批。" : checkpoint.fullError);
    setRunUsageTokens(checkpoint.runUsageTokens);
    setSampleUsageTokens(checkpoint.sampleUsageTokens);
    setSelectedResultIds([]);
    setUsageEstimate(null);
    setEstimateState("idle");
    setActiveStep(checkpoint.phase === "full" ? "full" : "results");
    setCheckpointPromptVisible(false);
    setCheckpointMessage(checkpoint.pendingBatchIds.length ? "已恢復到最後確認的批次；上一批狀態不明，重新判讀可能再次計費。" : "已恢復到最後一個成功保存的批次。");
    showToast("已恢復本機斷點");
  };

  const persistProtocolTemplates = (next: ProtocolTemplate[], message: string) => {
    try {
      window.localStorage.setItem(PROTOCOL_TEMPLATES_KEY, JSON.stringify(next));
      setProtocolTemplates(next);
      setTemplateMessage(message);
      showToast(message);
      return true;
    } catch {
      const failure = "模板无法写入本机存储；请先使用导出功能保存当前模板。";
      setTemplateMessage(failure);
      showToast(failure);
      return false;
    }
  };

  const saveProtocolTemplate = (mode: "new" | "update") => {
    const now = new Date().toISOString();
    const snapshot = normalizeResearchPlan(plan);
    if (!snapshot) {
      showToast("完整 Prompt 为空，暂时无法保存模板");
      return;
    }
    if (mode === "update" && selectedTemplateId) {
      const next = protocolTemplates.map((template) => template.id === selectedTemplateId
        ? { ...template, name: snapshot.title, updatedAt: now, plan: snapshot }
        : template);
      persistProtocolTemplates(next, `已更新模板「${snapshot.title}」`);
      return;
    }
    const template: ProtocolTemplate = {
      id: uniqueId("protocol"),
      name: snapshot.title,
      createdAt: now,
      updatedAt: now,
      plan: snapshot,
    };
    const next = [template, ...protocolTemplates].slice(0, 100);
    if (persistProtocolTemplates(next, `已保存模板「${template.name}」`)) setSelectedTemplateId(template.id);
  };

  const loadProtocolTemplate = (templateId = selectedTemplateId) => {
    const template = protocolTemplates.find((item) => item.id === templateId);
    if (!template) {
      showToast("请先选择一个模板");
      return;
    }
    setPlan({ ...template.plan, include: [...template.plan.include], exclude: [...template.plan.exclude], fields: [...template.plan.fields] });
    setPlanState("ready");
    setUsageEstimate(null);
    setEstimateState("idle");
    setRunState("idle");
    setFullRunState("idle");
    setResults([]);
    setSampleResults([]);
    setSampledChunkIds([]);
    setTemplateMessage(`已载入「${template.name}」；可继续修改后试跑。`);
    showToast(`已载入模板「${template.name}」`);
  };

  const deleteProtocolTemplate = () => {
    const template = protocolTemplates.find((item) => item.id === selectedTemplateId);
    if (!template) return;
    const next = protocolTemplates.filter((item) => item.id !== selectedTemplateId);
    if (persistProtocolTemplates(next, `已删除模板「${template.name}」`)) setSelectedTemplateId(next[0]?.id || "");
  };

  const exportProtocolTemplates = () => {
    const now = new Date().toISOString();
    const current = normalizeResearchPlan(plan);
    const templates = protocolTemplates.length ? protocolTemplates : current ? [{ id: uniqueId("protocol"), name: current.title, createdAt: now, updatedAt: now, plan: current }] : [];
    if (!templates.length) {
      showToast("目前没有可导出的 Prompt 模板");
      return;
    }
    const payload = JSON.stringify({ type: "shiliao-protocol-templates", version: 1, exportedAt: now, templates }, null, 2);
    const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `史料研析台_Prompt模板_${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${templates.length} 个模板`);
  };

  const importProtocolTemplates = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const raw = await file.text();
      let candidates: unknown[] = [];
      if (file.name.toLowerCase().endsWith(".txt")) {
        candidates = [{ name: file.name.replace(/\.txt$/i, ""), plan: { ...plan, title: file.name.replace(/\.txt$/i, ""), prompt: raw } }];
      } else {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) candidates = parsed;
        else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { templates?: unknown[] }).templates)) candidates = (parsed as { templates: unknown[] }).templates;
        else candidates = [parsed];
      }
      const now = new Date().toISOString();
      const imported = candidates.flatMap((candidate, index): ProtocolTemplate[] => {
        const record = candidate && typeof candidate === "object" ? candidate as { name?: unknown; plan?: unknown } : {};
        const importedPlan = normalizeResearchPlan(record.plan || candidate);
        if (!importedPlan) return [];
        return [{
          id: `${uniqueId("imported")}-${index}`,
          name: String(record.name || importedPlan.title),
          createdAt: now,
          updatedAt: now,
          plan: importedPlan,
        }];
      });
      if (!imported.length) throw new Error("文件中没有可用的 Prompt 或研究规约");
      const next = [...imported, ...protocolTemplates].slice(0, 100);
      if (persistProtocolTemplates(next, `已导入 ${imported.length} 个 Prompt 模板`)) {
        setSelectedTemplateId(imported[0].id);
        setPlan({ ...imported[0].plan, include: [...imported[0].plan.include], exclude: [...imported[0].plan.exclude], fields: [...imported[0].plan.fields] });
        setPlanState("ready");
        setUsageEstimate(null);
        setEstimateState("idle");
        setRunState("idle");
        setFullRunState("idle");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "模板文件无法读取";
      setTemplateMessage(message);
      showToast(message);
    }
  };

  const addFiles = async (files: File[]) => {
    const next = await Promise.all(files.map(async (file) => {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const canRead = ["txt", "md", "markdown", "csv", "jsonl", "json"].includes(extension || "") && file.size <= 8 * 1024 * 1024;
      let text = "";
      if (canRead) text = await file.text();
      return {
        id: uniqueId("source"),
        name: file.name,
        size: file.size,
        characters: text.length,
        type: fileKind(file.name),
        text,
        status: canRead ? "ready" as const : "pending" as const,
      };
    }));
    setSources((current) => [...current, ...next]);
    setRunState("idle");
    setFullRunState("idle");
    setResults([]);
    setSampleResults([]);
    setSampledChunkIds([]);
    setUsageEstimate(null);
    setEstimateState("idle");
    showToast(`已加入 ${next.length} 個檔案`);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(Array.from(event.target.files));
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files.length) void addFiles(Array.from(event.dataTransfer.files));
  };

  const chooseProvider = (id: string) => {
    const next = providers.find((provider) => provider.id === id) || providers[0];
    setProviderId(id);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    const sessionKey = window.sessionStorage.getItem(`${SESSION_API_KEY_PREFIX}${id}`) || "";
    setApiKey(sessionKey);
    setInputPrice(next.inputPrice === null ? "" : String(next.inputPrice));
    setOutputPrice(next.outputPrice === null ? "" : String(next.outputPrice));
    const encrypted = Boolean(readEncryptedApiKeys()[id]);
    setHasEncryptedCredential(encrypted);
    setCredentialPassphrase("");
    setCredentialStorageState("idle");
    setCredentialStorageMessage(sessionKey
      ? "已恢復這個模型在本頁工作階段中的 API Key。"
      : encrypted
        ? "這台設備有已加密的 Key；輸入解鎖密碼即可恢復。"
        : "API Key 會在本頁工作階段內自動記住；關閉本頁後清除。");
    setUsageEstimate(null);
    setEstimateState("idle");
    setConnectionState("idle");
    setConnectionMessage("尚未測試");
  };

  const rememberApiKeyForSession = (value: string) => {
    setApiKey(value);
    try {
      if (value) window.sessionStorage.setItem(`${SESSION_API_KEY_PREFIX}${providerId}`, value);
      else window.sessionStorage.removeItem(`${SESSION_API_KEY_PREFIX}${providerId}`);
      setCredentialStorageMessage(value
        ? "API Key 已在本頁工作階段內記住；關閉本頁後清除。"
        : hasEncryptedCredential
          ? "目前 Key 已清空；這台設備仍有可解鎖的加密副本。"
          : "尚未輸入 API Key。");
    } catch {
      setCredentialStorageMessage("瀏覽器不允許工作階段暫存；Key 只會保留到下一次刷新前。");
    }
  };

  const saveEncryptedCredential = async () => {
    if (!selectedProvider.needsKey || !apiKey.trim()) {
      setCredentialStorageState("error");
      setCredentialStorageMessage("請先輸入要保存的 API Key。");
      return;
    }
    if (credentialPassphrase.length < 8) {
      setCredentialStorageState("error");
      setCredentialStorageMessage("請設定至少 8 個字元的本機解鎖密碼。");
      return;
    }
    if (!window.crypto?.subtle) {
      setCredentialStorageState("error");
      setCredentialStorageMessage("目前瀏覽器不支援安全加密保存，請僅使用工作階段記憶。");
      return;
    }
    setCredentialStorageState("working");
    setCredentialStorageMessage("正在本機加密…");
    try {
      const record = await encryptApiKey(apiKey.trim(), credentialPassphrase, providerId);
      const encryptedKeys = readEncryptedApiKeys();
      encryptedKeys[providerId] = record;
      window.localStorage.setItem(ENCRYPTED_API_KEYS_KEY, JSON.stringify(encryptedKeys));
      setHasEncryptedCredential(true);
      setCredentialPassphrase("");
      setCredentialStorageState("idle");
      setCredentialStorageMessage("Key 已在這台設備上加密保存；下次只需輸入解鎖密碼。");
      showToast("API Key 已在本機加密保存");
    } catch {
      setCredentialStorageState("error");
      setCredentialStorageMessage("本機加密保存失敗；Key 仍只在目前工作階段內使用。");
    }
  };

  const unlockEncryptedCredential = async () => {
    if (credentialPassphrase.length < 8) {
      setCredentialStorageState("error");
      setCredentialStorageMessage("請輸入保存時設定的本機解鎖密碼。");
      return;
    }
    const record = readEncryptedApiKeys()[providerId];
    if (!record) {
      setHasEncryptedCredential(false);
      setCredentialStorageState("error");
      setCredentialStorageMessage("沒有找到這個模型的加密 Key。");
      return;
    }
    setCredentialStorageState("working");
    setCredentialStorageMessage("正在解鎖…");
    try {
      const decrypted = await decryptApiKey(record, credentialPassphrase, providerId);
      rememberApiKeyForSession(decrypted);
      setCredentialPassphrase("");
      setCredentialStorageState("idle");
      setCredentialStorageMessage("已解鎖，並在本頁工作階段內恢復 API Key。");
      showToast("已恢復加密保存的 API Key");
    } catch {
      setCredentialStorageState("error");
      setCredentialStorageMessage("無法解鎖：密碼不正確，或本機記錄已經損壞。");
    }
  };

  const clearSavedCredential = () => {
    try {
      window.sessionStorage.removeItem(`${SESSION_API_KEY_PREFIX}${providerId}`);
      const encryptedKeys = readEncryptedApiKeys();
      delete encryptedKeys[providerId];
      if (Object.keys(encryptedKeys).length) window.localStorage.setItem(ENCRYPTED_API_KEYS_KEY, JSON.stringify(encryptedKeys));
      else window.localStorage.removeItem(ENCRYPTED_API_KEYS_KEY);
    } catch {
      // Clear the in-memory copy even if browser storage is unavailable.
    }
    setApiKey("");
    setHasEncryptedCredential(false);
    setCredentialPassphrase("");
    setCredentialStorageState("idle");
    setCredentialStorageMessage("已清除這個模型在本頁及本機保存的 API Key。");
    setConnectionState("idle");
    setConnectionMessage("尚未測試");
    showToast("已清除保存的 API Key");
  };

  const callLlm = async (operation: "test" | "plan" | "estimate" | "analyze", extra: Record<string, unknown> = {}) => {
    const response = await fetch("/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation,
        providerId,
        baseUrl,
        model,
        apiKey,
        ...extra,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "模型服務暫時無法回應。請檢查設定後重試。");
    return data;
  };

  const analyzeChunksResiliently = async (
    chunks: TextChunk[],
    onStatus: (message: string, calls: number) => void,
  ): Promise<ResilientAnalysisOutcome> => {
    const pending: TextChunk[][] = [chunks];
    const items: Array<Partial<EvidenceItem>> = [];
    let completed = 0;
    let calls = 0;
    let retries = 0;
    let usage = 0;

    while (pending.length) {
      const group = pending.shift() || [];
      if (!group.length) continue;
      calls += 1;
      onStatus(`正在判讀 ${group.length} 段（第 ${calls} 次請求）`, calls);
      try {
        const data = await callLlm("analyze", { question, plan, chunks: group });
        if (Array.isArray(data.items)) items.push(...data.items);
        completed += group.length;
        usage += usageTokens(data.usage) || 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : "模型判讀失敗";
        if (retryableBatchError(error) && group.length > 1) {
          retries += 1;
          const midpoint = Math.ceil(group.length / 2);
          const left = group.slice(0, midpoint);
          const right = group.slice(midpoint);
          pending.unshift(left, right);
          onStatus(`${group.length} 段請求逾時，已自動拆成 ${left.length}＋${right.length} 段重試`, calls);
          continue;
        }
        return { items, completed, calls, retries, usage, error: message };
      }
    }

    return { items, completed, calls, retries, usage };
  };

  const testConnection = async () => {
    if (selectedProvider.needsKey && !apiKey.trim()) {
      setConnectionState("error");
      setConnectionMessage("請先輸入 API Key");
      return;
    }
    if (!baseUrl.trim() || !model.trim()) {
      setConnectionState("error");
      setConnectionMessage("請填寫 API 地址與模型名稱");
      return;
    }
    setConnectionState("testing");
    setConnectionMessage("正在確認服務…");
    try {
      const data = await callLlm("test");
      setConnectionState("ok");
      setConnectionMessage(data.message || "連接正常");
    } catch (error) {
      setConnectionState("error");
      setConnectionMessage(error instanceof Error ? error.message : "連接失敗");
    }
  };

  const generatePlan = async () => {
    setPlanState("working");
    setUsageEstimate(null);
    setEstimateState("idle");
    try {
      if ((!selectedProvider.needsKey || apiKey.trim()) && baseUrl.trim() && model.trim()) {
        const data = await callLlm("plan", { question });
        setPlan(data.plan);
        showToast(`已由 ${selectedProvider.label} 產生研究規約`);
      } else {
        setPlan(draftPlan(question));
        showToast("已產生本機規約草案；連接 AI 後可再優化");
      }
      setPlanState("ready");
      setActiveStep("protocol");
    } catch (error) {
      setPlan(draftPlan(question));
      setPlanState("ready");
      setActiveStep("protocol");
      showToast(error instanceof Error ? `${error.message} 已改用本機草案。` : "已改用本機草案");
    }
  };

  const updatePlan = (next: ResearchPlan) => {
    setPlan(next);
    setUsageEstimate(null);
    setEstimateState("idle");
    setRunState("idle");
    setFullRunState("idle");
  };

  const updateRule = (group: "include" | "exclude", index: number, value: string) => {
    updatePlan({ ...plan, [group]: plan[group].map((entry, entryIndex) => entryIndex === index ? value : entry) });
  };

  const addRule = (group: "include" | "exclude") => {
    updatePlan({ ...plan, [group]: [...plan[group], ""] });
  };

  const removeRule = (group: "include" | "exclude", index: number) => {
    updatePlan({ ...plan, [group]: plan[group].filter((_, entryIndex) => entryIndex !== index) });
  };

  const updateOutputField = (index: number, value: string) => {
    updatePlan({ ...plan, fields: plan.fields.map((field, fieldIndex) => fieldIndex === index ? value : field) });
  };

  const addOutputField = () => updatePlan({ ...plan, fields: [...plan.fields, ""] });
  const removeOutputField = (index: number) => updatePlan({ ...plan, fields: plan.fields.filter((_, fieldIndex) => fieldIndex !== index) });

  const estimateUsage = async () => {
    setEstimateState("working");
    const chunks = stratifiedChunks(textChunks(sources), 32);
    const readableCharacters = sources.reduce((sum, source) => sum + (source.text.length || source.characters), 0);
    const sampleCharacters = chunks.length
      ? chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
      : Math.min(readableCharacters, 20000);
    const prices = {
      inputPerMillion: Math.max(0, Number(inputPrice) || 0),
      outputPerMillion: Math.max(0, Number(outputPrice) || 0),
    };
    const overheadCharacters = question.length + JSON.stringify(plan).length + 1200;
    const local: UsageEstimate = {
      sample: projectedScope("本次自適應試跑上限", sampleCharacters, overheadCharacters, plan.fields.length, prices.inputPerMillion, prices.outputPerMillion, Math.ceil(Math.max(chunks.length, 1) / ANALYSIS_BATCH_SIZE)),
      full: projectedScope("完整資料集規劃值", readableCharacters, overheadCharacters, plan.fields.length, prices.inputPerMillion, prices.outputPerMillion),
      assumptions: ["中文、標點與異體字在不同模型中的切詞方式不同，因此以範圍呈現。", "完整資料集暫按每批約 7,000 個字元估算；超時後自動拆批會增加請求次數。"],
      generatedBy: "local",
    };
    try {
      if ((!selectedProvider.needsKey || apiKey.trim()) && baseUrl.trim() && model.trim()) {
        const data = await callLlm("estimate", {
          question,
          plan,
          sourceSummary: {
            fileCount: sources.length,
            readableCharacters,
            sampleCharacters,
            sampleSegments: chunks.length,
            plannedBatchCharacters: 7000,
          },
          pricing: prices,
        });
        setUsageEstimate(data.estimate as UsageEstimate);
        showToast(`已由 ${selectedProvider.label} 完成用量預算`);
      } else {
        setUsageEstimate(local);
        showToast("尚未連接 AI，先顯示本機粗估");
      }
    } catch (error) {
      setUsageEstimate(local);
      showToast(error instanceof Error ? `${error.message} 已改用本機粗估。` : "已改用本機粗估");
    } finally {
      setEstimateState("ready");
    }
  };

  const runSample = async (resume = false) => {
    const allChunks = textChunks(sources);
    const queue = stratifiedChunks(allChunks, 32);
    let collected: EvidenceItem[] = resume ? [...results] : [];
    let processedIds: string[] = resume ? [...sampledChunkIds] : [];
    let batches = resume ? sampleProgress.batches : 0;
    let accumulatedUsage = resume ? runUsageTokens : 0;
    let accumulatedSampleUsage = resume ? sampleUsageTokens : 0;

    if (!resume) {
      setResults([]);
      setSampleResults([]);
      setSelectedResultIds([]);
      setSampledChunkIds([]);
      setRunUsageTokens(0);
      setSampleUsageTokens(0);
      reviewOverridesRef.current.clear();
    }
    setSampleError("");
    setFullRunState("idle");
    setFullCursor(0);
    setFullError("");
    setSampleProgress({ processed: processedIds.length, total: queue.length, batches, message: resume ? "正在從上一個未完成段落繼續…" : `將從全文不同位置最多檢查 ${queue.length} 段` });
    setRunState("working");
    try {
      if (!queue.length) throw new Error("目前沒有可試跑的文字段落；請先加入可讀取的 TXT、Markdown、CSV、JSONL 或 JSON 史料。");
      if (selectedProvider.needsKey && !apiKey.trim()) throw new Error("請先回到模型設定，填寫 API Key 並完成連接測試。");
      if (!baseUrl.trim() || !model.trim()) throw new Error("請先完成 API 地址與模型名稱設定。");

      let offset = processedIds.length;
      while (offset < queue.length) {
        const batch = queue.slice(offset, offset + ANALYSIS_BATCH_SIZE);
        await persistAnalysisCheckpoint("sample", {
          pendingBatchIds: batch.map((chunk) => chunk.id),
          results: collected,
          sampleResults: collected,
          runState: "working",
          sampleProgress: { processed: processedIds.length, total: queue.length, batches, message: `正在準備第 ${batches + 1} 次請求…` },
          sampledChunkIds: processedIds,
          runUsageTokens: accumulatedUsage,
          sampleUsageTokens: accumulatedSampleUsage,
        });
        const outcome = await analyzeChunksResiliently(batch, (message, calls) => {
          setSampleProgress({ processed: processedIds.length, total: queue.length, batches: batches + calls, message });
        });
        batches += outcome.calls;
        const mapped = mapEvidenceItems(outcome.items, `sample-${batches}`);
        collected = mergeEvidence(collected, mapped).map((item) => ({ ...item, review: reviewOverridesRef.current.get(item.id) || item.review }));
        const completedChunks = batch.slice(0, outcome.completed);
        processedIds = [...processedIds, ...completedChunks.map((chunk) => chunk.id)];
        offset += outcome.completed;
        if (outcome.usage) {
          accumulatedUsage += outcome.usage;
          accumulatedSampleUsage += outcome.usage;
          setRunUsageTokens(accumulatedUsage);
          setSampleUsageTokens(accumulatedSampleUsage);
        }
        setResults(collected);
        setSampleResults(collected);
        setSampledChunkIds(processedIds);
        setSampleProgress({
          processed: processedIds.length,
          total: queue.length,
          batches,
          message: `已檢查 ${processedIds.length} 段，找到 ${collected.filter((item) => item.relevance !== "低").length} 條候選${outcome.retries ? `；自動拆批 ${outcome.retries} 次` : ""}`,
        });
        await persistAnalysisCheckpoint("sample", {
          pendingBatchIds: outcome.error ? batch.slice(outcome.completed).map((chunk) => chunk.id) : [],
          results: collected,
          sampleResults: collected,
          runState: outcome.error ? "error" : "working",
          sampleProgress: {
            processed: processedIds.length,
            total: queue.length,
            batches,
            message: `已保存 ${processedIds.length} 段；找到 ${collected.filter((item) => item.relevance !== "低").length} 條候選。`,
          },
          sampleError: outcome.error || "",
          sampledChunkIds: processedIds,
          runUsageTokens: accumulatedUsage,
          sampleUsageTokens: accumulatedSampleUsage,
        });
        if (outcome.error) throw new Error(`${outcome.error}${outcome.completed ? `；前 ${outcome.completed} 段結果已保留。` : ""}`);
        if (collected.filter((item) => item.relevance !== "低").length >= sampleTarget) break;
      }

      const relevant = collected.filter((item) => item.relevance !== "低").length;
      setSampleProgress((current) => ({
        ...current,
        message: relevant >= sampleTarget
          ? `已達校準目標：找到 ${relevant} 條候選，請先人工複核。`
          : `已檢查 ${processedIds.length} 段，暫未達到 ${sampleTarget} 條候選。`,
      }));
      setRunState("ready");
      await persistAnalysisCheckpoint("sample", {
        pendingBatchIds: [],
        results: collected,
        sampleResults: collected,
        runState: "ready",
        sampleProgress: {
          processed: processedIds.length,
          total: queue.length,
          batches,
          message: relevant >= sampleTarget ? `已達校準目標：找到 ${relevant} 條候選。` : `已檢查 ${processedIds.length} 段，暫未達到 ${sampleTarget} 條候選。`,
        },
        sampleError: "",
        sampledChunkIds: processedIds,
        runUsageTokens: accumulatedUsage,
        sampleUsageTokens: accumulatedSampleUsage,
      });
      setActiveStep("results");
      showToast(relevant ? `自適應試跑完成：找到 ${relevant} 條候選` : `已檢查 ${processedIds.length} 段，未找到符合材料`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "樣本試跑失敗";
      setResults(collected);
      setSampleResults(collected);
      setSampledChunkIds(processedIds);
      setSampleError(message);
      setRunState("error");
      setActiveStep("results");
      showToast(message);
    }
  };

  const processFullAnalysis = async (startCursor: number, seedResults: EvidenceItem[]) => {
    const allChunks = textChunks(sources);
    const sampled = new Set(sampledChunkIds);
    const queue = allChunks.filter((chunk) => !sampled.has(chunk.id));
    let cursor = startCursor;
    let collected = seedResults;
    let completedBatches = startCursor ? fullProgress.batches : 0;
    let accumulatedUsage = runUsageTokens;

    pauseFullRunRef.current = false;
    stopFullRunRef.current = false;
    setFullRunState("working");
    setFullError("");
    setFullProgress({
      processed: Math.min(allChunks.length, sampledChunkIds.length + cursor),
      total: allChunks.length,
      batches: completedBatches,
      message: "正在準備完整分析…",
    });

    try {
      if (!allChunks.length) throw new Error("目前沒有可分析的文字段落。");
      while (cursor < queue.length) {
        const batch = queue.slice(cursor, cursor + ANALYSIS_BATCH_SIZE);
        await persistAnalysisCheckpoint("full", {
          pendingBatchIds: batch.map((chunk) => chunk.id),
          results: collected,
          sampleResults,
          fullRunState: "working",
          fullProgress: {
            processed: Math.min(allChunks.length, sampledChunkIds.length + cursor),
            total: allChunks.length,
            batches: completedBatches,
            message: `正在準備第 ${completedBatches + 1} 次完整判讀請求…`,
          },
          fullCursor: cursor,
          fullError: "",
          runUsageTokens: accumulatedUsage,
        });
        const outcome = await analyzeChunksResiliently(batch, (message, calls) => {
          setFullProgress({
            processed: sampledChunkIds.length + cursor,
            total: allChunks.length,
            batches: completedBatches + calls,
            message,
          });
        });
        completedBatches += outcome.calls;
        const mapped = mapEvidenceItems(outcome.items, `full-${completedBatches}`);
        collected = mergeEvidence(collected, mapped).map((item) => ({ ...item, review: reviewOverridesRef.current.get(item.id) || item.review }));
        const nextCursor = cursor + outcome.completed;
        setResults(collected);
        setFullCursor(nextCursor);
        if (outcome.usage) {
          accumulatedUsage += outcome.usage;
          setRunUsageTokens(accumulatedUsage);
        }
        setFullProgress({
          processed: Math.min(allChunks.length, sampledChunkIds.length + nextCursor),
          total: allChunks.length,
          batches: completedBatches,
          message: `已保存 ${sampledChunkIds.length + nextCursor} 段；累計找到 ${collected.filter((item) => item.relevance !== "低").length} 條候選${outcome.retries ? `；自動拆批 ${outcome.retries} 次` : ""}`,
        });
        await persistAnalysisCheckpoint("full", {
          pendingBatchIds: outcome.error ? batch.slice(outcome.completed).map((chunk) => chunk.id) : [],
          results: collected,
          sampleResults,
          fullRunState: outcome.error ? "error" : "working",
          fullProgress: {
            processed: Math.min(allChunks.length, sampledChunkIds.length + nextCursor),
            total: allChunks.length,
            batches: completedBatches,
            message: `已保存 ${sampledChunkIds.length + nextCursor} 段；累計找到 ${collected.filter((item) => item.relevance !== "低").length} 條候選。`,
          },
          fullCursor: nextCursor,
          fullError: outcome.error || "",
          runUsageTokens: accumulatedUsage,
        });
        if (outcome.error) throw new Error(`${outcome.error}${outcome.completed ? `；本次已完成的 ${outcome.completed} 段已保留。` : ""}`);
        cursor = nextCursor;

        if (stopFullRunRef.current) {
          setFullRunState("stopped");
          setFullProgress((current) => ({ ...current, message: "已在本批完成後停止；可以稍後從下一批繼續。" }));
          await persistAnalysisCheckpoint("full", { pendingBatchIds: [], results: collected, sampleResults, fullRunState: "stopped", fullProgress: { processed: Math.min(allChunks.length, sampledChunkIds.length + cursor), total: allChunks.length, batches: completedBatches, message: "已在本批完成後停止；可以稍後從下一批繼續。" }, fullCursor: cursor, runUsageTokens: accumulatedUsage });
          return;
        }
        if (pauseFullRunRef.current) {
          setFullRunState("paused");
          setFullProgress((current) => ({ ...current, message: "已暫停並保留本頁進度。" }));
          await persistAnalysisCheckpoint("full", { pendingBatchIds: [], results: collected, sampleResults, fullRunState: "paused", fullProgress: { processed: Math.min(allChunks.length, sampledChunkIds.length + cursor), total: allChunks.length, batches: completedBatches, message: "已暫停並保留本頁進度。" }, fullCursor: cursor, runUsageTokens: accumulatedUsage });
          return;
        }
      }
      setFullRunState("completed");
      setFullProgress({
        processed: allChunks.length,
        total: allChunks.length,
        batches: completedBatches,
        message: `完整分析完成；共找到 ${collected.filter((item) => item.relevance !== "低").length} 條候選。`,
      });
      await persistAnalysisCheckpoint("full", {
        pendingBatchIds: [],
        results: collected,
        sampleResults,
        fullRunState: "completed",
        fullProgress: {
          processed: allChunks.length,
          total: allChunks.length,
          batches: completedBatches,
          message: `完整分析完成；共找到 ${collected.filter((item) => item.relevance !== "低").length} 條候選。`,
        },
        fullCursor: queue.length,
        fullError: "",
        runUsageTokens: accumulatedUsage,
      });
      showToast("完整資料集分析完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "完整分析暫時中斷";
      setFullError(message);
      setFullRunState("error");
      setFullProgress((current) => ({ ...current, message: "本批未完成，進度停在上一個成功批次。" }));
      showToast(message);
    }
  };

  const startFullAnalysis = () => {
    setFullCursor(0);
    setResults(sampleResults);
    setSelectedResultIds([]);
    setActiveStep("full");
    void processFullAnalysis(0, sampleResults);
  };

  const resumeFullAnalysis = () => {
    setActiveStep("full");
    void processFullAnalysis(fullCursor, results);
  };

  const pauseFullAnalysis = () => {
    pauseFullRunRef.current = true;
    setFullProgress((current) => ({ ...current, message: "會在目前批次完成後暫停…" }));
  };

  const stopFullAnalysis = () => {
    stopFullRunRef.current = true;
    setFullProgress((current) => ({ ...current, message: "會在目前批次完成後停止並保留進度…" }));
  };

  const updateReview = (id: string, review: EvidenceItem["review"]) => {
    reviewOverridesRef.current.set(id, review);
    const nextResults = results.map((item) => item.id === id ? { ...item, review } : item);
    const nextSampleResults = sampleResults.map((item) => item.id === id ? { ...item, review } : item);
    setResults(nextResults);
    setSampleResults(nextSampleResults);
    if (runState !== "working" && fullRunState !== "working") void persistAnalysisCheckpoint(activeStep === "full" ? "full" : "sample", { pendingBatchIds: [], results: nextResults, sampleResults: nextSampleResults });
  };

  const toggleResultSelection = (id: string) => {
    setSelectedResultIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const selectResultGroup = (scope: "current" | "high") => {
    const ids = (scope === "high" ? visibleResults.filter((item) => item.relevance === "高") : filteredResults).map((item) => item.id);
    setSelectedResultIds(ids);
    showToast(scope === "high" ? `已選擇 ${ids.length} 條高相關材料` : `已選擇目前顯示的 ${ids.length} 條材料`);
  };

  const bulkUpdateReview = (review: EvidenceItem["review"]) => {
    if (!selectedVisibleIds.length) {
      showToast("請先選擇要批量處理的材料");
      return;
    }
    const selected = new Set(selectedVisibleIds);
    selectedVisibleIds.forEach((id) => reviewOverridesRef.current.set(id, review));
    const applyReview = (items: EvidenceItem[]) => items.map((item) => selected.has(item.id) ? { ...item, review } : item);
    const nextResults = applyReview(results);
    const nextSampleResults = applyReview(sampleResults);
    setResults(nextResults);
    setSampleResults(nextSampleResults);
    setSelectedResultIds([]);
    if (runState !== "working" && fullRunState !== "working") void persistAnalysisCheckpoint(activeStep === "full" ? "full" : "sample", { pendingBatchIds: [], results: nextResults, sampleResults: nextSampleResults });
    showToast(`已將 ${selected.size} 條材料標記為「${review}」`);
  };

  const exportResults = () => {
    const isFullExport = activeStep === "full";
    const reportTitle = isFullExport ? "完整資料集結果" : "自適應試跑結果";
    const projectTitle = safeFileName(plan.title || "未命名史料研究");
    const scopeLabel = exportScopes.find((scope) => scope.id === exportScope)?.label || "自訂範圍";
    const markdown = buildMarkdownReport(exportableResults, reportTitle, projectTitle, question, scopeLabel, visibleUsageTokens);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${projectTitle}_${scopeLabel.replace(/[（）／\s]/g, "-")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("已匯出 Markdown");
  };

  const exportProjectPackage = () => {
    if (!exportableResults.length) return;
    const isFullExport = activeStep === "full";
    const reportTitle = isFullExport ? "完整資料集結果" : "自適應試跑結果";
    const projectTitle = safeFileName(plan.title || "未命名史料研究");
    const scopeLabel = exportScopes.find((scope) => scope.id === exportScope)?.label || "自訂範圍";
    const exportedAt = new Date().toISOString();
    const directory = `${projectTitle}/`;
    const markdown = buildMarkdownReport(exportableResults, reportTitle, projectTitle, question, scopeLabel, visibleUsageTokens);
    const offlineHtml = buildOfflineReport(exportableResults, projectTitle, question, plan, scopeLabel, visibleUsageTokens);
    const projectData = JSON.stringify({
      type: "shiliao-research-project",
      version: 1,
      exportedAt,
      projectTitle,
      phase: activeStep === "full" ? "full" : "sample",
      exportScope: { id: exportScope, label: scopeLabel, resultIds: exportableResults.map((item) => item.id) },
      question,
      plan,
      provider: { id: providerId, label: selectedProvider.label, model },
      usage: { sampleTokens: sampleUsageTokens, fullTokens: runUsageTokens },
      progress: { sample: sampleProgress, full: fullProgress },
      sources,
      sampleResults,
      fullResults: results,
    }, null, 2);
    const readme = `${projectTitle}\n${"=".repeat(Math.min(48, projectTitle.length || 1))}\n\n這是由史料研析台匯出的完整研究項目包。\n\n使用方式\n- 雙擊「閱讀報告.html」：在瀏覽器中離線閱讀、搜尋與篩選。\n- 開啟「研究結果.md」：在任何 Markdown 工具中查看本次選定範圍。\n- 保存「研究資料.json」：保留史料、規約、判讀結果與人工複核狀態，供日後重新匯入。\n\n匯出範圍：${scopeLabel}（${exportableResults.length} 條）\n匯出時間：${exportedAt}\n\n安全說明\n- 項目包不包含 API Key。\n- 閱讀報告可完全離線使用，不會呼叫模型或上傳材料。\n- 研究資料.json 包含本項目的原始史料文字，請依材料敏感程度妥善保存。\n`;
    const archive = createZipArchive([
      { name: `${directory}閱讀報告.html`, content: offlineHtml },
      { name: `${directory}研究結果.md`, content: markdown },
      { name: `${directory}研究資料.json`, content: projectData },
      { name: `${directory}項目說明.txt`, content: readme },
    ]);
    const url = URL.createObjectURL(archive);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${projectTitle}_研究項目包.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast(`已匯出「${projectTitle}」研究項目包`);
  };

  const stepComplete = (id: StepId) => {
    if (id === "sources") return sources.length > 0;
    if (id === "question") return question.trim().length > 20;
    if (id === "provider") return connectionState === "ok";
    if (id === "protocol") return planState === "ready";
    if (id === "results") return runState === "ready";
    return fullRunState === "completed";
  };

  const currentProjectTitle = planState === "working"
    ? "AI 正在整理目前研究…"
    : planState === "ready" && plan.title.trim()
      ? plan.title.trim()
      : "新建史料研究";

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="史料研析台首頁">
          <span className="brand-seal">史</span>
          <span><strong>史料研析台</strong><small>Historical Evidence Workbench</small></span>
        </a>
        <div className="top-actions">
          <button className="project-name" type="button" title={currentProjectTitle}><span>目前研究項目</span><b>{currentProjectTitle}</b></button>
          <span className={`provider-pill ${connectionState === "ok" ? "is-connected" : ""}`}>
            <i />{selectedProvider.label}{connectionState === "ok" ? " · 已連接" : ""}
          </span>
          <button className="avatar" type="button" aria-label="研究者帳戶">毛</button>
        </div>
      </header>

      <div className="workspace" id="top">
        <aside className="sidebar">
          <div className="project-kicker">新建研究流程</div>
          <h1>從問題出發，<br />回到原文證據。</h1>
          <p>先確認研究口徑，再讓模型閱讀史料。每一條結果都保留可回查的來源。</p>
          <nav className="step-list" aria-label="研究流程">
            {steps.map((step) => (
              <button
                key={step.id}
                type="button"
                className={`step-button ${activeStep === step.id ? "active" : ""} ${stepComplete(step.id) ? "complete" : ""}`}
                onClick={() => setActiveStep(step.id)}
                disabled={(fullRunState === "working" && step.id !== "full") || (step.id === "full" && runState !== "ready" && fullRunState === "idle")}
              >
                <span className="step-number">{stepComplete(step.id) ? "✓" : step.number}</span>
                <span><strong>{step.label}</strong><small>{step.hint}</small></span>
              </button>
            ))}
          </nav>
          <div className="privacy-note">
            <span className="lock-mark">◇</span>
            <div><strong>本機優先</strong><p>API Key 可只留在工作階段，或用解鎖密碼加密保存在本機；不寫入研究項目或匯出檔。</p></div>
          </div>
        </aside>

        <section className="main-panel">
          {checkpointPromptVisible && recoverableCheckpoint && (
            <section className="checkpoint-recovery" aria-labelledby="checkpoint-recovery-title">
              <div className="checkpoint-recovery-mark">↻</div>
              <div className="checkpoint-recovery-copy"><span>本機斷點</span><h2 id="checkpoint-recovery-title">發現未完成或可恢復的研究任務</h2><p>「{recoverableCheckpoint.plan.title}」已處理 {recoverableCheckpoint.phase === "full" ? recoverableCheckpoint.fullProgress.processed : recoverableCheckpoint.sampleProgress.processed}／{recoverableCheckpoint.phase === "full" ? recoverableCheckpoint.fullProgress.total : recoverableCheckpoint.sampleProgress.total} 段，保存於 {new Date(recoverableCheckpoint.updatedAt).toLocaleString()}。史料與結果只存放在這台設備。</p>{recoverableCheckpoint.pendingBatchIds.length > 0 && <strong>上次中斷時有 {recoverableCheckpoint.pendingBatchIds.length} 段狀態未明；恢復後重新判讀可能再次計費。</strong>}</div>
              <div className="checkpoint-recovery-actions"><button type="button" className="next-button" onClick={restoreLocalCheckpoint}>恢復這個任務 <b>→</b></button><button type="button" className="text-button danger" onClick={() => void clearLocalCheckpoint()}>清除斷點</button></div>
            </section>
          )}
          {activeStep === "sources" && (
            <div className="panel-view">
              <div className="view-heading">
                <div><span className="eyebrow">步驟 01 · 資料來源</span><h2>建立您的史料集</h2><p>先匯入文字材料。第一版可直接讀取 TXT、Markdown、CSV、JSONL 與 JSON；DOCX、PDF 將在下一階段加入解析。</p></div>
                <div className="summary-chip"><strong>{sourceStats.characters.toLocaleString()}</strong><span>可讀字元</span></div>
              </div>
              <div className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                <input ref={inputRef} type="file" multiple accept=".txt,.md,.markdown,.csv,.jsonl,.json,.docx,.pdf" onChange={onFileChange} />
                <div className="upload-glyph">＋</div>
                <h3>拖放史料檔案到這裡</h3>
                <p>原檔不會被改寫；系統會另外建立段落與來源位置索引。</p>
                <button type="button" className="primary-button" onClick={() => inputRef.current?.click()}>選擇檔案</button>
                <small>單個文字檔建議小於 8 MB · 可一次選擇多個檔案</small>
              </div>
              <div className="source-table-wrap">
                <div className="section-label"><span>已加入的史料</span><span>{sources.length} 個檔案</span></div>
                <div className="source-table">
                  {sources.map((source) => (
                    <div className="source-row" key={source.id}>
                      <span className="file-badge">{source.type.slice(0, 4)}</span>
                      <div className="source-name"><strong>{source.name}</strong><small>{formatBytes(source.size)} · {source.characters ? `${source.characters.toLocaleString()} 字元` : "等待解析"}{source.locator ? ` · ${source.locator}` : ""}</small></div>
                      <span className={`source-status ${source.status}`}><i />{source.status === "ready" ? "可分析" : "待解析"}</span>
                      <button type="button" className="icon-button" aria-label={`移除 ${source.name}`} onClick={() => { setSources((current) => current.filter((item) => item.id !== source.id)); setUsageEstimate(null); setEstimateState("idle"); setRunState("idle"); setFullRunState("idle"); setResults([]); setSampleResults([]); setSampledChunkIds([]); }}>×</button>
                    </div>
                  ))}
                  {!sources.length && <div className="empty-state">尚未加入可分析的史料。請先上傳文字檔。</div>}
                </div>
              </div>
              <div className="panel-footer"><span>下一步會將您的問題轉成可檢查的研究規約。</span><button type="button" className="next-button" onClick={() => setActiveStep("question")}>設定研究問題 <b>→</b></button></div>
            </div>
          )}

          {activeStep === "question" && (
            <div className="panel-view">
              <div className="view-heading">
                <div><span className="eyebrow">步驟 02 · 研究問題</span><h2>您希望在史料中尋找什麼？</h2><p>像向研究助理交代工作一樣描述。範圍、排除條件與需要保留的證據越清楚，結果越可靠。</p></div>
              </div>
              <label className="question-card">
                <span>自然語言研究需求</span>
                <textarea value={question} onChange={(event) => { setQuestion(event.target.value); setUsageEstimate(null); setEstimateState("idle"); setRunState("idle"); setFullRunState("idle"); }} rows={9} />
                <div className="question-meta"><span>{question.length} 字</span><span>繁簡與異體字將保留</span></div>
              </label>
              <div className="guidance-grid">
                <div><span>宜說明</span><strong>什麼算相關</strong><p>事件、人物關係、概念議論，或制度性處置。</p></div>
                <div><span>宜說明</span><strong>什麼應排除</strong><p>容易混淆的詞義、文類與無正文的材料。</p></div>
                <div><span>宜說明</span><strong>需要哪些證據</strong><p>完整原文、頁碼、人物、時間與判定理由。</p></div>
              </div>
              <div className="panel-footer"><button className="text-button" type="button" onClick={() => setActiveStep("sources")}>← 返回資料來源</button><button type="button" className="next-button" onClick={() => setActiveStep("provider")}>選擇分析模型 <b>→</b></button></div>
            </div>
          )}

          {activeStep === "provider" && (
            <div className="panel-view">
              <div className="view-heading">
                <div><span className="eyebrow">步驟 03 · 模型供應商</span><h2>使用您自己的 AI</h2><p>每位研究者自行選擇服務並承擔用量。普通設定會自動記住；API Key 可按需要只留在本次工作階段，或在本機加密保存。</p></div>
                <div className={`connection-badge ${connectionState}`}><i />{connectionMessage}</div>
              </div>
              <div className="provider-grid">
                {providers.map((provider) => (
                  <button type="button" key={provider.id} className={`provider-card ${providerId === provider.id ? "selected" : ""}`} onClick={() => chooseProvider(provider.id)}>
                    <span className="provider-initial">{provider.label.slice(0, 1)}</span>
                    <span><strong>{provider.label}</strong><small>{provider.region}</small></span>
                    <i>{providerId === provider.id ? "✓" : ""}</i>
                  </button>
                ))}
              </div>
              <div className="credentials-card">
                <div className="credentials-heading"><div><strong>{selectedProvider.label}</strong><p>{selectedProvider.note}</p></div><span>{hasEncryptedCredential ? "本機已加密保存" : apiKey ? "本次工作階段已記住" : "尚未保存密鑰"}</span></div>
                <div className="form-grid">
                  <label className="field full"><span>API 地址</span><input value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setUsageEstimate(null); }} placeholder="https://example.com/v1" /></label>
                  <label className="field"><span>模型名稱</span><input value={model} onChange={(event) => { setModel(event.target.value); setUsageEstimate(null); }} placeholder="請輸入平台顯示的模型名稱" /></label>
                  <label className="field"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => rememberApiKeyForSession(event.target.value)} placeholder={selectedProvider.needsKey ? "sk-••••••••••••" : "本地模型無需金鑰"} disabled={!selectedProvider.needsKey} autoComplete="off" spellCheck={false} /></label>
                  <label className="field"><span>輸入單價（US$／百萬 Token）</span><input type="number" min="0" step="0.01" value={inputPrice} onChange={(event) => { setInputPrice(event.target.value); setUsageEstimate(null); }} placeholder="請查閱供應商最新價格" /></label>
                  <label className="field"><span>輸出單價（US$／百萬 Token）</span><input type="number" min="0" step="0.01" value={outputPrice} onChange={(event) => { setOutputPrice(event.target.value); setUsageEstimate(null); }} placeholder="請查閱供應商最新價格" /></label>
                </div>
                {selectedProvider.needsKey && (
                  <section className="credential-vault" aria-labelledby="credential-vault-title">
                    <div className="credential-vault-copy"><strong id="credential-vault-title">本機密鑰保管</strong><p>{credentialStorageMessage}</p><small>解鎖密碼不會上傳或保存；若忘記，只能清除 Key 後重新設定。請勿在公共電腦使用加密保存。</small></div>
                    <div className="credential-vault-controls">
                      <label className="field"><span>本機解鎖密碼（至少 8 字）</span><input type="password" value={credentialPassphrase} onChange={(event) => { setCredentialPassphrase(event.target.value); setCredentialStorageState("idle"); }} placeholder={hasEncryptedCredential ? "輸入密碼以解鎖或更新" : "設定一個本機解鎖密碼"} autoComplete="new-password" /></label>
                      <div className="credential-vault-actions"><button type="button" className="secondary-button" onClick={() => void saveEncryptedCredential()} disabled={credentialStorageState === "working" || !apiKey.trim() || credentialPassphrase.length < 8}>{hasEncryptedCredential ? "更新加密保存" : "加密保存在本機"}</button>{hasEncryptedCredential && <button type="button" className="secondary-button" onClick={() => void unlockEncryptedCredential()} disabled={credentialStorageState === "working" || credentialPassphrase.length < 8}>解鎖已保存 Key</button>}<button type="button" className="text-button danger" onClick={clearSavedCredential} disabled={!apiKey && !hasEncryptedCredential}>清除已保存 Key</button></div>
                    </div>
                  </section>
                )}
                <div className="credential-actions"><p><span>◇</span>API 地址、模型名稱與單價會自動保存；Key 不會寫入 Prompt 模板、史料或匯出檔。</p><button type="button" className="secondary-button" onClick={testConnection} disabled={connectionState === "testing"}>{connectionState === "testing" ? "正在測試…" : "測試連接"}</button></div>
              </div>
              <div className="panel-footer"><button className="text-button" type="button" onClick={() => setActiveStep("question")}>← 返回研究問題</button><button type="button" className="next-button" onClick={generatePlan} disabled={planState === "working"}>{planState === "working" ? "正在整理規約…" : "產生研究規約"} <b>→</b></button></div>
            </div>
          )}

          {activeStep === "protocol" && (
            <div className="panel-view protocol-view">
              <div className="view-heading">
                <div><span className="eyebrow">步驟 04 · Prompt 工作台</span><h2>確認研究規約</h2><p>這份規約會隨任務保存版本。請先修改口徑，再讓模型正式閱讀史料。</p></div>
                <span className="version-tag">規約 v1</span>
              </div>
              <section className="protocol-template-library" aria-labelledby="protocol-template-title">
                <div className="protocol-template-head">
                  <div><span className="eyebrow">可复用 Prompt</span><h3 id="protocol-template-title">研究规约模板库</h3><p>保存完整 Prompt、纳入／排除标准和输出字段。模板仅留在本机，不包含 API Key 或史料。</p></div>
                  <span>{protocolTemplates.length} 个模板</span>
                </div>
                <div className="protocol-template-controls">
                  <label><span>已保存模板</span><select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}><option value="">请选择模板</option>{protocolTemplates.map((template) => <option value={template.id} key={template.id}>{template.name} · {template.updatedAt.slice(0, 10)}</option>)}</select></label>
                  <div className="protocol-template-actions"><button type="button" className="secondary-button" onClick={() => loadProtocolTemplate()} disabled={!selectedTemplateId}>载入</button><button type="button" className="secondary-button" onClick={() => saveProtocolTemplate("update")} disabled={!selectedTemplateId}>更新已选</button><button type="button" className="text-button danger" onClick={deleteProtocolTemplate} disabled={!selectedTemplateId}>删除</button></div>
                </div>
                <div className="protocol-template-footer">
                  <p>{templateMessage}</p>
                  <div><button type="button" className="secondary-button" onClick={() => saveProtocolTemplate("new")}>保存为新模板</button><button type="button" className="secondary-button" onClick={exportProtocolTemplates}>导出模板库</button><button type="button" className="secondary-button" onClick={() => templateInputRef.current?.click()}>导入模板</button><input ref={templateInputRef} type="file" accept=".json,.txt,application/json,text/plain" onChange={(event) => void importProtocolTemplates(event)} /></div>
                </div>
              </section>
              <label className="field title-field"><span>規約名稱</span><input value={plan.title} onChange={(event) => updatePlan({ ...plan, title: event.target.value })} /></label>
              <div className="protocol-columns">
                <section className="protocol-card">
                  <div className="protocol-card-title"><span className="rule-dot include" />納入標準</div>
                  {plan.include.map((item, index) => <div key={`include-${index}`} className="rule-row"><span>{index + 1}</span><textarea aria-label={`納入標準 ${index + 1}`} rows={2} value={item} placeholder="輸入新的納入標準" onChange={(event) => updateRule("include", index, event.target.value)} /><button type="button" className="rule-delete" aria-label={`刪除納入標準 ${index + 1}`} onClick={() => removeRule("include", index)}>×</button></div>)}
                  {!plan.include.length && <div className="rule-empty">尚無納入標準</div>}
                  <button type="button" className="rule-add" onClick={() => addRule("include")}>＋ 新增納入標準</button>
                </section>
                <section className="protocol-card">
                  <div className="protocol-card-title"><span className="rule-dot exclude" />排除標準</div>
                  {plan.exclude.map((item, index) => <div key={`exclude-${index}`} className="rule-row"><span>{index + 1}</span><textarea aria-label={`排除標準 ${index + 1}`} rows={2} value={item} placeholder="輸入新的排除標準" onChange={(event) => updateRule("exclude", index, event.target.value)} /><button type="button" className="rule-delete" aria-label={`刪除排除標準 ${index + 1}`} onClick={() => removeRule("exclude", index)}>×</button></div>)}
                  {!plan.exclude.length && <div className="rule-empty">尚無排除標準</div>}
                  <button type="button" className="rule-add" onClick={() => addRule("exclude")}>＋ 新增排除標準</button>
                </section>
              </div>
              <section className="schema-card">
                <div><span className="eyebrow">結構化輸出</span><strong>每條材料需要包含</strong></div>
                <div className="field-tags">{plan.fields.map((field, index) => <span key={`field-${index}`} className="field-tag-editor"><input aria-label={`輸出欄位 ${index + 1}`} value={field} placeholder="欄位名稱" onChange={(event) => updateOutputField(index, event.target.value)} /><button type="button" aria-label={`刪除輸出欄位 ${field || index + 1}`} onClick={() => removeOutputField(index)}>×</button></span>)}<button type="button" className="field-add" onClick={addOutputField}>＋ 新增欄位</button></div>
              </section>
              <details className="prompt-details">
                <summary><span>查看完整 Prompt</span><small>可直接編輯</small></summary>
                <textarea rows={10} value={plan.prompt} onChange={(event) => updatePlan({ ...plan, prompt: event.target.value })} />
              </details>
              <div className="evidence-rule"><span>證據規則</span><p>{plan.evidenceRule}</p></div>
              <section className="usage-budget">
                <div className="usage-budget-head">
                  <div><span className="eyebrow">開跑前預算</span><h3>Token 與成本估算</h3><p>只把字數、規約長度與分批摘要交給 AI，不會為估算先上傳完整史料。</p></div>
                  <button type="button" className="secondary-button" onClick={estimateUsage} disabled={estimateState === "working"}>{estimateState === "working" ? "正在估算…" : usageEstimate ? "重新估算" : "請 AI 估算"}</button>
                </div>
                {usageEstimate ? (
                  <>
                    <div className="usage-grid">
                      {[usageEstimate.sample, usageEstimate.full].map((scope) => <article key={scope.label} className="usage-scope"><span>{scope.label}</span><strong>{formatTokens(scope.totalLow)}–{formatTokens(scope.totalHigh)}</strong><small>預計 {scope.calls} 次請求</small><dl><div><dt>輸入</dt><dd>{formatTokens(scope.inputLow)}–{formatTokens(scope.inputHigh)}</dd></div><div><dt>輸出</dt><dd>{formatTokens(scope.outputLow)}–{formatTokens(scope.outputHigh)}</dd></div><div><dt>費用</dt><dd>{formatCostRange(scope.costLow, scope.costHigh)}</dd></div></dl></article>)}
                    </div>
                    <div className="usage-notes"><span className={`estimate-method ${usageEstimate.generatedBy}`}>{usageEstimate.generatedBy === "ai" ? `由 ${selectedProvider.label} 評估` : "本機粗估"}</span><p>{usageEstimate.assumptions.join(" ")}</p>{usageEstimate.estimatorTokens ? <small>本次估算本身約使用 {usageEstimate.estimatorTokens.toLocaleString()} Token，未計入上方工作預算。</small> : null}</div>
                  </>
                ) : <div className="usage-placeholder"><strong>尚未估算</strong><span>估算結果會分開顯示輸入、輸出、請求次數與費用範圍。</span></div>}
                <p className="usage-disclaimer">估算僅供預算參考，實際用量以模型供應商帳單為準；若單價留空，費用將顯示「待填單價」。</p>
              </section>
              <section className="calibration-card">
                <div><span className="eyebrow">自適應校準</span><h3>找到足夠樣本再停</h3><p>每次從全文不同位置判讀最多 4 段；逾時會自動拆成 2 段、再拆成 1 段，最多檢查 32 段。</p></div>
                <label><span>停止條件</span><select value={sampleTarget} onChange={(event) => setSampleTarget(Number(event.target.value) === 1 ? 1 : 3)} disabled={runState === "working"}><option value={3}>標準：找到 3 條候選</option><option value={1}>快速：找到 1 條候選</option></select></label>
                {runState === "working" && <div className="inline-run-progress"><span><i style={{ width: `${sampleProgress.total ? Math.round((sampleProgress.processed / sampleProgress.total) * 100) : 0}%` }} /></span><small>{sampleProgress.message}</small></div>}
              </section>
              <div className="panel-footer"><button className="text-button" type="button" onClick={() => setActiveStep("provider")}>← 返回模型設定</button><button type="button" className="next-button" onClick={() => void runSample(false)} disabled={runState === "working"}>{runState === "working" ? `正在進行第 ${Math.max(1, sampleProgress.batches)} 次請求…` : `自適應試跑 · 目標 ${sampleTarget} 條`} <b>→</b></button></div>
            </div>
          )}

          {(activeStep === "results" || activeStep === "full") && (
            <div className="panel-view results-view">
              <div className="view-heading results-heading">
                <div><span className="eyebrow">{activeStep === "full" ? "步驟 06 · 完整判讀" : "步驟 05 · 樣本校準"}</span><h2>{activeStep === "full" ? "完整資料集判讀" : "自適應試跑結果"}</h2><p>{activeStep === "full" ? "這是一個獨立的完整任務頁；每批完成即累加結果，可隨時暫停並人工複核。" : "先人工複核這一小批材料；確認口徑後，再前往下一頁啟動完整判讀。"}</p></div>
                <div className="export-controls"><label><span>匯出結果範圍</span><select value={exportScope} onChange={(event) => setExportScope(event.target.value as ExportScope)}>{exportScopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.label}</option>)}</select></label><button type="button" className="secondary-button" onClick={exportResults} disabled={!exportableResults.length}>匯出 Markdown</button><button type="button" className="secondary-button package-button" onClick={exportProjectPackage} disabled={!exportableResults.length}>下載項目包 · {exportableResults.length} 條</button></div>
              </div>
              <section className={`run-status-card ${(activeStep === "full" ? fullError : sampleError) ? "has-error" : ""}`} aria-live="polite">
                <div className="run-status-copy"><span>{activeStep === "full" ? "完整判讀進度" : "校準進度"}</span><strong>{activeStep === "full" ? fullError || fullProgress.message : sampleError || sampleProgress.message}</strong></div>
                <div className="run-progress-track"><i style={{ width: `${(() => { const progress = activeStep === "full" ? fullProgress : sampleProgress; return progress.total ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0; })()}%` }} /></div>
                <div className="run-status-meta"><span>已處理 {activeStep === "full" ? fullProgress.processed : sampleProgress.processed}／{activeStep === "full" ? fullProgress.total : sampleProgress.total} 段</span><span>{activeStep === "full" ? fullProgress.batches : sampleProgress.batches} 次請求</span><span>{visibleUsageTokens ? `${visibleUsageTokens.toLocaleString()} Token` : "Token 用量待供應商返回"}</span><span className="checkpoint-inline">◇ {checkpointMessage}<button type="button" onClick={() => void clearLocalCheckpoint()} disabled={runState === "working" || fullRunState === "working"}>清除</button></span></div>
              </section>
              {activeStep === "full" && (
                <section className="full-run-card full-run-controls-card">
                  <div><span className="eyebrow">完整任務控制</span><h3>{fullRunState === "completed" ? "全部段落已完成" : fullRunState === "working" ? "正在分批閱讀全文" : "完整判讀目前未運行"}</h3><p>每次最多 4 段；逾時會自動拆成 2 段或 1 段。成功一批就保留一批結果，暫停、停止或失敗後可從下一個未完成段落繼續。</p></div>
                  <div className="full-run-actions">
                    {fullRunState === "idle" && <button type="button" className="next-button" onClick={startFullAnalysis}>開始完整判讀 <b>→</b></button>}
                    {fullRunState === "working" && <><button type="button" className="secondary-button" onClick={pauseFullAnalysis}>本批後暫停</button><button type="button" className="text-button danger" onClick={stopFullAnalysis}>本批後停止</button></>}
                    {["paused", "stopped", "error"].includes(fullRunState) && <button type="button" className="next-button" onClick={resumeFullAnalysis}>{fullRunState === "error" ? "重試未完成批次" : "從下一批繼續"} <b>→</b></button>}
                    {fullRunState === "completed" && <span className="completion-mark">✓ 已完成，可匯出結果</span>}
                  </div>
                </section>
              )}
              <div className="result-stats">
                <div><span>候選材料</span><strong>{visibleResults.filter((item) => item.relevance !== "低").length}</strong><small>不含低相關</small></div>
                <div><span>高相關</span><strong>{visibleResults.filter((item) => item.relevance === "高").length}</strong><small>優先複核</small></div>
                <div><span>已採用</span><strong>{visibleResults.filter((item) => item.review === "採用").length}</strong><small>人工確認</small></div>
                <div><span>待核</span><strong>{visibleResults.filter((item) => item.review === "待核").length}</strong><small>需要判斷</small></div>
              </div>
              <div className="result-toolbar">
                <div className="filter-tabs">{["全部", "高", "中", "低", "採用", "待核", "排除"].map((filter) => <button type="button" key={filter} className={resultFilter === filter ? "active" : ""} onClick={() => setResultFilter(filter)}>{filter}</button>)}</div>
                <span>顯示 {filteredResults.length}／{visibleResults.length} 條</span>
              </div>
              <section className="bulk-review-bar" aria-label="批量複核工具">
                <div className="bulk-select-actions"><strong>批量複核</strong><button type="button" className="text-button" onClick={() => selectResultGroup("current")} disabled={!filteredResults.length}>選擇目前顯示</button><button type="button" className="text-button" onClick={() => selectResultGroup("high")} disabled={!visibleResults.some((item) => item.relevance === "高")}>選擇全部高相關</button><button type="button" className="text-button" onClick={() => setSelectedResultIds([])} disabled={!selectedVisibleIds.length}>取消選擇</button><span>已選 {selectedVisibleIds.length} 條</span></div>
                <div className="bulk-review-actions"><button type="button" className="secondary-button" onClick={() => bulkUpdateReview("採用")} disabled={!selectedVisibleIds.length}>批量採用</button><button type="button" className="secondary-button" onClick={() => bulkUpdateReview("待核")} disabled={!selectedVisibleIds.length}>設為待核</button><button type="button" className="text-button danger" onClick={() => bulkUpdateReview("排除")} disabled={!selectedVisibleIds.length}>批量排除</button></div>
              </section>
              <div className="evidence-list">
                {filteredResults.map((item, index) => (
                  <article className={`evidence-card ${item.review === "排除" ? "is-excluded" : ""}`} key={item.id}>
                    <div className="evidence-index">{String(index + 1).padStart(2, "0")}</div>
                    <div className="evidence-body">
                      <div className="evidence-topline"><div><label className="evidence-select"><input type="checkbox" checked={selectedResultIds.includes(item.id)} onChange={() => toggleResultSelection(item.id)} /><span>選擇</span></label><span className={`relevance-tag r-${item.relevance}`}>{item.relevance}相關</span><span className="category-tag">{item.category}</span></div><span className="source-locator">{item.source} · {item.locator}</span></div>
                      <h3>{item.title}</h3>
                      <div className="metadata-row">{item.time && <span>時間：{item.time}</span>}{item.people.length > 0 && <span>人物：{item.people.join("、")}</span>}</div>
                      <blockquote>{renderExcerpt(item.excerpt, item.evidenceTerms)}</blockquote>
                      <div className="analysis-row"><div><span>判定理由</span><p>{item.reason}</p></div><div><span>研究札記</span><p>{item.note}</p></div></div>
                      <div className="review-row"><span>人工複核</span><div>{(["採用", "待核", "排除"] as const).map((review) => <button type="button" key={review} className={item.review === review ? "active" : ""} onClick={() => updateReview(item.id, review)}>{review}</button>)}</div></div>
                    </div>
                  </article>
                ))}
                {!filteredResults.length && <div className="empty-state">{visibleResults.length ? "這個篩選條件下沒有材料。" : (activeStep === "full" ? fullError : sampleError) || (activeStep === "full" ? "完整判讀尚未找到符合研究規約的材料；進度與控制選項顯示在頁面上方。" : "本次已如實完成檢查，暫未發現符合研究規約的材料。您可以修訂規約後重試，或前往下一頁擴大到完整資料集。")}</div>}
              </div>
              {activeStep === "results" && (
                <section className="full-run-card sample-to-full-card">
                  <div><span className="eyebrow">下一步 · 完整資料集</span><h3>樣本口徑確認好了嗎？</h3><p>完整判讀會在獨立的新頁面運行，不會把控制按鈕混在樣本校準結果裡。開始後仍可暫停、停止並保留已完成批次。</p></div>
                  <div className="full-run-actions">{runState === "error" ? <button type="button" className="next-button" onClick={() => void runSample(true)}>重試未完成樣本 <b>→</b></button> : <button type="button" className="next-button" onClick={startFullAnalysis} disabled={runState !== "ready"}>確認口徑，前往完整判讀 <b>→</b></button>}</div>
                </section>
              )}
              <div className="panel-footer sticky-footer"><button className="text-button" type="button" onClick={() => setActiveStep(activeStep === "full" ? "results" : "protocol")} disabled={fullRunState === "working"}>{activeStep === "full" ? "← 返回樣本結果" : "← 修訂研究規約"}</button><span>{activeStep === "full" ? "完整任務與樣本校準已分頁顯示；結果會在每批完成後立即加入本頁。" : "確認命中與誤收情況後，再前往完整判讀頁。"}</span></div>
            </div>
          )}
        </section>

        <aside className="context-rail">
          <div className="rail-block">
            <div className="rail-title"><span>項目概況</span><i>本機草稿</i></div>
            <div className="rail-stat"><strong>{sourceStats.files}</strong><span>史料檔案</span></div>
            <div className="mini-stats"><div><strong>{sourceStats.ready}</strong><span>可讀取</span></div><div><strong>{sourceStats.characters ? `${Math.round(sourceStats.characters / 1000)}k` : "0"}</strong><span>字元</span></div></div>
          </div>
          <div className="rail-block evidence-preview">
            <div className="rail-title"><span>證據預覽</span><i>示例</i></div>
            <p>「遂日夜謀<mark>引其黨爲臺諫</mark>，以擯汝愚。」</p>
            <small>卷之三・光宗皇帝 · P35</small>
          </div>
          <div className="rail-block run-preview">
            <div className="rail-title"><span>本次流程</span><i>{planState === "ready" ? "已成規約" : "草稿"}</i></div>
            <ul>
              <li><span className={sources.length ? "done" : ""} />建立來源索引</li>
              <li><span className={question.trim().length > 20 ? "done" : ""} />定義研究問題</li>
              <li><span className={connectionState === "ok" ? "done" : ""} />連接模型服務</li>
              <li><span className={planState === "ready" ? "done" : ""} />確認研究規約</li>
              <li><span className={runState === "ready" ? "done" : ""} />複核樣本結果</li>
              <li><span className={fullRunState === "completed" ? "done" : ""} />完成全文分析</li>
            </ul>
          </div>
          <div className="rail-tip"><span>研究提示</span><p>先用少量樣本檢查漏收與誤收，再擴大到完整資料集，可以顯著減少無效 API 用量。</p></div>
        </aside>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
