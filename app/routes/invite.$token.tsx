import { data, Form, Link, redirect } from "react-router";

import { clientIp } from "~/auth/login-limits";
import { authFor, currentSession, requireMember, sessionCookie } from "~/auth/request";
import { type NewLoginErrors, normaliseUsername, validateNewLogin } from "~/auth/rules";
import { LoginFields, NewLoginFields } from "~/components/login-fields";
import { Notice } from "~/components/notice";
import { OfflineBar } from "~/components/offline-bar";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { createInvites, type InviteView } from "~/invites";
import { appContext } from "~/services";

import type { Route } from "./+types/invite.$token";
import { LOGIN_FAILED_MESSAGE } from "./login";

export const UNUSABLE_INVITE_TITLE = "This Invite has been used or cancelled.";
export const UNUSABLE_INVITE_MESSAGE = "Ask the Owner of the Group for a new one.";

// The token is in the URL: never send it on to another site, never cache it.
export function headers(_: Route.HeadersArgs) {
  return { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Invite · Daily Check-in" }];
}

type Mode = "create" | "login" | null;

function modeOf(request: Request): Mode {
  const mode = new URL(request.url).searchParams.get("mode");
  return mode === "create" || mode === "login" ? mode : null;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const session = currentSession(context);
  const view = await createInvites(context.get(appContext)).inviteFor(params.token, session?.member.id ?? null);
  return data({ view, loggedIn: session !== null, mode: modeOf(request) }, { status: view.usable ? 200 : 404 });
}

type ActionResult =
  | { unusable: true }
  | { unusable: false; mode: null }
  | { unusable: false; mode: "create"; errors: NewLoginErrors; username: string; colour: string }
  | { unusable: false; mode: "login"; error: string; username: string };

const unusable = () => data<ActionResult>({ unusable: true }, { status: 404 });

/**
 * The form's intent field says which way in it is: "join" for a logged-in
 * Member, "create" to create a login and join, "login" to log in and join.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  const app = context.get(appContext);
  const invites = createInvites(app);
  const auth = authFor(context);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "join") {
    const member = requireMember(context);
    const joined = await invites.joinWithInvite(member.id, params.token);
    return joined === "unusable" ? unusable() : redirect("/");
  }

  if (intent === "create") {
    const echo = {
      username: normaliseUsername(String(form.get("username") ?? "")),
      colour: String(form.get("colour") ?? ""),
    };
    if (!(await invites.inviteFor(params.token)).usable) return unusable();
    const checked = validateNewLogin(form);
    if (!checked.ok) {
      return data<ActionResult>({ unusable: false, mode: "create", errors: checked.errors, ...echo }, { status: 400 });
    }
    const created = await auth.createLoginFromInvite(params.token, checked.value);
    if (!created.ok) {
      if (created.reason === "link-unusable") return unusable();
      const errors = { username: "That username is taken." };
      return data<ActionResult>({ unusable: false, mode: "create", errors, ...echo }, { status: 400 });
    }
    return redirect("/", { headers: { "Set-Cookie": sessionCookie(created.sessionToken) } });
  }

  if (intent === "login") {
    const username = String(form.get("username") ?? "");
    const sessionToken = await auth.logIn(username, String(form.get("password") ?? ""), clientIp(request));
    if (!sessionToken) {
      return data<ActionResult>({ unusable: false, mode: "login", error: LOGIN_FAILED_MESSAGE, username }, { status: 401 });
    }
    const member = await auth.resolveSession(sessionToken);
    const joined = member ? await invites.joinWithInvite(member.id, params.token) : "unusable";
    // Logged in now, the Invite page shows its warning for an unusable Invite.
    const to = joined === "unusable" ? `/invite/${encodeURIComponent(params.token)}` : "/";
    return redirect(to, { headers: { "Set-Cookie": sessionCookie(sessionToken) } });
  }

  return data<ActionResult>({ unusable: false, mode: null }, { status: 400 });
}

/** An Invite link: who invited you to which Group, and the way in. It has no top bar. */
export default function Invite({ loaderData, actionData }: Route.ComponentProps) {
  const { view, loggedIn } = loaderData;
  const failed = actionData && !actionData.unusable ? actionData : null;
  const mode = failed?.mode ?? loaderData.mode;

  if (!view.usable || actionData?.unusable === true) {
    return (
      <>
        <OfflineBar />
        <main className="page">
          <header className="setup-header">
            <h1>Join a Group</h1>
          </header>
          <Notice tone="warning" title={UNUSABLE_INVITE_TITLE}>
            {UNUSABLE_INVITE_MESSAGE}
          </Notice>
        </main>
      </>
    );
  }

  return (
    <>
      <OfflineBar />
      <main className="page">
        <InviteHeader view={view} />
        {loggedIn ? (
          <JoinOrAlreadyIn view={view} />
        ) : mode === "create" ? (
          <CreateLoginForm failed={failed?.mode === "create" ? failed : null} />
        ) : mode === "login" ? (
          <LogInForm failed={failed?.mode === "login" ? failed : null} />
        ) : (
          <div className="page-form">
            <Link className="btn-primary" to="?mode=create">
              Create a login
            </Link>
            <Link className="btn-secondary" to="?mode=login">
              Log in
            </Link>
          </div>
        )}
      </main>
    </>
  );
}

type UsableView = Extract<InviteView, { usable: true }>;

function InviteHeader({ view }: { view: UsableView }) {
  return (
    <header className="setup-header">
      <p className="setup-note">{view.inviterName ? `${view.inviterName} invited you to` : "You're invited to"}</p>
      <h1>{view.groupName}</h1>
    </header>
  );
}

function JoinOrAlreadyIn({ view }: { view: UsableView }) {
  const submitting = useSubmitting();
  if (view.alreadyMember) {
    return (
      <Notice tone="info" title={`You're already in ${view.groupName}.`}>
        <Link to="/">Go to Tonight</Link>
      </Notice>
    );
  }
  return (
    <Form method="post" className="page-form">
      <input type="hidden" name="intent" value="join" />
      <SubmitButton
        pending={submitting}
        label={`Join ${view.groupName}`}
        pendingLabel="Joining…"
        className="btn-primary"
      />
    </Form>
  );
}

function CreateLoginForm({ failed }: { failed: { errors: NewLoginErrors; username: string; colour: string } | null }) {
  const submitting = useSubmitting();
  return (
    <>
      <Form method="post" className="page-form" noValidate>
        <input type="hidden" name="intent" value="create" />
        <NewLoginFields errors={failed?.errors ?? {}} username={failed?.username} colour={failed?.colour} />
        <SubmitButton
          pending={submitting}
          label="Create login and join"
          pendingLabel="Creating login…"
          className="btn-primary"
        />
      </Form>
      <p className="login-hint">
        Have a login? <Link to="?mode=login">Log in</Link>
      </p>
    </>
  );
}

function LogInForm({ failed }: { failed: { error: string; username: string } | null }) {
  const submitting = useSubmitting();
  return (
    <>
      {failed ? (
        <Notice tone="error" title="Can't log in">
          {failed.error}
        </Notice>
      ) : null}
      <Form method="post" className="page-form">
        <input type="hidden" name="intent" value="login" />
        <LoginFields username={failed?.username} />
        <SubmitButton pending={submitting} label="Log in and join" pendingLabel="Logging in…" className="btn-primary" />
      </Form>
      <p className="login-hint">
        No login yet? <Link to="?mode=create">Create a login</Link>
      </p>
    </>
  );
}
