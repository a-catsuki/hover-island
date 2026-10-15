import type { AppConnection,AppNotification,DockItem } from './ipc'
export function sourceMatches(source:string,names:string[]):boolean {
  const actual=source.trim().toLowerCase()
  return names.some(name=>{const expected=name.trim().toLowerCase();return expected.length>1 && (actual===expected || actual.startsWith(`${expected} `) || actual.startsWith(`${expected} -`))})
}
export function notificationAllowed(item:AppNotification,connections:AppConnection[],dock:DockItem[]):boolean {
  const matching=connections.find(connection=>sourceMatches(item.app,[connection.name,...connection.notificationSources??[]]))
  if(matching)return matching.notifications
  return dock.some(app=>sourceMatches(item.app,[app.name]))
}
