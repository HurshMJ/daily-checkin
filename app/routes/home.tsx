import { data, Form, Link, redirect, useNavigation, useSubmit } from "react-router";

import { requireMember } from "~/auth/request";
import { boardReachLine, createCheckins, isAvailability, MAX_NOTE_LENGTH } from "~/checkins";
import { Board } from "~/components/board";
import { CheckinTiles } from "~/components/checkin-tiles";
import { FieldError } from "~/components/field-error";
import { Notice } from "~/components/notice";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { TopBar } from "~/components/top-bar";
import { appContext } from "~/services";

import type { Route } from "./+types/home";

export const SAVE_FAILED_MESSAGE = "Your answer did not save. Your Boards still show your last saved answer.";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tonight · Daily Check-in" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const member = requireMember(context);
  const tonight = await createCheckins(context.get(appContext)).tonightFor(member.id);
  return { colour: member.colour, memberId: member.id, ...tonight };
}

/**
 * Tonight's one action. The form's intent field says which save it is:
 * "availability" sets Yes, Maybe or No; "note" sets or removes the Note.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const form = await request.formData();
  const checkins = createCheckins(context.get(appContext));

  if (form.get("intent") === "note") {
    const note = String(form.get("note") ?? "");
    const result = await checkins.setNote(member.id, note);
    if (!result.ok) return data({ intent: "note" as const, error: result.error, note }, { status: 400 });
    return redirect("/", 303);
  }

  const availability = form.get("availability");
  if (!isAvailability(availability)) {
    return data({ intent: "availability" as const, availability: null }, { status: 400 });
  }
  try {
    await checkins.setAvailability(member.id, availability);
  } catch (error) {
    console.error("Saving an Availability failed", error);
    return data({ intent: "availability" as const, availability }, { status: 503 });
  }
  return redirect("/", 303);
}

/** Tonight: the Member's answer and every Board they are on. A Member in no Group sees the empty state. */
export default function Tonight({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const submitting = useSubmitting();
  const submit = useSubmit();

  if (loaderData.boards.length === 0) {
    return (
      <>
        <TopBar colour={loaderData.colour} />
        <main className="page">
          <h1>Tonight</h1>
          <div className="card empty-state">
            <span className="empty-ring" aria-hidden="true" />
            <h2>You're not in a Group yet</h2>
            <p className="empty-hint">Create one and invite your friends, or open an Invite link a friend sent you.</p>
            <Link className="btn-primary" to="/groups/new">
              Create a Group
            </Link>
          </div>
        </main>
      </>
    );
  }

  const pendingIntent = submitting ? navigation.formData?.get("intent") : null;
  const pendingAvailability = pendingIntent === "availability" ? navigation.formData?.get("availability") : null;
  const own = loaderData.own;
  const failedAnswer = actionData?.intent === "availability" && !submitting ? actionData : null;
  const noteError = actionData?.intent === "note" && !submitting ? actionData : null;

  return (
    <>
      <TopBar colour={loaderData.colour} />
      <main className="page">
        <header className="tonight-header">
          <h1>Tonight</h1>
          <p className="tonight-reach">{boardReachLine(loaderData.boards.length)}</p>
        </header>
        <section className="card checkin" aria-label="Your answer">
          <Form method="post" className="checkin-form">
            <input type="hidden" name="intent" value="availability" />
            <CheckinTiles
              chosen={own?.availability ?? null}
              pending={isAvailability(pendingAvailability) ? pendingAvailability : null}
            />
          </Form>
          {failedAnswer ? (
            <Notice
              tone="error"
              title="Can't save your answer"
              retry={
                failedAnswer.availability
                  ? () => submit({ intent: "availability", availability: failedAnswer.availability! }, { method: "post" })
                  : undefined
              }
            >
              {SAVE_FAILED_MESSAGE}
            </Notice>
          ) : null}
          <NoteForm
            answered={own !== null}
            saved={own?.note ?? null}
            error={noteError?.error ?? null}
            typed={noteError?.note ?? null}
            pending={pendingIntent === "note"}
          />
        </section>
        {loaderData.boards.map((board) => (
          <Board key={board.groupId} board={board} viewerId={loaderData.memberId} />
        ))}
      </main>
    </>
  );
}

/**
 * The Note field and its Save button, disabled until the Member has answered.
 * The server's 140-code-point rule is the authority; the field sets no
 * maxLength, which counts UTF-16 units and would cut emoji Notes short.
 */
function NoteForm({
  answered,
  saved,
  error,
  typed,
  pending,
}: {
  answered: boolean;
  saved: string | null;
  error: string | null;
  typed: string | null;
  pending: boolean;
}) {
  return (
    <Form method="post" className="checkin-note">
      <input type="hidden" name="intent" value="note" />
      <label className="field-label" htmlFor="note">
        Note
      </label>
      <div className="checkin-note-row">
        <input
          // A new saved Note resets the field to it.
          key={saved ?? ""}
          className="field-input"
          id="note"
          name="note"
          autoComplete="off"
          disabled={!answered}
          defaultValue={typed ?? saved ?? ""}
          aria-invalid={error ? true : undefined}
          aria-describedby="note-help"
        />
        <SubmitButton
          pending={pending}
          label="Save"
          pendingLabel="Saving…"
          className="btn-secondary"
          disabled={!answered}
        />
      </div>
      {error ? (
        <FieldError id="note-help">{error}</FieldError>
      ) : (
        <p id="note-help" className="field-hint">
          {answered ? `Up to ${MAX_NOTE_LENGTH} characters, like “on after 10”.` : "Answer first, then add a Note."}
        </p>
      )}
    </Form>
  );
}
