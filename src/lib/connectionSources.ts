import type { AppConnection,AppNotification,DockItem } from './ipc'
export function sourceMatches(source:string,names:string[]):boolean {
  const actual=source.trim().toLowerCase()
  return names.some(name=>{const expected=name.trim().toLowerCase();return expected.length>0 && (actual===expected || (expected.length>1 && (actual.startsWith(`${expected} `) || actual.startsWith(`${expected} -`))))})
}
/** Apple behaviour: every app may alert unless the user muted it (a saved source with notifications off). */
/** The saved connection that governs an app name; exact source names beat broad prefix rules. */
export function matchingConnection(app:string,connections:AppConnection[]):AppConnection|undefined {
  const actual=app.trim().toLowerCase()
  // Prefer a source's exact saved rule over a broad app-name prefix (for
  // example, "Outlook" must not override "Outlook New").
  return connections.find(connection=>[connection.name,...connection.notificationSources??[]].some(name=>name.trim().toLowerCase()===actual))
    ?? connections.find(connection=>sourceMatches(app,[connection.name,...connection.notificationSources??[]]))
}
/** Apple behaviour: every app may alert unless the user muted it (a saved source with notifications off). */
export function notificationAllowed(item:Pick<AppNotification,'app'>,connections:AppConnection[],_dock:DockItem[]=[]):boolean {
  const matching=matchingConnection(item.app,connections)
  return matching ? matching.notifications : true
}

/** Short relative stamp for notification rows: "now", "2m ago", "3h ago", "2d ago". */
export function relativeTime(timestamp:number,now:number):string {
  const seconds=Math.floor(Math.max(0,now-timestamp)/1000)
  if(seconds<45)return 'now'
  const minutes=Math.floor(seconds/60)
  if(minutes<60)return `${Math.max(1,minutes)}m ago`
  const hours=Math.floor(minutes/60)
  if(hours<24)return `${hours}h ago`
  return `${Math.floor(hours/24)}d ago`
}
