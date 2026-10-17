import { headers } from "next/headers";

/**
 * This request's own site, for absolute links such as social card URLs: the forwarded protocol
 * where a proxy sets one (its first value), http on a local dev host, https otherwise.
 */
export async function siteOrigin(): Promise<URL | null> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  if (!host) return null;
  const forwarded = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol =
    forwarded ||
    (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return new URL(`${protocol}://${host}`);
}
