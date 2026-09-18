import { NextRequest, NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation, rejectUnauthorizedAdminRequest } from "@/lib/admin-auth";
import { loadMemberReviews, normalizeReviewTag, ReviewInputError, saveMemberReview } from "@/lib/member-reviews";
import { loadMemberReviewHistorySummaries } from "@/lib/member-review-history";

export const dynamic = "force-dynamic";

function privateResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
}
function privateAuthResponse(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}
function reviewError(error: unknown) {
  if (error instanceof ReviewInputError) return privateResponse({ error: error.message }, error.status);
  console.error("Private member review storage is unavailable");
  return privateResponse({ error: "Private member reviews are unavailable. Please try again later." }, 503);
}

export async function GET(request: NextRequest) {
  const denied = rejectUnauthorizedAdminRequest(request);
  if (denied) return privateAuthResponse(denied);
  try {
    const params = new URL(request.url).searchParams;
    const tagParam = params.get("player_tag");
    const tag = tagParam === null ? undefined : normalizeReviewTag(tagParam);
    if (!tag && params.get("include_history") === "1") {
      const [reviews, historySummaries] = await Promise.all([loadMemberReviews(), loadMemberReviewHistorySummaries()]);
      return privateResponse({ reviews, historySummaries });
    }
    const reviews = await loadMemberReviews(tag);
    return privateResponse(tag ? { review: reviews[0] || null } : { reviews });
  } catch (error) { return reviewError(error); }
}

export async function PATCH(request: NextRequest) {
  const denied = rejectUnauthorizedAdminMutation(request);
  if (denied) return privateAuthResponse(denied);
  try {
    const body = await request.json().catch(() => null);
    const review = await saveMemberReview(body);
    return privateResponse({ success: true, review });
  } catch (error) { return reviewError(error); }
}
