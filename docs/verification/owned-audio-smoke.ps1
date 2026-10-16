$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Extensions
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
$stream=[IO.MemoryStream]::new([HoverIslandOwnedAudio]::Wave());$player=[System.Media.SoundPlayer]::new($stream);$player.Load()
$process=[Diagnostics.Process]::Start($start)
try {Start-Sleep -Milliseconds 200;$player.Play();$result=$process.StandardOutput.ReadToEnd();$process.WaitForExit();if($process.ExitCode -ne 0){throw 'Native loopback check failed'};[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'live-audio-owned-signal.log'),"Owned quiet 3-second four-tone WAV at amplitude 0.003; generated in memory. No account/player/microphone access.`n"+$result);$result}
finally {$player.Stop();$player.Dispose();$stream.Dispose();$process.Dispose()}
