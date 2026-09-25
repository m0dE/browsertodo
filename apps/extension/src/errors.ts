/** The message of a thrown value, for logs, results and UI errors. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
