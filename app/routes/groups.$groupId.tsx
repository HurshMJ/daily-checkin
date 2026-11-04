import { useRef, useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";

import { requireMember } from "~/auth/request";
import { AvatarDot } from "~/components/avatar-dot";
import { FieldError } from "~/components/field-error";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { isConfirmed, TapAgainButton } from "~/components/tap-again-button";
import { ThresholdStepper } from "~/components/threshold-stepper";
import { TopBar } from "~/components/top-bar";
import { zoneDayTime } from "~/game-night";
import { createGroups, MAX_GROUP_NAME_LENGTH, MAX_THRESHOLD, MIN_THRESHOLD, parseGroupId } from "~/groups";
import { createInvites, MAX_INVITE_LABEL_LENGTH } from "~/invites";
import { appContext } from "~/services";

import type { Route } from "./+types/groups.$groupId";

// A new Invite link appears in the page: never send it on, never cache it.
export function headers(_: Route.HeadersArgs) {
  return { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.group.name ?? "Group"} · Daily Check-in` }];
}

const notFound = () => data("Not found", { status: 404 });

/** The Group, for one of its Members; anyone else gets the 404 a missing Group gets. */
async function memberGroup(context: Route.LoaderArgs["context"], memberId: number, rawId: string) {
  const groupId = parseGroupId(rawId);
  if (groupId === null) return null;
  return createGroups(context.get(appContext)).groupFor(memberId, groupId);
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const member = requireMember(context);
  const group = await memberGroup(context, member.id, params.groupId);
  if (!group) throw notFound();
  const pending = await createInvites(context.get(appContext)).pendingInvites(member.id, group.id);
  return {
    colour: member.colour,
    isOwner: group.ownerId === member.id,
    group,
    invites:
      pending?.map((invite) => ({
        id: invite.id,
        text: invite.label ?? `Made ${zoneDayTime(new Date(invite.createdAt))}`,
      })) ?? null,
  };
}

/** The Owner actions that sit behind a TapAgainButton. */
const DESTRUCTIVE = ["hand-over", "remove", "delete"] as const;
type Destructive = (typeof DESTRUCTIVE)[number];

function isDestructive(intent: unknown): intent is Destructive {
  return (DESTRUCTIVE as readonly unknown[]).includes(intent);
}

/** Which tap-again button a first tap without JavaScript armed: "delete", or the intent and the Member's id. */
function armedKey(intent: Destructive, memberId: number | null): string {
  return memberId === null ? intent : `${intent}-${memberId}`;
}

/**
 * The Owner's actions. The intent field says which: "make" makes an Invite
 * and shows its link once; "cancel" cancels the pending Invite `inviteId`;
 * "rename" and "threshold" change the basics; "hand-over" (Make Owner) and
 * "remove" act on the Member `memberId`; "delete" deletes the Group. The last
 * three act only when the tap-again button confirmed them; an unconfirmed
 * post changes nothing and returns the page with that button armed. Anyone
 * but the Group's current Owner gets 403; an unknown intent gets 400.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const group = await memberGroup(context, member.id, params.groupId);
  if (!group) throw notFound();
  const app = context.get(appContext);
  const invites = createInvites(app);
  const groups = createGroups(app);
  const form = await request.formData();
  const intent = form.get("intent");
  const forbidden = () => data({ intent: null, error: "Only the Owner can do that." }, { status: 403 });
  const back = () => redirect(`/groups/${group.id}`, 303);
  /** A refused Owner change: 403 for a non-Owner, the 404 a missing Group gets once the Member is out. */
  const refused = (reason: "not-owner" | "not-member") => {
    if (reason === "not-member") throw notFound();
    return forbidden();
  };

  if (intent === "make") {
    const label = String(form.get("label") ?? "");
    const made = await invites.makeInvite(member.id, group.id, label);
    if (!made.ok) {
      if (made.reason === "not-owner") return forbidden();
      return data({ intent: "make" as const, error: made.error, label }, { status: 400 });
    }
    const link = `${new URL(request.url).origin}/invite/${made.token}`;
    return { intent: "make" as const, link };
  }

  if (intent === "cancel") {
    const inviteId = Number(form.get("inviteId"));
    if (!Number.isSafeInteger(inviteId)) return data({ intent: null }, { status: 400 });
    const cancelled = await invites.cancelInvite(member.id, group.id, inviteId);
    if (!cancelled.ok && cancelled.reason === "not-owner") return forbidden();
    // A used or already-cancelled Invite simply drops out of the list.
    return back();
  }

  if (intent === "rename" || intent === "threshold") {
    const field = intent === "rename" ? ("rename" as const) : ("threshold" as const);
    const value = String(form.get(field === "rename" ? "name" : "threshold") ?? "");
    const changed =
      field === "rename"
        ? await groups.rename(member.id, group.id, value)
        : await groups.setThreshold(member.id, group.id, value);
    if (changed.ok) return back();
    if (changed.reason === "invalid") return data({ intent: field, error: changed.error, value }, { status: 400 });
    return refused(changed.reason);
  }

  if (isDestructive(intent)) {
    if (group.ownerId !== member.id) return forbidden();
    const target = intent === "delete" ? null : Number(form.get("memberId"));
    if (target !== null && !Number.isSafeInteger(target)) return data({ intent: null }, { status: 400 });
    if (!isConfirmed(form)) return { intent, armed: armedKey(intent, target) };

    const changed =
      target === null
        ? await groups.deleteGroup(member.id, group.id)
        : intent === "remove"
          ? await groups.remove(member.id, group.id, target)
          : await groups.handOver(member.id, group.id, target);
    if (changed.ok) return target === null ? redirect("/", 303) : back();
    // An invalid target, such as a Member who has already left, simply drops out of the list.
    return changed.reason === "invalid" ? back() : refused(changed.reason);
  }

  return data({ intent: null }, { status: 400 });
}

/** The posted form of the submission in flight on this page, if any. */
function usePendingForm(): FormData | null {
  const navigation = useNavigation();
  return useSubmitting() ? (navigation.formData ?? null) : null;
}

type ActionData = Route.ComponentProps["actionData"];

/** The failed rename or threshold post, for its field error and the typed value. */
function failedField(actionData: ActionData, intent: "rename" | "threshold") {
  return actionData?.intent === intent && "error" in actionData ? actionData : null;
}

/**
 * The Group page. The Owner gets cards for the basics (rename and the
 * threshold stepper), the Members (each with Manage), the Invites and the
 * Owner actions. Any other Member sees the same page read-only: the name,
 * "Game On at N Yes" and the Members with the Owner tag. Leaving is on the
 * profile.
 */
export default function Group({ loaderData, actionData }: Route.ComponentProps) {
  const { group, invites, isOwner } = loaderData;
  const count = group.members.length;
  const armed = (actionData && "armed" in actionData ? actionData.armed : null) ?? null;
  const pendingForm = usePendingForm();
  return (
    <>
      <TopBar back colour={loaderData.colour} />
      <main className="page">
        <header className="group-header">
          <h1>{group.name}</h1>
          <p className="group-count">{count === 1 ? "1 Member" : `${count} Members`}</p>
        </header>
        {isOwner ? (
          <OwnerBasics group={group} actionData={actionData} pendingForm={pendingForm} />
        ) : (
          <section className="card" aria-labelledby="basics-heading">
            <h2 id="basics-heading">Basics</h2>
            <dl className="group-basics">
              <dt>Name</dt>
              <dd>{group.name}</dd>
              <dt>Game On Threshold</dt>
              <dd>Game On at {group.threshold} Yes</dd>
            </dl>
          </section>
        )}
        <section className="card" aria-labelledby="members-heading">
          <h2 id="members-heading">Members</h2>
          <ul className="list">
            {group.members.map((member) => {
              const manage = isOwner && member.id !== group.ownerId;
              const nameId = manage ? `member-${member.id}-name` : undefined;
              return (
                <li key={member.id} className="list-tile">
                  <AvatarDot colour={member.colour} />
                  <span className="list-tile-text">
                    <span className="list-tile-name" id={nameId}>
                      {member.shownName}
                    </span>
                    <span className="list-tile-detail">@{member.username}</span>
                  </span>
                  {member.id === group.ownerId ? <span className="list-tile-tag">Owner</span> : null}
                  {manage ? (
                    <Manage
                      member={member}
                      nameId={nameId!}
                      armed={armed}
                      pendingIntent={pendingForm?.get("memberId") === String(member.id) ? pendingForm.get("intent") : null}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
        {invites ? (
          <InvitesCard
            invites={invites}
            made={(actionData && "link" in actionData ? actionData.link : null) ?? null}
            failed={actionData?.intent === "make" && "error" in actionData ? actionData : null}
          />
        ) : null}
        {isOwner ? (
          <section className="card" aria-labelledby="owner-actions-heading">
            <h2 id="owner-actions-heading">Owner actions</h2>
            <Form method="post" className="card-action">
              <input type="hidden" name="intent" value="delete" />
              <TapAgainButton
                pending={pendingForm?.get("intent") === "delete"}
                label="Delete Group"
                confirmLabel={`Tap again to delete ${group.name} for everyone`}
                pendingLabel="Deleting Group…"
                armed={armed === "delete"}
              />
              <p className="card-hint">Deletes the Group, its Board and its History for every Member.</p>
            </Form>
          </section>
        ) : null}
      </main>
    </>
  );
}

function OwnerBasics({
  group,
  actionData,
  pendingForm,
}: {
  group: { name: string; threshold: number };
  actionData: ActionData;
  pendingForm: FormData | null;
}) {
  const rename = failedField(actionData, "rename");
  const threshold = failedField(actionData, "threshold");
  const pendingIntent = pendingForm?.get("intent");
  // The stepper's buttons post a value; the typed field's form has its own pending state.
  const stepping = pendingIntent === "threshold" && pendingForm?.get("typed") !== "yes";
  return (
    <section className="card" aria-labelledby="basics-heading">
      <h2 id="basics-heading">Basics</h2>
      {/* A new key after each change shows the saved value in the field. */}
      <Form method="post" className="page-form" noValidate key={`name-${group.name}`}>
        <input type="hidden" name="intent" value="rename" />
        <div className="field">
          <label className="field-label" htmlFor="group-name">Group name</label>
          <input
            className="field-input"
            id="group-name"
            name="name"
            autoComplete="off"
            required
            defaultValue={rename?.value ?? group.name}
            aria-invalid={rename ? true : undefined}
            aria-describedby="group-name-help"
          />
          {rename ? (
            <FieldError id="group-name-help">{rename.error}</FieldError>
          ) : (
            <p id="group-name-help" className="field-hint">
              1 to {MAX_GROUP_NAME_LENGTH} characters. Emoji are fine.
            </p>
          )}
        </div>
        <SubmitButton
          pending={pendingIntent === "rename"}
          label="Save name"
          pendingLabel="Saving name…"
          className="btn-secondary"
        />
      </Form>
      <div className="field">
        <p className="field-label">Game On Threshold</p>
        <ThresholdStepper
          threshold={group.threshold}
          pendingValue={stepping ? String(pendingForm?.get("threshold")) : null}
        />
        <p className="field-hint">The Group is Game On when this many Members say Yes.</p>
      </div>
      <Form method="post" className="page-form" noValidate key={`threshold-${group.threshold}`}>
        <input type="hidden" name="intent" value="threshold" />
        <input type="hidden" name="typed" value="yes" />
        <div className="field">
          <label className="field-label" htmlFor="threshold">Or type the threshold</label>
          <input
            className="field-input"
            id="threshold"
            name="threshold"
            inputMode="numeric"
            autoComplete="off"
            required
            defaultValue={threshold?.value ?? String(group.threshold)}
            aria-invalid={threshold ? true : undefined}
            aria-describedby="threshold-help"
          />
          {threshold ? (
            <FieldError id="threshold-help">{threshold.error}</FieldError>
          ) : (
            <p id="threshold-help" className="field-hint">
              A whole number from {MIN_THRESHOLD} to {MAX_THRESHOLD}.
            </p>
          )}
        </div>
        <SubmitButton
          pending={pendingIntent === "threshold" && !stepping}
          label="Set threshold"
          pendingLabel="Setting threshold…"
          className="btn-secondary"
        />
      </Form>
    </section>
  );
}

/**
 * Manage on a Member's tile: a disclosure, so it works without JavaScript,
 * that reveals Make Owner and Remove, each behind a tap-again button. It
 * opens by itself when the server sends back one of its buttons armed.
 */
function Manage({
  member,
  nameId,
  armed,
  pendingIntent,
}: {
  member: { id: number; shownName: string };
  nameId: string;
  armed: string | null;
  pendingIntent: FormDataEntryValue | null;
}) {
  const handOverKey = armedKey("hand-over", member.id);
  const removeKey = armedKey("remove", member.id);
  return (
    <details className="manage" open={armed === handOverKey || armed === removeKey ? true : undefined}>
      <summary className="btn-small" aria-describedby={nameId}>
        Manage
      </summary>
      <div className="manage-actions">
        <Form method="post">
          <input type="hidden" name="intent" value="hand-over" />
          <input type="hidden" name="memberId" value={member.id} />
          <TapAgainButton
            pending={pendingIntent === "hand-over"}
            label="Make Owner"
            confirmLabel={`Tap again to make ${member.shownName} Owner`}
            pendingLabel="Making Owner…"
            armed={armed === handOverKey}
            describedBy={nameId}
          />
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="memberId" value={member.id} />
          <TapAgainButton
            pending={pendingIntent === "remove"}
            label="Remove"
            confirmLabel={`Tap again to remove ${member.shownName}`}
            pendingLabel="Removing…"
            armed={armed === removeKey}
            describedBy={nameId}
          />
        </Form>
      </div>
    </details>
  );
}

function InvitesCard({
  invites,
  made,
  failed,
}: {
  invites: { id: number; text: string }[];
  made: string | null;
  failed: { error: string; label: string } | null;
}) {
  const navigation = useNavigation();
  const submitting = useSubmitting();
  const pendingIntent = submitting ? navigation.formData?.get("intent") : null;
  const cancelling = pendingIntent === "cancel" ? navigation.formData?.get("inviteId") : null;
  return (
    <section className="card" aria-labelledby="invites-heading">
      <h2 id="invites-heading">Invites</h2>
      {/* A new key after each Invite empties the label field. */}
      <Form method="post" className="page-form" noValidate key={made ?? "invite"}>
        <input type="hidden" name="intent" value="make" />
        <div className="field">
          <label className="field-label" htmlFor="invite-label">Who is it for?</label>
          <input
            className="field-input"
            id="invite-label"
            name="label"
            autoComplete="off"
            defaultValue={failed?.label}
            aria-invalid={failed ? true : undefined}
            aria-describedby="invite-label-help"
          />
          {failed ? (
            <FieldError id="invite-label-help">{failed.error}</FieldError>
          ) : (
            <p id="invite-label-help" className="field-hint">
              Optional, only you see it. Up to {MAX_INVITE_LABEL_LENGTH} characters.
            </p>
          )}
        </div>
        <SubmitButton
          pending={pendingIntent === "make"}
          label="Make an Invite"
          pendingLabel="Making an Invite…"
          className="btn-primary"
        />
      </Form>
      {made ? <CopyBox link={made} /> : null}
      {invites.length === 0 ? (
        <p className="card-hint">No pending Invites.</p>
      ) : (
        <ul className="list" aria-label="Pending Invites">
          {invites.map((invite) => (
            <li key={invite.id} className="list-tile">
              <span className="list-tile-text">
                {/* The Invite's label or time gives each Cancel button its own description. */}
                <span className="list-tile-name" id={`invite-${invite.id}-name`}>
                  {invite.text}
                </span>
              </span>
              <Form method="post">
                <input type="hidden" name="intent" value="cancel" />
                <input type="hidden" name="inviteId" value={invite.id} />
                <SubmitButton
                  pending={cancelling === String(invite.id)}
                  label="Cancel"
                  pendingLabel="Cancelling…"
                  className="btn-small"
                  aria-describedby={`invite-${invite.id}-name`}
                />
              </Form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The new Invite link, shown once: a read-only field to select, and a Copy
 * button that uses the clipboard when the browser offers it and announces
 * the result in a status line.
 */
function CopyBox({ link }: { link: string }) {
  const [status, setStatus] = useState("");
  const field = useRef<HTMLInputElement>(null);
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(link);
      setStatus("Copied");
    } catch {
      field.current?.select();
      setStatus("Selected. Copy it from your browser's menu.");
    }
  }
  return (
    <div className="copy-box">
      <label className="field-label" htmlFor="invite-link">New Invite link</label>
      <div className="copy-box-row">
        <input
          ref={field}
          className="field-input"
          id="invite-link"
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          aria-describedby="invite-link-help"
        />
        <button type="button" className="btn-small" onClick={copy}>
          Copy
        </button>
      </div>
      <p id="invite-link-help" className="card-hint">
        It works once. Copy it now: this page will not show it again.
      </p>
      <p role="status" className="copy-box-status">
        {status}
      </p>
    </div>
  );
}
