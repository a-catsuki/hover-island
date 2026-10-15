function Test-MsixPackageSignature([string]$Path,[string]$ExpectedThumbprint) {
    if(-not ('HoverIslandPackageTrust' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HoverIslandPackageTrust {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FileInfo {
  public uint Size; [MarshalAs(UnmanagedType.LPWStr)] public string Path; public IntPtr Handle; public IntPtr Subject;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct TrustData {
  public uint Size; public IntPtr Policy; public IntPtr Sip; public uint Ui; public uint Revocation; public uint Choice;
  public IntPtr File; public uint State; public IntPtr StateData; public IntPtr Url; public uint Flags; public uint Context; public IntPtr Settings;
 }
 [DllImport("wintrust.dll",ExactSpelling=true,PreserveSig=true)] static extern uint WinVerifyTrust(IntPtr window,ref Guid action,ref TrustData data);
 public static uint Verify(string path) {
  var file=new FileInfo {Size=(uint)Marshal.SizeOf(typeof(FileInfo)),Path=path};
  IntPtr pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
  try {
   Marshal.StructureToPtr(file,pointer,false);
   var data=new TrustData {Size=(uint)Marshal.SizeOf(typeof(TrustData)),Ui=2,Choice=1,File=pointer,Flags=0x1000};
   var action=new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
   return WinVerifyTrust(new IntPtr(-1),ref action,ref data);
  } finally {Marshal.DestroyStructure(pointer,typeof(FileInfo));Marshal.FreeHGlobal(pointer);}
 }
}
'@
    }
    $signature=Get-AuthenticodeSignature -LiteralPath $Path
    if(-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ine $ExpectedThumbprint){throw 'Package signer does not match the expected publisher.'}
    $result=[HoverIslandPackageTrust]::Verify((Resolve-Path -LiteralPath $Path).Path)
    # WinVerifyTrust verifies the MSIX SIP digest. Permit precisely an untrusted
    # root for a personal build; every other policy or integrity failure blocks.
    if($result -ne 0 -and $result -ne [uint32]2148204809){throw ('MSIX signature validation failed: 0x{0:X8}' -f $result)}
    return [pscustomobject]@{Trusted=($result -eq 0);Signer=$signature.SignerCertificate;Result=$result}
}
