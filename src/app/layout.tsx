// ============================================================
// Root layout for the citemaps.org registry app.
//
// Two surfaces share this layout:
//   - api.citemaps.org/* — JSON API routes (the layout is
//     irrelevant here since route handlers don't render HTML;
//     left intact for cohesion)
//   - registry.citemaps.org/* — public HTML pages (this is
//     where the layout matters)
//
// Geist Sans + Geist Mono loaded via next/font/google — pinned
// at build time, served from the same origin, no FOUT.
// ============================================================

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "citemaps.org registry",
  description:
    "Public registry of citemap.json files on the open web. The neutral catalog of every entity that publishes a citemap.",
  metadataBase: new URL("https://registry.citemaps.org"),
  openGraph: {
    title: "citemaps.org registry",
    description:
      "Public registry of citemap.json files on the open web.",
    url: "https://registry.citemaps.org",
    siteName: "citemaps.org registry",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
