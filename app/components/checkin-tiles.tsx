import { AVAILABILITIES, AVAILABILITY_LABELS, type Availability } from "~/checkins";

export const SAVING_MESSAGE = "Saving your answer…";

/**
 * The three equal Yes / Maybe / No tiles. Each is a submit button posting
 * name=availability, so the answer saves without JavaScript. The chosen tile
 * is aria-pressed and filled in its colour. While an answer saves, the tapped
 * tile is aria-busy (dimmed) and the status line reads "Saving your answer…";
 * the pressed tile stays on the last saved answer until the save lands.
 */
export function CheckinTiles({ chosen, pending }: { chosen: Availability | null; pending: Availability | null }) {
  return (
    <>
      <div className="checkin-tiles">
        {AVAILABILITIES.map((availability) => (
          <button
            key={availability}
            type="submit"
            name="availability"
            value={availability}
            className="checkin-answer"
            data-availability={availability}
            aria-pressed={chosen === availability}
            aria-busy={pending === availability ? true : undefined}
            onClick={pending ? (event) => event.preventDefault() : undefined}
          >
            <span className="checkin-ring" aria-hidden="true" />
            {AVAILABILITY_LABELS[availability]}
          </button>
        ))}
      </div>
      <p className="checkin-status" role="status">
        {pending ? SAVING_MESSAGE : null}
      </p>
    </>
  );
}
