import ICAL from 'ical.js'
import type { CalendarEvent } from './ipc'

function millis(time:ICAL.Time,hint?:string):number {
  if(time.isDate||(!hint&&time.zone.tzid==='floating'))return new Date(time.year,time.month-1,time.day,time.hour,time.minute,time.second).getTime()
  if(hint&&time.zone.tzid==='floating'){
    const format=new Intl.DateTimeFormat('en-CA',{timeZone:hint,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
    const wall=Date.UTC(time.year,time.month-1,time.day,time.hour,time.minute,time.second)
    let guess=wall
    for(let i=0;i<4;i++){const p=format.formatToParts(guess);const n=(key:string)=>Number(p.find(item=>item.type===key)?.value??0);const delta=wall-Date.UTC(n('year'),n('month')-1,n('day'),n('hour'),n('minute'),n('second'));guess+=delta;if(delta===0)return guess}
    throw Error('Calendar contains an invalid local time')
  }
  return time.toUnixTime()*1000
}

/** Expand a bounded calendar window, honoring timezone definitions and exceptions. */
export function subscribedCalendar(text:string,sourceId:string,now=Date.now()):{events:CalendarEvent[];warning?:string} {
  if(text.length>2*1024*1024)throw Error('Calendar is larger than 2 MB')
  const root=new ICAL.Component(ICAL.parse(text))
  if(root.name!=='vcalendar')throw Error('This is not an iCalendar feed')
  ICAL.TimezoneService.reset()
  for(const component of root.getAllSubcomponents('vtimezone').slice(0,50)){
    const id=String(component.getFirstPropertyValue('tzid')??'')
    if(id&&!['UTC','GMT','floating'].includes(id))ICAL.TimezoneService.register(new ICAL.Timezone({component,tzid:id}))
  }
  const components=root.getAllSubcomponents('vevent').slice(0,2500)
  const events:CalendarEvent[]=[]
  let skipped=0,iterations=0
  const from=now-31*86400000,until=now+370*86400000,started=performance.now()
  for(const component of components){
    // Allow a small ordinary calendar through even when Intl's cold timezone
    // initialization consumes the time budget under heavy system load.
    if(events.length>=1000||iterations>20000||((events.length>=32||iterations>=32)&&performance.now()-started>200)){skipped++;break}
    if(component.hasProperty('recurrence-id')||component.getFirstPropertyValue('status')==='CANCELLED')continue
    try {
      const uid=component.getFirstPropertyValue('uid')
      const exceptions=components.filter(item=>item.hasProperty('recurrence-id')&&item.getFirstPropertyValue('uid')===uid)
      const event=new ICAL.Event(component,{strictExceptions:true,exceptions})
      const hint=component.getFirstProperty('dtstart')?.getParameter('tzid') as string|undefined
      const add=(item:ICAL.Event,start:ICAL.Time,end:ICAL.Time)=>{
        if(item.component.getFirstPropertyValue('status')==='CANCELLED')return
        const localHint=item.component.getFirstProperty('dtstart')?.getParameter('tzid') as string|undefined
        const begin=millis(start,localHint??hint),finish=millis(end,localHint??hint)
        if(!Number.isFinite(begin)||!Number.isFinite(finish)||finish<begin||finish<from||begin>until)return
        events.push({id:`ics:${sourceId}:${event.uid}:${begin}`,title:(item.summary||'Untitled event').slice(0,200),start:begin,end:finish,allDay:start.isDate,location:item.location?.slice(0,256)||null})
      }
      if(!event.isRecurring()){add(event,event.startDate,event.endDate);continue}
      const rules=component.getAllProperties('rrule')
      if(rules.some(rule=>['SECONDLY','MINUTELY'].includes(String((rule.getFirstValue() as ICAL.Recur).freq)))){skipped++;continue}
      const iterator=event.iterator()
      for(let count=0;count<20000&&iterations++<20000&&events.length<1000;count++){
        const occurrence=iterator.next();if(!occurrence)break
        if(millis(occurrence,hint)>until)break
        const detail=event.getOccurrenceDetails(occurrence)
        add(detail.item,detail.startDate,detail.endDate)
        if(performance.now()-started>200){skipped++;break}
      }
    }catch{skipped++}
  }
  return {events:events.sort((a,b)=>a.start-b.start),warning:skipped?'Some unsupported or unusually large recurring events were skipped.':undefined}
}
