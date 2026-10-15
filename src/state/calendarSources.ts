import { createSignal } from 'solid-js'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type CalendarEvent } from '../lib/ipc'
import { subscribedCalendar } from '../lib/subscribedCalendar'

export interface CalendarSource {id:string;label:string;provider:string;updatedAt:number|null;error:string|null;contents?:string|null}
const [calendarSources,setCalendarSources]=createSignal<CalendarSource[]>([])
const [subscribedEvents,setSubscribedEvents]=createSignal<CalendarEvent[]>([])
const [calendarSourceError,setCalendarSourceError]=createSignal('')
let pending:Promise<void>|undefined
export function refreshCalendarSources(force=false):Promise<void>{
  if(pending)return pending
  pending=(async()=>{
    if(!isTauri())return
    try{
      const sources=await invoke<CalendarSource[]>('calendar_sources_get',{force})
      const next:CalendarEvent[]=[]
      for(const source of sources){if(!source.contents)continue;try{const parsed=subscribedCalendar(source.contents,source.id);next.push(...parsed.events);source.error||=parsed.warning??null}catch{source.error='This calendar contains unsupported data.'}}
      setSubscribedEvents(next);setCalendarSources(sources.map(({contents,...source})=>source));setCalendarSourceError('')
    }catch(error){setCalendarSourceError(String(error))}
  })().finally(()=>{pending=undefined})
  return pending
}
export async function addCalendarSource(label:string,provider:string,url:string):Promise<void>{
  if(!isTauri())throw Error('Calendar subscriptions are available in the desktop app.')
  await invoke('calendar_source_add',{label,provider,url});await pending;await refreshCalendarSources()
}
export async function removeCalendarSource(id:string):Promise<void>{await invoke('calendar_source_remove',{id});await pending;await refreshCalendarSources()}
export function subscribeCalendarSources():()=>void {
  let disposed=false,off:(()=>void)|undefined
  void refreshCalendarSources();const timer=setInterval(()=>void refreshCalendarSources(),300000)
  void listen('calendar://sources-changed',()=>{
    // A mutation in Settings can arrive while the main window is still polling.
    // Read the new source list after that older request settles.
    if(pending)void pending.then(()=>{if(!disposed)void refreshCalendarSources()})
    else void refreshCalendarSources()
  }).then(fn=>disposed?fn():off=fn)
  return()=>{disposed=true;clearInterval(timer);off?.()}
}
export {calendarSources,subscribedEvents,calendarSourceError}
