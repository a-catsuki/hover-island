$ErrorActionPreference='Stop'
$source = @"
using System;
using System.IO;
public static class HoverIslandOwnedAudio {
 public static byte[] Wave() {
  int rate=48000, frames=rate*3;var memory=new MemoryStream();var writer=new BinaryWriter(memory);
  writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));writer.Write(36+frames*4);writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));writer.Write(16);writer.Write((short)1);writer.Write((short)2);writer.Write(rate);writer.Write(rate*4);writer.Write((short)4);writer.Write((short)16);writer.Write(System.Text.Encoding.ASCII.GetBytes("data"));writer.Write(frames*4);
  for(int n=0;n<frames;n++) {double t=(double)n/rate;double fade=Math.Min(1,Math.Min(t/.05,(3-t)/.05));double sample=.003*fade*(Math.Sin(2*Math.PI*320*t)+Math.Sin(2*Math.PI*860*t)+Math.Sin(2*Math.PI*1600*t)+Math.Sin(2*Math.PI*4800*t))/4;short value=(short)(sample*32767);writer.Write(value);writer.Write(value);}writer.Flush();return memory.ToArray();
 }
}
"@
Add-Type -TypeDefinition $source
$islandTestExe=(Get-ChildItem -LiteralPath src-tauri/target/debug/deps -Filter 'hover_island_lib-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$islandTestExe;$start.Arguments='--ignored default_render_loopback_opens_reads_and_stops --nocapture';$start.UseShellExecute=$false;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.CreateNoWindow=$true
$signal=[Convert]::ToBase64String([HoverIslandOwnedAudio]::Wave())
$process=[Diagnostics.Process]::Start($start)
$playerStart=[Diagnostics.ProcessStartInfo]::new();$playerStart.FileName='python';$playerStart.Arguments='-c "import base64,sys,winsound; winsound.PlaySound(base64.b64decode(sys.stdin.read()), winsound.SND_MEMORY)"';$playerStart.UseShellExecute=$false;$playerStart.RedirectStandardInput=$true;$playerStart.CreateNoWindow=$true
$player=[Diagnostics.Process]::Start($playerStart)
try {
 Start-Sleep -Milliseconds 200
 $player.StandardInput.Write($signal);$player.StandardInput.Close();$player.WaitForExit()
 if($player.ExitCode -ne 0){throw 'Owned in-memory WAV playback failed'}
 $result=$process.StandardOutput.ReadToEnd();$process.WaitForExit()
 if($process.ExitCode -ne 0){throw 'Native loopback check failed'}
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
 $prefix="Owned quiet 3-second four-tone WAV at amplitude 0.003; generated in memory and played with Python winsound. No account/player/microphone access.`n"
 [IO.File]::WriteAllText((Join-Path $PSScriptRoot "live-audio-owned-signal-$stamp.log"),$prefix+$result)
 $bandMatch=[regex]::Match($result,'bands=\[([0-9., -]+)\]')
 $maxMatch=[regex]::Match($result,'max_band=([0-9.]+)')
 $packetMatch=[regex]::Match($result,'packets=(\d+)')
 $bands=$null
 if($bandMatch.Success){$bands=@($bandMatch.Groups[1].Value.Split(',') | ForEach-Object {[double]::Parse($_,[Globalization.CultureInfo]::InvariantCulture)})}
 $proof=[ordered]@{capturedAt=(Get-Date).ToUniversalTime().ToString('o');testSignal='four-tone WAV generated in memory; amplitude 0.003';packets=if($packetMatch.Success){[int]$packetMatch.Groups[1].Value}else{$null};maxBand=if($maxMatch.Success){[double]::Parse($maxMatch.Groups[1].Value,[Globalization.CultureInfo]::InvariantCulture)}else{$null};bands=$bands;source='WASAPI default render endpoint; numeric spectrum only';noPrivateMetadata=$true}
 [IO.File]::WriteAllText((Join-Path $PSScriptRoot "live-audio-owned-signal-$stamp.json"),($proof | ConvertTo-Json -Depth 5)+"`n")
 $result
}
finally {$player.Dispose();$process.Dispose()}
