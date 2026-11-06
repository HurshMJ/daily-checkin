import { data, Form, Link, redirect, useNavigation, useSubmit } from "react-router";

import { authFor, requireMember } from "~/auth/request";
import { createCheckins, isAvailability, MAX_NOTE_LENGTH, type OwnCheckin } from "~/checkins";
import { Board, boardHeadingId } from "~/components/board";
import { CheckinTiles } from "~/components/checkin-tiles";
import { FieldError } from "~/components/field-error";
import { Notice } from "~/components/notice";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { TopBar } from "~/components/top-bar";
import { parseGroupId } from "~/groups";
import { appContext } from "~/services";

import type { Route } from "./+types/home";

export const PASSWORD_RESET_NOTICE = "If you did not ask for this, tell your Group's Owner.";

export const SAVE_FAILED_MESSAGE = "Your answer did not save. The Board still shows your last saved answer.";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tonight · Daily Check-in" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const member = requireMember(context);
  const [tonight, passwordWasReset] = await Promise.all([
    createCheckins(context.get(appContext)).tonightFor(member.id),
    // Shown once: the first Tonight after a Password Reset Link set the password.
    member.passwordWasReset ? authFor(context).takePasswordResetNotice(member.id) : false,
  ]);
  return { colour: member.colour, memberId: member.id, passwordWasReset, ...tonight };
}

const notFound = () => data("Not found", { status: 404 });

/**
 * Tonight's one action. The form's intent field says which save it is:
 * "availability" sets Yes, Maybe or No; "note" sets or removes the Note. The
 * groupId field names the Group whose Board the form is on. Any other
 * intent, or none, and a groupId that is not a positive integer are refused
 * with 400; a Group the Member is not in now gets 404. Neither writes
 * anything.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const form = await request.formData();
  const checkins = createCheckins(context.get(appContext));

  const intent = form.get("intent");
  const groupId = parseGroupId(String(form.get("groupId") ?? ""));
  if ((intent !== "note" && intent !== "availability") || groupId === null) {
    return data({ intent: null, groupId: null }, { status: 400 });
  }

  if (intent === "note") {
    const note = String(form.get("note") ?? "");
    let result;
    try {
      result = await checkins.setNote(member.id, groupId, note);
    } catch (error) {
      console.error("Saving a Note failed", error);
      return data({ intent: "note" as const, groupId, failed: true as const, error: null, note }, { status: 503 });
    }
    if (!result.ok && result.notMember) throw notFound();
    if (!result.ok) {
      return data({ intent: "note" as const, groupId, failed: false as const, error: result.error, note }, { status: 400 });
    }
    return redirect("/", 303);
  }

  const availability = form.get("availability");
  if (!isAvailability(availability)) {
    return data({ intent: "availability" as const, groupId, availability: null }, { status: 400 });
  }
  let result;
  try {
    result = await checkins.setAvailability(member.id, groupId, availability);
  } catch (error) {
    console.error("Saving an Availability failed", error);
    return data({ intent: "availability" as const, groupId, availability }, { status: 503 });
  }
  if (!result.ok) throw notFound();
  return redirect("/", 303);
}

/**
 * Tonight: every Board the Member is on, each with the Member's own answer
 * and Note for that Group. A Member in no Group sees the empty state.
 */
