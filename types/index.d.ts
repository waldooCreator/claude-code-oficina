export type OfficeStatus = 'working' | 'idle' | 'done' | 'failed'

export type OfficeKind = 'subagent' | 'workflow' | 'teammate'

export type OfficeAgent = {
  id: string
  label: string
  kind: OfficeKind
  status: OfficeStatus
  startedAt: number
  endedAt?: number
  activity?: string
}

declare module 'claude-code' {
  interface PluginState {
    oficina: { agents: OfficeAgent[]; isAutoOpened: boolean }
  }
}
