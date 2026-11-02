import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import { sessionMiddleware } from "./auth/request";
import appStylesHref from "./styles/app.css?url";

import type { Route } from "./+types/root";

export const middleware: Route.MiddlewareFunction[] = [sessionMiddleware];

// The latin files only: latin-ext loads on demand through unicode-range.
const PRELOADED_FONTS = [
  "/fonts/fredoka-600-latin.woff2",
  "/fonts/nunito-sans-400-latin.woff2",
  "/fonts/nunito-sans-700-latin.woff2",
];

// The one global stylesheet, linked explicitly so every page gets exactly one
// <link>, plus preloads for the fonts it uses first.
export const links: Route.LinksFunction = () => [
  ...PRELOADED_FONTS.map((href) => ({
    rel: "preload",
    as: "font",
    type: "font/woff2",
    href,
    crossOrigin: "anonymous" as const,
  })),
  { rel: "stylesheet", href: appStylesHref },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong";
  let details = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Page not found" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
  }

  return (
    <main>
      <h1>{message}</h1>
      <p>{details}</p>
    </main>
  );
}
