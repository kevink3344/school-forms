import type { ReactNode } from "react";

// A toggle switch built from a styled checkbox.
//
// Extracted from the Admin Settings page (which used to declare its own copy) so
// the filter toolbars do not grow a second switch that drifts: one `onChange`
// signature, one focus style, one place to change the visual.
//
// `children` renders INSIDE the same `<label>` as the checkbox, so the visible
// words become the control's accessible name. An `aria-label` alone would leave
// the text outside the control — readable on screen, invisible to the keyboard's
// own reading order — and a `<label>` must not be nested inside another one, so
// callers pass the text here rather than wrapping this in a label of their own.
export function Toggle({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track">
        <span className="thumb" />
      </span>
      {children ? <span className="toggle-label">{children}</span> : null}
    </label>
  );
}
