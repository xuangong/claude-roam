import React from 'react'

/**
 * Format a date string to a human-readable format
 */
export function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Highlight search query matches in text
 * Returns React nodes with <mark> tags around matches
 */
export function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let index = lowerText.indexOf(lowerQuery)
  let keyIndex = 0

  while (index !== -1) {
    if (index > lastIndex) {
      parts.push(text.substring(lastIndex, index))
    }
    parts.push(
      React.createElement('mark', { key: keyIndex++, className: 'search-highlight' },
        text.substring(index, index + query.length)
      )
    )
    lastIndex = index + query.length
    index = lowerText.indexOf(lowerQuery, lastIndex)
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex))
  }

  return parts.length > 0 ? parts : text
}

/**
 * Truncate a string to a maximum length with ellipsis indicator
 */
export function truncate(str: string, maxLen: number): string {
  if (!str || typeof str !== 'string') return str
  if (str.length <= maxLen) return str
  return str.substring(0, maxLen) + '...[' + (str.length - maxLen) + ' more]'
}

/**
 * Limit string values in an object to prevent huge tool inputs
 */
export function limitInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== 'object') return input
  const result: Record<string, unknown> = {}
  for (const key in input) {
    const val = input[key]
    if (typeof val === 'string' && val.length > 10000) {
      result[key] = truncate(val, 10000)
    } else {
      result[key] = val
    }
  }
  return result
}
