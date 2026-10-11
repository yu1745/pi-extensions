import {
  __name
} from "./chunk-SHUYVCID.js";

// extensions/antigravity/index.ts
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { getApiKey, loginAntigravity, refreshAntigravityToken } from "./../extensions/antigravity/auth/index.ts";
import { DEFAULT_ENDPOINT, endpointCandidates as endpointCandidates3 } from "./../extensions/antigravity/client/index.ts";
import { getLastDiagnostics, runWithDiagnostics as runWithDiagnostics2 } from "./../extensions/antigravity/diagnostics/index.ts";
import { ANTIGRAVITY_MODELS, PROVIDER_ID as PROVIDER_ID2, PROVIDER_NAME } from "./../extensions/antigravity/models/index.ts";

// extensions/antigravity/stream/stream.ts
import {
  calculateCost,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";
import {
  antigravityHeaders,
  endpointCandidates,
  fetchAvailableRuntimeModel,
  formatRequestDiagnostics,
  jsonOrTextError,
  loadCodeAssist,
  parseApiKey,
  resolveProjectId,
  writeTrajectoryAcls
} from "./../extensions/antigravity/client/client.ts";
import {
  getCurrentEndpoint,
  runWithDiagnostics,
  setLastEndpoint,
  setLastError,
  setLastLatencyMs,
  setLastCostBasis,
  setLastProjectId,
  setLastResolvedRuntimeModel,
  setLastResponseId,
  setLastServedModel,
  setLastStatus
} from "./../extensions/antigravity/diagnostics/diagnostics.ts";
import {
  AntigravityRequestType,
  AntigravityUserAgent,
  GeminiRole,
  GeminiToolCallingMode,
  StopReason
} from "./../extensions/antigravity/types/enums.ts";
import {
  ANTIGRAVITY_ROUTING,
  getMaxOutputTokens,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getThinkingConfig,
  resolveServedModelCost,
  PROVIDER_ID
} from "./../extensions/antigravity/models/models.ts";
import { redactSecrets, safeError } from "./../extensions/antigravity/utils/security.ts";
import { weblog } from "./../extensions/antigravity/utils/weblog.ts";
import {
  ANTIGRAVITY_API
} from "./../extensions/antigravity/types/types.ts";
import {
  antigravityEnv,
  antigravityRequestEnvelope,
  isRecord as isRecord2,
  prepareAntigravityRequestIdentity,
  sanitizeText
} from "./../extensions/antigravity/utils/util.ts";
import { antigravityFetch } from "./../extensions/antigravity/utils/http.ts";

// extensions/antigravity/stream/schema.ts
import { isRecord } from "./../extensions/antigravity/utils/util.ts";
var PROTO_TYPES = {
  object: "OBJECT",
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY"
};
var PROTO_SCHEMA_ALLOW = /* @__PURE__ */ new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum"
]);
function toProtoType(value) {
  const scalar = Array.isArray(value) ? value.find((entry) => typeof entry === "string" && entry !== "null") : typeof value === "string" ? value : void 0;
  if (!scalar) return void 0;
  return PROTO_TYPES[scalar.toLowerCase()] ?? scalar.toUpperCase();
}
__name(toProtoType, "toProtoType");
function dereferenceSchema(schema, rootDefs = {}, visited = /* @__PURE__ */ new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => dereferenceSchema(item, rootDefs, visited));
  }
  const s = schema;
  if (visited.has(s)) return s;
  visited.add(s);
  const defs = { ...rootDefs };
  if (isRecord(s.$defs)) Object.assign(defs, s.$defs);
  if (isRecord(s.definitions)) Object.assign(defs, s.definitions);
  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
    if (match && match[1] && defs[match[1]] !== void 0) {
      const resolved = dereferenceSchema(defs[match[1]], defs, visited);
      if (isRecord(resolved)) {
        const { $ref: _, ...rest } = s;
        const restCleaned = dereferenceSchema(rest, defs, visited);
        return isRecord(restCleaned) ? { ...resolved, ...restCleaned } : resolved;
      }
      return resolved;
    }
  }
  const out = {};
  for (const [key, value] of Object.entries(s)) {
    out[key] = dereferenceSchema(value, defs, visited);
  }
  return out;
}
__name(dereferenceSchema, "dereferenceSchema");
function ensureRootObjectSchema(schema) {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }
  if (!schema.type) {
    return { ...schema, type: "object", properties: schema.properties || {} };
  }
  return schema;
}
__name(ensureRootObjectSchema, "ensureRootObjectSchema");
function stripMetaSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = /* @__PURE__ */ new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions"
  ]);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}
