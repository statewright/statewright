use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, List, ListItem, ListState, Paragraph},
    Frame,
};

use crate::events::{StateInfo, TuiEvent};

// Jurassic Park power grid palette
const BORDER_ACTIVE: Color = Color::Rgb(0, 255, 136);   // neon green
const BORDER_INACTIVE: Color = Color::Rgb(60, 60, 70);  // dark steel
const BORDER_DANGER: Color = Color::Rgb(255, 60, 60);   // alarm red
const BORDER_WARN: Color = Color::Rgb(255, 180, 0);     // amber
const BORDER_INFO: Color = Color::Rgb(0, 180, 255);     // cyan
const BG_PANEL: Color = Color::Rgb(15, 15, 20);         // near-black
const FG_DIM: Color = Color::Rgb(90, 90, 100);
const FG_BRIGHT: Color = Color::Rgb(220, 220, 230);
const DIFF_ADD: Color = Color::Rgb(80, 255, 80);
const DIFF_DEL: Color = Color::Rgb(255, 80, 80);
const DIFF_HDR: Color = Color::Rgb(0, 180, 255);

pub struct App {
    pub states: Vec<StateInfo>,
    pub current_state: String,
    pub step: u32,
    pub log: Vec<LogEntry>,
    pub log_state: ListState,
    pub status: String,
    pub finished: bool,
    pub success: Option<bool>,
    pub auto_scroll: bool,
    pub current_tool: Option<String>,
    pub last_tool: Option<String>,
}

#[derive(Clone)]
pub enum LogStyle {
    Normal,
    Boxed { border_color: Color },
    Diff { lines: Vec<DiffLine> },
}

#[derive(Clone)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

#[derive(Clone)]
pub enum DiffKind {
    Add,
    Remove,
    Context,
    Header,
}

pub struct LogEntry {
    pub tag: String,
    pub message: String,
    pub color: Color,
    pub style: LogStyle,
}

impl Default for App {
    fn default() -> Self {
        Self {
            states: Vec::new(),
            current_state: String::new(),
            step: 0,
            log: Vec::new(),
            log_state: ListState::default(),
            status: "INITIALIZING...".into(),
            finished: false,
            success: None,
            auto_scroll: true,
            current_tool: None,
            last_tool: None,
        }
    }
}

