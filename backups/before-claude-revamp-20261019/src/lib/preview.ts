// Browser-only development adapter. Desktop builds always invoke Tauri.
import type { EventCallback,UnlistenFn } from '@tauri-apps/api/event'
import type { Settings,CalendarEvent } from './ipc'
const KEY='hover-island.preview.settings'
const emit=(name:string,payload:unknown)=>window.dispatchEvent(new CustomEvent(name,{detail:payload}))
let preferences:Settings|undefined
let playing=true
let position=94
const apps=[{id:'browser',name:'Browser',target:'https://example.com',kind:'desktop'},{id:'notes',name:'Notes',target:'C:\\Apps\\Notes.exe',kind:'desktop'}]
const art=`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#2f423e"/><circle cx="100" cy="90" r="68" fill="#81968a"/><circle cx="100" cy="90" r="43" fill="#344e44"/><circle cx="100" cy="90" r="7" fill="#c9d0ad"/><path d="M0 160Q80 110 200 168V200H0Z" fill="#b3c0a0"/></svg>')}`
const media=()=>({title:'A Walk in the Quiet',artist:'Slow Mornings',album:'Room to Breathe',sourceApp:'Spotify',status:playing?'playing':'paused',thumbnail:art,duration:248,position,canPlay:true,canPause:true,canSkipNext:true,canSkipPrevious:true,canSeek:true,seekMin:0,seekMax:248})
const weatherSample=()=>{
  const hourly=Array.from({length:24},(_,index)=>{
    const hour=(new Date().getHours()+index)%24
    const code=[2,2,1,0,0,1,2,3,61,61,3,2][Math.floor(index/2)%12]
    return {time:`2026-10-15T${String(hour).padStart(2,'0')}:00`,temperatureC:Math.round(24+4*Math.sin((hour-6)*Math.PI/12)),code,precipitationProbability:[5,5,10,0,5,15,20,30,45,55,20,10][Math.floor(index/2)%12]}
  })
  const daily=[{code:2,highC:29,lowC:21,precipitationProbability:10,uvIndexMax:7,windSpeedMaxKmh:14},{code:61,highC:27,lowC:20,precipitationProbability:75,uvIndexMax:5,windSpeedMaxKmh:18},{code:3,highC:28,lowC:20,precipitationProbability:20,uvIndexMax:6,windSpeedMaxKmh:12},{code:0,highC:30,lowC:21,precipitationProbability:0,uvIndexMax:8,windSpeedMaxKmh:10},{code:2,highC:29,lowC:22,precipitationProbability:15,uvIndexMax:7,windSpeedMaxKmh:16},{code:80,highC:27,lowC:20,precipitationProbability:55,uvIndexMax:5,windSpeedMaxKmh:21},{code:1,highC:29,lowC:21,precipitationProbability:5,uvIndexMax:7,windSpeedMaxKmh:13}].map((day,index)=>{
    const date=new Date();date.setDate(date.getDate()+index)
    const key=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
    return {date:key,...day,sunrise:`${key}T06:08`,sunset:`${key}T17:56`}
  })
  return {...{ok:true,city:preferences?.weatherCity??'New Delhi',tempC:26,hiC:29,loC:21,feelsLikeC:28,humidityPct:58,windSpeedKmh:13,windDirectionDeg:235,precipitationMm:0,isDay:true,pressureHpa:1008,cloudCoverPct:32,timezone:'Asia/Kolkata',hourly,daily,code:2,label:'Partly cloudy',aqi:62,aqiLabel:'US AQI · Moderate',pm25:12.4,pm10:24.7,locationSource:preferences?.weatherCity?'manual':'approximate',stale:false,updatedAt:Date.now()},...read('hover-island.preview.weather',{})}
}
function merge(base:Settings,patch:Partial<Settings>):Settings {const result={...base,...patch};for(const key of ['collapsed','expanded','placement','modules','visualizer','notifications','interaction','usage'] as const)Object.assign(result,{[key]:{...base[key],...patch[key]}});if(patch.panels)result.panels={...patch.panels};return result}
const read=<T,>(key:string,fallback:T):T=>{try{return JSON.parse(localStorage.getItem(key)??'null')??fallback}catch{return fallback}}
function events():CalendarEvent[]{return read('hover-island.preview.calendar',[{id:'local:sample',title:'Design review',start:Date.now()+3600000,end:Date.now()+5400000,allDay:false,location:'Studio'}])}
function savePrefs(){localStorage.setItem(KEY,JSON.stringify(preferences));emit('settings://changed',preferences)}
export async function previewInvoke<T>(command:string,args:Record<string,unknown>={},defaults:Settings):Promise<T> {
  preferences??=merge(structuredClone(defaults),read(KEY,{weatherLat:28.61,weatherLon:77.21,weatherCity:'New Delhi'}))
  let result:unknown
  switch(command){
    case 'settings_get':result=preferences;break
    case 'settings_set':preferences=merge(preferences,args.patch as Partial<Settings>);savePrefs();result=preferences;break
    case 'settings_reset':preferences=structuredClone(defaults);savePrefs();result=preferences;break
    case 'set_expanded':emit('island://expanded',args.expanded);break
    case 'audio_loopback_start':
      if(read<boolean>('hover-island.preview.audio-fixture',false)!==true)throw new Error('System audio capture is available in the Windows app.')
      emit('audio://capture-ready',{});break
    case 'audio_loopback_stop':break
    case 'apply_geometry':case 'apply_effects':case 'set_click_through':case 'set_interaction_bounds':break
    case 'media_get':result=media();break
    case 'media_control':if(args.action==='toggle')playing=!playing;if(args.action==='seek')position=Number(args.value);emit('media://changed',media());break
    case 'apps_list':result=apps;break
    case 'notifications_get':result=[];break
    case 'notifications_clear':emit('notifications://changed',[]);break
    case 'notifications_request_access':result=false;break
    case 'notifications_access_status':result={packaged:false,status:'unpackaged'};break
    case 'notifications_test_connection':emit('notifications://popup',{id:`test:${Date.now()}`,app:preferences.connections.find(item=>item.id===args.id)?.name??'Test',title:'Connection test',body:'Sample routing test',timestamp:Date.now()});break
    case 'email_codes_accounts':result={accounts:[],lastError:null};break
    case 'email_codes_authorize':throw new Error('Email account connections require the Hover Island desktop app.')
    case 'email_codes_remove':break
    case 'email_codes_set_paused':result={accounts:[],lastError:null};break
    case 'usage_get':case 'usage_refresh':result=[{provider:'codex',label:'Codex · 5h',status:'ok',percent:.28,window:'5h',source:'official-rate-limit',resetAt:Date.now()+7200000,updatedAt:Date.now(),detail:'Sample recorded limit.'},{provider:'claude-code',label:'Claude Code local activity',status:'ok',used:24800,unit:'tokens',window:'24h',source:'local-logs',updatedAt:Date.now(),detail:'Sample local activity.'}];break
    case 'weather_get':result=weatherSample();break
    case 'weather_detect_location':throw new Error('Device location is available in the Windows app. Choose a city instead.')
    case 'weather_search':result=[{name:String(args.query),country:'India',latitude:28.61,longitude:77.21}];break
    case 'calendar_get':result=events();break
    case 'calendar_save':{const event=args.event as CalendarEvent;result=[...events().filter(item=>item.id!==event.id),event];localStorage.setItem('hover-island.preview.calendar',JSON.stringify(result));break}
    case 'calendar_delete':result=events().filter(item=>item.id!==args.id);localStorage.setItem('hover-island.preview.calendar',JSON.stringify(result));break
    case 'notes_get':result={text:localStorage.getItem('hover-island.preview.notes')??''};break
    case 'notes_set':localStorage.setItem('hover-island.preview.notes',String(args.text));break
    case 'system_stats':result={cpuPercent:18,memoryUsedBytes:8589934592,memoryTotalBytes:17179869184,batteryPercent:76,charging:true};break
    case 'quick_controls_get':result={volume:{supported:false,level:50,muted:false,error:'Native volume control is available in the desktop app.'},brightness:{supported:false,level:70,error:'Native brightness control is available in the desktop app.'},bluetooth:{supported:false,enabled:null,error:'Native quick controls are available in the desktop app.'},powerMode:{activeName:null,supported:false,bestEfficiencyActive:false,canRestorePrevious:false,error:'Windows 11 power-mode controls are available in the desktop app.'},nightLight:{supported:false,enabled:null,bestEffort:true,error:null},doNotDisturb:{supported:false,enabled:false,bestEffort:true,error:null}};break
    case 'set_master_volume':case 'set_mute':case 'set_brightness':case 'set_night_light':case 'set_do_not_disturb':break
    case 'open_night_light_settings':case 'open_bluetooth_settings':case 'bluetooth_open_settings':case 'open_power_settings':case 'open_windows_settings':case 'set_bluetooth_radio':case 'set_power_saver_plan':case 'memory_scan':case 'memory_reclaim':case 'bluetooth_connect':case 'bluetooth_disconnect':case 'bluetooth_unpair':throw new Error('Bluetooth device actions are available in the desktop app.')
    case 'bluetooth_devices_list':result=[];break
    case 'devices_get':result={bluetooth:['AirPods Pro'],charging:true,error:null};break
    case 'connections_list':result=[{id:'whatsapp',name:'WhatsApp',url:'https://web.whatsapp.com',notifications:true,notificationSources:['WhatsApp','WhatsApp Desktop']},{id:'gmail',name:'Gmail',url:'https://mail.google.com',notifications:true,notificationSources:['Gmail']},{id:'instagram',name:'Instagram',url:'https://www.instagram.com',notifications:true,notificationSources:['Instagram']},{id:'outlook',name:'Outlook',url:'https://outlook.live.com',notifications:true,notificationSources:['Outlook']}];break
    case 'open_settings_window':case 'toggle_settings_window':window.open('/settings.html','hover-island-settings','width=960,height=700');break
    case 'spotlight_search':result=apps.filter(app=>!args.query||app.name.toLowerCase().includes(String(args.query).toLowerCase())).map(app=>({...app,title:app.name,subtitle:app.target,kind:'app',action:'launch',score:100}));break
    case 'spotlight_reindex':result=3;break
    case 'airdrop_capability':result={protocol:'AirDrop',backend:'Windows',adapter:'Intel AX211',hardwareSupportedByOmdropOwl:false,windowsMonitorMode:false,npcapWlanHelperPresent:false,ready:false,reason:'No working AWDL radio path has been verified for this AX211. Current Owl reports firmware limitations.'};break
    case 'reset_watch_get':result={events:[{id:'sample-global',kind:'global',title:'Global Codex reset announced',publishedAt:Date.now()-7200000,sourceUrl:'https://x.com/thsottiaux',reportedBy:'Sample data'},{id:'sample-banked',kind:'banked',title:'Banked reset grant announced for eligible accounts',publishedAt:Date.now()-86400000,sourceUrl:'https://x.com/thsottiaux',reportedBy:'Sample data'}],source:'https://codex-reset.com/api/feed',lastCheckedAt:Date.now(),sourceUpdatedAt:Date.now(),stale:false};break
    case 'nearby_status':result={running:false,deviceName:'Preview',port:53317,peers:[],transfers:[]};break
    case 'apps_launch':case 'apps_open_url':case 'apps_open_web_app':throw new Error('Open the desktop app to launch this service.')
    case 'play_alert_sound':break
    case 'send_test_alert':emit('alert://test',{});break
    case 'acknowledge_quit_request':break
    case 'quit_app':break
    default:throw new Error(`Browser preview does not implement ${command}`)
  }
  return result as T
}
export async function previewListen<T>(name:string,callback:EventCallback<T>):Promise<UnlistenFn>{
  const handler=(event:Event)=>callback({event:name,id:0,payload:(event as CustomEvent<T>).detail})
  const storage=(event:StorageEvent)=>{if(name==='settings://changed'&&event.key===KEY&&event.newValue){preferences=JSON.parse(event.newValue);callback({event:name,id:0,payload:preferences as T})}}
  window.addEventListener(name,handler);window.addEventListener('storage',storage)
  return()=>{window.removeEventListener(name,handler);window.removeEventListener('storage',storage)}
}
