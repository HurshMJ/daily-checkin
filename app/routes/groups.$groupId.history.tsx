import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";

import { requireMember } from "~/auth/request";
import { AvatarDot } from "~/components/avatar-dot";
import { PastNightTile } from "~/components/past-night-tile";
import { SubmitButton } from "~/components/submit-button";
import { TopBar } from "~/components/top-bar";
import { isGameNight } from "~/game-night";
import { parseGroupId } from "~/groups";
import { createHistory, type PastNightSummary, YES_COUNT_NIGHTS, type YesCount } from "~/history";
import { appContext } from "~/services";

import type { Route } from "./+types/groups.$groupId.history";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `History · ${loaderData?.groupName ?? "Group"} · Daily Check-in` }];
}

const notFound = () => data("Not found", { status: 404 });

/**
 * A Group's History for one of its current Members: the Yes-count table and
 * a page of past nights, newest first. `?before=<night>` starts the page
 * below that night. Anyone else, or a malformed cursor, gets the 404 a
 * missing Group gets.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const member = requireMember(context);
  const groupId = parseGroupId(params.groupId);
  const before = new URL(request.url).searchParams.get("before");
  if (groupId === null || (before !== null && !isGameNight(before))) throw notFound();
  const page = await createHistory(context.get(appContext)).historyPage(member.id, groupId, before);
  if (!page) throw notFound();
  return { colour: member.colour, groupId, before, ...page };
}

/**
 * The History page: the Group name above the heading, the "Who usually
 * shows up" card, then the past nights.
 */
export default function History({ loaderData }: Route.ComponentProps) {
  const { groupId, groupName } = loaderData;
  return (
    <>
      <TopBar back colour={loaderData.colour} />
      <main className="page">
        <header className="page-header">
          <p className="page-context">{groupName}</p>
          <h1>History</h1>
        </header>
        <YesCounts counts={loaderData.yesCounts} />
        {/* A new key per starting cursor drops nights appended to another page. */}
        <PastNights
          key={loaderData.before ?? ""}
          groupId={groupId}
          first={loaderData.nights}
          older={loaderData.older}
        />
      </main>
    </>
  );
}

/**
 * The Yes-count table as a bar list: each current Member's Yes answers over
 * the counted nights, as "Yes 21 of 30", with a decorative bar filled to
 * the share. The text carries the number; the bar is hidden from assistive
 * technology.
 */
function YesCounts({ counts }: { counts: YesCount[] }) {
  return (
    <section className="card" aria-labelledby="yes-counts-heading">
      <h2 id="yes-counts-heading">Who usually shows up</h2>
      <p className="card-hint">
        Yes answers over the last {YES_COUNT_NIGHTS} nights, counting only nights each Member was in the Group.
      </p>
      <ul className="yes-counts">
        {counts.map((count) => (
          <li key={count.memberId} className="yes-count">
            <AvatarDot colour={count.colour} />
            <span className="yes-count-name">{count.shownName}</span>
            <span className="yes-count-number">
              {count.nights === 0 ? (
                "No nights yet"
              ) : (
                <>
                  Yes {count.yes} <span className="yes-count-of">of {count.nights}</span>
                </>
              )}
            </span>
            <svg
              className="yes-count-bar"
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <rect className="yes-count-fill" width={count.nights === 0 ? 0 : (100 * count.yes) / count.nights} height="10" />
            </svg>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The past nights, newest first, and "Show older nights" while older ones
 * exist. The button is a GET form: without JavaScript it loads the page
 * that starts at the cursor; with JavaScript a fetcher loads that page and
 * appends its nights in place.
 */
function PastNights({
  groupId,
  first,
  older,
}: {
  groupId: number;
  first: PastNightSummary[];
  older: string | null;
}) {
  const fetcher = useFetcher<typeof loader>();
  const [shown, setShown] = useState({ nights: first, older });

  useEffect(() => {
    const page = fetcher.data;
    if (!page) return;
    setShown((current) => {
      const oldest = current.nights.at(-1)?.night;
      // Only nights older than the last one shown, so a repeated load appends nothing twice.
      const fresh = page.nights.filter((night) => oldest === undefined || night.night < oldest);
      return { nights: [...current.nights, ...fresh], older: page.older };
    });
  }, [fetcher.data]);

  return (
    <section className="history-nights" aria-labelledby="past-nights-heading">
      <h2 id="past-nights-heading">Past nights</h2>
      {shown.nights.length === 0 ? (
        <p className="card-hint">No past nights yet. Each night joins History at the Reset the next morning.</p>
      ) : (
        <ul className="past-nights">
          {shown.nights.map((night) => (
            <PastNightTile key={night.night} groupId={groupId} night={night} />
          ))}
        </ul>
      )}
      {shown.older ? (
        <fetcher.Form method="get" action={`/groups/${groupId}/history`}>
          <input type="hidden" name="before" value={shown.older} />
          <SubmitButton
            pending={fetcher.state !== "idle"}
            label="Show older nights"
            pendingLabel="Loading older nights…"
            className="btn-secondary"
          />
        </fetcher.Form>
      ) : null}
    </section>
  );
}
