/** Application artwork IPC, separate from the frozen audio-engine protocol. */
export interface ArtworkResult { dataUrl: string; source: 'embedded' | 'sidecar' | 'custom' }
