#requires -Version 5.1
<#
    Fetches everything the engine links against into engine/third_party/.

    Run once (or after deleting third_party/):
        powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1

    Notes for this machine (CONTRACT 7):
      * raw.githubusercontent.com is unreachable; gh-proxy.com works, so headers
        fetched individually go through it.
      * codeload.github.com works directly, so archives do not need the mirror.
      * Nothing is ever installed into <系统工具目录> (read-only ACL).
#>
[CmdletBinding()]
param(
    [string] $Root = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# $PSScriptRoot is not dependable inside a param() default on every host, so it
# is resolved in the body instead.
if (-not $Root) {
    $here = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (-not $here) { $here = (Get-Location).Path }
    $Root = Join-Path $here '..\third_party'
}
$Root = [System.IO.Path]::GetFullPath($Root)
New-Item -ItemType Directory -Force -Path $Root | Out-Null
Write-Host "third_party: $Root"

function Get-TagLib {
    # Latest release, resolved through the API so this script does not rot.
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/taglib/taglib/releases/latest' -TimeoutSec 60
    $tag     = $release.tag_name
    $version = $tag.TrimStart('v')
    $dest    = Join-Path $Root "taglib-$version"

    if (Test-Path $dest) {
        Write-Host "TagLib $tag already present; skipping."
        return
    }

    Write-Host "Fetching TagLib $tag ..."
    $archive = Join-Path $env:TEMP "taglib-$tag.tar.gz"
    Invoke-WebRequest -Uri "https://codeload.github.com/taglib/taglib/tar.gz/refs/tags/$tag" -OutFile $archive -TimeoutSec 600
    tar -xzf $archive -C $Root
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Write-Host "  extracted -> $dest"
}

function Get-DrLibs {
    # Single-header decoders for the PCM path. TagLib cannot decode, and these
    # avoid an FFmpeg dependency for M1 (SPEC 2.6 allows dr_libs as the start).
    $dest = Join-Path $Root 'dr_libs'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null

    foreach ($header in @('dr_flac.h', 'dr_wav.h', 'dr_mp3.h')) {
        $out = Join-Path $dest $header
        if ((Test-Path $out) -and ((Get-Item $out).Length -gt 10000)) {
            Write-Host "dr_libs/$header already present; skipping."
            continue
        }
        Write-Host "Fetching dr_libs/$header ..."
        $url = "https://gh-proxy.com/https://raw.githubusercontent.com/mackron/dr_libs/master/$header"
        Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 180
        Write-Host ("  " + (Get-Item $out).Length + " bytes")
    }
}

function Get-KissFft {
    # Real-input FFT for the spectrum meter. Chosen over pffft for STRUCTURE,
    # not speed: this is six files and ~30 KB, while the pffft repository is an
    # FFT benchmark grab-bag with three vendored implementations inside it.
    #
    # NOTE: soxr-0.1.3/src contains a pffft of its own, which is why 'pffft is
    # already vendored' was wrong -- that copy is SoXR's private inline
    # implementation with its own symbol prefixes (pffft32s/pffft64s wrappers)
    # and cannot be linked as an independent translation unit.
    #
    # AVX would buy nothing here: the spectrum is 30 Hz over 2048 points and it
    # runs on the CONTROL thread, never on the render thread.
    $dest = Join-Path $Root 'kissfft'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null

    # Exactly these, and no more. The C++ template headers (kissfft.hh,
    # kissfft_i32.hh) and the N-dimensional transforms (kiss_fftnd*.c) are
    # deliberately NOT taken: every extra file is extra review surface for a
    # capability that needs one real FFT.
    $files = @{
        'kiss_fft.c'         = 8000;
        'kiss_fft.h'         = 3000;
        'kiss_fftr.c'        = 3000;
        'kiss_fftr.h'        = 700;
        '_kiss_fft_guts.h'   = 3000;
        'kiss_fft_log.h'     = 500;
        'COPYING'            = 100;   # BSD-3-Clause requires the notice to travel
    }
    foreach ($name in $files.Keys) {
        $out = Join-Path $dest $name
        if ((Test-Path $out) -and ((Get-Item $out).Length -ge $files[$name])) {
            Write-Host "kissfft/$name already present; skipping."
            continue
        }
        Write-Host "Fetching kissfft/$name ..."
        $url = "https://gh-proxy.com/https://raw.githubusercontent.com/mborgerding/kissfft/master/$name"
        Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 180
        Write-Host ("  " + (Get-Item $out).Length + " bytes")
    }
}

function Get-UtfCpp {
    # TagLib 2.3+ hard-requires utfcpp for UTF-8 and UTF-16 conversion, and it
    # is not shipped in the release tarball (it is a git submodule there).
    if (Test-Path (Join-Path $Root 'utfcpp\source\utf8.h')) {
        Write-Host 'utfcpp already present; skipping.'
        return
    }
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/nemtrif/utfcpp/releases/latest' -TimeoutSec 60
    $tag     = $release.tag_name
    Write-Host "Fetching utfcpp $tag ..."
    $archive = Join-Path $env:TEMP "utfcpp-$tag.tar.gz"
    Invoke-WebRequest -Uri "https://codeload.github.com/nemtrif/utfcpp/tar.gz/refs/tags/$tag" -OutFile $archive -TimeoutSec 300
    $staging = Join-Path $env:TEMP "utfcpp-$tag"
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    tar -xzf $archive -C $staging
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
    $inner = Get-ChildItem $staging -Directory | Select-Object -First 1
    if (-not (Test-Path (Join-Path $inner.FullName 'source\utf8.h'))) {
        throw "utfcpp layout unexpected at $($inner.FullName)"
    }
    if (Test-Path (Join-Path $Root 'utfcpp')) { Remove-Item (Join-Path $Root 'utfcpp') -Recurse -Force }
    Move-Item $inner.FullName (Join-Path $Root 'utfcpp')
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Write-Host '  extracted -> utfcpp'
}

function Get-SoXR {
    # SPEC 3.4 names SoXR for resampling, and it is load-bearing: the reference
    # library is 74 tracks at 44.1 kHz and 6 at 96 kHz, while the audio device
    # runs at 48 kHz. Without a resampler 80 of the 91 tracks cannot play.
    $existing = Get-ChildItem $Root -Directory -Filter 'soxr-*' -ErrorAction SilentlyContinue |
                Where-Object { Test-Path (Join-Path $_.FullName 'srcsoxr.h') } |
                Select-Object -First 1
    if ($existing) {
        Write-Host "soxr already present ($($existing.Name)); skipping."
        return
    }

    # soxr publishes tags but no GitHub releases, so resolve the newest tag.
    $tags = Invoke-RestMethod -Uri 'https://api.github.com/repos/chirlu/soxr/tags' -TimeoutSec 60
    if (-not $tags) { throw 'could not list soxr tags' }
    $tag = $tags[0].name
    Write-Host "Fetching soxr $tag ..."
    $archive = Join-Path $env:TEMP "soxr-$tag.tar.gz"
    Invoke-WebRequest -Uri "https://codeload.github.com/chirlu/soxr/tar.gz/refs/tags/$tag" -OutFile $archive -TimeoutSec 300

    # The tarball contains a couple of extensionless helper scripts that tar on
    # Windows refuses to create ("Invalid argument"), so extract only src/ and
    # the build files instead of the whole tree. Nothing outside src/ is needed.
    $dest = Join-Path $Root "soxr-$($tag.TrimStart('v'))"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    tar -xzf $archive -C $dest --strip-components=1 --wildcards '*/src/*' '*/CMakeLists.txt' '*/soxr-config.h.in' '*/cmake/*'
    if ($LASTEXITCODE -ne 0) {
        # bsdtar (the Windows built-in) has no --wildcards; list explicitly instead.
        tar -xzf $archive -C $dest --strip-components=1 "soxr-$tag/src" "soxr-$tag/CMakeLists.txt" "soxr-$tag/soxr-config.h.in"
        if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
    }
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Write-Host "  extracted -> soxr-$($tag.TrimStart('v'))"
}

Get-TagLib
Get-UtfCpp
Get-DrLibs
Get-KissFft
Get-SoXR

Write-Host ''
Write-Host 'Dependencies ready. Now build with:'
Write-Host '    powershell -ExecutionPolicy Bypass -File engine/tools/build.ps1'
