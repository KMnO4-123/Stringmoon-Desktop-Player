cmake_minimum_required(VERSION 3.25)

project(TwilightEchoEngine
    VERSION 0.1.0
    DESCRIPTION "Twilight Echo audio engine (CONTRACT 3 endpoint)"
    LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "Twilight Echo is Windows-only (CONTRACT P2).")
endif()

# 静态 CRT（/MT，Debug 用 /MTd）。
#
# 为什么：安装包要能在干净 Windows 上直接运行。MSVCP140 / VCRUNTIME140 /
# VCRUNTIME140_1 不是系统组件，动态链接会让引擎在未装 VC++ 2015-2022
# Redistributable 的机器上**加载失败**（Electron spawn 报「找不到模块」，全部
# 播放不可用）。静态 CRT 让 resources/engine/bin 里的 exe 无外部运行时依赖。
#
# 必须放在任何 add_library/add_executable 之前：CMAKE_MSVC_RUNTIME_LIBRARY 是
# 目录作用域变量，第三方静态库（soxr/taglib/te_*）也要继承同一种 CRT，混用
# /MT 与 /MD 对象会产生各自的 CRT 堆与静态状态，是比体积增长严重得多的问题。
if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# MSVC needs /EHsc for the STL and /utf-8 because every source file in this
# project contains non-ASCII text. NOMINMAX and WIN32_LEAN_AND_MEAN keep
# windows.h from defining min/max macros that break <algorithm>.
# Off by default: SPEC 3.2 keeps the RT path free of logging work. Turning it
# on adds a single relaxed store per render stage, which is what makes a
# crash report name the call instead of the thread.
option(TE_RT_TRACE "Record which render-thread call is in progress (diagnostics)" OFF)

add_library(te_build_options INTERFACE)
target_compile_features(te_build_options INTERFACE cxx_std_20)
target_compile_options(te_build_options INTERFACE
    /W4 /permissive- /utf-8 /EHsc /Zc:__cplusplus /Zc:preprocessor
    $<$<CONFIG:Release>:/O2 /Oi>
    $<$<CONFIG:RelWithDebInfo>:/O2 /Zi>
    $<$<CONFIG:Debug>:/Od /RTC1 /Zi>
)
target_compile_definitions(te_build_options INTERFACE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    _CRT_SECURE_NO_WARNINGS
    UNICODE
    _UNICODE
)

# ---------------------------------------------------------------------------
# Third-party: TagLib (LGPL-2.1 / MPL-1.1) for tag reading only.
#
# The tree is placed by tools/fetch-deps.ps1 instead of being fetched by CMake,
# so a build never depends on the network (GitHub raw downloads need a mirror on
# this machine). CMake only finds what is already there.
# ---------------------------------------------------------------------------
file(GLOB TAGLIB_SOURCE_DIRS LIST_DIRECTORIES true "${CMAKE_CURRENT_SOURCE_DIR}/third_party/taglib-*")
list(FILTER TAGLIB_SOURCE_DIRS INCLUDE REGEX "taglib-[0-9]")

