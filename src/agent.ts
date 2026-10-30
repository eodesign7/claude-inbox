import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { InboxError, agentName } from "./base.js";
import { ensureCard, listCards, migrateLegacy, readCard, setCardPaths } from "./cards.js";

export interface Resolved {
  agent: string;
  source: "card" | "env" | "git" | "dir" | "default";
  /** čo rozhodlo: cesta z karty, premenná alebo koreň repa */
  detail: string;
}

export const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const trimSep = (p: string) => p.replace(/[\\/]+$/, "") || sep;

/** Rozbalí `.git`: priečinok alebo súbor worktree. Vráti {root, gitDir}. */
function locateGit(cwd: string): { root: string; gitDir: string } | null {
  let dir = real(cwd);
  for (;;) {
    const g = join(dir, ".git");
    if (existsSync(g)) {
      if (statSync(g).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
        if (m) {
          const gd = resolve(dir, m[1]!.trim());
          const i = gd.indexOf(`${sep}.git${sep}worktrees${sep}`);
          return { root: i > 0 ? gd.slice(0, i) : dir, gitDir: gd };
        }
      }
      return { root: dir, gitDir: g };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Koreň git repa (pre worktree koreň hlavného repa), alebo null. Bez spúšťania gitu. */
export function findGitRoot(cwd: string): string | null {
  try {
    return locateGit(cwd)?.root ?? null;
  } catch {
    return null;
  }
}

/** Aktuálna vetva z .git/HEAD, alebo null (detached HEAD, mimo repa). */
export function findGitBranch(cwd: string): string | null {
  try {
    const g = locateGit(cwd);
    if (!g) return null;
    const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(g.gitDir, "HEAD"), "utf8"));
    return m ? m[1]!.trim() : null;
  } catch {
    return null;
  }
}

function fromCards(cwd: string): { agent: string; path: string } | null {
  const target = real(cwd);
  let best: { agent: string; path: string } | null = null;
  for (const agent of listCards()) {
    for (const raw of readCard(agent)?.meta.paths ?? []) {
      const k = trimSep(real(raw));
      if (target === k || target.startsWith(k === sep ? k : k + sep)) {
        if (!best || k.length > best.path.length) best = { agent, path: k };
      }
    }
  }
  return best;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "");
}

/**
 * Beží proces pod Claude Code? Claude Code (terminál, desktop Code, SDK) nastavuje svojim
 * potomkom CLAUDECODE=1 a CLAUDE_CODE_ENTRYPOINT; chat v desktop appke ich nemá.
 */
export function isCodeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDECODE === "1" || !!env.CLAUDE_CODE_ENTRYPOINT || !!env.CLAUDE_CODE_SESSION_ID;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** Povoliť poslednú možnosť: názov priečinka, potom "default". Status line a hooky ju vypínajú. */
  allowDir?: boolean;
}

/**
 * Code session: karta (paths, najdlhší prefix), názov git repa, názov priečinka, "default".
 * CLAUDE_INBOX_AGENT sa ignoruje úplne. Chat: CLAUDE_INBOX_AGENT, potom to isté.
 */
export function resolveAgentInfo(cwd: string = process.cwd(), opts: ResolveOptions = {}): Resolved {
  const env = opts.env ?? process.env;
  migrateLegacy();
  if (!isCodeSession(env) && env.CLAUDE_INBOX_AGENT && env.CLAUDE_INBOX_AGENT.trim()) {
    return { agent: agentName(env.CLAUDE_INBOX_AGENT, "CLAUDE_INBOX_AGENT"), source: "env", detail: "CLAUDE_INBOX_AGENT" };
  }
  const c = fromCards(cwd);
  if (c) return { agent: c.agent, source: "card", detail: c.path };
  const root = findGitRoot(cwd);
  if (root) {
    const s = slug(basename(root));
    if (s) return { agent: agentName(s), source: "git", detail: root };
  }
  if (opts.allowDir === false) {
    throw new InboxError(`Neviem určiť agenta pre ${cwd}: spusti "claude-inbox link <agent>".`);
  }
  const dir = slug(basename(real(cwd)));
  if (dir) return { agent: agentName(dir), source: "dir", detail: real(cwd) };
  return { agent: "default", source: "default", detail: real(cwd) };
}

/** Pre server: nikdy nepadá. Upozornenie je pri zdroji priečinok/default alebo pri neplatnom CLAUDE_INBOX_AGENT. */
export function resolveAgentOrFallback(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Resolved & { warning?: string } {
  let r: Resolved;
  let bad: string | undefined;
  try {
    r = resolveAgentInfo(cwd, { env });
  } catch (e) {
    bad = e instanceof Error ? e.message : String(e);
    r = resolveAgentInfo(cwd, { env: { ...env, CLAUDE_INBOX_AGENT: "" } });
  }
  const warnings = [];
  if (bad) warnings.push(`claude-inbox: ${bad} Ignorujem ho.`);
  if (r.source === "dir" || r.source === "default") {
    warnings.push(
      `claude-inbox: priečinok ${r.detail} nie je repo ani nemá kartu, používam agenta "${r.agent}". ` +
        `Spusti v ňom: claude-inbox link <agent>.`,
    );
  }
  return warnings.length ? { ...r, warning: warnings.join("\n") } : r;
}

/** Strict (status line, hooky): bez poslednej možnosti, inak vyhodí chybu. */
export const resolveAgent = (cwd: string = process.cwd()) => resolveAgentInfo(cwd, { allowDir: false }).agent;

/** Založí kartu zo šablóny, ak neexistuje, a pridá cestu repa. Cestu odoberie iným kartám. */
export function linkProject(cwd: string, agent: string): { root: string; created: boolean } {
  const a = agentName(agent);
  const root = findGitRoot(cwd) ?? real(cwd);
  for (const other of listCards()) {
    if (other !== a) setCardPaths(other, (ps) => ps.filter((p) => trimSep(real(p)) !== root));
  }
  const created = ensureCard(a, root);
  setCardPaths(a, (ps) => (ps.some((p) => trimSep(real(p)) === root) ? ps : [...ps, root]));
  return { root, created };
}
