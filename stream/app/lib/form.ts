/** Shared form-field coercion for the routes. */

export function emptyToNull(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

export function text(value: FormDataEntryValue | null): string {
  return String(value ?? "").trim();
}

/**
 * `datetime-local` carries no zone. Events happen in Japan, so read it as JST
 * rather than as whatever zone the Worker happens to think it is in.
 */
export function parseLocalDateTime(value: FormDataEntryValue | null): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(`${raw}:00+09:00`);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/** The inverse, for pre-filling `datetime-local`. */
export function toLocalDateTimeValue(seconds: number | null): string {
  if (seconds === null) return "";
  const jst = new Date((seconds + 9 * 3600) * 1000);
  return jst.toISOString().slice(0, 16);
}

export function formatEventDate(seconds: number | null): string {
  if (seconds === null) return "日時未定";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(seconds * 1000));
}
