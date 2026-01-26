// Shared message types for conversation display

// Content block types
export interface TextBlock {
  type: 'text'
  content: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface JsonBlock {
  type: 'json'
  content: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | JsonBlock

// Display types for the terminal
export type DisplayType = 'human' | 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'tree-separator'

// Unified display message interface
export interface DisplayMessage {
  displayType: DisplayType
  blocks: ContentBlock[]
  toolName?: string      // For tool_call and tool_result
  toolId?: string        // To link tool_call with tool_result
  raw?: Record<string, unknown>  // For system/other messages
  // For tree-separator
  treeIndex?: number
  treeSummaryCount?: number
  treeTimestamp?: string
}

// Store tool_use info to link with results
export interface ToolUseInfo {
  id: string
  name: string
}

// Raw message from JSONL (for tree building)
export interface RawMessage {
  uuid?: string
  parentUuid?: string | null
  type: string
  timestamp?: string
  message?: {
    content: string | ContentItem[]
  }
  summary?: string
  leafUuid?: string
  treeIndex?: number
  treeSummaryCount?: number
  treeMessageCount?: number
  // System message fields
  subtype?: string
  content?: string
  stopReason?: string
  compactMetadata?: Record<string, unknown>
  hookCount?: number
  hookInfos?: Array<{ hookName: string; status: string }>
  hookErrors?: string[]
  preventedContinuation?: boolean
  hasOutput?: boolean
}

export interface ContentItem {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | { text?: string }[]
  is_error?: boolean
}
