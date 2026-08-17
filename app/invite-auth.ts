export const INVITE_COOKIE_NAME = "shiliao_invite_access";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const SESSION_MESSAGE = "shiliao-workbench-invite-session-v1";
const encoder = new TextEncoder();

function secret() {
  return String(process.env.SITE_INVITE_CODE || "");
}

function base64Url(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function constantTimeEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function sha256(value: string) {
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function sessionToken(inviteSecret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(inviteSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(SESSION_MESSAGE)));
}

export function inviteIsConfigured() {
  return Boolean(secret());
}

export async function verifyInviteCode(value: string) {
  const inviteSecret = secret();
  if (!inviteSecret || !value) return false;
  return constantTimeEqual(await sha256(value), await sha256(inviteSecret));
}

export async function createInviteSession() {
  const inviteSecret = secret();
  if (!inviteSecret) throw new Error("邀请码尚未配置");
  return sessionToken(inviteSecret);
}

export async function verifyInviteSession(value: string | undefined) {
  const inviteSecret = secret();
  if (!inviteSecret) return process.env.NODE_ENV !== "production";
  if (!value) return false;
  return constantTimeEqual(value, await sessionToken(inviteSecret));
}

export function readInviteCookie(request: Request) {
  const source = request.headers.get("cookie") || "";
  for (const entry of source.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === INVITE_COOKIE_NAME) return entry.slice(separator + 1).trim();
  }
  return "";
}

export function inviteCookieHeader(value: string, clear = false) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${INVITE_COOKIE_NAME}=${clear ? "" : value}; Path=/; Max-Age=${clear ? 0 : SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure}`;
}

export async function rejectUnauthorizedApi(request: Request) {
  if (!inviteIsConfigured() || await verifyInviteSession(readInviteCookie(request))) return null;
  return Response.json({ error: "请先使用邀请码进入史料研析台。" }, { status: 401, headers: { "cache-control": "no-store" } });
}
