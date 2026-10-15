import { settings } from '../state/settings'
const formats=new Map<string,Intl.DateTimeFormat>()
export function clockTime(date:Date,zone?:string):string {
  const key=`${zone??'local'}:${settings.clockHourCycle}:${settings.clockSeconds}`
  let format=formats.get(key)
  if(!format){format=new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:'numeric',minute:'2-digit',second:settings.clockSeconds?'2-digit':undefined,hour12:settings.clockHourCycle!=='24'});formats.set(key,format)}
  return format.format(date)
}
