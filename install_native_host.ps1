param(
  [string]$ExtensionId = "jgcegnegoifbcokpipkogolkmodkcceb"
)

$ErrorActionPreference = "Stop"
$HostName = "com.xiaoyuzhou.desktop"

if ($ExtensionId -notmatch "^[a-p]{32}$") {
  throw "无效的 Chrome 扩展 ID：$ExtensionId"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceHost = Join-Path $ScriptDir "native_host.py"
if (-not (Test-Path $SourceHost)) {
  throw "缺少 Native Host：$SourceHost"
}

$PythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
$PythonPrefix = ""
if (-not $PythonCommand) {
  $PythonCommand = Get-Command py.exe -ErrorAction SilentlyContinue
  $PythonPrefix = "-3 "
}
if (-not $PythonCommand) {
  throw "未找到 Python 3。请先从 https://www.python.org/downloads/windows/ 安装，并勾选 Add Python to PATH。"
}

$InstallDir = Join-Path $env:LOCALAPPDATA "Xiaoyuzhou Desktop Native Host"
$HostScript = Join-Path $InstallDir "native_host.py"
$Launcher = Join-Path $InstallDir "native-host.exe"
$ManifestPath = Join-Path $InstallDir "$HostName.json"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $SourceHost $HostScript -Force

function ConvertTo-CSharpVerbatim([string]$Value) {
  return $Value.Replace('"', '""')
}

$PythonPath = ConvertTo-CSharpVerbatim $PythonCommand.Source
$Arguments = ConvertTo-CSharpVerbatim "$PythonPrefix`"$HostScript`""
$Source = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

public static class NativeHostLauncher
{
    private const string PythonPath = @"$PythonPath";
    private const string Arguments = @"$Arguments";

    public static int Main()
    {
        var startInfo = new ProcessStartInfo(PythonPath, Arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var process = Process.Start(startInfo))
        {
            if (process == null) return 1;
            Task input = Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream);
            Task output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            Task error = process.StandardError.ReadToEndAsync();
            output.Wait();
            process.WaitForExit();
            Console.OpenStandardOutput().Flush();
            return process.ExitCode;
        }
    }
}
"@

if (Test-Path $Launcher) {
  Remove-Item $Launcher -Force
}
Add-Type -TypeDefinition $Source -Language CSharp -OutputAssembly $Launcher -OutputType ConsoleApplication

$AllowedOrigins = @(
  "chrome-extension://jgcegnegoifbcokpipkogolkmodkcceb/",
  "chrome-extension://$ExtensionId/"
) | Sort-Object -Unique

if (Test-Path $ManifestPath) {
  try {
    $Existing = Get-Content $ManifestPath -Raw | ConvertFrom-Json
    $AllowedOrigins += @($Existing.allowed_origins)
    $AllowedOrigins = $AllowedOrigins |
      Where-Object { $_ -match "^chrome-extension://[a-p]{32}/$" } |
      Sort-Object -Unique
  } catch {
  }
}

$Manifest = @{
  name = $HostName
  description = "Xiaoyuzhou Desktop local file and API helper"
  path = $Launcher
  type = "stdio"
  allowed_origins = @($AllowedOrigins)
}
$ManifestJson = $Manifest | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText(
  $ManifestPath,
  $ManifestJson,
  (New-Object Text.UTF8Encoding($false))
)

$ChromeRegistry = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $ChromeRegistry -Force | Out-Null
Set-Item -Path $ChromeRegistry -Value $ManifestPath

$EdgeRegistry = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
New-Item -Path $EdgeRegistry -Force | Out-Null
Set-Item -Path $EdgeRegistry -Value $ManifestPath

Write-Host "本地助手已安装：$ManifestPath"
Write-Host "已加入扩展 ID：$ExtensionId"
Write-Host "请在 chrome://extensions 重新加载扩展。"
