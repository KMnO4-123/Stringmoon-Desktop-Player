import type { EngineErrorShape } from './protocol'

// Plain data survives both Electron IPC and contextBridge serialization.
export type RequestResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { message: string; code?: string; kind?: EngineErrorShape['kind'] } }

export async function captureRequest(request: () => Promise<unknown>): Promise<RequestResult> {
  try {
    return { ok: true, data: await request() }
  } catch (error) {
    const details = error !== null && typeof error === 'object'
      ? error as Record<string, unknown> : {}
    return {
      ok: false,
      error: {
        message: typeof details.message === 'string' ? details.message : String(error),
        code: typeof details.code === 'string' ? details.code : undefined,
        kind: details.kind === 'hardware' || details.kind === 'not_implemented' ? details.kind : undefined
      }
    }
  }
}

export function unwrapRequest(result: RequestResult): unknown {
  if (result.ok) return result.data
  throw Object.assign(new Error(result.error.message), {
    code: result.error.code,
    kind: result.error.kind
  })
}
