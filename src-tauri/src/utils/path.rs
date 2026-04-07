//! Path utilities

#![allow(dead_code)]

use std::path::PathBuf;

/// Get the Claude projects directory
pub fn get_claude_projects_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude").join("projects");

    if projects_dir.exists() {
        Some(projects_dir)
    } else {
        None
    }
}

/// Get the Claude Roam data directory
pub fn get_claude_roam_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let roam_dir = home.join(".claude-roam");

    // Create if doesn't exist
    if !roam_dir.exists() {
        std::fs::create_dir_all(&roam_dir).ok()?;
    }

    Some(roam_dir)
}

/// Decode an encoded project directory name
pub fn decode_project_dir(encoded: &str) -> String {
    urlencoding::decode(encoded)
        .map(|s| s.to_string())
        .unwrap_or_else(|_| encoded.to_string())
}

/// Encode a project directory name
pub fn encode_project_dir(path: &str) -> String {
    urlencoding::encode(path).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode() {
        let original = "/Users/test/projects/my-app";
        let encoded = encode_project_dir(original);
        let decoded = decode_project_dir(&encoded);
        assert_eq!(decoded, original);
    }
}
