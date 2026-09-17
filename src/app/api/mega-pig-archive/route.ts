import { NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation, rejectUnauthorizedAdminRequest } from "@/lib/admin-auth";
import { ClubRosterUnavailableError } from "@/lib/accepted-club-roster";
import { MegaPigArchiveError } from "@/lib/mega-pig-archive-input";
import { mutateMegaPigArchive, readMegaPigArchive } from "@/lib/mega-pig-archive";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", Vary: "Cookie" };
function denial(response: Response | null) {
  if (response) Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}
function failure(error: unknown) {
  if (error instanceof MegaPigArchiveError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
  if (error instanceof ClubRosterUnavailableError) return NextResponse.json({ error: error.message, code: "conflict" }, { status: 409, headers });
  return NextResponse.json({ error: "Mega Pig history is unavailable. Please try again.", code: "unavailable" }, { status: 503, headers });
}
async function body(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new MegaPigArchiveError("Send the archive fields as JSON.", 415);
  if (Number(request.headers.get("content-length")) > 16384) throw new MegaPigArchiveError("Mega Pig archive input is too long.", 413);
  const reader = request.body?.getReader(); if (!reader) throw new MegaPigArchiveError();
  const chunks: Uint8Array[] = []; let size = 0, finished = false;
  const deadline = AbortSignal.timeout(10000);
  try {
    while (true) {
      let abort: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new MegaPigArchiveError("Archive request timed out.", 408));
        if (deadline.aborted) abort(); else deadline.addEventListener("abort", abort, { once: true });
      });
      let item: ReadableStreamReadResult<Uint8Array>;
      try { item = await Promise.race([reader.read(), cancelled]); }
      finally { if (abort) deadline.removeEventListener("abort", abort); }
      if (item.done) { finished = true; break; }
      size += item.value.byteLength; if (size > 16384) throw new MegaPigArchiveError("Mega Pig archive input is too long.", 413);
      chunks.push(item.value);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new MegaPigArchiveError(); }
  } finally { if (!finished) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function GET(request: Request) {
  const denied = denial(rejectUnauthorizedAdminRequest(request)); if (denied) return denied;
  try { return NextResponse.json(await readMegaPigArchive(new URL(request.url).searchParams), { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const denied = denial(rejectUnauthorizedAdminMutation(request)); if (denied) return denied;
  try { return NextResponse.json(await mutateMegaPigArchive(await body(request)), { headers }); }
  catch (error) { return failure(error); }
}
