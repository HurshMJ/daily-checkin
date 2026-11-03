import { Form } from "react-router";

import { MAX_THRESHOLD, MIN_THRESHOLD } from "~/groups";

import { SubmitButton } from "./submit-button";

/**
 * The Game On Threshold stepper: round − and + buttons around "N Yes". Each
 * button is a submit button that posts the new value, so it works without
 * JavaScript. − stops at 1 and + at 99. `pendingValue` is the value being
 * saved, if any.
 */
export function ThresholdStepper({ threshold, pendingValue }: { threshold: number; pendingValue: string | null }) {
  const lower = threshold - 1;
  const higher = threshold + 1;
  return (
    <Form method="post" className="stepper">
      <input type="hidden" name="intent" value="threshold" />
      <SubmitButton
        pending={pendingValue === String(lower)}
        label="−"
        pendingLabel=""
        className="stepper-btn"
        name="threshold"
        value={lower}
        disabled={threshold <= MIN_THRESHOLD}
        aria-label={`Lower the threshold to ${lower} Yes`}
      />
      <p className="stepper-value" role="status">
        {threshold} Yes
      </p>
      <SubmitButton
        pending={pendingValue === String(higher)}
        label="+"
        pendingLabel=""
        className="stepper-btn"
        name="threshold"
        value={higher}
        disabled={threshold >= MAX_THRESHOLD}
        aria-label={`Raise the threshold to ${higher} Yes`}
      />
    </Form>
  );
}
