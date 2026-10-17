"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  {
    href: "/",
    label: "Kills",
    match: (path: string) =>
      path === "/" || path.startsWith("/kill"),
  },
  {
    href: "/battles",
    label: "Battles",
    match: (path: string) => path.startsWith("/battle"),
  },
  {
    href: "/leaderboards",
    label: "Leaders",
    match: (path: string) => path.startsWith("/leaderboards"),
  },
];

export function KillboardNav() {
  const path = usePathname() ?? "";
  return (
    <nav className="kb-nav" aria-label="Killboard">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={link.match(path) ? "page" : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
