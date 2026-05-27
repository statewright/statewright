#!/usr/bin/env python3
"""Lint reveal.js markdown slides for overflow issues.

Constraints (960x700 viewport, 0.08 margin, 0.48em code font):
- Code lines: max 58 chars (monospace ~8.3px/char at 0.48em of 16px)
- Code blocks: max 14 lines visible
- Bullet points: max 8 per slide
- Table columns: max 5
- Table cell text: max 30 chars
- Overall text lines: max 10 (excluding code)
"""

import sys
import re

MAX_CODE_CHARS = 58
MAX_CODE_LINES = 14
MAX_BULLETS = 8
MAX_TABLE_COLS = 5
MAX_TABLE_CELL = 30
MAX_TEXT_LINES = 10

def lint_slide(num, content):
    issues = []
    lines = content.strip().split('\n')

    # Code blocks
    in_code = False
    code_lines = 0
    code_start = 0
    for i, line in enumerate(lines):
        if line.strip().startswith('```'):
            if in_code:
                if code_lines > MAX_CODE_LINES:
                    issues.append(f"  Code block ({code_lines} lines, max {MAX_CODE_LINES})")
                in_code = False
                code_lines = 0
            else:
                in_code = True
                code_start = i
                code_lines = 0
        elif in_code:
            code_lines += 1
            stripped = line.rstrip()
            if len(stripped) > MAX_CODE_CHARS:
                issues.append(f"  Code L{i+1}: {len(stripped)} chars (max {MAX_CODE_CHARS}): {stripped[:60]}...")

    # Bullet points
    bullets = [l for l in lines if re.match(r'^\s*[-*\d]+[.)] ', l)]
    if len(bullets) > MAX_BULLETS:
        issues.append(f"  {len(bullets)} bullets (max {MAX_BULLETS})")

    # Tables
    table_rows = [l for l in lines if l.strip().startswith('|')]
    if table_rows:
        cols = len(table_rows[0].split('|')) - 2
        if cols > MAX_TABLE_COLS:
            issues.append(f"  Table: {cols} columns (max {MAX_TABLE_COLS})")
        for row in table_rows:
            cells = [c.strip() for c in row.split('|')[1:-1]]
            for j, cell in enumerate(cells):
                if len(cell) > MAX_TABLE_CELL and not re.match(r'^-+$', cell):
                    issues.append(f"  Table cell ({len(cell)} chars): {cell[:35]}...")

    # Text lines (non-code, non-table, non-heading, non-empty)
    text_lines = [l for l in lines
                  if l.strip()
                  and not l.strip().startswith('#')
                  and not l.strip().startswith('|')
                  and not l.strip().startswith('```')
                  and not l.strip().startswith('Note:')
                  and not in_code]
    if len(text_lines) > MAX_TEXT_LINES:
        issues.append(f"  {len(text_lines)} text lines (max {MAX_TEXT_LINES})")

    return issues


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'ai-meetup-2026-05-28.md'
    with open(path) as f:
        content = f.read()

    # Strip YAML frontmatter
    if content.startswith('---'):
        end = content.index('---', 3)
        content = content[end+3:]

    slides = re.split(r'^---$', content, flags=re.MULTILINE)
    total_issues = 0

    for i, slide in enumerate(slides, 1):
        # Get first heading for label
        heading = ''
        for line in slide.strip().split('\n'):
            if line.startswith('#'):
                heading = line.strip('#').strip()[:40]
                break

        issues = lint_slide(i, slide)
        if issues:
            total_issues += len(issues)
            print(f"\nSlide {i}: {heading}")
            for issue in issues:
                print(issue)

    if total_issues == 0:
        print("All slides pass overflow checks.")
    else:
        print(f"\n{total_issues} issues across {len(slides)} slides.")

if __name__ == '__main__':
    main()
