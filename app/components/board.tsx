import { Link } from "react-router";

import { AVAILABILITY_LABELS, type Board as BoardData } from "~/checkins";

export const NO_ANSWER = "No answer yet";
export const NOBODY_ANSWERED = "Nobody has answered yet tonight.";

/**
 * One Group's Board for tonight: a banner with the pill and the Yes count,
 * the Group name, then one row per Member in Board order. The viewer's own
 * row reads "You", and the Board ends with its links: the Group page now,
 * History with ticket 21. Rows and the banner reach the CSS through
 * data-availability and data-state.
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
      <ul className="board-rows">
        {board.rows.map((row) => (
          <li key={row.memberId} className="board-row" data-availability={row.availability ?? "none"}>
            <span className="board-row-name">{row.memberId === viewerId ? "You" : row.username}</span>
            <span className="board-row-answer">
              {row.availability ? AVAILABILITY_LABELS[row.availability] : NO_ANSWER}
            </span>
            {row.note ? <p className="board-row-note">{row.note}</p> : null}
          </li>
        ))}
      </ul>
      {nobodyAnswered ? <p className="board-empty">{NOBODY_ANSWERED}</p> : null}
      <p className="board-links">
        {/* The Group name gives each "Group" link its own description. */}
        <Link to={`/groups/${board.groupId}`} aria-describedby={headingId}>
          Group
        </Link>
      </p>
    </section>
  );
}