if(TAGLIB_SOURCE_DIRS)
    list(GET TAGLIB_SOURCE_DIRS 0 TAGLIB_SOURCE_DIR)
    message(STATUS "TagLib source: ${TAGLIB_SOURCE_DIR}")

    # TagLib 2.3+ needs utfcpp. There is no system package for it on this
    # machine, so fetch-deps.ps1 vendors it and we hand TagLib the include path
    # its own find_path() is looking for.
    set(TE_UTFCPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/utfcpp/source")
    if(EXISTS "${TE_UTFCPP_DIR}/utf8.h")
        # An externally supplied path wins; a stale NOTFOUND from a previous
        # configure does not.
        if(NOT utf8cpp_INCLUDE_DIR OR utf8cpp_INCLUDE_DIR MATCHES "-NOTFOUND")
            set(utf8cpp_INCLUDE_DIR "${TE_UTFCPP_DIR}" CACHE PATH "vendored utfcpp headers" FORCE)
            message(STATUS "Using vendored utfcpp: ${utf8cpp_INCLUDE_DIR}")
        endif()
    elseif(NOT utf8cpp_INCLUDE_DIR OR utf8cpp_INCLUDE_DIR MATCHES "-NOTFOUND")
        message(WARNING "utfcpp missing; TagLib configure will fail. "
                        "Run: powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1")
    endif()

    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
    set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(BUILD_BINDINGS OFF CACHE BOOL "" FORCE)
    set(WITH_ZLIB OFF CACHE BOOL "" FORCE)
    set(TAGLIB_INSTALL OFF CACHE BOOL "" FORCE)
    add_subdirectory("${TAGLIB_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/taglib" EXCLUDE_FROM_ALL)
    set(TE_HAVE_TAGLIB ON)
else()
    message(WARNING
        "TagLib source not found under engine/third_party/.\n"
        "The engine will build WITHOUT tag reading: every scan will fail.\n"
        "Run:  powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1")
    set(TE_HAVE_TAGLIB OFF)
endif()

# ---------------------------------------------------------------------------
# Third-party: SoXR (LGPL-2.1) stream resampler.
#
# SPEC 3.4 designates SoXR for the only resampling job this project has, and it
# is not optional in practice: the reference library is 74 tracks at 44.1 kHz
# and 6 at 96 kHz, while the audio device here runs at 48 kHz. Without it 80 of
# the 91 tracks cannot be played at all.
# ---------------------------------------------------------------------------
file(GLOB SOXR_SOURCE_DIRS LIST_DIRECTORIES true "${CMAKE_CURRENT_SOURCE_DIR}/third_party/soxr-*" )
list(FILTER SOXR_SOURCE_DIRS INCLUDE REGEX "soxr-[0-9]")

if(SOXR_SOURCE_DIRS)
    list(GET SOXR_SOURCE_DIRS 0 SOXR_SOURCE_DIR)
    message(STATUS "SoXR source: " ${SOXR_SOURCE_DIR})
    # SoXR 0.1.3 declares cmake_minimum_required(3.1), and CMake 4.x refuses
    # anything below 3.5 outright. Nothing here depends on the old policy
    # behaviour, so lift the floor rather than patching a vendored file.
    set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)
    set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(WITH_OPENMP OFF CACHE BOOL "" FORCE)      # one feeder thread; OpenMP buys nothing here
    set(WITH_LSR_BINDINGS OFF CACHE BOOL "" FORCE)
    set(WITH_AVFFT OFF CACHE BOOL "" FORCE)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    # SoXR resolves its own helper modules from ${CMAKE_SOURCE_DIR}/cmake/Modules,
    # which is only correct when SoXR is the top-level project. As a
    # subproject that points at engine/ instead. Putting the real directory
    # on the search path first is enough, and avoids patching a vendored
    # third-party file that a re-fetch would overwrite.
    list(APPEND CMAKE_MODULE_PATH "${SOXR_SOURCE_DIR}/cmake/Modules")
    add_subdirectory("${SOXR_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/soxr" EXCLUDE_FROM_ALL)
    set(TE_HAVE_SOXR ON)
else()
    message(FATAL_ERROR
        "SoXR source not found under engine/third_party/."
        "Run: powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1")
endif()

