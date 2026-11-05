import { data, Form, redirect } from "react-router";

import { clientIp } from "~/auth/login-limits";
import { authFor, currentSession, sessionCookie } from "~/auth/request";
import { LoginFields } from "~/components/login-fields";
import { Notice } from "~/components/notice";
import { OfflineBar } from "~/components/offline-bar";
import { SubmitButton, useSubmitting } from "~/components/submit-button";

import type { Route } from "./+types/login";

// One message for every failure, so it never tells whether a username exists
// or whether a login limit refused the attempt.
export const LOGIN_FAILED_MESSAGE = "That username and password do not match.";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Log in · Daily Check-in" }];
}

/**
 * The fixed notices another page sends here with `?notice=<key>`. Only these
 * keys show anything, and the text lives here, never in the URL.
 */
const LOGIN_NOTICES = {
  "password-set": { title: "Password set", body: "Log in with your new password." },
  "login-deleted": { title: "Login deleted", body: "Your login was deleted." },
} as const;

type LoginNoticeKey = keyof typeof LOGIN_NOTICES;

function isLoginNoticeKey(key: string | null): key is LoginNoticeKey {
  return key !== null && Object.hasOwn(LOGIN_NOTICES, key);
}

export function loader({ request, context }: Route.LoaderArgs) {
  if (currentSession(context)) throw redirect("/");
  const key = new URL(request.url).searchParams.get("notice");
  return { notice: isLoginNoticeKey(key) ? key : null };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  const token = await authFor(context).logIn(username, password, clientIp(request));
  if (!token) return data({ error: LOGIN_FAILED_MESSAGE, username }, { status: 401 });
  return redirect("/", { headers: { "Set-Cookie": sessionCookie(token) } });
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const submitting = useSubmitting();
  const notice = loaderData?.notice && !actionData ? LOGIN_NOTICES[loaderData.notice] : null;
  return (
    <>
      <OfflineBar />
      <main className="page">
        <header className="login-header">
          <h1>Daily Check-in</h1>
          <p className="login-tagline">Who's on tonight?</p>
        </header>
        <div role="status">
          {notice ? (
            <Notice tone="info" title={notice.title}>
              {notice.body}
            </Notice>
          ) : null}
        </div>
        {actionData?.error ? (
          <Notice tone="error" title="Can't log in">
            {actionData.error}
          </Notice>
        ) : null}
        {/* Posts to /login itself, so a notice key in this page's URL is not carried on. */}
        <Form method="post" action="/login" className="page-form">
          <LoginFields username={actionData?.username} />
          <SubmitButton pending={submitting} label="Log in" pendingLabel="Logging in…" className="btn-primary" />
        </Form>
        <p className="login-hint">No login yet? Ask a friend in your Group for an Invite.</p>
      </main>
    </>
  );
}
