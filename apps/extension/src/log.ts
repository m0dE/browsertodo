/** The service worker's log lines, tagged so they stand out in the extension's console. */
export function logger(scope?: string): (message: string) => void {
  const tag = scope ? `[browsertodo] ${scope}:` : "[browsertodo]";
  return (message) => console.log(tag, message);
}