# stb_vorbis v1.22 (public domain / MIT dual) for Ogg Vorbis.
#
# Why vendored rather than fetched: it is a single 190 KB .c file with no build
# system, which is the cheapest possible dependency, and Ogg Vorbis is the format
# streaming providers actually serve -- .ogg is the normal transport container for
# them, so "cannot decode this build's most likely stream" was a real gap.
#
# dr_flac's own OGG support is NOT this: it handles Ogg-encapsulated FLAC (still
# lossless), which is a different thing from Vorbis (lossy). Both are handled --
# DR_FLAC_NO_OGG is off for the lossless case, and this decodes Vorbis.
#
# The decoder is reached through src/stb_vorbis_shim.c rather than by including
# the .c into audio_source.cpp: stb_vorbis has no header and returns a struct by
# value, and mirroring that struct in C++ would couple engine code to a vendored
# file's private layout. The shim keeps the handle opaque and the boundary
# scalar-only, so a library update cannot silently change a struct ABI.
set(TE_STB_VORBIS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb_vorbis")
if(NOT EXISTS "${TE_STB_VORBIS_DIR}/stb_vorbis.c")
    message(FATAL_ERROR
        "stb_vorbis is missing: engine/third_party/stb_vorbis/stb_vorbis.c\n"
        "Download it from https://github.com/nothings/stb/blob/master/stb_vorbis.c (public domain).")
endif()
add_library(te_stb_vorbis STATIC "${CMAKE_CURRENT_SOURCE_DIR}/src/stb_vorbis_shim.c")
target_include_directories(te_stb_vorbis PRIVATE "${TE_STB_VORBIS_DIR}")
if(MSVC)
    # Same reasoning as te_ebur128 and te_kissfft below: a vendored file nobody
    # will edit must not add warnings to a build people are supposed to read.
    target_compile_options(te_stb_vorbis PRIVATE /w)
endif()

add_executable(twilight-engine
    src/main.cpp
    src/audio_source.cpp
    src/media_reader.cpp
    src/mp4_source.cpp
    src/mf_source.cpp
    src/dsd_source.cpp
    src/diag_log.cpp
    src/convolver.cpp
    src/dsp.cpp
    src/meter.cpp
    src/analysis.cpp
    src/main.cpp
    src/output_wasapi.cpp
    src/player.cpp
    src/app.cpp
    src/app_selftest.cpp
    src/probe_exclusive.cpp
    src/probe_mf.cpp
    src/probe_decode.cpp
    src/probe_format.cpp
    src/probe_ir.cpp
    src/probe_reader.cpp
    src/probe_spectrum.cpp
    src/probe_resample.cpp
    src/probe_transport.cpp
    src/probe_spatial.cpp
    src/device_monitor.cpp
    src/catalog.cpp
    src/metadata.cpp
    src/devices.cpp
    src/io.cpp
)
# dr_libs are single-header decoders; fetch-deps.ps1 drops them here.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/dr_libs/dr_flac.h")
    set(TE_DRLIBS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/dr_libs")
else()
    message(FATAL_ERROR "dr_libs headers missing. Run: powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1")
endif()

# libebur128 v1.2.6 (MIT) for the EBU R128 loudness scan. Vendored as source
# rather than fetched at configure time: SPEC 2.6 names the component, the
# release has been final since 2021-02-14, so a build that cannot be reproduced
# offline is a worse trade than a 53 KB file in the tree.
set(TE_EBUR128_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/libebur128")
if(NOT EXISTS "${TE_EBUR128_DIR}/ebur128.c")
    message(FATAL_ERROR "libebur128 missing under engine/third_party/libebur128")
endif()
add_library(te_ebur128 STATIC "${TE_EBUR128_DIR}/ebur128.c")
# ebur128.c includes <sys/queue.h>, which is BSD and absent on MSVC. The library
# ships its own copy under queue/ and its own CMake puts that directory on the
# include path when the system one is missing -- so this mirrors the upstream
# arrangement rather than patching a vendored file that a re-fetch would revert.
target_include_directories(te_ebur128 PRIVATE
    "${TE_EBUR128_DIR}"
    "${TE_EBUR128_DIR}/queue")
# Its own CMake sets these; without them MSVC warns on every math function in a
# 53 KB third-party file, and warnings nobody will ever act on train people to
# ignore the ones that matter.
if(MSVC)
    target_compile_options(te_ebur128 PRIVATE /w)
    # ebur128.c uses M_PI, which MSVC hides behind this define. The file's own
    # header comment says so ("You may have to define _USE_MATH_DEFINES if you
    # use MSVC"), so this is the documented route and not a local workaround.
    target_compile_definitions(te_ebur128 PRIVATE _USE_MATH_DEFINES)
endif()

# kissfft (BSD-3-Clause) for the spectrum meter's real FFT. Chosen over pffft
# for STRUCTURE rather than speed: six files and ~30 KB, against a repository
# that is an FFT benchmark grab-bag with three implementations inside it.
# AVX would buy nothing here -- the spectrum is 30 Hz over 2048 points and it
# runs on the CONTROL thread, never on the render thread.
#
# NOTE: soxr-0.1.3/src contains a pffft of its own, which is why "pffft is
# already vendored" was wrong: that copy is SoXR's private inline
# implementation with its own symbol prefixes and cannot be linked as an
# independent translation unit. Hence a separate dependency rather than reuse.
set(TE_KISSFFT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/kissfft")
if(NOT EXISTS "${TE_KISSFFT_DIR}/kiss_fftr.c")
    message(FATAL_ERROR "kissfft missing. Run: powershell -ExecutionPolicy Bypass -File engine/tools/fetch-deps.ps1")
endif()
add_library(te_kissfft STATIC
    "${TE_KISSFFT_DIR}/kiss_fft.c"
    "${TE_KISSFFT_DIR}/kiss_fftr.c")
# PUBLIC: the engine's own meter code includes <kiss_fftr.h> from src/.
target_include_directories(te_kissfft PUBLIC "${TE_KISSFFT_DIR}")
if(MSVC)
    # Same reasoning as te_ebur128 above: a third-party file nobody will edit
    # must not add warnings to a build people are supposed to read.
    target_compile_options(te_kissfft PRIVATE /w)
endif()

target_include_directories(twilight-engine PRIVATE ${TE_DRLIBS_DIR} ${TE_EBUR128_DIR} src)
target_link_libraries(twilight-engine PRIVATE te_ebur128)
target_link_libraries(twilight-engine PRIVATE te_kissfft)
target_link_libraries(twilight-engine PRIVATE te_stb_vorbis)
target_link_libraries(twilight-engine PRIVATE te_build_options ole32 oleaut32 uuid winhttp)
# Media Foundation: the MP4 (AAC / ALAC) decode path, and --probe-mf's
# enumeration. mfuuid carries the transform categories and the AAC media types.
target_link_libraries(twilight-engine PRIVATE mfplat mfreadwrite mfuuid shell32)

if(TE_HAVE_TAGLIB)
    target_link_libraries(twilight-engine PRIVATE tag)
    # TagLib only exports INSTALL_INTERFACE include dirs, so an in-tree
    # add_subdirectory() consumer gets none. Its own sources use
    # "taglib/foo.h", so the source root is what must be on the path.
    # TagLib compiles its own sources with include_directories() at directory
    # scope and exports only INSTALL_INTERFACE dirs, so an in-tree consumer
    # sees none of them: taglib/fileref.h reaches for "tfile.h" exactly the
    # way TagLib own sources do. Its installed layout flattens every header
    # into one directory, so mirror that by putting each subdirectory on the
    # path. Recomputed from the tree, so a TagLib bump cannot break it.
    file(GLOB TAGLIB_HEADER_DIRS LIST_DIRECTORIES true "${TAGLIB_SOURCE_DIR}/taglib/*")
    list(FILTER TAGLIB_HEADER_DIRS EXCLUDE REGEX "\\.[A-Za-z0-9]+$")
    target_include_directories(twilight-engine PRIVATE
        "${TAGLIB_SOURCE_DIR}"
        "${TAGLIB_SOURCE_DIR}/taglib"
        ${TAGLIB_HEADER_DIRS}
    )
    target_compile_definitions(twilight-engine PRIVATE TE_HAVE_TAGLIB=1)
if(TE_RT_TRACE)
    target_compile_definitions(twilight-engine PRIVATE TE_RT_TRACE=1)
else()
    target_compile_definitions(twilight-engine PRIVATE TE_RT_TRACE=0)
endif()
endif()

if(TE_HAVE_SOXR)
    target_link_libraries(twilight-engine PRIVATE soxr)
    target_include_directories(twilight-engine PRIVATE "${SOXR_SOURCE_DIR}/src")
else()
    target_compile_definitions(twilight-engine PRIVATE TE_HAVE_TAGLIB=0)
endif()

# One fixed output path so drive.mjs and the app both find the exe without
# guessing a configuration subfolder.
set_target_properties(twilight-engine PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    OUTPUT_NAME "twilight-engine"
)

# A linker map, so a crash address can be turned into a function name without a
# debugger on this machine. ASLR stays on: the crash filter reports the module
# base alongside the faulting address, which is enough to look a symbol up in the
# map, and turning ASLR off to save one subtraction is not a trade worth making.
if(MSVC)
    target_link_options(twilight-engine PRIVATE /MAP)
    target_compile_options(twilight-engine PRIVATE /Zi)
endif()

message(STATUS "Twilight Echo engine configured (TagLib: ${TE_HAVE_TAGLIB})")
