param(
  [string]$ExtensionId = "jgcegnegoifbcokpipkogolkmodkcceb"
)

$ErrorActionPreference = "Stop"
$HostName = "com.xiaoyuzhou.desktop"

if ($ExtensionId -notmatch "^[a-p]{32}$") {
  throw "Invalid Chrome extension ID: $ExtensionId"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceHost = Join-Path $ScriptDir "native_host.py"
if (-not (Test-Path $SourceHost)) {
  throw "Native Host source is missing: $SourceHost"
}

$PythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
$PythonPrefix = ""
if (-not $PythonCommand) {
  $PythonCommand = Get-Command py.exe -ErrorAction SilentlyContinue
  $PythonPrefix = "-3 "
}
if (-not $PythonCommand) {
  throw "Python 3 was not found. Install it from https://www.python.org/downloads/windows/ and enable Add Python to PATH."
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

    private static bool ReadExactly(Stream input, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = input.Read(buffer, offset, count - offset);
            if (read == 0) return false;
            offset += read;
        }
        return true;
    }

    private static bool ForwardOneMessage(Stream input, Stream output)
    {
        byte[] header = new byte[4];
        if (!ReadExactly(input, header, header.Length)) return false;

        int length = header[0]
            | (header[1] << 8)
            | (header[2] << 16)
            | (header[3] << 24);
        if (length < 0 || length > 64 * 1024 * 1024) return false;

        byte[] payload = new byte[length];
        if (!ReadExactly(input, payload, payload.Length)) return false;

        output.Write(header, 0, header.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
        return true;
    }

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
            Task error = process.StandardError.ReadToEndAsync();
            if (!ForwardOneMessage(Console.OpenStandardInput(), process.StandardInput.BaseStream))
            {
                process.Kill();
                return 1;
            }
            process.StandardInput.Close();
            process.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput());
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

Write-Host "Native Host installed: $ManifestPath"
Write-Host "Extension ID added: $ExtensionId"
Write-Host "Fully exit every Chrome process, then reopen Chrome."

