import { createContext, type MiddlewareFunction, redirect, type RouterContextProvider } from "react-router";

import { appContext } from "~/services";

import { type Auth, createAuth, type CurrentMember, SESSION_LIFETIME_MS } from "./auth";

/**
 * The session cookie. The `__Host-` prefix makes the browser refuse it unless
 * it is Secure, has Path=/ and no Domain, so no other origin can plant it.
 */
export const SESSION_COOKIE = "__Host-session";

const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax; Path=/";

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_LIFETIME_MS / 1000}; ${COOKIE_ATTRIBUTES}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

/** The session token from the request's cookie, if there is one. */
export function readSessionToken(request: Request): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
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
 * or cleared the session cookie (log in, log out).
 */
export const sessionMiddleware: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  const token = readSessionToken(request);
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
