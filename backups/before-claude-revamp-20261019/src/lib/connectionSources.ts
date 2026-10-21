import type { AppConnection,AppNotification,DockItem } from './ipc'
export function sourceMatches(source:string,names:string[]):boolean {
  const actual=source.trim().toLowerCase()
  return names.some(name=>{const expected=name.trim().toLowerCase();return expected.length>0 && (actual===expected || (expected.length>1 && (actual.startsWith(`${expected} `) || actual.startsWith(`${expected} -`))))})
}
export function notificationAllowed(item:AppNotification,connections:AppConnection[],dock:DockItem[]):boolean {
  const actual=item.app.trim().toLowerCase()
  // Prefer a source's exact saved rule over a broad app-name prefix (for
  // example, "Outlook" must not override "Outlook New").
  const matching=connections.find(connection=>[connection.name,...connection.notificationSources??[]].some(name=>name.trim().toLowerCase()===actual))
    ?? connections.find(connection=>sourceMatches(item.app,[connection.name,...connection.notificationSources??[]]))
  if(matching)return matching.notifications
  return dock.some(app=>sourceMatches(item.app,[app.name]))
}
