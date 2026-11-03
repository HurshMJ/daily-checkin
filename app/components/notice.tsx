import type { ReactNode } from "react";

/**
 * A notice box: a title and a body line on a row-colour box with a stripe.
 * Errors are announced as alerts. A notice for a failed save passes `retry`
 * to offer a "Try again" button.
 */
export function Notice({
  tone,
  title,
  children,
  retry,
}: {
  tone: "info" | "warning" | "error";
  title: string;
  children: ReactNode;
  retry?: () => void;
}) {
  return (
    <div className={`notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <p className="notice-title">{title}</p>
      <p>{children}</p>
      {retry ? (
        <button type="button" className="btn-secondary" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
