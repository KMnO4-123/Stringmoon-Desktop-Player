#pragma once
// SPEC 8 (lines 182 and 449): the AUDIO-DIAGNOSTIC record gets its own file --
// xrun counts, the output buffer's history, and the device-change history.
//
// Why it is not the protocol: the JSON Lines channel answers "what is true
// now". state.xrunCount is deliberately session-cumulative, so a UI can show a
// total but nobody can see the SHAPE of a fault over time. A user reporting
// "it crackles after an hour" can send one file instead of a console dump or a
// screen recording.
//
// NOT REALTIME, and that is a design constraint rather than an oversight.
// SPEC 3.2 forbids the render thread from doing I/O, so nothing here is called
// from it: the render thread only bumps counters, and the control thread writes
// a record when it OBSERVES a change. That is the same place and the same
// moment the matching event is emitted, which is what keeps the file and the
// wire from disagreeing about what happened.
//
// No writer thread either. Records are rare by construction -- an underrun, a
// buffer increase, a device change -- so a queue plus a thread would be
// machinery for a load that does not exist. The file is BOUNDED instead: past
// the cap the oldest half is dropped, which is what stops a multi-hour soak
// from filling the disk. That bound is what SPEC 449 means by a ring buffer.

#include <string>

namespace te {

// Appends one line: "<local time> <category> <message>".
// Safe to call at any time from the control thread; does nothing if the file
// cannot be opened (a missing diagnostic must never fail playback).
void diagRecord(const char* category, const std::string& message);

// The path actually in use. Empty until the first record.
std::string diagLogPath();

// Flushes and closes. Called from cmdShutdown BEFORE the reply, so the last
// records are on disk rather than in a buffer the process exit is about to
// discard -- the same reason the device is closed there and not in a destructor.
void diagClose();

} // namespace te