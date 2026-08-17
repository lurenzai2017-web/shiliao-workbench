import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import AccessGate from "./access-gate";
import { INVITE_COOKIE_NAME, inviteIsConfigured, verifyInviteSession } from "./invite-auth";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const image = new URL("/og.png", base).toString();
  return {
    metadataBase: base,
    title: "史料研析台｜從研究問題到可追溯的原文證據",
    description: "為歷史研究者設計的本機優先 AI 史料工作台：匯入資料、生成研究規約、試跑樣本並複核原文證據。",
    openGraph: {
      title: "史料研析台",
      description: "從研究問題到可追溯的原文證據",
      images: [{ url: image, width: 1200, height: 630, alt: "史料研析台" }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "史料研析台",
      description: "從研究問題到可追溯的原文證據",
      images: [image],
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const configured = inviteIsConfigured();
  const granted = !configured || await verifyInviteSession(cookieStore.get(INVITE_COOKIE_NAME)?.value);
  return (
    <html lang="zh-Hant">
      <body>{granted ? children : <AccessGate configured={configured} />}</body>
    </html>
  );
}
