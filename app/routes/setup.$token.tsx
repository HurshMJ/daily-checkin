import { data, Form, redirect } from "react-router";

import { AVATAR_COLOUR_NAMES, AVATAR_COLOURS } from "~/auth/palette";
import { authFor, sessionCookie } from "~/auth/request";
import { type NewLoginErrors, normaliseUsername, validateNewLogin } from "~/auth/rules";
import { AvatarDot } from "~/components/avatar-dot";

import type { Route } from "./+types/setup.$token";

export const UNUSABLE_LINK_MESSAGE =
  "This Setup Link does not work. It may be used, replaced or more than an hour old. Ask the Operator for a new one.";

// The token is in the URL: never send it on to another site, never cache it.
export function headers(_: Route.HeadersArgs) {
  return { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Create your login · Daily Check-in" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const usable = await authFor(context).setupLinkIsUsable(params.token);
  return data({ usable }, { status: usable ? 200 : 404 });
}

interface ActionResult {
  usable: boolean;
  errors: NewLoginErrors;
  username: string;
  colour: string;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const auth = authFor(context);
  const form = await request.formData();
  const echo = {
    username: normaliseUsername(String(form.get("username") ?? "")),
    colour: String(form.get("colour") ?? ""),
  };

  if (!(await auth.setupLinkIsUsable(params.token))) {
    return data<ActionResult>({ usable: false, errors: {}, ...echo }, { status: 404 });
  }
  const checked = validateNewLogin(form);
  if (!checked.ok) {
    return data<ActionResult>({ usable: true, errors: checked.errors, ...echo }, { status: 400 });
  }

  const result = await auth.createLoginFromSetupLink(params.token, checked.value);
  if (!result.ok) {
    const usable = result.reason !== "link-unusable";
    const errors = usable ? { username: "That username is taken." } : {};
    return data<ActionResult>({ usable, errors, ...echo }, { status: usable ? 400 : 404 });
  }
  return redirect("/", { headers: { "Set-Cookie": sessionCookie(result.sessionToken) } });
}

export default function SetupLink({ loaderData, actionData }: Route.ComponentProps) {
  const usable = actionData?.usable ?? loaderData?.usable ?? false;
  const errors = actionData?.errors ?? {};

  if (!usable) {
    return (
      <main className="page">
        <header className="setup-header">
          <h1>Create your login</h1>
        </header>
        <div className="notice-error" role="alert">
          <p>{UNUSABLE_LINK_MESSAGE}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="setup-header">
        <h1>Create your login</h1>
        <p className="setup-note">This link works once and expires an hour after it was made.</p>
      </header>
      <Form method="post" className="page-form" noValidate>
        <div className="field">
          <label className="field-label" htmlFor="username">Username</label>
          <input
            className="field-input"
            id="username"
            name="username"
            autoComplete="username"
            required
            defaultValue={actionData?.username}
            aria-invalid={errors.username ? true : undefined}
            aria-describedby="username-help"
          />
          <p id="username-help" className={errors.username ? "field-error" : "field-hint"}>
            {errors.username ?? "3 to 32 characters. Spaces and symbols are fine."}
          </p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="password">Password</label>
          <input
            className="field-input"
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={errors.password ? true : undefined}
            aria-describedby="password-help"
          />
          <p id="password-help" className={errors.password ? "field-error" : "field-hint"}>
            {errors.password ?? "12 to 128 characters. A phrase with spaces works well."}
          </p>
        </div>
        <fieldset className="picker" aria-describedby={errors.colour ? "colour-error" : undefined}>
          <legend className="picker-legend">Avatar colour</legend>
          {AVATAR_COLOUR_NAMES.map((name) => (
            <label key={name} className="picker-tile">
              <input
                className="picker-input"
                type="radio"
                name="colour"
                value={name}
                required
                defaultChecked={actionData?.colour === name}
              />
              <AvatarDot colour={name} />
              {AVATAR_COLOURS[name].label}
            </label>
          ))}
          {errors.colour ? (
            <p id="colour-error" className="field-error">
              {errors.colour}
            </p>
          ) : null}
        </fieldset>
        <button className="btn-primary" type="submit">Create login</button>
      </Form>
    </main>
  );
}