impl App {
    pub fn apply(&mut self, event: TuiEvent) {
        match event {
            TuiEvent::Setup { files_snapshotted } => {
                self.push_log("SETUP", &format!("snapshotted {} file(s)", files_snapshotted), FG_DIM, LogStyle::Normal);
            }
            TuiEvent::MachineLoaded { states } => {
                self.states = states;
                self.push_log("LOADED", "state machine online", BORDER_INFO, LogStyle::Boxed { border_color: BORDER_INFO });
            }
            TuiEvent::StepStarted { step, state, iteration, max_iterations, is_checkpoint, .. } => {
                self.step = step;
                self.current_state = state.clone();
                if is_checkpoint {
                    self.push_log("CHKPT", &format!("[{}] {} iter {}/{}", step, state, iteration, max_iterations), BORDER_WARN,
                        LogStyle::Boxed { border_color: BORDER_WARN });
                } else {
                    self.push_log("STEP", &format!("[{}] {} ({}/{})", step, state, iteration, max_iterations), BORDER_INFO, LogStyle::Normal);
                }
                self.status = format!("step {} | {} ({}/{})", step, state, iteration, max_iterations);
            }
            TuiEvent::Localized { excerpt_lines, .. } => {
                self.push_log("SCAN", &format!("{} lines extracted", excerpt_lines), Color::Magenta, LogStyle::Normal);
            }
            TuiEvent::ToolCall { name, args_preview } => {
                self.last_tool = self.current_tool.take();
                self.current_tool = Some(name.clone());
                // args_preview might already include "name(...)" from sw-agent output — don't double-wrap
                let display = if args_preview.starts_with(&format!("{}(", name)) {
                    truncate(&args_preview, 65)
                } else {
                    format!("{}({})", name, truncate(&args_preview, 55))
                };
                self.push_log("EXEC", &display, FG_BRIGHT, LogStyle::Normal);
            }
            TuiEvent::ToolResult { name, result_preview } => {
                self.last_tool = Some(name.clone());
                self.current_tool = None;
                // Unified diff output
                if name == "diff" || result_preview.contains("+++ ") || result_preview.contains("--- ") {
                    let diff_lines = parse_diff_lines(&result_preview);
                    if !diff_lines.is_empty() {
                        self.push_log("DIFF", &name, BORDER_WARN, LogStyle::Diff { lines: diff_lines });
                        return;
                    }
                }
                // edit_line: "L19 changed: 'return a // b' -> 'return a / b'"
                if result_preview.contains("changed:") && result_preview.contains(" -> ") {
                    if let Some(diff) = parse_edit_result(&result_preview) {
                        self.push_log("EDIT", &diff.header, DIFF_ADD, LogStyle::Diff { lines: diff.lines });
                        return;
                    }
                }
                // edit_block: "replaced N lines with M lines at LN in file\n- old\n+ new"
                if result_preview.contains("replaced") && result_preview.contains("lines") {
                    let diff_lines = parse_diff_lines(&result_preview);
                    if diff_lines.len() > 1 {
                        let header = result_preview.lines().next().unwrap_or(&result_preview).to_string();
                        self.push_log("EDIT", &header, DIFF_ADD, LogStyle::Diff { lines: diff_lines });
                    } else {
                        self.push_log("EDIT", &truncate(&result_preview, 70), DIFF_ADD, LogStyle::Normal);
                    }
                    return;
                }
                // patch_file: "N patch(es) applied to file\n- old\n+ new"
                if result_preview.contains("patch(es) applied") {
                    let diff_lines = parse_diff_lines(&result_preview);
                    if diff_lines.len() > 1 {
                        let header = result_preview.lines().next().unwrap_or(&result_preview).to_string();
                        self.push_log("PATCH", &header, DIFF_ADD, LogStyle::Diff { lines: diff_lines });
                    } else {
                        self.push_log("PATCH", &truncate(&result_preview, 70), DIFF_ADD, LogStyle::Normal);
                    }
                    return;
                }
                self.push_log("RECV", &format!("{} -> {}", name, truncate(&result_preview, 65)), FG_DIM, LogStyle::Normal);
            }
            TuiEvent::GuardBlocked { tool, state } => {
                // If the last log entry was an EXEC for this tool, replace it
                // with the block message (don't show both EXEC + BLOCK)
                if let Some(last) = self.log.last() {
                    if last.tag == "EXEC" && last.message.starts_with(&tool) {
                        self.log.pop();
                    }
                }
                self.push_log("BLOCK", &format!("{} not available in {} state", tool, state), BORDER_DANGER,
                    LogStyle::Boxed { border_color: BORDER_DANGER });
            }
            TuiEvent::Transition { from, to, .. } => {
                self.current_state = to.clone();
                self.push_log("STATE", &format!("{} -> {}", from, to), Color::Rgb(180, 80, 255),
                    LogStyle::Boxed { border_color: Color::Rgb(180, 80, 255) });
            }
            TuiEvent::AutoTest { passed, fail_count } => {
                if passed {
                    self.push_log("PASS", "all tests pass", BORDER_ACTIVE,
                        LogStyle::Boxed { border_color: BORDER_ACTIVE });
                } else {
                    self.push_log("FAIL", &format!("{} test(s) failing", fail_count), BORDER_DANGER,
                        LogStyle::Boxed { border_color: BORDER_DANGER });
                }
            }
            TuiEvent::DiffStats { file, changed, total } => {
                let color = if changed <= 5 { DIFF_ADD } else { BORDER_WARN };
                self.push_log("DIFF", &format!("{} | {}/{} lines", file, changed, total), color, LogStyle::Normal);
            }
            TuiEvent::MinimizerRejected { file, changed, max } => {
                self.push_log("REJECT", &format!("{} changed {} lines (max {})", file, changed, max), BORDER_DANGER,
                    LogStyle::Boxed { border_color: BORDER_DANGER });
            }
            TuiEvent::EditGateBlocked => {
                self.push_log("GATE", "no changes detected -- edit required", BORDER_DANGER,
                    LogStyle::Boxed { border_color: BORDER_DANGER });
            }
            TuiEvent::ParseFail { preview } => {
                self.push_log("PARSE", &truncate(&preview, 55), BORDER_DANGER, LogStyle::Normal);
            }
            TuiEvent::LlmResponse { preview } => {
                let trimmed = preview.trim();
                if trimmed.is_empty() { return; }
                // Skip JSON — tool calls, transitions, etc. The structured events cover these.
                if trimmed.starts_with('{') || trimmed.starts_with('[')
                    || trimmed.contains("\"tool_calls\"") || trimmed.contains("\"id\":\"call_")
                    || trimmed.contains("\"function\":{") || trimmed.contains("\"event\":") { return; }
                // Skip engine/infrastructure noise
                if trimmed.starts_with("Phase ") || trimmed.starts_with("[ENGINE]")
                    || trimmed.starts_with("[STDERR]") || trimmed.starts_with("LOCALIZE:")
                    || trimmed.starts_with("all tests pass")
                    || trimmed.starts_with("```") || trimmed.contains("process exited") { return; }
                // Skip very short fragments (single words, stray chars)
                if trimmed.len() < 10 { return; }
                // What's left is reasoning — show in italics
                self.push_log("    ", &truncate(trimmed, 80), Color::Rgb(130, 130, 160), LogStyle::Normal);
            }
            TuiEvent::NavAction { action } => {
                self.push_log("NAV", &action, BORDER_INFO, LogStyle::Normal);
            }
            TuiEvent::ApprovalGate { message } => {
                self.push_log("GATE", &message, BORDER_WARN,
                    LogStyle::Boxed { border_color: BORDER_WARN });
            }
            TuiEvent::Snapshot => {
                self.push_log("SNAP", "checkpoint saved", FG_DIM, LogStyle::Normal);
            }
            TuiEvent::Completed { steps, success } => {
                self.finished = true;
                self.success = Some(success);
                if success {
                    self.push_log("DONE", &format!("completed in {} steps -- all tests pass", steps), BORDER_ACTIVE,
                        LogStyle::Boxed { border_color: BORDER_ACTIVE });
                    self.status = format!("complete | {} steps | all tests pass", steps);
                } else {
                    self.push_log("DONE", &format!("failed after {} steps", steps), BORDER_DANGER,
                        LogStyle::Boxed { border_color: BORDER_DANGER });
                    self.status = format!("failed | {} steps", steps);
                }
            }
            TuiEvent::AgentFailed { error } => {
                self.push_log("FAULT", &error.unwrap_or_else(|| "agent failure".into()), BORDER_DANGER,
                    LogStyle::Boxed { border_color: BORDER_DANGER });
            }
            TuiEvent::Aborted { max_steps } => {
                self.push_log("ABORT", &format!("step limit ({}) exceeded", max_steps), BORDER_DANGER,
                    LogStyle::Boxed { border_color: BORDER_DANGER });
                self.status = format!("aborted | {} steps | limit exceeded", max_steps);
            }
        }
    }

