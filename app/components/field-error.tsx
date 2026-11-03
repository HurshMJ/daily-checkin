import type { ReactNode } from "react";

/**
 * A field's error line. It owns the "Error:" prefix, so the error never
 * relies on colour alone. Point the field's aria-describedby at its id.
 */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="field-error">
      Error: {children}
    </p>
  );
}
