import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getServerRuntimeConfig } from "@/lib/runtime-config";
import "./globals.css";

// Read runtime env on every request so the WS URL reflects per-deployment
// config rather than what was set when `pnpm build` ran in the Docker image.
export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hive Orchestrator",
  description: "AI-powered task orchestration platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const runtimeConfig = getServerRuntimeConfig();
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-controlled config from env
          dangerouslySetInnerHTML={{
            __html: `window.__HIVE_CONFIG__=${JSON.stringify(runtimeConfig)};`,
          }}
        />
        <ServiceWorkerRegister />
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
