/**
 * Qoder Cosy 族 Header 与签名生成器
 * 依据对 Qoder 官方抓包与开源还原协议：
 * - RSA-1024 加密 16 字节 AES-Key 作为 Cosy-Key
 * - AES-128-CBC 加密用户身份信息作为 info
 * - MD5 校验和签名组装 Authorization: Bearer COSY.<payload>.<sig>
 * - 严格保序导出与官方 CLI 24 个 Headers 完全对齐的键值对
 */

import * as crypto from "node:crypto";
import * as os from "node:os";

export const RSAPublicKeyPEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export interface QoderUser {
  uid: string;
  token: string;
  name?: string;
  email?: string;
}

export function urlPathname(rawURL: string): string {
  try {
    const u = new URL(rawURL);
    let p = u.pathname;
    if (p.startsWith("/algo")) {
      p = p.slice("/algo".length);
    }
    return p;
  } catch {
    return rawURL;
  }
}

function hex(n: number): string {
  return crypto.randomBytes(n).toString("hex");
}

function cosyMachineOS(): string {
  const p = os.platform();
  const arch = os.arch() === "x64" ? "x86_64" : os.arch();
  if (p === "darwin") return `${arch}_darwin`;
  if (p === "win32") return `${arch}_win32`;
  return `${arch}_linux`;
}

export function buildCosyHeaders(
  rawURL: string,
  user: QoderUser,
  bodyWire: string,
  machineId: string,
  timestamp = Math.floor(Date.now() / 1000)
): [string, string][] {
  // 1. 生成 16 字节 ASCII Hex 格式 AES Key
  const aesKeyStr = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const aesKey = Buffer.from(aesKeyStr, "utf8");

  // 2. RSA 公钥加密 AES key -> Cosy-Key
  const encryptedKey = crypto.publicEncrypt(
    {
      key: RSAPublicKeyPEM,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    aesKey
  );
  const keyB64 = encryptedKey.toString("base64");

  // 3. AES-128-CBC 加密 user blob -> infoB64
  const cipher = crypto.createCipheriv("aes-128-cbc", aesKey, aesKey);
  cipher.setAutoPadding(true);
  const userBlob = JSON.stringify({
    uid: user.uid,
    aid: "",
    name: user.name ?? "",
    email: user.email ?? "",
    security_oauth_token: user.token,
  });
  const infoEnc = Buffer.concat([cipher.update(userBlob, "utf8"), cipher.final()]);
  const infoB64 = infoEnc.toString("base64");

  // 4. 组装 payload（与真实 Qoder CLI 1.1.63 保持一致）
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const payloadObj = {
    version: "v1",
    requestId,
    info: infoB64,
    cosyVersion: "1.1.63",
    ideVersion: "",
  };
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64");

  // 5. 计算 MD5 签名
  const path = urlPathname(rawURL);
  const sigInput = `${payload}\n${keyB64}\n${timestamp}\n${bodyWire}\n${path}`;
  const sig = crypto.createHash("md5").update(sigInput, "utf8").digest("hex");
  const authHeader = `Bearer COSY.${payload}.${sig}`;

  const traceId = hex(16);
  const spanId = hex(8);
  const traceparent = `00-${traceId}-${spanId}-01`;
  const hostname = os.hostname() || "wangyu-mc";

  // 6. 返回严格保序的 Headers 对（完全使用宿主环境真值：Linux/x86_64，绝无伪造 Windows）
  const u = new URL(rawURL);
  const host = u.host;

  const headers: [string, string][] = [
    ["Accept", "text/event-stream"],
    ["Authorization", authHeader],
    ["Cache-Control", "no-cache"],
    ["Connection", "keep-alive"],
    ["Content-Type", "application/json"],
    ["Cosy-Business-Product", "cli"],
    ["Cosy-Business-Type", "agent"],
    ["Cosy-ClientType", "5"],
    ["Cosy-Data-Policy", "agree"],
    ["Cosy-Date", String(timestamp)],
    ["Cosy-Key", keyB64],
    ["Cosy-MachineHostname", hostname],
    ["Cosy-MachineId", machineId],
    ["Cosy-MachineOS", cosyMachineOS()],
    ["Cosy-MachineToken", machineId],
    ["Cosy-MachineType", "2523c4c5131308e414"],
    ["Cosy-Scene", "assistant"],
    ["Cosy-User", user.uid],
    ["Cosy-Version", "1.1.63"],
    ["Login-Version", "v2"],
    ["X-Model-Key", "qfmodel"],
    ["X-Model-Source", "system"],
    ["traceparent", traceparent],
    ["User-Agent", "Bun/1.4.2"],
    ["Host", host],
    ["Accept-Encoding", "gzip, deflate, br, zstd"],
  ];

  return headers;
}