    fn push_log(&mut self, tag: &str, message: &str, color: Color, style: LogStyle) {
        self.log.push(LogEntry {
            tag: tag.to_string(),
            message: message.to_string(),
            color,
            style,
        });
        if self.auto_scroll {
            self.log_state.select(Some(self.log.len().saturating_sub(1)));
        }
    }

    pub fn scroll_up(&mut self) { self.auto_scroll = false; let i = self.log_state.selected().unwrap_or(0); self.log_state.select(Some(i.saturating_sub(1))); }
    pub fn scroll_down(&mut self) { let i = self.log_state.selected().unwrap_or(0); let max = self.log.len().saturating_sub(1); let n = (i+1).min(max); self.log_state.select(Some(n)); if n == max { self.auto_scroll = true; } }
    pub fn page_up(&mut self) { self.auto_scroll = false; let i = self.log_state.selected().unwrap_or(0); self.log_state.select(Some(i.saturating_sub(20))); }
    pub fn page_down(&mut self) { let i = self.log_state.selected().unwrap_or(0); let max = self.log.len().saturating_sub(1); let n = (i+20).min(max); self.log_state.select(Some(n)); if n == max { self.auto_scroll = true; } }
    pub fn scroll_top(&mut self) { self.auto_scroll = false; self.log_state.select(Some(0)); }
    pub fn scroll_bottom(&mut self) { self.auto_scroll = true; self.log_state.select(Some(self.log.len().saturating_sub(1))); }
}

