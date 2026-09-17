export const eventKinds = ["mega_pig", "ranked", "tournament", "custom"] as const;
export type EventFields = { title:string; kind:typeof eventKinds[number]; cycleLabel:string; startsAt:string; endsAt:string; teamSize:number; ticketAllowance:number|null; status:"planned"|"completed"|"cancelled"; notes:string };
export type EventEntry = { playerTag:string; team:number; slot:"starter"|"substitute"; attendance:"invited"|"confirmed"|"present"|"absent"; wins:number|null; ticketsRemaining:number|null; observedAt:string|null; notes:string };
export type PlanningEvent = Omit<EventFields,"notes"> & { id:string; version:number; updatedAt:string; notes?:string };
export type EventRevision = { version:number; savedAt:string; reason:string; event:EventFields; entries:EventEntry[] };
export type PlanningResponse = { events:PlanningEvent[]; roster?:{tag:string;name:string}[]; eventDetail?:{id:string;entries:(EventEntry & {playerName:string})[];revisions:EventRevision[]} };
export type PlanningMutation = {action:"save_event";id:string|null;version:number;event:EventFields;entries:EventEntry[];reason:string;request_id?:string};
