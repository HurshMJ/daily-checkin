import { createContext, type MiddlewareFunction, redirect, type RouterContextProvider } from "react-router";

import { appContext } from "~/services";

import { type Auth, createAuth, type CurrentMember, SESSION_LIFETIME_MS } from "./auth";
import { isTokenShaped } from "./crypto";

/**
 * The session cookie. The `__Host-` prefix makes the browser refuse it unless
 * it is Secure, has Path=/ and no Domain, so no other origin can plant it.
 */
export const SESSION_COOKIE = "__Host-session";

/**
 * The link cookies. Opening `/invite/<token>`, `/setup/<token>` or
 * `/reset/<token>` moves the token into one of these and redirects to a page
 * whose URL holds no token.
 */
export const INVITE_COOKIE = "__Host-invite";
export const SETUP_COOKIE = "__Host-setup";
export const RESET_COOKIE = "__Host-reset";
export type LinkCookie = typeof INVITE_COOKIE | typeof SETUP_COOKIE | typeof RESET_COOKIE;

/** A link cookie lasts an hour, the life of a Setup Link. */
export const LINK_COOKIE_MAX_AGE_S = 60 * 60;

const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax; Path=/";

function cookie(name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; Max-Age=${maxAgeS}; ${COOKIE_ATTRIBUTES}`;
}

export function sessionCookie(token: string): string {
  return cookie(SESSION_COOKIE, token, SESSION_LIFETIME_MS / 1000);
}

export function linkCookie(name: LinkCookie, token: string): string {
  return cookie(name, token, LINK_COOKIE_MAX_AGE_S);
}

/** A flash cookie lasts a minute: long enough to reach the page a redirect names. */
export const FLASH_COOKIE_MAX_AGE_S = 60;

/**
 * A short-lived cookie that carries a value across one redirect, for the page
 * it lands on to read and clear. Path=/ because a single-fetch request goes to
 * `<page>.data`, which a Path=<page> cookie would not reach.
 */
export function flashCookie(name: string, value: string): string {
  return cookie(name, value, FLASH_COOKIE_MAX_AGE_S);
}

/** A Set-Cookie value that removes the named cookie. */
export function clearedCookie(name: string): string {
  return cookie(name, "", 0);
}

export function clearedSessionCookie(): string {
  return clearedCookie(SESSION_COOKIE);
}

/** Response headers that set each of the given Set-Cookie values. */
export function setCookies(...values: string[]): [string, string][] {
  return values.map((value) => ["Set-Cookie", value]);
}

/** The named cookie's value from the request, if it has a non-empty one. */
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

/** The first path segment of each redirect-only link route, such as `/invite/<token>`. */
const LINK_ROUTE_PREFIXES = ["invite", "setup", "reset"] as const;

/**
 * The redirect-only link routes' paths, matched case-insensitively and with
 * any number of trailing slashes, like the router matches them
 * (`compilePath` in node_modules/react-router/dist/development/lib/router/utils.js
 * ends every route pattern with `\/*$` and adds the `i` flag).
 */
const LINK_PATH = new RegExp(`^/(${LINK_ROUTE_PREFIXES.join("|")})/[^/]+/*$`, "i");

/**
 * The pathname the router matches for a single-fetch data request: a
 * trailing `/_.data` loses its `_.data`, otherwise a trailing `.data` is
 * removed, so `/reset/<token>.data` and `/reset/<token>/_.data` reach the
 * link route (`getNormalizedPath` in
 * node_modules/react-router/dist/development/lib/server-runtime/urls.js).
 */
function withoutDataSuffix(pathname: string): string {
  return pathname.endsWith("/_.data") ? pathname.replace(/_\.data$/, "") : pathname.replace(/\.data$/, "");
}

/**
 * True when the router sends this pathname to a redirect-only link route. The
 * single-fetch suffix is removed first, then the path is decoded segment by
 * segment with `%2F` kept, as the router decodes it before matching, so
 * `/%69nvite/<token>` counts. A malformed escape counts as no match: the
 * lookup that follows is the safe side.
 */
export function isLinkPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = withoutDataSuffix(pathname)
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/");
  } catch {
    return false;
  }
  return LINK_PATH.test(decoded);
}

/**
 * The redirect-only link route: a token of the right shape goes into the link
 * cookie, and every request goes on to `to`, a page whose URL holds no token.
 * It reads no D1 and logs nothing, so the token in this one URL reaches no log.
 */
export function moveTokenToCookie(token: string, name: LinkCookie, to: string): Response {
  const headers = new Headers({ Location: to, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  if (isTokenShaped(token)) headers.append("Set-Cookie", linkCookie(name, token));
  return new Response(null, { status: 303, headers });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Request safety: any request that may change data must carry an `Origin`
 * header equal to the app's own origin. Returns the 403 to send, or null to
 * let the request through. A missing `Origin` is refused like a wrong one.
 */
export function refuseCrossOrigin(request: Request): Response | null {
  if (SAFE_METHODS.has(request.method)) return null;
  const origin = request.headers.get("Origin");
  if (origin !== null && origin === new URL(request.url).origin) return null;
  return new Response("Forbidden: this request did not come from the app.", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

interface CurrentSession {
  member: CurrentMember;
  token: string;
}

const currentSessionContext = createContext<CurrentSession | null>(null);

type ReadContext = Readonly<RouterContextProvider>;

/** The Auth module wired to this request's D1 and clock. */
export function authFor(context: ReadContext): Auth {
  return createAuth(context.get(appContext));
}

/**
 * Root middleware: resolves the session cookie once per request, renews the
 * session in D1, and sends the renewed cookie, unless the route itself set
 * or cleared the session cookie (log in, log out). It skips the redirect-only
 * link routes, so a request whose URL holds a token never touches D1.
 */
export const sessionMiddleware: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  if (isLinkPath(new URL(request.url).pathname)) return next();
  const token = readCookie(request, SESSION_COOKIE);
  const member = token ? await authFor(context).resolveSession(token) : null;
  context.set(currentSessionContext, member && token ? { member, token } : null);

  const response = await next();
  const routeSetCookie = response.headers
    .getSetCookie()
    .some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (member && token && !routeSetCookie) {
    response.headers.append("Set-Cookie", sessionCookie(token));
  }
  return response;
};

/** This request's session, or null when logged out. */
export function currentSession(context: ReadContext): CurrentSession | null {
  return context.get(currentSessionContext);
}

/** The logged-in Member; a logged-out request is redirected to /login. */
export function requireMember(context: ReadContext): CurrentMember {
  const session = currentSession(context);
  if (!session) throw redirect("/login");
  return session.member;
}