pub fn render(frame: &mut Frame, app: &App) {
    // Fill background
    let bg = Block::default().style(Style::default().bg(BG_PANEL));
    frame.render_widget(bg, frame.area());

    let vert = Layout::vertical([
        Constraint::Length(3),
        Constraint::Fill(1),
        Constraint::Length(3),
    ]).split(frame.area());

    // Title bar
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("statewright", Style::default().fg(BORDER_ACTIVE).bold()),
            Span::styled(" | ", Style::default().fg(BORDER_INACTIVE)),
            Span::styled("state machine guardrails for LLM agents", Style::default().fg(FG_DIM)),
        ]))
        .alignment(ratatui::layout::Alignment::Center)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Double)
                .border_style(Style::default().fg(BORDER_INFO))
                .style(Style::default().bg(BG_PANEL)),
        ),
        vert[0],
    );

    let horiz = Layout::horizontal([
        Constraint::Percentage(28),
        Constraint::Percentage(72),
    ]).split(vert[1]);

    render_state_machine(frame, app, horiz[0]);
    render_event_log(frame, app, horiz[1]);
    render_status_bar(frame, app, vert[2]);
}

fn render_state_machine(frame: &mut Frame, app: &App, area: Rect) {
    let outer = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(BORDER_INFO))
        .style(Style::default().bg(BG_PANEL))
        .title(Span::styled(" systems ", Style::default().fg(BORDER_INFO).bold()));
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if app.states.is_empty() { return; }

    // Calculate height per state
    let state_heights: Vec<u16> = app.states.iter().map(|s| {
        let mut h: u16 = 3; // border top + name + border bottom
        if !s.tools.is_empty() && !s.is_final { h += 1; }
        h += s.transitions.len() as u16;
        h
    }).collect();

    let constraints: Vec<Constraint> = state_heights.iter()
        .map(|h| Constraint::Length(*h))
        .chain(std::iter::once(Constraint::Fill(1)))
        .collect();
    let chunks = Layout::vertical(constraints).split(inner);

    for (i, state) in app.states.iter().enumerate() {
        if i >= chunks.len() { break; }
        let is_current = state.name == app.current_state;

        // Per-state colors
        let state_color = match state.name.as_str() {
            "localizing" => Color::Rgb(0, 180, 255),    // cyan — scanning
            "planning"   => Color::Rgb(100, 140, 255),   // blue — reading
            "implementing" => Color::Rgb(255, 180, 0),   // amber — writing
            "testing"    => Color::Rgb(180, 80, 255),     // purple — verifying
            "review"     => Color::Rgb(0, 200, 140),      // teal — approval
            "completed"  => BORDER_ACTIVE,                // green — success
            "failed"     => BORDER_DANGER,                // red — failure
            _ => FG_BRIGHT,
        };

        let bc = if is_current {
            state_color
        } else if state.name == "failed" {
            Color::Rgb(50, 20, 20) // very muted red
        } else if state.name == "completed" {
            Color::Rgb(30, 80, 50) // dim green always
        } else {
            BORDER_INACTIVE
        };
        let name_style = if is_current {
            Style::default().fg(state_color).bold()
        } else if state.name == "failed" {
            Style::default().fg(Color::Rgb(70, 30, 30))
        } else if state.name == "completed" {
            Style::default().fg(FG_DIM)
        } else {
            Style::default().fg(FG_BRIGHT)
        };

        let max_str = state.max_iterations.map(|m| format!(" [max:{}]", m)).unwrap_or_default();
        let title = format!(" {}{} ", state.name.to_uppercase(), max_str);

        let state_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(bc))
            .style(Style::default().bg(BG_PANEL))
            .title(Span::styled(title, name_style));

        let state_inner = state_block.inner(chunks[i]);
        frame.render_widget(state_block, chunks[i]);

        let mut lines: Vec<Line> = Vec::new();

        if !state.tools.is_empty() && !state.is_final {
            // Render each tool with highlighting
            let mut tool_spans: Vec<Span> = Vec::new();
            for (ti, tool) in state.tools.iter().enumerate() {
                if ti > 0 { tool_spans.push(Span::styled(", ", Style::default().fg(FG_DIM))); }
                let style = if is_current && app.current_tool.as_deref() == Some(tool.as_str()) {
                    Style::default().fg(FG_BRIGHT).bold()
                } else if is_current && app.last_tool.as_deref() == Some(tool.as_str()) {
                    Style::default().fg(Color::Rgb(140, 140, 150))
                } else {
                    Style::default().fg(FG_DIM).italic()
                };
                tool_spans.push(Span::styled(tool.clone(), style));
            }
            lines.push(Line::from(tool_spans));
        }

        for (event, target) in &state.transitions {
            let arrow_color = if is_current { BORDER_WARN } else { FG_DIM };
            lines.push(Line::from(vec![
                Span::styled(event.clone(), Style::default().fg(arrow_color)),
                Span::styled(" -> ", Style::default().fg(FG_DIM)),
                Span::styled(target.clone(), Style::default().fg(arrow_color)),
            ]));
        }

        frame.render_widget(Paragraph::new(lines), state_inner);
    }
}

