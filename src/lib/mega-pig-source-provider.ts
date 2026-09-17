import "server-only";
import { DomUtils, parseDocument } from "htmlparser2";
import { parseRetryAfterMs } from "@/lib/upstream-rate-limit";
import type { MegaPigSourceMember, MegaPigSourcePayload } from "@/lib/mega-pig-source-types";

export type { MegaPigSourcePayload } from "@/lib/mega-pig-source-types";
export class SourceProviderError extends Error {
  constructor(public readonly code: "rate_limited" | "unavailable" | "invalid", public readonly retryAfterSeconds?: number) {
    super(code === "invalid" ? "Source data could not be verified." : code === "rate_limited" ? "Source request limit reached." : "Source is temporarily unavailable.");
    this.name = "SourceProviderError";
  }
}

const MAX_BYTES = 128 * 1024;
const MAX_MEMBERS = 30;
const TAG = /^#[0289PYLQGRJCUV]{2,19}$/;
const ORIGIN = "https://brawlace.com";
type HtmlNode = ReturnType<typeof parseDocument> | ReturnType<typeof parseDocument>["children"][number];
type HtmlElement = ReturnType<typeof DomUtils.getElementsByTagName>[number];
const fail = (): never => { throw new SourceProviderError("invalid"); };
const element = (node: HtmlNode): node is HtmlElement => "attribs" in node;
function clubTag(value: unknown): string {
  if (typeof value !== "string" || value.length > 23) return fail();
  const tag = `#${value.trim().replace(/^%23/i, "#").replace(/^#/, "").toUpperCase()}`;
  return TAG.test(tag) ? tag : fail();
}
function count(value: unknown, max = 30000): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fail();
}
const memberCount = (value: unknown): number | null => value === null ? null : count(value, 1000);
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return fail();
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
}

/** Re-project restored/cached values as strictly as a new source response. */
export function validateMegaPigSourcePayload(value: unknown, expectedClub: string): MegaPigSourcePayload {
  const expected = clubTag(expectedClub), row = record(value);
  if (row.clubTag !== expected || !Array.isArray(row.members) || row.members.length > MAX_MEMBERS) return fail();
  const seen = new Set<string>();
  const members = row.members.map((value): MegaPigSourceMember => {
    const item = record(value);
    if (typeof item.playerTag !== "string" || !TAG.test(item.playerTag) || seen.has(item.playerTag)) return fail();
    seen.add(item.playerTag);
    return { playerTag: item.playerTag, playerName: name(item.playerName), reportedWins: memberCount(item.reportedWins), reportedTicketsRemaining: memberCount(item.reportedTicketsRemaining) };
  });
  const totalWins = count(row.totalWins), reportedPlayersPlayed = count(row.reportedPlayersPlayed, MAX_MEMBERS);
  const knownWins = members.reduce((sum, member) => sum + (member.reportedWins ?? 0), 0);
  const allWinsKnown = members.every(member => member.reportedWins !== null);
  if (knownWins > totalWins || (allWinsKnown && knownWins !== totalWins) || reportedPlayersPlayed > members.length) return fail();
  return { clubTag: expected, totalWins, reportedPlayersPlayed, members };
}

