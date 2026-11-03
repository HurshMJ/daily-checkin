import { Link } from "react-router";

import { nightLabel } from "~/game-night";
import { pastCountLine, type PastNightSummary, pastPill } from "~/history";

/**
 * One past night in a Group's History list: a row-colour tile linking to
 * the night's own page, with the date, the Yes line or "No Check-ins", and
 * the state pill. The pill's words carry the state; data-state only styles it.
 */
export function PastNightTile({ groupId, night }: { groupId: number; night: PastNightSummary }) {
  const pill = pastPill(night);
  return (
    <li>
      <Link to={`/groups/${groupId}/history/${night.night}`} className="past-night">
        <span className="past-night-text">
          <span className="past-night-date">{nightLabel(night.night)}</span>
          <span className="past-night-count">{pastCountLine(night)}</span>
        </span>
        <span className="past-night-pill" data-state={pill.state}>
          {pill.text}
        </span>
      </Link>
    </li>
  );
}
