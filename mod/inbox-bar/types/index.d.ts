/** Segment riadku: text a voliteľný štýl (rovnaký model ako status line `claude-inbox status --json`). */
export type Seg = { t: string; s?: 'hi' | 'dim' }

export type Pending = { id: number; subject: string; from: string; to: string }

export type Status = { segments: Seg[]; plain: string; pending: Pending[] }

declare module 'claude-code' {
  interface PluginState {
    'inbox-bar': { status: Status | null }
  }
}
