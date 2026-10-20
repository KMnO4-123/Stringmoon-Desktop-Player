#requires -Version 5.1
<#
    Builds twilight-engine.exe.

        powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1
        powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1 -Generator Ninja

    CONTRACT 7 note: cl.exe is not on PATH by design, so this script opens a
    developer shell (vcvars64.bat) and then runs CMake inside it.

    Generator choice, measured on this machine:
      * "Visual Studio 17 2022" is the default because it works here. CMake
        itself is installed under a very deep winget path, and Ninja stat()s
        CMake's own module files as dependencies -- several of those paths
        exceed the 260-character MAX_PATH limit, so Ninja refuses to build
        ("Filename longer than 260 characters"). MSBuild tolerates it.
      * Ninja stays available via -Generator Ninja for machines with a short
        CMake path; it is faster when it can run.
#>
[CmdletBinding()]
param(
    [ValidateSet('VisualStudio', 'Ninja')]
    [string] $Generator = 'VisualStudio',

    [ValidateSet('Release', 'Debug', 'RelWithDebInfo')]
    [string] $Configuration = 'Release',

    [switch] $Clean,

    # Records which render-thread call is in progress. Costs one relaxed store
    # per call, so it stays off unless a crash has to be attributed to a call.
    [switch] $RtTrace
)

$ErrorActionPreference = 'Stop'

$engineDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cmake     = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) { throw 'cmake not found on PATH.' }

# Visual Studio 的安装根目录不写死：不同机器的版本、盘符与发行通道都不一样。
# 先问 vswhere（随 VS 安装器一起分发，路径固定），问不到再退回目录扫描。
# 找不到时返回 $null，由下面的分支给出明确报错，而不是带着空路径继续跑。
function Find-VsInstallPath {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $args = @('-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
        $found = & $vswhere @args 2>$null
        if ($found) { return ($found | Select-Object -First 1) }
    }
    # vswhere 缺失（安装器被清理过）时的兜底：按各版本的目录形状找 vcvars64.bat。
    $roots = @(
        (Join-Path $env:ProgramFiles 'Microsoft Visual Studio'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    foreach ($root in $roots) {
        $candidate = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue } |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'VC\Auxiliary\Build\vcvars64.bat') } |
            Sort-Object Name -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return $null
}

$vsPath = Find-VsInstallPath

if ($Clean) {
    $stale = Join-Path $engineDir 'build'
    if (Test-Path $stale) {
        Write-Host "Removing $stale"
        Remove-Item $stale -Recurse -Force
    }
}

if ($Generator -eq 'Ninja') {
    $buildDir = Join-Path $engineDir 'build\ninja'
    $ninja    = (Get-Command ninja -ErrorAction SilentlyContinue).Source
    if (-not $ninja) {
        $ninjaCandidates = @()
        if ($vsPath) { $ninjaCandidates += (Join-Path $vsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe') }
        $ninjaCandidates += 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
        $ninja = $ninjaCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
    if (-not $ninja) { throw 'Ninja requested but not found. Install Ninja, or run without -Generator Ninja.' }

    $vcvarsCandidates = @()
    if ($vsPath) { $vcvarsCandidates += (Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat') }
    $vcvarsCandidates += 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
    $vcvars = $vcvarsCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $vcvars) { throw 'Ninja requested but no vcvars64.bat was found. Install the MSVC C++ workload.' }

    Write-Host "Toolchain: $vcvars"
    Write-Host "Ninja:     $ninja"
    $lines = @(
        ('call "{0}"' -f $vcvars),
        'if errorlevel 1 exit /b 1',
        ('"{0}" -S "{1}" -B "{2}" -G Ninja -DCMAKE_BUILD_TYPE={3} -DCMAKE_MAKE_PROGRAM="{4}"' -f $cmake, $engineDir, $buildDir, $Configuration, $ninja),
        'if errorlevel 1 exit /b 1',
        ('"{0}" --build "{1}" --config {2}' -f $cmake, $buildDir, $Configuration)
    )
    $batchFile = Join-Path $env:TEMP 'twilight-engine-build.bat'
    Set-Content -LiteralPath $batchFile -Value $lines -Encoding ASCII
    & cmd.exe /c $batchFile
} else {
    # CMake locates MSVC itself with this generator, so vcvars is not needed.
    # The script still checks that a toolchain exists, to fail with a clear
    # message instead of a wall of MSBuild output.
    $vcvarsCandidates = @()
    if ($vsPath) { $vcvarsCandidates += (Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat') }
    $vcvarsCandidates += 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
    $vcvars = $vcvarsCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $vcvars) { throw 'No MSVC toolchain found: install Visual Studio (or Build Tools) with the C++ workload, or pass -Generator Ninja.' }
    Write-Host "Toolchain: $vcvars"

    $buildDir = Join-Path $engineDir 'build\vs2022'
    $traceFlag = if ($RtTrace) { 'ON' } else { 'OFF' }
    & $cmake -S $engineDir -B $buildDir -G 'Visual Studio 17 2022' -A x64 "-DTE_RT_TRACE=$traceFlag"
    if ($LASTEXITCODE -ne 0) { throw "configure failed ($LASTEXITCODE)" }
    & $cmake --build $buildDir --config $Configuration
}

if ($LASTEXITCODE -ne 0) { throw "build failed (exit code $LASTEXITCODE)" }

$exe = Join-Path $engineDir 'bin\twilight-engine.exe'
if (-not (Test-Path $exe)) { throw "Build reported success but $exe is missing." }

$info = Get-Item $exe
Write-Host ''
Write-Host ("Built: {0}  ({1:N0} bytes, {2})" -f $info.FullName, $info.Length, $info.LastWriteTime)
