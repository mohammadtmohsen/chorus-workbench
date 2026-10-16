export const CONVERSATION_NOTE_MAX_LENGTH = 4_000

export interface ConversationNote {
  readonly body: string
  readonly revision: number
  readonly version: number
  readonly visible: boolean
  readonly x: number | null
  readonly y: number | null
  readonly width: number | null
  readonly height: number | null
  readonly updatedBy: string | null
  readonly updatedAt: number
}

export interface ConversationNoteWrite {
  readonly status: 'saved' | 'conflict'
  readonly note: ConversationNote
}

export interface ConversationNoteView {
  readonly visible?: boolean | undefined
  readonly x?: number | undefined
  readonly y?: number | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
}

export const EMPTY_CONVERSATION_NOTE: ConversationNote = {
  body: '',
  revision: 0,
  version: 0,
  visible: false,
  x: null,
  y: null,
  width: null,
  height: null,
  updatedBy: null,
  updatedAt: 0,
}
