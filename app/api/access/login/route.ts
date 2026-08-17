import { createInviteSession, inviteCookieHeader, inviteIsConfigured, verifyInviteCode } from "../../../invite-auth";

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function clientKey(request: Request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function attemptFor(key: string) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    const next = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(key, next);
    return next;
  }
  return current;
}

export async function POST(request: Request) {
  if (!inviteIsConfigured()) return Response.json({ error: "站点尚未配置邀请码。" }, { status: 503 });
  const key = clientKey(request);
  const attempt = attemptFor(key);
  if (attempt.count >= MAX_ATTEMPTS) {
    return Response.json({ error: "尝试次数过多，请十五分钟后再试。" }, { status: 429, headers: { "cache-control": "no-store" } });
  }
  try {
    const body = await request.json() as { inviteCode?: string };
    if (!(await verifyInviteCode(String(body.inviteCode || "")))) {
      attempt.count += 1;
      return Response.json({ error: "邀请码不正确。" }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    attempts.delete(key);
    const token = await createInviteSession();
    return Response.json({ ok: true }, {
      headers: {
        "cache-control": "no-store",
        "set-cookie": inviteCookieHeader(token),
      },
    });
  } catch {
    attempt.count += 1;
    return Response.json({ error: "邀请码验证失败。" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
