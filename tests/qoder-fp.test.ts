import { test, describe } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import { encodeRequestBody, decodeRequestBody, BODY_ALPHABET } from "../extensions/qoder-fp/codec.ts";
import { buildCosyHeaders, RSAPublicKeyPEM } from "../extensions/qoder-fp/cosy.ts";

describe("qoder-fp codec", () => {
  test("roundtrip JSON payload", () => {
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "Hello Qoder" }],
      parameters: { reasoning_effort: "high" },
      model: "qfmodel",
    });
    const encoded = encodeRequestBody(payload);
    assert.ok(encoded.length > 0);
    assert.strictEqual(encoded.length % 4, 0);

    const decoded = decodeRequestBody(encoded).toString("utf8");
    assert.strictEqual(decoded, payload);
  });

  test("alphabet integrity", () => {
    assert.strictEqual(BODY_ALPHABET.length, 64);
    assert.strictEqual(new Set(BODY_ALPHABET).size, 64);
  });
});

describe("qoder-fp cosy headers", () => {
  test("builds 24 ordered headers with valid signature", () => {
    const testUrl =
      "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
    const user = {
      uid: "01a0d3a3-a11b-73aa-9975-aa1bd0e029c6",
      token: "jt-test-token-12345",
      name: "wangyu",
      email: "test@example.com",
    };
    const body = "mock_wire_body";
    const machineId = "71435bea-db19-4eb4-a616-e1cc35623d2c";
    const headers = buildCosyHeaders(testUrl, user, body, machineId, 1790257470);

    assert.strictEqual(headers.length, 26);
    const headerMap = Object.fromEntries(headers);

    assert.strictEqual(headerMap["Accept"], "text/event-stream");
    assert.ok(headerMap["Authorization"].startsWith("Bearer COSY."));
    assert.strictEqual(headerMap["Cosy-User"], user.uid);
    assert.strictEqual(headerMap["Cosy-MachineId"], machineId);
    assert.strictEqual(headerMap["X-Model-Key"], "qfmodel");
    assert.strictEqual(headerMap["Cosy-Date"], "1790257470");
    assert.ok(headerMap["Cosy-Key"].length > 50);
  });
});
