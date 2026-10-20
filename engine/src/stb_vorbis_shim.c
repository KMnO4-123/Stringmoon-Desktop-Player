/* stb_vorbis boundary shim.
 *
 * Why this file exists at all: stb_vorbis ships as one .c file with no header,
 * and its API hands a struct (stb_vorbis_info) back BY VALUE while also
 * declaring enums the caller is expected to compare against. A C++ caller can
 * only use those by re-declaring them, and a re-declared struct that drifts by
 * one field is silent memory corruption rather than a compile error.
 *
 * So the translation unit that owns the decoder is the only one that sees the
 * decoder's types. Everything crossing into C++ is a scalar or an opaque void*.
 *
 * Compiled as C (this is a .c file), with the vendored directory on the include
 * path, so the symbols other translation units link against are unmangled C
 * names and match what the compiler emits here.
 */

#include "stb_vorbis.c" /* no STB_VORBIS_HEADER_ONLY equivalent: this pulls the implementation */

/* The single error code the caller has to distinguish: "the block you handed me
 * does not contain the whole header set yet, call again with more". Exposed as a
 * function rather than a mirrored constant so the value stays upstream's. */
int te_vorbis_need_more_data(void)
{
    return VORBIS_need_more_data;
}

/* Returns NULL on failure, with *error set. *used receives the number of bytes
 * of the supplied block that were consumed and are already owned by the
 * decoder, so the caller knows where the first audio byte begins. */
void *te_vorbis_open(const unsigned char *data, int len, int *used, int *error)
{
    return (void *) stb_vorbis_open_pushdata(data, len, used, error, NULL);
}

/* Return value: bytes consumed from `data`. Zero means "need more data" -- the
 * block must be handed in again with more appended. *samples may be 0 for a
 * packet that produced no audio (headers, resynchronisation), which is not an
 * error. *output points at stb_vorbis-owned planar float buffers that are valid
 * only until the next decode call. */
int te_vorbis_decode(void *handle, const unsigned char *data, int len,
                     int *channels, void **output, int *samples)
{
    return stb_vorbis_decode_frame_pushdata((stb_vorbis *) handle, data, len,
                                            channels, (float ***) output, samples);
}

/* Tells the decoder the next block is NOT contiguous with the previous one (a
 * seek happened). It will resynchronise on the next Ogg page it recognises. */
void te_vorbis_flush(void *handle)
{
    stb_vorbis_flush_pushdata((stb_vorbis *) handle);
}

void te_vorbis_close(void *handle)
{
    stb_vorbis_close((stb_vorbis *) handle);
}

/* Absolute sample position of the next decode, or -1 while unknown. After a
 * flush this stays -1 until the decoder has parsed a page that carries a
 * granule position -- which is exactly what makes it usable as a seek
 * verification rather than a guess. */
int te_vorbis_sample_offset(void *handle)
{
    return stb_vorbis_get_sample_offset((stb_vorbis *) handle);
}

/* Last error detected, cleared by reading it. */
int te_vorbis_error(void *handle)
{
    return stb_vorbis_get_error((stb_vorbis *) handle);
}

void te_vorbis_stream_info(void *handle, int *sample_rate, int *channels)
{
    stb_vorbis_info info = stb_vorbis_get_info((stb_vorbis *) handle);
    if (sample_rate) *sample_rate = (int) info.sample_rate;
    if (channels)    *channels    = info.channels;
}
