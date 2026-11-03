import { data, Form, redirect } from "react-router";

import { requireMember } from "~/auth/request";
import { FieldError } from "~/components/field-error";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { TopBar } from "~/components/top-bar";
import { createGroups, DEFAULT_THRESHOLD, MAX_GROUP_NAME_LENGTH } from "~/groups";
import { appContext } from "~/services";

import type { Route } from "./+types/groups.new";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Create a Group · Daily Check-in" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { colour } = requireMember(context);
  return { colour };
}

export async function action({ request, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const form = await request.formData();
  const result = await createGroups(context.get(appContext)).createGroup(member.id, String(form.get("name") ?? ""));
  if (!result.ok) return data({ error: result.error, name: result.name }, { status: 400 });
  return redirect("/", 303);
}

/** Create a Group: one name field. The Owner and threshold come from the server. */
export default function NewGroup({ loaderData, actionData }: Route.ComponentProps) {
  const submitting = useSubmitting();
  const error = actionData?.error;
  return (
    <>
      <TopBar back colour={loaderData.colour} />
      <main className="page">
        <h1>Create a Group</h1>
        <Form method="post" className="page-form" noValidate>
          <div className="field">
            <label className="field-label" htmlFor="name">Group name</label>
            <input
              className="field-input"
              id="name"
              name="name"
              autoComplete="off"
              required
              defaultValue={actionData?.name}
              aria-invalid={error ? true : undefined}
              aria-describedby="name-help"
            />
            {error ? (
              <FieldError id="name-help">{error}</FieldError>
            ) : (
              <p id="name-help" className="field-hint">
                1 to {MAX_GROUP_NAME_LENGTH} characters. Emoji are fine.
              </p>
            )}
          </div>
          <p className="group-new-note">
            You become the Owner. The Group is Game On when {DEFAULT_THRESHOLD} people say Yes.
          </p>
          <SubmitButton
            pending={submitting}
            label="Create Group"
            pendingLabel="Creating Group…"
            className="btn-primary"
          />
        </Form>
      </main>
    </>
  );
}