fn render_event_log(frame: &mut Frame, app: &App, area: Rect) {
    let w = area.width.saturating_sub(4) as usize;
    let items: Vec<ListItem> = app.log.iter().map(|e| render_log_entry(e, w)).collect();

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(BORDER_INFO))
        .style(Style::default().bg(BG_PANEL))
        .title(Span::styled(
            " event log ",
            Style::default().fg(BORDER_INFO).bold(),
        ));

    let mut state = app.log_state.clone();
    frame.render_stateful_widget(List::new(items).block(block), area, &mut state);
}

fn render_log_entry(entry: &LogEntry, width: usize) -> ListItem<'static> {
    let tag_w = 8;
    let padded = format!("{:>w$}", entry.tag, w = tag_w);

    match &entry.style {
        LogStyle::Normal => {
            let is_reasoning = entry.tag.trim().is_empty();
            let msg_style = if is_reasoning {
                Style::default().fg(entry.color).italic()
            } else {
                Style::default().fg(FG_BRIGHT)
            };
            ListItem::new(Line::from(vec![
                Span::styled(padded, Style::default().fg(entry.color).bold()),
                Span::styled(if is_reasoning { "   " } else { " | " }, Style::default().fg(BORDER_INACTIVE)),
                Span::styled(entry.message.clone(), msg_style),
            ]))
        }
        LogStyle::Boxed { border_color } => {
            let bc = *border_color;
            let inner_w = width.saturating_sub(tag_w + 6).min(80);
            let hbar: String = "─".repeat(inner_w);
            let msg = truncate(&entry.message, inner_w.saturating_sub(2));
            let msg_pad = inner_w.saturating_sub(msg.chars().count() + 1);
            let pad = format!("{:>w$}", "", w = tag_w);

            ListItem::new(vec![
                Line::from(vec![
                    Span::styled(pad.clone(), Style::default()),
                    Span::styled(format!(" ┌{}┐", hbar), Style::default().fg(bc)),
                ]),
                Line::from(vec![
                    Span::styled(padded.clone(), Style::default().fg(entry.color).bold()),
                    Span::styled(" │ ", Style::default().fg(bc)),
                    Span::styled(msg, Style::default().fg(FG_BRIGHT).bold()),
                    Span::styled(format!("{:>w$}", "", w = msg_pad), Style::default()),
                    Span::styled("│", Style::default().fg(bc)),
                ]),
                Line::from(vec![
                    Span::styled(pad, Style::default()),
                    Span::styled(format!(" └{}┘", hbar), Style::default().fg(bc)),
                ]),
            ])
        }
        LogStyle::Diff { lines } => {
            let diff_w = width.saturating_sub(tag_w + 4).min(80);
            let pad = format!("{:>w$}", "", w = tag_w);

            let mut result = vec![
                Line::from(vec![
                    Span::styled(padded.clone(), Style::default().fg(entry.color).bold()),
                    Span::styled(" │ ", Style::default().fg(BORDER_WARN)),
                    Span::styled(entry.message.clone(), Style::default().fg(BORDER_WARN)),
                ]),
            ];

            for dl in lines {
                let (prefix, fg, bg) = match dl.kind {
                    DiffKind::Add =>    ("+ ", DIFF_ADD, Color::Rgb(0, 35, 0)),
                    DiffKind::Remove => ("- ", DIFF_DEL, Color::Rgb(50, 0, 0)),
                    DiffKind::Context => ("  ", FG_DIM, BG_PANEL),
                    DiffKind::Header =>  ("@@ ", DIFF_HDR, Color::Rgb(0, 20, 35)),
                };
                let text = truncate(&dl.text, diff_w.saturating_sub(4));
                let line_content = format!("{}{}", prefix, text);
                let fill = diff_w.saturating_sub(line_content.chars().count());
                result.push(Line::from(vec![
                    Span::styled(pad.clone(), Style::default()),
                    Span::styled(" ", Style::default()),
                    Span::styled(line_content, Style::default().fg(fg).bg(bg)),
                    Span::styled(format!("{:w$}", "", w = fill), Style::default().bg(bg)),
                ]));
            }

            ListItem::new(result)
        }
    }
}

