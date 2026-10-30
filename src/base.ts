export class InboxError extends Error {}

const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function agentName(raw: string | undefined, what = "agent"): string {
  const n = (raw ?? "").trim().toLowerCase();
  if (!NAME_RE.test(n)) {
    throw new InboxError(`Neplatný ${what} "${raw ?? ""}": malé písmená, čísla, - alebo _, bez medzier.`);
  }
  return n;
}
