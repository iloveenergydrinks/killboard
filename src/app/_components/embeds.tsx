"use client";

import { useEffect, useState } from "react";

/**
 * The kill cam of the build that recorded the kill. Its viewer runs a whole game build and needs a
 * cross-origin isolated page of its own, so it opens in a new tab; the lost ship stands in for it.
 */
export function KillCamLink({
  href,
  poster,
  label,
}: {
  href: string;
  poster: string | null;
  label: string;
}) {
  return (
    <div className="kb-player">
      <a
        className="kb-player-poster"
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
      >
        {poster ? <img src={poster} alt="" /> : null}
        <span className="kb-button">
          <span className="kb-chevron is-double" aria-hidden="true" /> Watch
          the kill{" "}
          <span className="kb-chevron is-double is-left" aria-hidden="true" />
        </span>
      </a>
    </div>
  );
}

/** Copy, share or post the kill's link, and download its clip when the kill feed rendered one. */
export function ShareBar({
  title,
  clipUrl,
  clipName,
}: {
  title: string;
  clipUrl: string | null;
  clipName: string;
}) {
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  useEffect(
    () =>
      setCanShare(
        typeof navigator !== "undefined" &&
          typeof navigator.share === "function",
      ),
    [],
  );
  const url = () => window.location.href;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  const share = () => navigator.share({ title, url: url() }).catch(() => {});
  const post = () =>
    window.open(
      `https://x.com/intent/post?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url())}`,
      "_blank",
      "noopener,noreferrer",
    );
  return (
    <div className="kb-share" role="group" aria-label="Share this kill">
      <button type="button" className="kb-chip" onClick={copy}>
        {copied ? "Link copied" : "Copy link"}
      </button>
      {canShare ? (
        <button type="button" className="kb-chip" onClick={share}>
          Share
        </button>
      ) : null}
      <button type="button" className="kb-chip" onClick={post}>
        Post on X
      </button>
      {clipUrl ? (
        <a
          className="kb-chip"
          href={clipUrl}
          download={clipName}
          target="_blank"
          rel="noreferrer"
        >
          Download video
        </a>
      ) : null}
    </div>
  );
}
