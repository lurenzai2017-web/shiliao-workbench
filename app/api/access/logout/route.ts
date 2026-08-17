import { inviteCookieHeader } from "../../../invite-auth";

export async function POST() {
  return Response.json({ ok: true }, {
    headers: {
      "cache-control": "no-store",
      "set-cookie": inviteCookieHeader("", true),
    },
  });
}
