/**
 * Structured task-result fields (roundtable-k8s/roundtable#258, docs/knight-task-contract.md):
 * `prs[]` (pull requests the task opened or updated) and `verdict` (`ship_it` /
 * `needs_changes`). Both are optional; the operator falls back to prose when
 * they are absent, so we only report what we can establish.
 */

export type Verdict = "ship_it" | "needs_changes";
export type PRAction = "opened" | "updated";

export interface PRRef {
  repo?: string;
  number?: number;
  url?: string;
  action?: PRAction;
}

const PR_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?![\d/])/g;
/** Same shape as the operator's pkg/nats verdictLineRe. */
const VERDICT_RE = /^[\s>*_#-]*verdict[\s*_]*[:=-][\s*_`]*(ship[ _-]?it|needs[ _-]?changes)\b/gim;

export function normalizeVerdict(v: string): Verdict | undefined {
  const n = v.toLowerCase().trim().replace(/[ -]/g, "_");
  return n === "ship_it" || n === "needs_changes" ? n : undefined;
}

/** The last `Verdict: SHIP IT` / `Verdict: needs changes` line wins. */
export function parseVerdict(text: string): Verdict | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(VERDICT_RE)) last = m[1];
  return last ? normalizeVerdict(last) : undefined;
}

/** Only ever applied to the last non-empty line, so no `m` flag. */
const TASK_FAILURE_RE = /^[\s>*_#-]*outcome[\s*_]*[:=-][\s*_`]*failed\b[\s*_`:=.-]*(.*?)[\s*_`]*$/i;

/**
 * `Outcome: failed <reason>` as the LAST non-empty line declares the task failed.
 * Returns the reason, or the whole line when there is none; undefined otherwise.
 */
export function parseTaskFailure(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  const m = TASK_FAILURE_RE.exec(last);
  if (!m) return undefined;
  return m[1] || last;
}

function refFromUrl(url: string, action?: PRAction): PRRef {
  const m = new RegExp(PR_URL_RE.source).exec(url)!;
  return { repo: m[1], number: Number(m[2]), url: m[0], action };
}

/** PR URLs mentioned in free text, in order of first appearance, without an action. */
export function prsFromText(text: string): PRRef[] {
  const out = new Map<string, PRRef>();
  for (const m of text.matchAll(PR_URL_RE)) {
    const key = `${m[1]}#${m[2]}`.toLowerCase();
    if (!out.has(key)) out.set(key, { repo: m[1], number: Number(m[2]), url: m[0] });
  }
  return [...out.values()];
}

/**
 * Git global options that take their value as the next token (`-c k=v`, `-C dir`).
 * Forms with the value attached (`--git-dir=d`) and switches (`--no-pager`) take none.
 */
const GIT_OPTS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);
/** Number of a `gh pr edit` target, after any flags (`gh pr edit -R o/r --body x #7`). */
const PR_EDIT_NUM_RE = /\bgh\s+pr\s+edit\s+(?:--?[\w-]+=\S+\s+|-\S+\s+\S+\s+)*#?(\d+)\b/;

/**
 * Arguments after `push` when a shell command segment runs `git push`, else undefined: the first token after `git`
 * that is not a global option must be `push`, so `git -c push.default=x status`
 * is not a push. Quoted arguments are not parsed; `echo "git push"` is matched
 * because its words are split on whitespace like any other.
 */
export function gitPushArgs(segment: string): string[] | undefined {
  for (const m of segment.matchAll(/\bgit\s+/g)) {
    const tokens = segment.slice(m.index + m[0].length).split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (/^push(?![\w.-])/.test(t)) return tokens.slice(i + 1);
      if (GIT_OPTS_WITH_VALUE.has(t)) i++; // skip the option's value
      else if (!t.startsWith("-")) break; // another subcommand: not a push
    }
  }
  return undefined;
}

export const isGitPush = (segment: string): boolean => gitPushArgs(segment) !== undefined;

/** Bash command that can open or update a PR; worth remembering until its output arrives. */
export function isPrCommand(command: string): boolean {
  return /\bgh\s+pr\s+(create|edit)\b/.test(command) || isGitPush(command);
}

function repoFlag(segment: string): string | undefined {
  return /(?:^|\s)(?:-R|--repo)[\s=]+["']?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["']?/.exec(segment)?.[1];
}

/**
 * PRs a finished Bash command opened or updated, from the command line and its
 * output. `gh pr create` prints the new PR's URL, `gh pr edit` the edited PR's.
 * A successful `git push` counts as an update only when GitHub's output names an
 * existing PR (it prints `pull/new/<branch>` for a branch without one, ignored).
 */
export function prsFromBash(command: string, output: string): PRRef[] {
  const refs: PRRef[] = [];
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const action: PRAction | undefined = /\bgh\s+pr\s+create\b/.test(segment)
      ? "opened"
      : /\bgh\s+pr\s+edit\b/.test(segment)
        ? "updated"
        : undefined;
    if (action) {
      const urls = prsFromText(output);
      if (urls.length) {
        // create prints the PR URL last; edit prints just the one.
        refs.push({ ...urls[urls.length - 1]!, action });
        continue;
      }
      // edit with a numeric target and -R can be named without output.
      const repo = repoFlag(segment);
      const num = PR_EDIT_NUM_RE.exec(segment)?.[1];
      if (action === "updated" && repo && num) {
        refs.push({ repo, number: Number(num), url: `https://github.com/${repo}/pull/${num}`, action });
      }
      continue;
    }
    if (isGitPush(segment)) {
      for (const m of output.matchAll(PR_URL_RE)) refs.push(refFromUrl(m[0], "updated"));
    }
  }
  return refs;
}

/** Add refs keyed by repo#number; "opened" is never downgraded to "updated". */
export function mergePrs(into: PRRef[], refs: PRRef[]): void {
  for (const r of refs) {
    const hit = into.find((p) => p.number === r.number && p.repo?.toLowerCase() === r.repo?.toLowerCase());
    if (!hit) into.push(r);
    else if (r.action === "opened") hit.action = "opened";
    else if (!hit.action && r.action) hit.action = r.action;
  }
}

/** prs[] for the result: what the agent did, else URLs in the final message. */
export function resolvePrs(fromCommands: PRRef[], finalText: string): PRRef[] {
  return fromCommands.length ? fromCommands : prsFromText(finalText);
}
