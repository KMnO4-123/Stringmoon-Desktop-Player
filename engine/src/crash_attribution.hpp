#pragma once
// Cross-thread crash attribution.
//
// The engine has no debugger here, so when it faults in the field the report
// has to be good enough on its own. The render thread publishes its id through
// this header; the unhandled-exception filter in main.cpp reads it to say
// whether the audio callback or the command loop is the one that died. That
// distinction is the difference between "the RT contract is violated" and "a
// command handler has a bug".

namespace te {

extern volatile unsigned long g_renderThreadId;

void publishRenderThreadId(unsigned long id);

inline unsigned long renderThreadId() {
    return g_renderThreadId;
}

} // namespace te
