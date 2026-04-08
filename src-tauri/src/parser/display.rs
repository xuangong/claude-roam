//! Display message types for UI rendering

use serde::{Deserialize, Serialize};

/// Content block types in Claude messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },

    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: ToolResultContent,
    },

    #[serde(rename = "thinking")]
    Thinking { thinking: String },

    #[serde(rename = "code_execution_tool_result")]
    CodeExecutionResult {
        stdout: Option<String>,
        stderr: Option<String>,
        return_code: Option<i32>,
    },

    #[serde(rename = "server_tool_use")]
    ServerToolUse {
        name: String,
        #[serde(rename = "serverToolUseId")]
        server_tool_use_id: String,
        input: serde_json::Value,
    },
}

/// Tool result content can be text or nested blocks
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolResultContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

/// Display type for UI rendering
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DisplayType {
    Human,
    Assistant,
    ToolUse,
    ToolResult,
    Thinking,
    CodeResult,
    Error,
}

impl std::fmt::Display for DisplayType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DisplayType::Human => write!(f, "H"),
            DisplayType::Assistant => write!(f, "A"),
            DisplayType::ToolUse => write!(f, "T"),
            DisplayType::ToolResult => write!(f, "R"),
            DisplayType::Thinking => write!(f, "K"),
            DisplayType::CodeResult => write!(f, "C"),
            DisplayType::Error => write!(f, "E"),
        }
    }
}

/// Display message for UI rendering - flattened structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayMessage {
    #[serde(rename = "displayType")]
    pub display_type: DisplayType,
    pub uuid: String,
    #[serde(rename = "parentUuid")]
    pub parent_uuid: Option<String>,
    pub timestamp: Option<String>,
    #[serde(rename = "treeIndex")]
    pub tree_index: u32,
    pub blocks: Vec<ContentBlock>,

    // Tool-related fields
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(rename = "toolId", skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(rename = "toolInput", skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<serde_json::Value>,
    #[serde(rename = "toolContent", skip_serializing_if = "Option::is_none")]
    pub tool_content: Option<ToolResultContent>,

    // Code execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(rename = "returnCode", skip_serializing_if = "Option::is_none")]
    pub return_code: Option<i32>,

    // Thinking content
    #[serde(rename = "thinkingContent", skip_serializing_if = "Option::is_none")]
    pub thinking_content: Option<String>,
}

/// Session metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    #[serde(rename = "encodedDir")]
    pub encoded_dir: String,
    pub directory: String,
    #[serde(rename = "lineCount")]
    pub line_count: u32,
    #[serde(rename = "messageCount")]
    pub message_count: u32,
    #[serde(rename = "firstHumanMessage")]
    pub first_human_message: Option<String>,
    #[serde(rename = "lastModified")]
    pub last_modified: i64,
    #[serde(rename = "parsedAt")]
    pub parsed_at: Option<i64>,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    #[serde(rename = "treeCount")]
    pub tree_count: u32,
    #[serde(rename = "typeString")]
    pub type_string: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

/// Scan result statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    #[serde(rename = "totalSessions")]
    pub total_sessions: u32,
    #[serde(rename = "newSessions")]
    pub new_sessions: u32,
    #[serde(rename = "updatedSessions")]
    pub updated_sessions: u32,
    #[serde(rename = "deletedSessions")]
    pub deleted_sessions: u32,
    pub duration_ms: u64,
}

/// Search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub uuid: String,
    #[serde(rename = "treeIndex")]
    pub tree_index: u32,
    #[serde(rename = "displayType")]
    pub display_type: String,
    pub snippet: String,
    pub score: f32,
}

/// Tool call result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallResult {
    pub uuid: String,
    #[serde(rename = "treeIndex")]
    pub tree_index: u32,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(rename = "toolId")]
    pub tool_id: String,
    pub input: serde_json::Value,
}

/// Session analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionAnalysis {
    #[serde(rename = "totalMessages")]
    pub total_messages: u32,
    #[serde(rename = "humanMessages")]
    pub human_messages: u32,
    #[serde(rename = "assistantMessages")]
    pub assistant_messages: u32,
    #[serde(rename = "toolCalls")]
    pub tool_calls: Vec<ToolCallStat>,
    #[serde(rename = "treeCount")]
    pub tree_count: u32,
    #[serde(rename = "timeSpan")]
    pub time_span: Option<TimeSpan>,
    #[serde(rename = "topToolsByUsage")]
    pub top_tools_by_usage: Vec<ToolUsageStat>,
    #[serde(rename = "tokenUsage")]
    pub token_usage: Option<TokenUsage>,
}

/// Tool call statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallStat {
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(rename = "callCount")]
    pub call_count: u32,
    #[serde(rename = "successCount")]
    pub success_count: u32,
    #[serde(rename = "errorCount")]
    pub error_count: u32,
}

/// Tool usage statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolUsageStat {
    pub name: String,
    pub count: u32,
}

/// Time span for session analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeSpan {
    pub start: String,
    pub end: String,
    #[serde(rename = "durationMinutes")]
    pub duration_minutes: i64,
}

/// Aggregated token usage for a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: u64,
    #[serde(rename = "cacheCreationTokens")]
    pub cache_creation_tokens: u64,
}
