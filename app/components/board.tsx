import { Link } from "react-router";

import { AVAILABILITY_LABELS, type Board as BoardData, type BoardRow } from "~/checkins";

import { AvatarDot } from "./avatar-dot";

export const NO_ANSWER = "No answer yet";
export const NOBODY_ANSWERED = "Nobody has answered yet tonight.";

/**
 * One Group's Board for tonight: a banner with the pill and the Yes count,
 * the Group name, then one row per Member in Board order. The viewer's own
 * row reads "You", and the Board ends with its links: the Group page and its
 * History. Rows and the banner reach the CSS through data-availability and
 * data-state.
 */
export function Board({ board, viewerId }: { board: BoardData; viewerId: number }) {
  const headingId = `board-${board.groupId}`;
  const nobodyAnswered = board.rows.every((row) => row.availability === null);
  return (
    <section className="card board" aria-labelledby={headingId}>
      <div className="board-banner" data-state={board.pill.state}>
        <p className="board-pill">{board.pill.text}</p>
        <p className="board-count">
          {board.yes} of {board.threshold} Yes so far
        </p>
      </div>
      <h2 id={headingId} className="board-name">
        {board.name}
      </h2>
      <BoardRows rows={board.rows} viewerId={viewerId} noAnswer={NO_ANSWER} />
      {nobodyAnswered ? <p className="board-empty">{NOBODY_ANSWERED}</p> : null}
      <p className="board-links">
        {/* The Group name gives each Board's links their own description. */}
        <Link to={`/groups/${board.groupId}`} aria-describedby={headingId}>
          Group
        </Link>
        <Link to={`/groups/${board.groupId}/history`} aria-describedby={headingId}>
          History
        </Link>
      </p>
    </section>
  );
}

/**
 * A Board's rows, already in Board order, tonight's or a past night's. Each
 * row starts with the Member's avatar dot. The viewer's own row reads "You";
 * every other row shows the Shown name as a disclosure that reveals
 * "@username" when tapped, with no JavaScript. A row without a Check-in reads
 * `noAnswer`; a row marked `left` names a Member who has since left the Group.
 */
export function BoardRows({
  rows,
  viewerId,
  noAnswer,
}: {
  rows: readonly (BoardRow & { left?: boolean })[];
  viewerId: number;
  noAnswer: string;
}) {
  return (
    <ul className="board-rows">
      {rows.map((row) => (
        <li key={row.memberId} className="board-row" data-availability={row.availability ?? "none"}>
          <div className="board-row-who">
            <AvatarDot colour={row.colour} />
            {row.memberId === viewerId ? (
              <span className="board-row-name">You</span>
            ) : (
              <details className="board-row-reveal">
                <summary className="board-row-name">{row.shownName}</summary>
                <span className="board-row-username">@{row.username}</span>
              </details>
            )}
            {row.left ? <span className="board-row-left"> (left the Group)</span> : null}
          </div>
          <span className="board-row-answer">{row.availability ? AVAILABILITY_LABELS[row.availability] : noAnswer}</span>
          {row.note ? <p className="board-row-note">{row.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}
