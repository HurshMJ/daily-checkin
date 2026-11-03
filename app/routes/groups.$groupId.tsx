import { useRef, useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";

import { requireMember } from "~/auth/request";
import { AvatarDot } from "~/components/avatar-dot";
import { FieldError } from "~/components/field-error";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { TopBar } from "~/components/top-bar";
import { zoneDayTime } from "~/game-night";
import { createGroups } from "~/groups";
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
  const groupId = /^[1-9][0-9]{0,15}$/.test(rawId) ? Number(rawId) : Number.NaN;
  if (!Number.isSafeInteger(groupId)) return null;
  return createGroups(context.get(appContext)).groupFor(memberId, groupId);
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const member = requireMember(context);
  const group = await memberGroup(context, member.id, params.groupId);
  if (!group) throw notFound();
  const pending = await createInvites(context.get(appContext)).pendingInvites(member.id, group.id);
  return {
    colour: member.colour,
    group,
    invites:
      pending?.map((invite) => ({
        id: invite.id,
        text: invite.label ?? `Made ${zoneDayTime(new Date(invite.createdAt))}`,
      })) ?? null,
  };
}

/**
 * The Owner's Invite actions. The intent field says which: "make" makes an
 * Invite and shows its link once; "cancel" cancels the pending Invite
 * `inviteId`. Anyone but the Group's current Owner gets 403.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const group = await memberGroup(context, member.id, params.groupId);
  if (!group) throw notFound();
  const invites = createInvites(context.get(appContext));
  const form = await request.formData();
  const forbidden = () => data({ intent: null, error: "Only the Owner can do that." }, { status: 403 });

  if (form.get("intent") === "make") {
    const label = String(form.get("label") ?? "");
    const made = await invites.makeInvite(member.id, group.id, label);
    if (!made.ok) {
      if (made.reason === "not-owner") return forbidden();
      return data({ intent: "make" as const, error: made.error, label }, { status: 400 });
    }
    const link = `${new URL(request.url).origin}/invite/${made.token}`;
    return { intent: "make" as const, link };
  }

  if (form.get("intent") === "cancel") {
    const inviteId = Number(form.get("inviteId"));
    if (!Number.isSafeInteger(inviteId)) return data({ intent: null }, { status: 400 });
    const cancelled = await invites.cancelInvite(member.id, group.id, inviteId);
    if (!cancelled.ok && cancelled.reason === "not-owner") return forbidden();
    // A used or already-cancelled Invite simply drops out of the list.
    return redirect(`/groups/${group.id}`, 303);
  }

  return data({ intent: null }, { status: 400 });
}

/**
 * The Group page: its name and Member count, the read-only basics, the
 * Members, and for the Owner the Invites card. Ticket 20 adds rename, the
 * threshold stepper, Manage and the Owner actions.
 */
export default function Group({ loaderData, actionData }: Route.ComponentProps) {
  const { group, invites } = loaderData;
  const count = group.members.length;
  return (
    <>
      <TopBar back colour={loaderData.colour} />
      <main className="page">
        <header className="group-header">
          <h1>{group.name}</h1>
          <p className="group-count">{count === 1 ? "1 Member" : `${count} Members`}</p>
        </header>
        <section className="card" aria-labelledby="basics-heading">
          <h2 id="basics-heading">Basics</h2>
          <dl className="group-basics">
            <dt>Name</dt>
            <dd>{group.name}</dd>
            <dt>Game On Threshold</dt>
            <dd>Game On at {group.threshold} Yes</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="members-heading">
          <h2 id="members-heading">Members</h2>
          <ul className="list">
            {group.members.map((member) => (
              <li key={member.id} className="list-tile">
                <AvatarDot colour={member.colour} />
                <span className="list-tile-text">
                  {/* Ticket 24 adds Display Name; until then the shown name is the username. */}
                  <span className="list-tile-name">{member.username}</span>
                  <span className="list-tile-detail">@{member.username}</span>
                </span>
                {member.id === group.ownerId ? <span className="list-tile-tag">Owner</span> : null}
              </li>
            ))}
          </ul>
        </section>
        {invites ? (
          <InvitesCard
            invites={invites}
            made={actionData && "link" in actionData ? actionData.link : null}
            failed={actionData?.intent === "make" && "error" in actionData ? actionData : null}
          />
        ) : null}
      </main>
    </>
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