fn render_status_bar(frame: &mut Frame, app: &App, area: Rect) {
    let (color, icon) = match app.success {
        Some(true) => (BORDER_ACTIVE, "ok"),
        Some(false) => (BORDER_DANGER, "fail"),
        None => (BORDER_WARN, ".."),
    };

    let status = Paragraph::new(Line::from(vec![
        Span::styled(format!(" [{}] ", icon), Style::default().fg(color).bold()),
        Span::styled(app.status.clone(), Style::default().fg(FG_BRIGHT)),
        Span::raw("  "),
        Span::styled("j/k", Style::default().fg(BORDER_WARN).bold()),
        Span::styled(" scroll  ", Style::default().fg(FG_DIM)),
        Span::styled("G", Style::default().fg(BORDER_WARN).bold()),
        Span::styled(" end  ", Style::default().fg(FG_DIM)),
        Span::styled("q", Style::default().fg(BORDER_DANGER).bold()),
        Span::styled(" quit", Style::default().fg(FG_DIM)),
    ]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Double)
            .border_style(Style::default().fg(BORDER_INFO))
            .style(Style::default().bg(BG_PANEL)),
    );

    frame.render_widget(status, area);
}

struct EditDiff {
    header: String,
    lines: Vec<DiffLine>,
}

/// Parse "L19 changed: 'return a // b' -> 'return a / b'" into a diff view
fn parse_edit_result(text: &str) -> Option<EditDiff> {
    // Format: "LN changed: 'old content' -> 'new content'"
    // Or multi-line: "LN changed: 'old' -> 'line1\n    line2'"
    let changed_idx = text.find("changed:")?;
    let header = text[..changed_idx].trim().to_string();
    let rest = text[changed_idx + "changed:".len()..].trim();

    // Split on " -> " — but the old/new content may contain " -> "
    // Find the pattern: 'old' -> 'new'
    let arrow_idx = rest.find("' -> '")?;
    let old_raw = &rest[1..arrow_idx]; // skip leading '
    let new_raw = &rest[arrow_idx + "' -> '".len()..];
    let new_raw = new_raw.strip_suffix('\'').unwrap_or(new_raw);

    let mut lines = Vec::new();
    lines.push(DiffLine { kind: DiffKind::Header, text: header.clone() });

    for line in old_raw.split("\\n") {
        lines.push(DiffLine { kind: DiffKind::Remove, text: line.to_string() });
    }
    for line in new_raw.split("\\n") {
        lines.push(DiffLine { kind: DiffKind::Add, text: line.to_string() });
    }

    Some(EditDiff { header, lines })
}

fn parse_diff_lines(text: &str) -> Vec<DiffLine> {
    text.lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let kind = if trimmed.starts_with("+ ") && !trimmed.starts_with("+++ ") {
                DiffKind::Add
            } else if trimmed.starts_with("- ") && !trimmed.starts_with("--- ") {
                DiffKind::Remove
            } else if trimmed.starts_with("@@") {
                DiffKind::Header
            } else {
                DiffKind::Context
            };
            DiffLine { kind, text: trimmed.to_string() }
        })
        .collect()
}

