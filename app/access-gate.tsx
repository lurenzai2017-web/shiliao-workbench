"use client";

import { FormEvent, useState } from "react";

export default function AccessGate({ configured }: { configured: boolean }) {
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState(configured ? "" : "站点尚未配置邀请码，请联系管理员。");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!configured || !inviteCode.trim()) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/access/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteCode }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "邀请码验证失败。");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "邀请码验证失败。");
      setSubmitting(false);
    }
  };

  return (
    <main className="access-shell">
      <section className="access-card" aria-labelledby="access-title">
        <div className="access-seal">史</div>
        <span className="access-eyebrow">Historical Evidence Workbench</span>
        <h1 id="access-title">史料研析台</h1>
        <p>站點管理者已啟用邀請碼。請輸入研究項目邀請碼後進入；邀請碼與 API Key 均不會寫入研究結果。</p>
        <form onSubmit={submit}>
          <label htmlFor="invite-code">邀请码</label>
          <input
            id="invite-code"
            type="password"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            placeholder="请输入邀请码"
            autoComplete="off"
            disabled={!configured || submitting}
          />
          {message && <div className="access-message" role="alert">{message}</div>}
          <button type="submit" disabled={!configured || submitting}>{submitting ? "正在验证…" : "进入研析台"}</button>
        </form>
        <small>邀請碼只用於驗證本次瀏覽器的存取權限。</small>
      </section>
    </main>
  );
}