__name(stripMetaSchema, "stripMetaSchema");
function normalizeProtoSchema(schema) {
  if (Array.isArray(schema)) return schema.map(normalizeProtoSchema);
  if (!isRecord(schema)) return {};
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!PROTO_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const protoType = toProtoType(value);
      if (protoType) out.type = protoType;
      continue;
    }
    if (key === "description") {
      if (typeof value === "string") out.description = value;
      continue;
    }
    if (key === "properties" && isRecord(value)) {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = normalizeProtoSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "required") {
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        out.required = value;
      }
      continue;
    }
    if (key === "items") {
      out.items = normalizeProtoSchema(value);
      continue;
    }
    if (key === "enum") {
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        out.enum = value;
      }
      continue;
    }
  }
  if (out.enum && !out.type) out.type = "STRING";
  if (out.properties && !out.type) out.type = "OBJECT";
  if (Object.keys(out).length === 0) return { type: "OBJECT" };
  return out;
}
__name(normalizeProtoSchema, "normalizeProtoSchema");
function toProtoSchema(schema) {
  const root = ensureRootObjectSchema(dereferenceSchema(schema));
  const normalized = normalizeProtoSchema(stripMetaSchema(root));
  return isRecord(normalized) ? normalized : { type: "OBJECT", properties: {} };
}
__name(toProtoSchema, "toProtoSchema");
function convertTools(tools) {
  if (!tools?.length) return void 0;
  return tools.map((tool) => ({
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters: toProtoSchema(tool.parameters)
      }
    ]
  }));
}
__name(convertTools, "convertTools");