pub fn render_menu(frame: &mut Frame, selected: usize) {
    let bg = Block::default().style(Style::default().bg(BG_PANEL));
    frame.render_widget(bg, frame.area());

    let vert = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(32),
        Constraint::Fill(1),
    ]).split(frame.area());

    let horiz = Layout::horizontal([
        Constraint::Fill(1),
        Constraint::Length(76),
        Constraint::Fill(1),
    ]).split(vert[1]);

    let area = horiz[1];

    let choices = [
        ("1", "buggy-calc", "26 lines, division bug — warmup", "~30s"),
        ("2", "sympy-22914", "640 lines — add Min/Max to printer", "~2m"),
        ("3", "requests-1963", "571 lines — redirect chain bug", "~2m"),
        ("4", "pytest-5262", "844 lines — EncodedFile mode property", "~3m"),
        ("5", "sympy-21847", "636 lines — monomial degree (may not converge)", "~3m"),
    ];

    let soft = Color::Rgb(160, 165, 180);

    let mut lines: Vec<Line> = vec![
        Line::raw(""),
        Line::from(vec![
            Span::styled("  statewright", Style::default().fg(BORDER_ACTIVE).bold()),
            Span::styled(" demo", Style::default().fg(soft)),
        ]),
        Line::raw(""),
        Line::from(Span::styled("  The state machine doesn't make the model smarter.", Style::default().fg(soft))),
        Line::from(Span::styled("  It prevents the failure modes that make smart models unreliable.", Style::default().fg(soft))),
        Line::raw(""),
        Line::from(vec![
            Span::styled("  Without guardrails, small models enter read-loop death spirals —", Style::default().fg(soft)),
        ]),
        Line::from(vec![
            Span::styled("  reading the same file repeatedly without ever editing it.", Style::default().fg(soft)),
        ]),
        Line::from(vec![
            Span::styled("  Phase transitions, tool restriction, and programmatic localization", Style::default().fg(soft)),
        ]),
        Line::from(vec![
            Span::styled("  break these loops. ", Style::default().fg(soft)),
            Span::styled("14/15 with guardrails. 3/15 without.", Style::default().fg(BORDER_ACTIVE)),
        ]),
        Line::raw(""),
        Line::from(Span::styled("  choose a task:", Style::default().fg(Color::Rgb(200, 205, 215)))),
        Line::raw(""),
    ];

    for (i, (key, name, desc, time)) in choices.iter().enumerate() {
        let is_sel = i == selected;
        let is_unstable = i == choices.len() - 1;
        let (indicator, style) = if is_sel && is_unstable {
            ("> ", Style::default().fg(BORDER_WARN).bold())
        } else if is_sel {
            ("> ", Style::default().fg(BORDER_ACTIVE).bold())
        } else if is_unstable {
            ("  ", Style::default().fg(BORDER_WARN))
        } else {
            ("  ", Style::default().fg(FG_BRIGHT))
        };
        let warn_icon = if is_unstable { " !" } else { "" };
        lines.push(Line::from(vec![
            Span::styled(format!("  {}[{}] ", indicator, key), style),
            Span::styled(*name, style),
            Span::styled(warn_icon, Style::default().fg(BORDER_WARN).bold()),
        ]));
        lines.push(Line::from(vec![
            Span::raw("      "),
            Span::styled(*desc, Style::default().fg(if is_unstable { BORDER_WARN } else { FG_DIM })),
            Span::styled(format!("  {}", time), Style::default().fg(FG_DIM).italic()),
        ]));
        lines.push(Line::raw(""));
    }

    lines.push(Line::from(Span::styled("  enter to start, q to quit", Style::default().fg(FG_DIM))));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(BORDER_INFO))
        .style(Style::default().bg(BG_PANEL));

    frame.render_widget(Paragraph::new(lines).block(block), area);
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let end = s.char_indices()
            .take_while(|(i, _)| *i <= max)
            .last()
            .map(|(i, _)| i)
            .unwrap_or(max);
        format!("{}...", &s[..end])
    }
}
