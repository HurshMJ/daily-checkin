import { data, Form, redirect } from "react-router";

import { authFor, clearedCookie, readCookie, SETUP_COOKIE, sessionCookie, setCookies } from "~/auth/request";
import { type NewLoginErrors, normaliseUsername, USERNAME_TAKEN_MESSAGE, validateNewLogin } from "~/auth/rules";
import { NewLoginFields } from "~/components/login-fields";
import { Notice } from "~/components/notice";
import { OfflineBar } from "~/components/offline-bar";
import { SubmitButton, useSubmitting } from "~/components/submit-button";

import type { Route } from "./+types/setup";

export const UNUSABLE_LINK_MESSAGE =
  "This Setup Link does not work. It may be used, replaced or more than an hour old. Ask the Operator for a new one.";

// The page acts on a secret link: never send its URL on to another site, never cache it.
export function headers(_: Route.HeadersArgs) {
  return { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Create your login · Daily Check-in" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const token = readCookie(request, SETUP_COOKIE);
  const usable = token !== null && (await authFor(context).setupLinkIsUsable(token));
  return data({ usable }, { status: usable ? 200 : 404 });
}

interface ActionResult {
  usable: boolean;
  errors: NewLoginErrors;
  username: string;
  colour: string;
}

export async function action({ request, context }: Route.ActionArgs) {
  const token = readCookie(request, SETUP_COOKIE);
  const auth = authFor(context);
  const form = await request.formData();
  const echo = {
    username: normaliseUsername(String(form.get("username") ?? "")),
    colour: String(form.get("colour") ?? ""),
  };

  if (token === null || !(await auth.setupLinkIsUsable(token))) {
    return data<ActionResult>({ usable: false, errors: {}, ...echo }, { status: 404 });
  }
  const checked = validateNewLogin(form);
  if (!checked.ok) {
    return data<ActionResult>({ usable: true, errors: checked.errors, ...echo }, { status: 400 });
  }

  const result = await auth.createLoginFromSetupLink(token, checked.value);
  if (!result.ok) {
    const usable = result.reason !== "link-unusable";
    const errors = usable ? { username: USERNAME_TAKEN_MESSAGE } : {};
    return data<ActionResult>({ usable, errors, ...echo }, { status: usable ? 400 : 404 });
  }
  return redirect("/", { headers: setCookies(sessionCookie(result.sessionToken), clearedCookie(SETUP_COOKIE)) });
}

export default function SetupLink({ loaderData, actionData }: Route.ComponentProps) {
  const usable = actionData?.usable ?? loaderData?.usable ?? false;
  const errors = actionData?.errors ?? {};
  const submitting = useSubmitting();

  if (!usable) {
    return (
      <>
        <OfflineBar />
        <main className="page">
          <header className="setup-header">
            <h1>Create your login</h1>
          </header>
          <Notice tone="error" title="Can't use this link">
            {UNUSABLE_LINK_MESSAGE}
          </Notice>
        </main>
      </>
    );
  }

  return (
    <>
      <OfflineBar />
      <main className="page">
        <header className="setup-header">
          <h1>Create your login</h1>
          <p className="setup-note">This link works once and expires an hour after it was made.</p>
        </header>
        <Form method="post" className="page-form" noValidate>
          <NewLoginFields errors={errors} username={actionData?.username} colour={actionData?.colour} />
          <SubmitButton
            pending={submitting}
            label="Create login"
            pendingLabel="Creating login…"
            className="btn-primary"
          />
        </Form>
      </main>
    </>
  );
}
