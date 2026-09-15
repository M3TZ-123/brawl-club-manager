import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { verifyAdminSession } from "@/lib/admin-auth";
import { isAuthorizedSchedulerRequest } from "@/lib/scheduler-auth";
import { rejectCrossOriginRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" } });
}
async function authorized(request: Request) {
  return verifyAdminSession(request) || await isAuthorizedSchedulerRequest(request);
}

export async function GET(request: NextRequest) {
  try {
    if (!await authorized(request)) return response({ error: "Backup authorization required" }, 401);
    const params = new URL(request.url).searchParams;
    const id = params.get("snapshot_id") || "";
    if (!uuid.test(id)) return response({ error: "Invalid snapshot_id" }, 400);
    const { data: snapshot, error } = await supabaseAdmin.from("backup_snapshots")
      .select("manifest,status,expires_at").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!snapshot) return response({ error: "Snapshot not found" }, 404);
    if (new Date(snapshot.expires_at).getTime() <= Date.now()) return response({ error: "Snapshot expired" }, 410);
    const table = params.get("table");
    if (table === null) return response({ ...snapshot.manifest, status: snapshot.status });
    const index = params.get("chunk");
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table) || !index || !/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) {
      return response({ error: "Invalid chunk request" }, 400);
    }
    const { data, error: chunkError } = await supabaseAdmin.from("backup_chunks")
      .select("payload,sha256,byte_count").eq("snapshot_id", id).eq("table_name", table).eq("chunk_index", Number(index)).maybeSingle();
    if (chunkError) throw chunkError;
    return data ? response(data) : response({ error: "Chunk not found" }, 404);
  } catch {
    // A snapshot contains credentials and private notes. Never log DB payloads.
    console.error("Backup retrieval unavailable");
    return response({ error: "Backup storage is unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  try {
    const crossOrigin = rejectCrossOriginRequest(request);
    if (crossOrigin) return crossOrigin;
    if (!await authorized(request)) return response({ error: "Backup authorization required" }, 401);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return response({ error: "Invalid backup request" }, 400);
    if (body.action === "begin" && typeof body.request_id === "string" && uuid.test(body.request_id)) {
      const { data, error } = await supabaseAdmin.rpc("create_backup_snapshot", { p_request_id: body.request_id });
      if (error) {
        if (error.code === "55P03") return response({ error: "Backup is busy; retry shortly" }, 409);
        throw error;
      }
      return response(data);
    }
    if (body.action === "complete" && typeof body.snapshot_id === "string" && uuid.test(body.snapshot_id)
      && typeof body.artifact_sha256 === "string" && /^[0-9a-f]{64}$/.test(body.artifact_sha256)) {
      const { data, error } = await supabaseAdmin.rpc("complete_backup_snapshot", {
        p_snapshot_id: body.snapshot_id, p_artifact_sha256: body.artifact_sha256,
      });
      if (error) throw error;
      return data ? response({ success: true }) : response({ error: "Snapshot not found or artifact hash differs" }, 409);
    }
    return response({ error: "Invalid backup action or identifier" }, 400);
  } catch {
    console.error("Backup operation unavailable");
    return response({ error: "Backup storage is unavailable" }, 503);
  }
}
