import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

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
  return (
    <html lang="en" className="dark">
      <head>
        {/* Runtime config served by a dedicated dynamic route so the rest of
            the app stays statically optimizable. The script must execute
            before any client bundle reads window.__HIVE_CONFIG__. */}
        <script src="/runtime-config.js" />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <ServiceWorkerRegister />
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