export default function Tonight({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const submitting = useSubmitting();

  if (loaderData.boards.length === 0) {
    return (
      <>
        <TopBar colour={loaderData.colour} />
        <main className="page">
          <h1>Tonight</h1>
          <PasswordResetNotice shown={loaderData.passwordWasReset} />
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

  // The form being posted, if any, and the action's answer, belong to one Board.
  const pending = submitting ? navigation.formData : undefined;
  const settled = submitting ? undefined : actionData;

  return (
    <>
      <TopBar colour={loaderData.colour} />
      <main className="page">
        <h1>Tonight</h1>
        <PasswordResetNotice shown={loaderData.passwordWasReset} />
        {loaderData.boards.map((board) => (
          <Board key={board.groupId} board={board} viewerId={loaderData.memberId}>
            <BoardAnswer
              groupId={board.groupId}
              own={board.own}
              pending={pending?.get("groupId") === String(board.groupId) ? pending : undefined}
              result={settled?.groupId === board.groupId ? settled : undefined}
            />
          </Board>
        ))}
      </main>
    </>
  );
}

type ActionResult = Route.ComponentProps["actionData"];

/**
 * The Member's answer controls on one Board: the tiles, the failure Notices
 * with Try again, and the Note. `pending` is the form being posted for this
 * Board and `result` the action's answer for it, so a save on one Board
 * never shows as saving or failed on another. Every control is described by
 * the Board heading, so assistive technology names the Group.
 */
function BoardAnswer({
  groupId,
  own,
  pending,
  result,
}: {
  groupId: number;
  own: OwnCheckin | null;
  pending: FormData | undefined;
  result: ActionResult;
}) {
  const submit = useSubmit();
  const headingId = boardHeadingId(groupId);
  const pendingIntent = pending?.get("intent");
  const pendingAvailability = pendingIntent === "availability" ? pending?.get("availability") : null;
  const failedAnswer = result?.intent === "availability" ? result : null;
  const noteResult = result?.intent === "note" ? result : null;
  const failedNote = noteResult?.failed ? noteResult : null;
  const group = String(groupId);

  return (
    <div className="checkin">
      <Form method="post" className="checkin-form">
        <input type="hidden" name="intent" value="availability" />
        <input type="hidden" name="groupId" value={group} />
        <CheckinTiles
          chosen={own?.availability ?? null}
          pending={isAvailability(pendingAvailability) ? pendingAvailability : null}
          describedBy={headingId}
        />
      </Form>
      {failedAnswer ? (
        <Notice
          tone="error"
          title="Can't save your answer"
          retry={
            failedAnswer.availability
              ? () =>
                  submit(
                    { intent: "availability", groupId: group, availability: failedAnswer.availability! },
                    { method: "post" },
                  )
              : undefined
          }
        >
          {SAVE_FAILED_MESSAGE}
        </Notice>
      ) : null}
      {failedNote ? (
        <Notice
          tone="error"
          title="Can't save your Note"
          retry={() => submit({ intent: "note", groupId: group, note: failedNote.note }, { method: "post" })}
        >
          {SAVE_FAILED_MESSAGE}
        </Notice>
      ) : null}
      <NoteForm
        groupId={groupId}
        answered={own !== null}
        saved={own?.note ?? null}
        error={noteResult?.error ?? null}
        typed={noteResult?.note ?? null}
        pending={pendingIntent === "note"}
      />
    </div>
  );
}

/** The fixed notice for a Member whose password a Password Reset Link set since they last saw Tonight. */
function PasswordResetNotice({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <Notice tone="warning" title="Your password was reset">
      {PASSWORD_RESET_NOTICE}
    </Notice>
  );
}

/**
 * One Board's Note field and its Save button, disabled until the Member has
 * answered in that Group. Its ids carry the Group id, so several Boards on
 * one page never share an id, and the field is described by the Board
 * heading as well as its hint. The server's 140-code-point rule is the
 * authority; the field sets no maxLength, which counts UTF-16 units and would
 * cut emoji Notes short.
 */
function NoteForm({
  groupId,
  answered,
  saved,
  error,
  typed,
  pending,
}: {
  groupId: number;
  answered: boolean;
  saved: string | null;
  error: string | null;
  typed: string | null;
  pending: boolean;
}) {
  const inputId = `note-${groupId}`;
  const helpId = `note-help-${groupId}`;
  return (
    <Form method="post" className="checkin-note">
      <input type="hidden" name="intent" value="note" />
      <input type="hidden" name="groupId" value={String(groupId)} />
      <label className="field-label" htmlFor={inputId}>
        Note
      </label>
      <div className="checkin-note-row">
        <input
          // A new saved Note resets the field to it.
          key={saved ?? ""}
          className="field-input"
          id={inputId}
          name="note"
          autoComplete="off"
          disabled={!answered}
          defaultValue={typed ?? saved ?? ""}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${helpId} ${boardHeadingId(groupId)}`}
        />
        <SubmitButton
          pending={pending}
          label="Save"
          pendingLabel="Saving…"
          className="btn-secondary"
          disabled={!answered}
          aria-describedby={boardHeadingId(groupId)}
        />
      </div>
      {error ? (
        <FieldError id={helpId}>{error}</FieldError>
      ) : (
        <p id={helpId} className="field-hint">
          {answered ? `Up to ${MAX_NOTE_LENGTH} characters, like “on after 10”.` : "Answer first, then add a Note."}
        </p>
      )}
    </Form>
  );
}
