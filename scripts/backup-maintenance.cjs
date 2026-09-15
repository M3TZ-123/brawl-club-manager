async function main() {
  const base = new URL(process.env.VERCEL_APP_URL || "https://brawlstatz.vercel.app");
  if(base.protocol !== "https:" || base.username || base.password || !process.env.CRON_SECRET) throw new Error("Scheduler configuration missing.");
  const response = await fetch(new URL("/api/sync/maintenance",base),{
    method:"POST",headers:{Authorization:"Bearer "+process.env.CRON_SECRET},
    signal:AbortSignal.timeout(60_000),
  });
  if(!response.ok) throw new Error("Retention maintenance failed (HTTP "+response.status+").");
  console.log("Retention maintenance completed after a verified offsite backup.");
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
