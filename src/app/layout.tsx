import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import {
  CODER_FRAME_HOSTS_META,
  CODER_FRAME_HOSTS_REQUEST_HEADER,
} from "@/lib/security/content-security-policy";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Hive — Your autonomous development control plane",
    template: "%s — Hive",
  },
  description:
    "Turn an engineering brief into an isolated workspace, verified implementation, and review-ready pull request.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icons/hive-mark.svg",
    apple: "/apple-touch-icon.png",
  },
  applicationName: "Hive",
  category: "developer tools",
  keywords: ["AI development", "developer automation", "Coder workspaces", "pull requests"],
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const documentCoderFrameHosts = (await headers()).get(CODER_FRAME_HOSTS_REQUEST_HEADER) ?? "";

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <meta name={CODER_FRAME_HOSTS_META} content={documentCoderFrameHosts} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Hive" />
        <meta name="format-detection" content="telephone=no" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body className="font-sans antialiased">
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
