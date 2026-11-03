import { data } from "react-router";

import { requireMember } from "~/auth/request";
import { BoardRows } from "~/components/board";
import { TopBar } from "~/components/top-bar";
import { isGameNight, nightLabel } from "~/game-night";
import { parseGroupId } from "~/groups";
import { createHistory, FINAL_STATE_LABELS, yesLine } from "~/history";
import { appContext } from "~/services";

import type { Route } from "./+types/groups.$groupId.history.$night";

const NO_ANSWER_PAST = "No answer";
const NOBODY_ANSWERED_PAST = "Nobody answered that night.";

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData ? `${nightLabel(loaderData.night.night)} · ${loaderData.night.groupName}` : "Past night";
  return [{ title: `${title} · Daily Check-in` }];
}

const notFound = () => data("Not found", { status: 404 });

/**
 * One past night's frozen Board for a current Member of the Group. A
 * malformed night, a night the Group has no History for, and anyone not in
 * the Group get the 404 a missing Group gets.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const member = requireMember(context);
  const groupId = parseGroupId(params.groupId);
  if (groupId === null || !isGameNight(params.night)) throw notFound();
  const night = await createHistory(context.get(appContext)).pastNight(member.id, groupId, params.night);
  if (!night) throw notFound();
  return { colour: member.colour, viewerId: member.id, groupId, night };
}

/**
 * A past night's page: the Group name above the date, then the frozen Board
 * in the Tonight Board look, with the final state and the Yes line in the
 * banner, and a line saying when it was frozen.
 */
export default function PastNightPage({ loaderData }: Route.ComponentProps) {
  const { night, groupId } = loaderData;
  return (
    <>
      <TopBar back={{ to: `/groups/${groupId}/history`, label: "History" }} colour={loaderData.colour} />
      <main className="page">
        <header className="page-header">
          <p className="page-context">{night.groupName}</p>
          <h1 id="night-heading">{nightLabel(night.night)}</h1>
        </header>
        <section className="card board" aria-labelledby="night-heading">
          <div className="board-banner" data-state={night.state}>
            <p className="board-pill">{FINAL_STATE_LABELS[night.state]}</p>
            <p className="board-count">{yesLine(night)}</p>
          </div>
          <BoardRows rows={night.rows} viewerId={loaderData.viewerId} noAnswer={NO_ANSWER_PAST} />
          {night.answered === 0 ? <p className="board-empty">{NOBODY_ANSWERED_PAST}</p> : null}
        </section>
        <p className="card-hint">Frozen as it stood at the Reset the next morning.</p>
      </main>
    </>
  );
}
