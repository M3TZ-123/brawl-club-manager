const assert = require("node:assert/strict");
const keys = {1:"24h",3:"3d",7:"7d",30:"30d",90:"90d"};

// Transport fixture only. Real SQL range boundaries, baselines and permissions
// are independently verified in integration/reporting-reads.test.cjs.
function reportingReadRpc(tables, calls = []) {
  return async (name,args) => {
    assert.ok(["report_dashboard_read","report_leaderboard_read"].includes(name),`Unexpected RPC ${name}`);
    calls.push({name,args});
    const now = new Date(args.p_now), endDate = now.toISOString().slice(0,10);
    const start = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())-(args.p_days-1)*86400000).toISOString();
    const tags = new Set((tables.member_history || []).filter(row=>row.is_current_member).map(row=>row.player_tag));
    const members = (tables.members || []).filter(row=>tags.has(row.player_tag)).map(member=>({
      ...member,...(tables.activity_summary || []).find(row=>row.player_tag===member.player_tag),
    }));
    const settings = Object.fromEntries((tables.settings || []).map(row=>[row.key,row.value]));
    const result = {inactivityThreshold:settings.inactivity_threshold ?? null,lastSyncTime:settings.last_sync_time ?? null};
    if(name==="report_dashboard_read"){
      const events=(tables.club_events || []).filter(row=>row.event_time>=start&&row.event_time<=args.p_now);
      const notifications=(tables.notifications || []).filter(row=>row.created_at>=start&&row.created_at<=args.p_now);
      return {data:{...result,members:members.sort((a,b)=>(b.trophies || 0)-(a.trophies || 0)),
        recentEvents:events.toSorted((a,b)=>b.event_time.localeCompare(a.event_time)||(b.id || 0)-(a.id || 0)).slice(0,5),
        changeCounts:{joins:events.filter(row=>row.event_type==="join").length,leaves:events.filter(row=>row.event_type==="leave").length,
          nameChanges:notifications.filter(row=>row.type==="name_change").length,roleChanges:notifications.filter(row=>["promotion","demotion","role_change"].includes(row.type)).length}},error:null};
    }
    return {data:{...result,members:members.map(member=>{
      const daily=(tables.daily_stats || []).filter(row=>row.player_tag===member.player_tag&&row.date>=start.slice(0,10)&&row.date<=endDate);
      const sum=key=>daily.reduce((total,row)=>total+(row[key] || 0),0);
      return {...member,trophyChange:member[`trophies_${keys[args.p_days]}`] ?? null,battles:sum("battles"),wins:sum("wins"),losses:sum("losses"),starPlayer:sum("star_player"),activeDays:daily.filter(row=>row.battles>0).length};
    })},error:null};
  };
}
module.exports={reportingReadRpc};
