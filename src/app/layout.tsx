import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "citemaps.org registry",
  description: "Public registry of citemap.json files on the open web.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          color: "#111",
          background: "#fafafa",
        }}
      >
        {children}
      </body>
    </html>
  );
}