// extensions/antigravity/stream/stream.ts
var ANTIGRAVITY_SYSTEM_INSTRUCTION = "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
var ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION = 'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.';
var toolCallCounter = 0;
function sanitizeToolCallId(id, fallbackName) {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${++toolCallCounter}`;
}
__name(sanitizeToolCallId, "sanitizeToolCallId");
var base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature) {
  if (!signature || typeof signature !== "string" || signature.length === 0) return false;
  if (signature.length % 4 !== 0) return false;
  return base64SignaturePattern.test(signature);
}
__name(isValidThoughtSignature, "isValidThoughtSignature");
function geminiRequiresThoughtSignature(runtimeModel) {
  if (!runtimeModel.startsWith("gemini-")) return false;
  const match = runtimeModel.match(/^gemini-(\d+)/);
  if (match) {
    const major = Number.parseInt(match[1], 10);
    return major >= 3;
  }
  return true;
}
__name(geminiRequiresThoughtSignature, "geminiRequiresThoughtSignature");
function parseImageData(raw, explicitMime) {
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    return {
      mimeType: explicitMime || match[1] || "image/png",
      data: match[2].trim()
    };
  }
  return {
    mimeType: explicitMime || "image/png",
    data: raw.trim()
  };
}
__name(parseImageData, "parseImageData");
function asTextParts(content) {
  if (typeof content === "string") return [{ text: sanitizeText(content) }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!isRecord2(item)) return [];
    const block = item;
    if (block.type === "text") return [{ text: sanitizeText(block.text) }];
    if (block.type === "image") {
      const rawData = block.data || block.source?.data;
      if (!rawData) return [];
      const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
      const { data, mimeType } = parseImageData(rawData, explicitMime);
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}
__name(asTextParts, "asTextParts");
function asImageParts(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!isRecord2(item)) return [];
    const block = item;
    if (block.type === "image") {
      const rawData = block.data || block.source?.data;
      if (!rawData) return [];
      const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
      const { data, mimeType } = parseImageData(rawData, explicitMime);
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}
__name(asImageParts, "asImageParts");
function appendTurn(contents, role, parts) {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
  } else {
    contents.push({ role, parts });
  }
}
__name(appendTurn, "appendTurn");
function convertMessages(model, context, runtimeModel) {
  const contents = [];
  const requiresSig = geminiRequiresThoughtSignature(runtimeModel);
  const droppedToolCallIds = /* @__PURE__ */ new Map();
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts = asTextParts(msg.content);
      appendTurn(contents, GeminiRole.User, parts);
    } else if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const parts = [];
      const isSameModel = msg.provider === PROVIDER_ID && msg.model === model.id;
      const toolCalls = msg.content.filter((b) => b.type === "toolCall");
      const firstCallHasSig = toolCalls.length > 0 && isValidThoughtSignature(toolCalls[0]?.thoughtSignature);
      const allSigsValid = toolCalls.every(
        (tc) => !tc.thoughtSignature || isValidThoughtSignature(tc.thoughtSignature)
      );
      const groupIsSigned = isSameModel && firstCallHasSig && allSigsValid;
      for (const block of msg.content) {
        if (block.type === "text") {
          const textSig = isSameModel && isValidThoughtSignature(block.textSignature) ? block.textSignature : void 0;
          if ((!block.text || block.text.trim() === "") && !textSig) {
            continue;
          }
          parts.push({
            text: sanitizeText(block.text),
            ...textSig ? { thoughtSignature: textSig } : {}
          });
        } else if (block.type === "thinking" && String(block.thinking || "").trim()) {
          if (!isSameModel) continue;
          parts.push({
            thought: true,
            text: sanitizeText(block.thinking),
            ...block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}
          });
        } else if (block.type === "toolCall") {
          if (requiresSig && !groupIsSigned) {
            const rawId = block.id || "";
            const argsText = (() => {
              try {
                return JSON.stringify(block.arguments ?? {});
              } catch {
                return "{}";
              }
            })();
            if (rawId) {
              droppedToolCallIds.set(rawId, argsText);
              droppedToolCallIds.set(sanitizeToolCallId(rawId, block.name), argsText);
            } else {
              droppedToolCallIds.set(`empty:${block.name}`, argsText);
            }
          } else {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.arguments ?? {},
                id: sanitizeToolCallId(block.id || "", block.name)
              },
              ...block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}
            });
          }
        }
      }
      appendTurn(contents, GeminiRole.Model, parts);
    } else if (msg.role === "toolResult") {
      const text = msg.content.filter((c) => c.type === "text").map((c) => sanitizeText(c.text)).join("\n");
      const responseText = text || (msg.isError ? "Tool failed" : "");
      const imageParts = asImageParts(msg.content);
      const rawId = msg.toolCallId || "";
      const sanitizedId = sanitizeToolCallId(rawId, msg.toolName);
      const droppedArgs = requiresSig ? droppedToolCallIds.get(rawId) ?? droppedToolCallIds.get(sanitizedId) ?? (rawId === "" ? droppedToolCallIds.get(`empty:${msg.toolName}`) : void 0) : void 0;
      if (droppedArgs !== void 0) {
        const label = droppedArgs === "{}" ? `\`${msg.toolName}\`` : `\`${msg.toolName}\` (${droppedArgs})`;
        appendTurn(contents, GeminiRole.User, [
          { text: sanitizeText(`[Observation from ${label}:
${responseText}]`) },
          ...imageParts
        ]);
      } else {
        const part = {
          functionResponse: {
            name: msg.toolName,
            response: msg.isError ? { error: responseText } : { output: responseText },
            id: sanitizedId
          }
        };
        appendTurn(contents, GeminiRole.User, [part, ...imageParts]);
      }
    }
  }
  if (contents.length > 0 && contents[0]?.role === GeminiRole.Model) {
    contents.unshift({
      role: GeminiRole.User,
      parts: [{ text: "Hello" }]
    });
  }
  return contents;
}
__name(convertMessages, "convertMessages");
function mapToolChoiceMode(toolChoice) {
  if (toolChoice === "none") return GeminiToolCallingMode.None;
  return GeminiToolCallingMode.Auto;
}
__name(mapToolChoiceMode, "mapToolChoiceMode");
function buildRequest(model, context, projectId, options, runtimeModel, identity) {
  const contents = convertMessages(model, context, runtimeModel);
  const request = {
    contents,
    // agy sends the persona as a single systemInstruction part.
    systemInstruction: {
      role: GeminiRole.User,
      parts: [
        {
          text: [
            ANTIGRAVITY_SYSTEM_INSTRUCTION,
            ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION,
            ...context.systemPrompt ? [sanitizeText(context.systemPrompt)] : []
          ].join("\n\n")
        }
      ]
    }
  };
  const generationConfig = {};
  if (options.temperature !== void 0) generationConfig.temperature = options.temperature;
  const thinking = getThinkingConfig(model.id, options.reasoning ?? "off");
  if (thinking) generationConfig.thinkingConfig = thinking;
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  if (options.maxTokens !== void 0) {
    generationConfig.maxOutputTokens = Math.min(options.maxTokens, maxAllowed);
  } else {
    generationConfig.maxOutputTokens = Math.min(maxAllowed, model.maxTokens || maxAllowed);
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  const isClaude = model.id.startsWith("claude-") || runtimeModel.startsWith("claude-");
  const isNonGeminiModel = isClaude || model.id.startsWith("gpt-oss-") || runtimeModel.startsWith("gpt-oss-");
  const tools = convertTools(context.tools);
  if (tools) {
    request.tools = tools;
    if (options.toolChoice === "none") {
      request.toolConfig = {
        functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) }
      };
    }
  }
  const callIdentity = identity ?? prepareAntigravityRequestIdentity(context, options);
  const envelope = antigravityRequestEnvelope(runtimeModel, {
    isClaude,
    isNonGeminiModel,
    sessionId: callIdentity.sessionId,
    trajectoryId: callIdentity.trajectoryId,
    callIndex: callIdentity.callIndex,
    // agy's `step` is the number of content entries (1 on the first turn, 3 after a
    // tool round-trip, ...) and `last_step_index` is `step - 1`.
    step: contents.length
  });
  request.sessionId = envelope.sessionId;
  request.labels = envelope.labels;
  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId
  };
}
__name(buildRequest, "buildRequest");
function mapStopReason(reason) {
  if (reason === "STOP") return StopReason.Stop;
  if (reason === "MAX_TOKENS") return StopReason.Length;
  return reason ? StopReason.Error : StopReason.Stop;
}
__name(mapStopReason, "mapStopReason");
function friendlyAntigravityError(status, text) {
  const msg = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
      return "Antigravity login expired or credentials are invalid. Next: run /login antigravity, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(msg)) {
      return `Antigravity request format was rejected by the backend (${msg}). Next: switch to a simpler model or retry after updating the extension.`;
    }
    if (/Request contains an invalid argument/i.test(msg)) {
      return `Antigravity rejected this request (${msg}). Next: retry once; if it keeps failing, switch models or re-login.`;
    }
    return `Bad request from Antigravity. Next: retry once, then run /login antigravity if it keeps failing. Backend said: ${msg}`;
  }
  if (status === 401) {
    return "Antigravity authentication failed. Next: run /login antigravity, then retry.";
  }
  if (status === 403) {
    if (/permission|forbidden|access/i.test(msg)) {
      return "Antigravity access was denied for this account or project. Next: try another model, re-login, or use an account with access.";
    }
    return `Antigravity denied this request. Next: re-login or try another model. Backend said: ${msg}`;
  }
  if (status === 404) {
    if (/Requested entity was not found/i.test(msg)) {
      return "This model is not available right now. Next: switch to gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.1-pro, or another working model.";
    }
    return `Antigravity could not find the requested resource. Next: retry or switch models. Backend said: ${msg}`;
  }
  if (status === 408) return "Antigravity timed out. Next: retry the same request.";
  if (status === 409) {
    return "Antigravity reported a conflict for this request. Next: retry once or start a new chat session.";
  }
  if (status === 429) {
    const wait = msg.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
    if (/Individual quota reached/i.test(msg)) {
      return `Quota reached. Please wait ${wait || "for reset"}. Next: switch models or try again after reset.`;
    }
    if (/quota/i.test(msg)) {
      return `Quota reached.${wait ? ` Please wait ${wait}.` : ""} Next: switch models or retry later.`;
    }
    return `Rate limited by Antigravity. Next: wait a bit and retry.${wait ? ` Reset: ${wait}.` : ""}`;
  }
  if (status === 500) {
    return "Antigravity had an internal server error. Next: retry in a moment or switch models.";
  }
  if (status === 502) return "Antigravity returned a bad gateway error. Next: retry in a moment.";
  if (status === 503) {
    if (/No capacity available/i.test(msg)) {
      return "This model has no capacity right now. Next: retry later or switch to another model.";
    }
    return "Antigravity is temporarily unavailable. Next: retry in a moment or switch models.";
  }
  if (status === 504) return "Antigravity timed out upstream. Next: retry in a moment.";
  return msg;
}
__name(friendlyAntigravityError, "friendlyAntigravityError");
function createOutput(model) {
  const output = {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API,
    provider: PROVIDER_ID,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
  priceUsage(model, output);
  return output;
}
__name(createOutput, "createOutput");
function priceUsage(model, output) {
  const { rates, pricedBy, unknownServedModel } = resolveServedModelCost(
    output.responseModel,
    model
  );
  calculateCost({ ...model, cost: rates }, output.usage);
  if (output.responseModel && output.responseModel !== model.id) {
    setLastCostBasis(pricedBy, unknownServedModel);
  }
}
__name(priceUsage, "priceUsage");
function asToolCallArguments(args) {
  return args ?? {};
}
__name(asToolCallArguments, "asToolCallArguments");
async function streamResponse(model, response, stream, output) {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scanStart = 0;
  let started = false;
  let currentBlock = null;
  let hasContent = false;
  const blocks = output.content;
  const blockIndex = /* @__PURE__ */ __name(() => blocks.length - 1, "blockIndex");
  const ensureStarted = /* @__PURE__ */ __name(() => {
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }
  }, "ensureStarted");
  const finishCurrent = /* @__PURE__ */ __name(() => {
    if (!currentBlock) return;
    if (currentBlock.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: currentBlock.text,
        partial: output
      });
    } else {
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: currentBlock.thinking,
        partial: output
      });
    }
    currentBlock = null;
  }, "finishCurrent");
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) continue;
    buffer += decoder.decode(result.value, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n", scanStart)) !== -1) {
      const line = buffer.slice(scanStart, newlineIdx);
      scanStart = newlineIdx + 1;
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(json);
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      }
      const responseData = chunk.response || chunk;
      const candidate = responseData.candidates?.[0];
      if (responseData.modelVersion) {
        output.responseModel = responseData.modelVersion;
        setLastServedModel(responseData.modelVersion);
      }
      if (responseData.responseId) setLastResponseId(responseData.responseId);
      for (const part of candidate?.content?.parts || []) {
        if (part.text !== void 0) {
          hasContent = true;
          const isThinking = part.thought === true;
          const type = isThinking ? "thinking" : "text";
          if (!currentBlock || currentBlock.type !== type) {
            finishCurrent();
            currentBlock = isThinking ? { type: "thinking", thinking: "", thinkingSignature: void 0 } : { type: "text", text: "" };
            blocks.push(currentBlock);
            ensureStarted();
            stream.push({
              type: isThinking ? "thinking_start" : "text_start",
              contentIndex: blockIndex(),
              partial: output
            });
          }
          if (isThinking && currentBlock.type === "thinking") {
            currentBlock.thinking += part.text;
            if (part.thoughtSignature) currentBlock.thinkingSignature = part.thoughtSignature;
            stream.push({
              type: "thinking_delta",
              contentIndex: blockIndex(),
              delta: part.text,
              partial: output
            });
          } else if (!isThinking && currentBlock.type === "text") {
            currentBlock.text += part.text;
            if (part.thoughtSignature) currentBlock.textSignature = part.thoughtSignature;
            stream.push({
              type: "text_delta",
              contentIndex: blockIndex(),
              delta: part.text,
              partial: output
            });
          }
        }
        if (part.functionCall) {
          hasContent = true;
          finishCurrent();
          const rawId = part.functionCall.id || "";
          const toolCall = {
            type: "toolCall",
            id: sanitizeToolCallId(rawId, part.functionCall.name),
            name: part.functionCall.name || "",
            arguments: asToolCallArguments(part.functionCall.args),
            ...part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}
          };
          blocks.push(toolCall);
          ensureStarted();
          stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: JSON.stringify(toolCall.arguments),
            partial: output
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall,
            partial: output
          });
        }
      }
      if (candidate?.finishReason) {
        output.rawStopReason = candidate.finishReason;
        output.stopReason = blocks.some((b) => b.type === "toolCall") ? StopReason.ToolUse : mapStopReason(candidate.finishReason);
      }
      if (responseData.usageMetadata) {
        const prompt = responseData.usageMetadata.promptTokenCount || 0;
        const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
        const thoughts = responseData.usageMetadata.thoughtsTokenCount || 0;
        output.usage.input = prompt - cacheRead;
        output.usage.output = (responseData.usageMetadata.candidatesTokenCount || 0) + thoughts;
        output.usage.reasoning = thoughts;
        output.usage.cacheRead = cacheRead;
        output.usage.totalTokens = responseData.usageMetadata.totalTokenCount || 0;
        priceUsage(model, output);
      }
    }
    if (scanStart > 0) {
      buffer = buffer.slice(scanStart);
      scanStart = 0;
    }
  }
  finishCurrent();
  return hasContent;
}
__name(streamResponse, "streamResponse");
function streamAntigravity(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const opts = options ?? {};
  void runWithDiagnostics(async () => {
    const startTime = Date.now();
    const output = createOutput(model);
    try {
      const creds = parseApiKey(opts.apiKey);
      const warmedProject = creds.projectId ? null : await loadCodeAssist(creds.token);
      const projectId = resolveProjectId({
        token: creds.token,
        warmedProject,
        credentialProjectId: creds.projectId
      });
      setLastProjectId(projectId);
      const effort = opts.reasoning ?? "off";
      const isKnownModel = model.id in ANTIGRAVITY_ROUTING;
      const baseRuntimeModel = antigravityEnv("RUNTIME_MODEL")?.trim() || getAntigravityRequestModelId(model.id, effort);
      let initialRuntimeModel = baseRuntimeModel;
      if (!isKnownModel && !antigravityEnv("RUNTIME_MODEL")) {
        const dynamic = await fetchAvailableRuntimeModel(creds.token, projectId, baseRuntimeModel);
        if (dynamic?.id && /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)) {
          initialRuntimeModel = dynamic.id;
        }
      }
      const runtimeCandidates = [initialRuntimeModel];
      const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
      if (fallback && fallback !== initialRuntimeModel) {
        runtimeCandidates.push(fallback);
      }
      const requestIdentity = prepareAntigravityRequestIdentity(context, opts);
      if (requestIdentity.isNewTrajectory) {
        void writeTrajectoryAcls(creds.token, requestIdentity.trajectoryId);
      }
      const requestHeaders = antigravityHeaders(creds.token);
      let response;
      let lastText = "";
      let received = false;
      let runtimeModel = initialRuntimeModel;
      let geoRetries = 0;
      for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
        if (opts.signal?.aborted) throw new Error("Request was aborted");
        if (emptyAttempt > 0) {
          const delay = 500 * 2 ** (emptyAttempt - 1);
          await new Promise((res) => setTimeout(res, delay));
        }
        for (let candIdx = 0; candIdx < runtimeCandidates.length; candIdx++) {
          runtimeModel = runtimeCandidates[candIdx];
          setLastResolvedRuntimeModel(runtimeModel);
          const body = JSON.stringify(
            buildRequest(model, context, projectId, opts, runtimeModel, requestIdentity)
          );
          for (const endpoint of endpointCandidates()) {
            setLastEndpoint(endpoint);
            response = await antigravityFetch(
              `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
              {
                method: "POST",
                headers: requestHeaders,
                body,
                signal: opts.signal
              }
            );
            setLastStatus(response.status);
            if (response.ok) break;
            lastText = await response.text();
            if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
            if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
          }
          if (response?.ok) break;
          if (response?.status === 404) {
            if (candIdx + 1 < runtimeCandidates.length) {
              continue;
            }
            if (isKnownModel && candIdx === runtimeCandidates.length - 1) {
              const dynamic = await fetchAvailableRuntimeModel(
                creds.token,
                projectId,
                baseRuntimeModel
              );
              if (dynamic?.id && !runtimeCandidates.includes(dynamic.id) && /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)) {
                runtimeCandidates.push(dynamic.id);
                continue;
              }
            }
          }
          break;
        }
        if (!response || !response.ok) {
          if (response?.status === 400 && /User location is not supported/i.test(lastText) && geoRetries < 3 && !opts.signal?.aborted) {
            geoRetries++;
            const geoDelay = 1e3 + Math.floor(Math.random() * 2e3);
            weblog(`stream: geo-blocked (400), retry ${geoRetries}/3 after ${geoDelay}ms (model=${runtimeModel})`);
            await new Promise((res) => setTimeout(res, geoDelay));
            emptyAttempt = -1;
            continue;
          }
          if (antigravityEnv("DEBUG_DUMP") === "1") {
            try {
              const body = JSON.stringify(
                buildRequest(model, context, projectId, opts, runtimeModel, requestIdentity)
              );
              let parsedBody = body;
              try {
                parsedBody = JSON.parse(body);
              } catch {
                parsedBody = body;
              }
              await (await import("node:fs/promises")).writeFile(
                "/tmp/antigravity-last-request.json",
                JSON.stringify(
                  {
                    status: response?.status,
                    runtimeModel,
                    lastText: lastText.slice(0, 4e3),
                    body: parsedBody
                  },
                  null,
                  2
                )
              );
            } catch {
            }
          }
          const friendly = friendlyAntigravityError(response?.status, lastText);
          if (response?.status === 429 && /Quota reached\./i.test(friendly)) {
            throw new Error(friendly);
          }
          throw new Error(
            `Antigravity API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}): ${friendly}`
          );
        }
        output.content = [];
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        };
        output.stopReason = "stop";
        received = await streamResponse(model, response, stream, output);
        if (received) break;
      }
      if (!received) throw new Error("Antigravity API returned an empty response");
      setLastLatencyMs(Date.now() - startTime);
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        const errorDetail = output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "An unknown error occurred";
        output.errorMessage = output.errorMessage || errorDetail;
        setLastError(output.errorMessage);
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } else if (output.stopReason === "pending") {
        throw new Error("Antigravity API returned no stop reason");
      } else {
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
    } catch (error) {
      setLastLatencyMs(Date.now() - startTime);
      output.stopReason = opts.signal?.aborted ? "aborted" : "error";
      output.errorMessage = safeError(error);
      setLastError(output.errorMessage);
      if (!getCurrentEndpoint() && endpointCandidates()[0]) {
        setLastEndpoint(endpointCandidates()[0]);
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  });
  return stream;
}
__name(streamAntigravity, "streamAntigravity");

// extensions/antigravity/usage/usage.ts
import {
  antigravityHeaders as antigravityHeaders2,
  endpointCandidates as endpointCandidates2,
  extractProjectId,
  parseApiKey as parseApiKey2,
  resolveProjectId as resolveProjectId2
} from "./../extensions/antigravity/client/client.ts";
import {
  setLastEndpoint as setLastEndpoint2,
  setLastError as setLastError2,
  setLastProjectId as setLastProjectId2,
  setLastStatus as setLastStatus2
} from "./../extensions/antigravity/diagnostics/diagnostics.ts";
import { isRecord as isRecord3 } from "./../extensions/antigravity/utils/util.ts";
import { safeError as safeError2 } from "./../extensions/antigravity/utils/security.ts";
import { antigravityFetch as antigravityFetch2 } from "./../extensions/antigravity/utils/http.ts";
function clampFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
__name(clampFraction, "clampFraction");
function remainingPercent(remaining) {
  if (remaining === void 0) return void 0;
  return Math.round(remaining * 1e3) / 10;
}
__name(remainingPercent, "remainingPercent");
function progressBar(remaining, width = 20) {
  if (remaining === void 0) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}
__name(progressBar, "progressBar");
function formatReset(resetTime) {
  if (!resetTime) return "n/a";
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return resetTime;
  const delta = ts - Date.now();
  if (delta <= 0) return "now";
  const totalMin = Math.round(delta / 6e4);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor(totalMin % (60 * 24) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
__name(formatReset, "formatReset");
function jsonHeaders(token) {
  return {
    ...antigravityHeaders2(token),
    Accept: "application/json"
  };
}
__name(jsonHeaders, "jsonHeaders");
async function postJson(path, token, body) {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates2()) {
    try {
      const res = await antigravityFetch2(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body)
      });
      setLastEndpoint2(endpoint);
      setLastStatus2(res.status);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const errorBody = isRecord3(data) ? data : void 0;
        lastErrorText = typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
        if (![403, 404, 429, 500, 502, 503, 504].includes(res.status)) {
          throw new Error(`${path} failed (${String(res.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: res.status, data };
    } catch (error) {
      lastErrorText = safeError2(error);
      setLastError2(lastErrorText);
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}
__name(postJson, "postJson");
async function fetchAvailableModelsFromEndpoint(endpoint, token, projectId) {
  try {
    const res = await antigravityFetch2(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ project: projectId })
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const errorBody = isRecord3(data) ? data : void 0;
      const lastErrorText = typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
      setLastError2(lastErrorText);
      return void 0;
    }
    return { endpoint, status: res.status, data };
  } catch (error) {
    setLastError2(safeError2(error));
    return void 0;
  }
}
__name(fetchAvailableModelsFromEndpoint, "fetchAvailableModelsFromEndpoint");
async function fetchMergedAvailableModels(token, projectId) {
  const results = await Promise.all(
    endpointCandidates2().map(
      (endpoint) => fetchAvailableModelsFromEndpoint(endpoint, token, projectId)
    )
  );
  const mergedModels = {};
  let defaultAgentModelId;
  let lastEndpoint = "";
  let lastStatus = 0;
  for (const result of results) {
    if (!result) continue;
    setLastEndpoint2(result.endpoint);
    setLastStatus2(result.status);
    lastEndpoint = result.endpoint;
    lastStatus = result.status;
    const data = result.data;
    if (isRecord3(data) && isRecord3(data.models)) {
      Object.assign(mergedModels, data.models);
    }
    if (isRecord3(data) && typeof data.defaultAgentModelId === "string") {
      defaultAgentModelId = data.defaultAgentModelId;
    }
  }
  if (!lastEndpoint) {
    throw new Error(`/v1internal:fetchAvailableModels failed: no endpoint available`);
  }
  return {
    endpoint: lastEndpoint,
    status: lastStatus,
    data: {
      models: mergedModels,
      defaultAgentModelId
    }
  };
}
__name(fetchMergedAvailableModels, "fetchMergedAvailableModels");
function parseQuotaSummary(data) {
  const summary = isRecord3(data) ? data : {};
  const groups = [];
  for (const group of summary.groups || []) {
    const buckets = [];
    for (const bucket of group.buckets || []) {
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === void 0 && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : void 0,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : void 0,
        description: bucket.description ? String(bucket.description) : void 0,
        remainingFraction: remaining ?? 0
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : void 0,
      buckets
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : void 0
  };
}
__name(parseQuotaSummary, "parseQuotaSummary");
function parseModels(data) {
  const raw = isRecord3(data) ? data : {};
  const modelsObj = raw.models && isRecord3(raw.models) ? raw.models : {};
  const models = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!info || !isRecord3(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const qi = isRecord3(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName: typeof info.displayName === "string" ? info.displayName : typeof info.label === "string" ? info.label : typeof info.modelName === "string" ? info.modelName : void 0,
      remainingFraction: clampFraction(qi.remainingFraction),
      resetTime: qi.resetTime ? String(qi.resetTime) : void 0,
      modelProvider: typeof info.modelProvider === "string" ? info.modelProvider : typeof info.apiProvider === "string" ? info.apiProvider : void 0,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId: raw.defaultAgentModelId || raw.defaultAgentModel ? String(raw.defaultAgentModelId || raw.defaultAgentModel) : void 0
  };
}
__name(parseModels, "parseModels");
function parseTier(value) {
  if (!isRecord3(value)) return void 0;
  const tier = value;
  if (!tier.id && !tier.name) return void 0;
  return {
    id: tier.id ? String(tier.id) : void 0,
    name: tier.name ? String(tier.name) : void 0,
    description: tier.description ? String(tier.description) : void 0
  };
}
__name(parseTier, "parseTier");
async function loadCodeAssistSafe(token) {
  try {
    return await postJson("/v1internal:loadCodeAssist", token, {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI"
      }
    });
  } catch {
    return null;
  }
}
__name(loadCodeAssistSafe, "loadCodeAssistSafe");
async function fetchQuotaSummarySafe(token) {
  try {
    return { ok: true, result: await postJson("/v1internal:retrieveUserQuotaSummary", token, {}) };
  } catch (error) {
    const msg = safeError2(error);
    setLastError2(msg);
    return { ok: false, error: msg };
  }
}
__name(fetchQuotaSummarySafe, "fetchQuotaSummarySafe");
async function fetchAccountUsage(apiKeyRaw) {
  const creds = parseApiKey2(apiKeyRaw);
  const initialProjectId = creds.projectId || resolveProjectId2({
    token: creds.token,
    credentialProjectId: creds.projectId
  });
  const [assistResult, summaryRes, available] = await Promise.all([
    loadCodeAssistSafe(creds.token),
    fetchQuotaSummarySafe(creds.token),
    fetchMergedAvailableModels(creds.token, initialProjectId)
  ]);
  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : void 0;
  const projectId = resolveProjectId2({
    token: creds.token,
    warmedProject: discoveredProject ?? null,
    credentialProjectId: creds.projectId
  });
  setLastProjectId2(projectId);
  const summary = summaryRes.ok ? summaryRes.result : null;
  const quotaSummaryError = summaryRes.ok ? void 0 : summaryRes.error;
  const { groups, description } = summary ? parseQuotaSummary(summary.data) : { groups: [], description: void 0 };
  const { models, defaultAgentModelId } = parseModels(available.data);
  const assistData = isRecord3(assistResult?.data) ? assistResult.data : {};
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const planLabel = paidTier?.name ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}` : productTier?.name ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}` : void 0;
  return {
    projectId,
    endpoint: summary?.endpoint ?? available.endpoint ?? assistResult?.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    quotaSummaryError,
    models,
    defaultAgentModelId,
    fetchedAt: Date.now()
  };
}
__name(fetchAccountUsage, "fetchAccountUsage");
function quotaErrorNote(msg) {
  if (/SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i.test(msg)) {
    return "Aggregate quota summary needs a paid subscription (free-tier can't use that endpoint). Per-model usage is still available via /antigravity.models.";
  }
  return `Aggregate quota summary unavailable: ${msg.slice(0, 160)}`;
}
__name(quotaErrorNote, "quotaErrorNote");
function formatUsageSummary(usage) {
  const lines = [];
  if (usage.planLabel) lines.push(usage.planLabel);
  if (!usage.groups.length) {
    if (usage.quotaSummaryError) {
      lines.push(quotaErrorNote(usage.quotaSummaryError));
    } else {
      lines.push("No quota groups returned.");
    }
    return lines.join("\n");
  }
  for (const group of usage.groups) {
    if (lines.length) lines.push("");
    lines.push(group.displayName);
    for (const bucket of group.buckets) {
      const rem = remainingPercent(bucket.remainingFraction);
      lines.push(
        `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${rem ?? "?"}% left \xB7 resets ${formatReset(bucket.resetTime)}`
      );
    }
  }
  return lines.join("\n").trimEnd();
}
__name(formatUsageSummary, "formatUsageSummary");
function formatModelsList(usage, opts) {
  const lines = [];
  lines.push("Antigravity available models");
  lines.push(`project=${usage.projectId}`);
  if (usage.defaultAgentModelId) lines.push(`defaultAgentModel=${usage.defaultAgentModelId}`);
  lines.push("");
  const rows = opts?.all ? usage.models : usage.models.filter((m) => !/tab_|chat_/i.test(m.modelId));
  if (!rows.length) {
    lines.push("No models returned.");
    return lines.join("\n");
  }
  const maxId = Math.max(...rows.map((m) => m.modelId.length), 8);
  for (const m of rows) {
    const rem = remainingPercent(m.remainingFraction);
    const flags = [
      m.recommended ? "recommended" : "",
      m.supportsThinking ? "thinking" : "",
      m.supportsImages ? "images" : ""
    ].filter(Boolean).join(",");
    const name = m.displayName && m.displayName !== m.modelId ? `  ${m.displayName}` : "";
    lines.push(
      `${m.modelId.padEnd(maxId)}  rem ${rem === void 0 ? "  ?" : String(rem).padStart(5)}%  reset ${formatReset(m.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${name}`
    );
  }
  lines.push("");
  lines.push("Note: remaining % is pool-shared (not a private per-model budget).");
  return lines.join("\n");
}
__name(formatModelsList, "formatModelsList");
async function resolveApiKeyFromContext(ctx) {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider("antigravity");
  } catch {
    return void 0;
  }
}
__name(resolveApiKeyFromContext, "resolveApiKeyFromContext");

// extensions/antigravity/index.ts
import { prewarmConnection, redactSecrets as redactSecrets2 } from "./../extensions/antigravity/utils/index.ts";
var MODEL_VERSION_ENTRY = "antigravity-model-version";
function emitCommandOutput(ctx, text, type = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}
__name(emitCommandOutput, "emitCommandOutput");
async function withUsage(ctx, fn) {
  try {
    const apiKey = await resolveApiKeyFromContext(ctx);
    if (!apiKey) {
      emitCommandOutput(
        ctx,
        "No Antigravity credentials. Run /login antigravity first.",
        "warning"
      );
      return;
    }
    if (ctx.hasUI) ctx.ui.notify("Fetching Antigravity usage\u2026", "info");
    const usage = await runWithDiagnostics2(() => fetchAccountUsage(apiKey));
    emitCommandOutput(ctx, fn(usage));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitCommandOutput(ctx, `Antigravity usage failed: ${msg}`, "warning");
  }
}
__name(withUsage, "withUsage");
function antigravity_default(pi) {
  const primaryEndpoint = endpointCandidates3()[0];
  if (primaryEndpoint) prewarmConnection(primaryEndpoint);
  registerApiProvider({
    api: ANTIGRAVITY_API,
    stream: streamAntigravity,
    streamSimple: streamAntigravity
  });
  pi.registerProvider(PROVIDER_ID2, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: ANTIGRAVITY_MODELS,
    oauth: {
      name: PROVIDER_NAME,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey
    },
    streamSimple: streamAntigravity
  });
  pi.registerEntryRenderer(
    MODEL_VERSION_ENTRY,
    (entry, _opts, theme) => {
      const { requested, served } = entry.data ?? {};
      if (!served) return void 0;
      const mismatch = Boolean(requested) && requested !== served;
      const servedText = theme.fg(mismatch ? "warning" : "dim", served);
      const asked = mismatch ? theme.fg("muted", `   asked for ${requested}`) : "";
      return new Text(`${theme.fg("dim", "modelVersion")}  ${servedText}${asked}`, 2, 0);
    }
  );
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== PROVIDER_ID2) return;
    if (!message.responseModel) return;
    const data = {
      requested: message.model,
      served: message.responseModel
    };
    setTimeout(() => pi.appendEntry(MODEL_VERSION_ENTRY, data), 0);
  });
  pi.registerCommand("antigravity.usage", {
    description: "Show Antigravity shared quota pools (Gemini / Claude+GPT, 5h + weekly)",
    handler: /* @__PURE__ */ __name(async (_args, ctx) => {
      await withUsage(ctx, formatUsageSummary);
    }, "handler")
  });
  pi.registerCommand("antigravity.models", {
    description: "List Antigravity runtime models + remaining pool fraction",
    handler: /* @__PURE__ */ __name(async (args, ctx) => {
      const all = /\ball\b/i.test(args || "");
      await withUsage(ctx, (usage) => formatModelsList(usage, { all }));
    }, "handler")
  });
  pi.registerCommand("antigravity.doctor", {
    description: "Show sanitized Antigravity provider diagnostics",
    handler: /* @__PURE__ */ __name(async (_args, ctx) => {
      const d = getLastDiagnostics();
      const lines = [
        `provider=${PROVIDER_ID2}`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `lastServedModel=${d.servedModel || "none"}`,
        `pricedByModel=${d.pricedByModel || (d.servedModel ? "requested-model-rates" : "none")}`,
        ...d.costBasisUnknown ? ["costBasisUnknown=true (unrecognized served model; requested rates kept)"] : [],
        ...d.responseId ? [`lastResponseId=${d.responseId}`] : [],
        `availableModels=${d.availableModels || "none"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastProjectId=${d.projectId || "none"}`,
        ...d.latencyMs !== void 0 ? [`lastLatencyMs=${d.latencyMs}`] : [],
        `lastError=${d.error ? redactSecrets2(d.error) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "commands=/antigravity.usage /antigravity.models /antigravity.doctor"
      ];
      emitCommandOutput(ctx, `Antigravity doctor
${lines.join("\n")}`);
    }, "handler")
  });
}
__name(antigravity_default, "default");
export {
  antigravity_default as default
};
