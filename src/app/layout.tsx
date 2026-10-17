import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import localFont from "next/font/local";
import { KillboardNav } from "./_components/nav";
import { Chevron } from "./_components/components";
import "./killboard.css";

// The public site's two instruments (thecitadel.com): Architekt for names, VCR for the machine.
const architekt = localFont({
  src: "./fonts/NBArchitektPro-Regular.ttf",
  variable: "--font-kb-architekt",
  display: "swap",
});
const vcr = localFont({
  src: "./fonts/VCRosdNEUE.ttf",
  variable: "--font-kb-vcr",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Killboard · Citadel", template: "%s · Citadel Killboard" },
  description:
    "Every ship lost in Citadel, rebuilt from the game's own replays.",
};

export default function KillboardLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
    <div className={`kb-root ${architekt.variable} ${vcr.variable}`}>
      <header className="kb-masthead">
        <div className="kb-shell kb-masthead-row">
          <KillboardNav />
          <Link
            href="/"
            className="kb-wordmark"
            aria-label="Citadel killboard"
          >
            <img
              src="/citadel-wordmark.webp"
              alt=""
              width={3400}
              height={400}
            />
          </Link>
          <a href="/" className="kb-signal-link kb-masthead-action">
            Play <Chevron double />
          </a>
        </div>
      </header>
      {children}
      <footer className="kb-shell kb-footer">
        <span className="kb-label">
          Rebuilt from replays · public 5 min after the kill
        </span>
        <span className="kb-label">Values in ore</span>
      </footer>
    </div>
      </body>
    </html>
  );
}
