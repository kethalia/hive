export interface CommandSearchDocument {
  label: string;
  group: string;
  aliases?: readonly string[];
  description?: string;
  value?: string;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** One missing/extra/wrong letter or adjacent transposition, never scattered-letter matching. */
function oneEditAway(query: string, word: string): boolean {
  if (query.length < 4 || Math.abs(query.length - word.length) > 1) return false;
  let index = 0;
  while (index < Math.min(query.length, word.length) && query[index] === word[index]) index++;
  if (query.length < word.length) return query.slice(index) === word.slice(index + 1);
  if (query.length > word.length) return query.slice(index + 1) === word.slice(index);
  return (
    query.slice(index + 1) === word.slice(index + 1) ||
    (query[index] === word[index + 1] &&
      query[index + 1] === word[index] &&
      query.slice(index + 2) === word.slice(index + 2))
  );
}

function wordMatch(text: string, token: string): number {
  const words = text.split(" ");
  if (words.includes(token)) return 3;
  if (words.some((word) => word.startsWith(token))) return 2;
  if (token.length >= 3 && text.includes(token)) return 1;
  return 0;
}

/** Name > alias > category > context. Every query word must match a real field. */
export function scoreCommand(document: CommandSearchDocument, search: string): number {
  const query = normalize(search);
  if (!query) return 1;
  const label = normalize(document.label);
  const aliases = (document.aliases ?? []).map(normalize);
  if (label === query) return 1;
  if (label.startsWith(query)) return 0.96;
  if (label.includes(query)) return 0.92;
  if (aliases.includes(query)) return 0.88;
  const category = normalize(document.group);
  const categories = `${category} ${category.endsWith("s") ? category.slice(0, -1) : category}`;
  const context = normalize(`${document.value ?? ""} ${document.description ?? ""}`);
  const tokens = query.split(" ");
  let lowest = 1;
  let total = 0;
  for (const token of tokens) {
    const titleMatch = wordMatch(label, token);
    const aliasMatch = Math.max(0, ...aliases.map((alias) => wordMatch(alias, token)));
    const categoryMatch = wordMatch(categories, token);
    const contextMatch = wordMatch(context, token);
    const score = titleMatch
      ? 0.75 + titleMatch * 0.04
      : aliasMatch
        ? 0.6 + aliasMatch * 0.04
        : categoryMatch
          ? 0.45 + categoryMatch * 0.04
          : contextMatch
            ? 0.3 + contextMatch * 0.04
            : [label, ...aliases].some((field) =>
                  field.split(" ").some((word) => oneEditAway(token, word)),
                )
              ? 0.15
              : 0;
    if (!score) return 0;
    lowest = Math.min(lowest, score);
    total += score;
  }
  return lowest + (total / tokens.length) * 0.01;
}

/** React owns group order; cmdk also uses the same score for filtering and keyboard selection. */
export function rankCommandGroups<T extends CommandSearchDocument>(actions: T[], query: string) {
  const groups = new Map<string, { action: T; score: number }[]>();
  for (const action of actions) {
    const group = groups.get(action.group) ?? [];
    group.push({ action, score: scoreCommand(action, query) });
    groups.set(action.group, group);
  }
  return [...groups.entries()]
    .map(([heading, entries]) => ({
      heading,
      entries: entries.sort((a, b) => b.score - a.score),
    }))
    .sort((a, b) => b.entries[0].score - a.entries[0].score)
    .map(({ heading, entries }) => [heading, entries.map(({ action }) => action)] as const);
}

// Carry the fields with each cmdk item so registration never reads an older React render's map.
export function commandSearchKeywords(document: CommandSearchDocument): string[] {
  return [
    document.label,
    document.group,
    document.description ?? "",
    document.value ?? "",
    ...(document.aliases ?? []),
  ];
}

export function filterCommand(_value: string, search: string, keywords: string[] = []): number {
  const [label = "", group = "", description, value, ...aliases] = keywords;
  return scoreCommand({ label, group, description, value, aliases }, search);
}

/** Projects remain literal name/path matches, with an optional category qualifier. */
export function matchesProjectSearch(label: string, path: string, search: string) {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every(
    (term) =>
      "projects".startsWith(term) ||
      label.toLowerCase().includes(term) ||
      path.toLowerCase().includes(term),
  );
}
