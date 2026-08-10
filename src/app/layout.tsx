import type * as React from "react";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Keyboard Accessibility AI Analyzer",
  description:
    "An autonomous keyboard accessibility testing agent. Explores a page with the keyboard and reports reproducible findings.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*
        Browser extensions add attributes to <body> before React hydrates —
        ColorZilla's `cz-shortcut-listen`, Grammarly's `data-gr-*`, and others —
        and every one of them reports as a hydration mismatch the user cannot
        act on.

        This suppresses the warning for this element's own attributes only. It
        does not extend to children, so a genuine mismatch anywhere inside the
        app still surfaces.
      */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