function text(node: HtmlNode, excluded?: HtmlNode): string {
  if (node === excluded) return "";
  if (node.type === "text") return node.data;
  if (element(node) && ["script", "style", "template", "noscript"].includes(node.name)) return "";
  const block = node.type === "root" || (element(node) && ["html", "body", "main", "section", "article", "header", "footer", "div", "p", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"].includes(node.name));
  return "children" in node ? node.children.map(child => text(child, excluded)).join(block ? " " : "") : "";
}
const normalizedText = (node: HtmlNode, excluded?: HtmlNode) => text(node, excluded).replace(/\s+/gu, " ").trim();
function digits(value: string): number {
  return /^(0|[1-9][0-9]*)$/.test(value) ? count(Number(value)) : fail();
}
const reportedCount = (value: string): number | null => value === "-" ? null : digits(value);
function descendants(node: HtmlElement, tag: string): HtmlElement[] {
  return DomUtils.getElementsByTagName(tag, node.children, true);
}

/** Parses the public modal only. No scripts, images or remote resources execute. */
export function parseMegaPigSourceHtml(html: string, expectedClub: string): MegaPigSourcePayload {
  const expected = clubTag(expectedClub);
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > MAX_BYTES || html.includes("\0")) return fail();
  try {
    const document = parseDocument(html, { decodeEntities: true });
    // Bound traversal as well as bytes before recursive text/selector helpers.
    const pending = document.children.map(node => ({ node, depth: 0 }));
    const nodes: HtmlNode[] = [];
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (depth > 64 || nodes.length >= 10000) return fail();
      nodes.push(node);
      if ("children" in node) for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
    }
    const identified = nodes.filter((node): node is HtmlElement => element(node) && node.attribs.id === "megaPigTable");
    if (identified.length !== 1 || identified[0].name !== "table") return fail();
    const table = identified[0];
    if (descendants(table, "table").length) return fail();
    const headers = descendants(table, "th").map(node => normalizedText(node));
    if (JSON.stringify(headers) !== JSON.stringify(["NAME", "Mega Pig Wins", "Mega Pig Tickets Left", "Trophies", "RANKED RANK"])) return fail();
    const outsideText = normalizedText(document, table);
    const visibleTags: string[] = outsideText.match(/#[0289PYLQGRJCUV]{2,19}(?![A-Z0-9])/g) || [];
    if (!visibleTags.includes(expected) || visibleTags.some(tag => tag !== expected)) return fail();
    const total = (label: string) => {
      const matches = nodes.filter((node): node is HtmlElement => element(node) && ["b", "strong"].includes(node.name))
        .map(node => normalizedText(node)).filter(value => value.startsWith(`${label}:`));
      if (matches.length !== 1) return fail();
      return digits(matches[0].slice(label.length + 1).trim());
    };
    const rows = descendants(table, "tr").filter(row => !descendants(row, "th").length);
    if (rows.length > MAX_MEMBERS) return fail();
    const members = rows.map((row): MegaPigSourceMember => {
      const cells = row.children.filter((node): node is HtmlElement => element(node) && node.name === "td");
      if (cells.length !== 5 || descendants(row, "td").length !== 5) return fail();
      const links = descendants(cells[0], "a");
      if (links.length !== 1) return fail();
      const href = links[0].attribs.href;
      if (!href || href.length > 180) return fail();
      const link = new URL(href, ORIGIN);
      if (link.origin !== ORIGIN || link.username || link.password || link.search || link.hash) return fail();
      const match = /^\/players\/%23([0289PYLQGRJCUV]{2,19})$/.exec(link.pathname);
      if (!match) return fail();
      return { playerTag: `#${match[1]}`, playerName: name(normalizedText(links[0])), reportedWins: reportedCount(normalizedText(cells[1])), reportedTicketsRemaining: reportedCount(normalizedText(cells[2])) };
    });
    return validateMegaPigSourcePayload({ clubTag: expected, totalWins: total("Total Wins"), reportedPlayersPlayed: total("Players Played"), members }, expected);
  } catch (error) { if (error instanceof SourceProviderError) throw error; return fail(); }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(new SourceProviderError("unavailable"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new SourceProviderError("unavailable")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
async function readHtml(response: Response, signal: AbortSignal): Promise<string> {
  if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) return fail();
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) return fail();
  if (!response.body) return fail();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, html = "", finished = false;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) { finished = true; break; }
      bytes += result.value.byteLength;
      if (bytes > MAX_BYTES) return fail();
      try { html += decoder.decode(result.value, { stream: true }); } catch { return fail(); }
    }
    try { return html + decoder.decode(); } catch { return fail(); }
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One honest, anonymous website request. It never retries or follows redirects. */
export async function fetchMegaPigSource(expectedClub: string, options: { signal?: AbortSignal } = {}): Promise<MegaPigSourcePayload> {
  const expected = clubTag(expectedClub), url = `${ORIGIN}/clubs/${encodeURIComponent(expected)}/megapig`;
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 8000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let response: Response | undefined;
  try {
    if (signal.aborted) throw new SourceProviderError("unavailable");
    response = await abortable(fetch(url, {
      method: "GET", headers: { "User-Agent": "BrawlStatz (+https://brawlstatz.vercel.app)", Accept: "text/html", "Accept-Language": "en" },
      credentials: "omit", cache: "no-store", redirect: "error", signal,
    }), signal);
    if (response.redirected || (response.url && response.url !== url)) throw new SourceProviderError("unavailable");
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const retry = header !== null && header.length <= 128 ? parseRetryAfterMs(header) : null;
      throw new SourceProviderError("rate_limited", retry !== null && Number.isFinite(retry) ? Math.max(1, Math.ceil(retry / 1000)) : undefined);
    }
    if (!response.ok) throw new SourceProviderError("unavailable");
    return parseMegaPigSourceHtml(await readHtml(response, signal), expected);
  } catch (error) {
    if (error instanceof SourceProviderError) throw error;
    throw new SourceProviderError("unavailable");
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
  }
}
