use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use statewright_engine::MachineDefinition;

/// A parked transition awaiting human approval.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingApproval {
    pub approval_id: String,
    pub event: String,
    pub from_state: String,
    pub to_state: String,
    pub new_context: serde_json::Value,
    pub message: Option<String>,
}

/// Parent snapshot retained while a named child workflow is executing.
#[derive(Debug, Clone)]
pub struct ActiveSubflow {
    pub name: String,
    pub parent_definition: MachineDefinition,
    pub parent_state: String,
    pub parent_context: serde_json::Value,
    pub on_complete: String,
    pub on_fail: Option<String>,
}

/// Active gateway session tracking state machine progression.
#[derive(Debug, Clone)]
pub struct GatewaySession {
    pub instance_id: String,
    pub definition: MachineDefinition,
    pub current_state: String,
    pub previous_state: Option<String>,
    pub context: serde_json::Value,
    pub iteration_count: u32,
    pub transition_count: u64,
    /// Plan transition limit (None = unlimited / self-hosted).
    pub plan_limit: Option<u64>,
    /// Files edited in current state (resets on transition).
    pub files_edited: Vec<String>,
    /// Total bytes of tool results in current state (resets on transition).
    pub context_bytes: u64,
    /// Files read in current state for dedup detection.
    pub files_read: std::collections::HashMap<String, u32>,
    /// Pending approval gate — transition parked until human approves/rejects.
    pub pending_approval: Option<PendingApproval>,
    /// Set while a named invoked workflow owns this session's current state.
    pub subflow: Option<ActiveSubflow>,
}

impl GatewaySession {
    pub fn new(instance_id: String, definition: MachineDefinition) -> Self {
        let initial = definition.initial.clone();
        // Ensure context is always an object, never null — downstream code uses as_object_mut()
        let context = if definition.context.is_object() {
            definition.context.clone()
        } else {
            serde_json::json!({})
        };
        Self {
            instance_id,
            definition,
            current_state: initial,
            previous_state: None,
            context,
            iteration_count: 0,
            transition_count: 0,
            plan_limit: None,
            files_edited: Vec::new(),
            context_bytes: 0,
            files_read: std::collections::HashMap::new(),
            pending_approval: None,
            subflow: None,
        }
    }

    /// Usage info for metering. Returns (used, limit, percentage).
    pub fn usage(&self) -> (u64, Option<u64>, Option<f64>) {
        let pct = self.plan_limit.map(|limit| {
            if limit == 0 {
                100.0
            } else {
                (self.transition_count as f64 / limit as f64) * 100.0
            }
        });
        (self.transition_count, self.plan_limit, pct)
    }

    /// Warning message if approaching plan limit.
    pub fn usage_warning(&self) -> Option<String> {
        let (used, limit, pct) = self.usage();
        match (limit, pct) {
            (Some(l), Some(p)) if p >= 100.0 => Some(format!(
                "Plan limit reached ({}/{}). Upgrade to continue.",
                used, l
            )),
            (Some(l), Some(p)) if p >= 95.0 => Some(format!(
                "Warning: 95% of plan limit ({}/{}). Consider upgrading.",
                used, l
            )),
            (Some(l), Some(p)) if p >= 90.0 => {
                Some(format!("Notice: 90% of plan limit ({}/{}).", used, l))
            }
            (Some(l), Some(p)) if p >= 80.0 => {
                Some(format!("Notice: 80% of plan limit ({}/{}).", used, l))
            }
            _ => None,
        }
    }

    pub fn max_iterations(&self) -> Option<u32> {
        self.definition
            .states
            .get(&self.current_state)
            .and_then(|s| s.max_iterations)
    }

    pub fn is_checkpoint(&self) -> bool {
        self.max_iterations()
            .is_some_and(|max| self.iteration_count >= max)
    }

    pub fn is_final(&self) -> bool {
        self.definition
            .states
            .get(&self.current_state)
            .and_then(|s| s.state_type.as_ref())
            .is_some_and(|t| matches!(t, statewright_engine::StateType::Final))
    }
}

/// Thread-safe session store.
#[derive(Debug, Clone)]
pub struct SessionManager {
    sessions: Arc<RwLock<HashMap<String, GatewaySession>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn create(&self, instance_id: String, definition: MachineDefinition) -> GatewaySession {
        let session = GatewaySession::new(instance_id.clone(), definition);
        let mut sessions = self.sessions.write().unwrap();
        // Don't overwrite a session with an active fork — the fork handler stored _fork
        // in the context and overwriting would lose it (race between load_workflow and fork)
        if let Some(existing) = sessions.get(&instance_id) {
            if existing.context.get("_fork").is_some() {
                return existing.clone();
            }
        }
        sessions.insert(instance_id, session.clone());
        session
    }

    pub fn get(&self, instance_id: &str) -> Option<GatewaySession> {
        self.sessions
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(instance_id)
            .cloned()
    }

    pub fn exists(&self, instance_id: &str) -> bool {
        self.sessions
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(instance_id)
    }

    pub fn update_state(
        &self,
        instance_id: &str,
        new_state: String,
        new_context: serde_json::Value,
    ) -> bool {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            session.previous_state = Some(session.current_state.clone());
            session.current_state = new_state;
            session.context = new_context;
            session.iteration_count = 0;
            session.transition_count += 1;
            session.files_edited.clear();
            session.context_bytes = 0;
            session.files_read.clear();
            true
        } else {
            false
        }
    }

    /// Suspend the current workflow and make a named child workflow active.
    pub fn start_subflow(
        &self,
        instance_id: &str,
        name: String,
        definition: MachineDefinition,
        input: serde_json::Value,
        on_complete: String,
        on_fail: Option<String>,
    ) -> bool {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            let mut context = if definition.context.is_object() {
                definition.context.clone()
            } else {
                serde_json::json!({})
            };
            if input.is_object() {
                context = statewright_engine::apply_context_patch(&context, &input);
            }
            session.subflow = Some(ActiveSubflow {
                name,
                parent_definition: session.definition.clone(),
                parent_state: session.current_state.clone(),
                parent_context: session.context.clone(),
                on_complete,
                on_fail,
            });
            session.definition = definition.clone();
            session.previous_state = None;
            session.current_state = definition.initial.clone();
            session.context = context;
            session.iteration_count = 0;
            session.files_edited.clear();
            session.context_bytes = 0;
            session.files_read.clear();
            true
        } else {
            false
        }
    }

    /// Restore the suspended parent after its child reaches a final state.
    pub fn complete_subflow(&self, instance_id: &str, succeeded: bool) -> Option<(String, String)> {
        let mut sessions = self.sessions.write().unwrap_or_else(|p| p.into_inner());
        let session = sessions.get_mut(instance_id)?;
        let subflow = session.subflow.take()?;
        let from = session.current_state.clone();
        let target = if succeeded {
            subflow.on_complete
        } else {
            subflow.on_fail.unwrap_or_else(|| "failed".to_string())
        };
        let context =
            statewright_engine::apply_context_patch(&subflow.parent_context, &session.context);
        session.definition = subflow.parent_definition;
        session.previous_state = Some(subflow.parent_state);
        session.current_state = target.clone();
        session.context = context;
        session.iteration_count = 0;
        session.files_edited.clear();
        session.context_bytes = 0;
        session.files_read.clear();
        Some((from, target))
    }

    pub fn record_file_edit(&self, instance_id: &str, file_path: &str) {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            if !session.files_edited.contains(&file_path.to_string()) {
                session.files_edited.push(file_path.to_string());
            }
        }
    }

    pub fn record_file_read(&self, instance_id: &str, file_path: &str) -> u32 {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            let count = session.files_read.entry(file_path.to_string()).or_insert(0);
            *count += 1;
            *count
        } else {
            1
        }
    }

    pub fn add_context_bytes(&self, instance_id: &str, bytes: u64) -> u64 {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            session.context_bytes += bytes;
            session.context_bytes
        } else {
            0
        }
    }

    pub fn set_plan_limit(&self, instance_id: &str, limit: u64) {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            session.plan_limit = Some(limit);
        }
    }

    pub fn increment_iteration(&self, instance_id: &str) -> Option<u32> {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            session.iteration_count += 1;
            Some(session.iteration_count)
        } else {
            None
        }
    }

    pub fn set_pending_approval(&self, instance_id: &str, pending: PendingApproval) {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            session.pending_approval = Some(pending);
        }
    }

    pub fn clear_pending_approval(&self, instance_id: &str) -> Option<PendingApproval> {
        if let Some(session) = self
            .sessions
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(instance_id)
        {
            session.pending_approval.take()
        } else {
            None
        }
    }

    pub fn has_pending_approval(&self, instance_id: &str) -> bool {
        self.sessions
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(instance_id)
            .is_some_and(|s| s.pending_approval.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_definition() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "test",
            "initial": "planning",
            "states": {
                "planning": {
                    "allowed_tools": ["read_file", "grep"],
                    "max_iterations": 5,
                    "on": { "READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["read_file", "edit_file", "write_file"],
                    "max_iterations": 10,
                    "on": { "DONE": "testing", "FAIL": "failed" }
                },
                "testing": {
                    "allowed_tools": ["read_file", "run_test"],
                    "on": { "PASS": "completed", "FAIL_TEST": "implementing" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    #[test]
    fn create_session_sets_initial_state() {
        let mgr = SessionManager::new();
        let session = mgr.create("s1".into(), test_definition());
        assert_eq!(session.current_state, "planning");
        assert_eq!(session.iteration_count, 0);
        assert_eq!(session.transition_count, 0);
    }

    #[test]
    fn get_returns_created_session() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        let session = mgr.get("s1").unwrap();
        assert_eq!(session.current_state, "planning");
    }

    #[test]
    fn get_returns_none_for_unknown() {
        let mgr = SessionManager::new();
        assert!(mgr.get("nonexistent").is_none());
    }

    #[test]
    fn increment_iteration() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        assert_eq!(mgr.increment_iteration("s1"), Some(1));
        assert_eq!(mgr.increment_iteration("s1"), Some(2));
        let session = mgr.get("s1").unwrap();
        assert_eq!(session.iteration_count, 2);
    }

    #[test]
    fn update_state_resets_iterations() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        mgr.increment_iteration("s1");
        mgr.increment_iteration("s1");
        mgr.increment_iteration("s1");

        mgr.update_state("s1", "implementing".into(), json!({}));

        let session = mgr.get("s1").unwrap();
        assert_eq!(session.current_state, "implementing");
        assert_eq!(session.iteration_count, 0);
        assert_eq!(session.transition_count, 1);
    }

    #[test]
    fn is_checkpoint_at_max_iterations() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        // planning has max_iterations: 5
        for _ in 0..4 {
            mgr.increment_iteration("s1");
        }
        let session = mgr.get("s1").unwrap();
        assert!(!session.is_checkpoint()); // 4 < 5

        mgr.increment_iteration("s1");
        let session = mgr.get("s1").unwrap();
        assert!(session.is_checkpoint()); // 5 >= 5
    }

    #[test]
    fn is_final_state() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        let session = mgr.get("s1").unwrap();
        assert!(!session.is_final());

        mgr.update_state("s1", "completed".into(), json!({}));
        let session = mgr.get("s1").unwrap();
        assert!(session.is_final());
    }

    // --- Approval gate tests ---

    #[test]
    fn pending_approval_initially_none() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        let session = mgr.get("s1").unwrap();
        assert!(session.pending_approval.is_none());
    }

    #[test]
    fn set_pending_approval() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        let pending = PendingApproval {
            approval_id: "apr_123".into(),
            event: "DEPLOY".into(),
            from_state: "testing".into(),
            to_state: "deploying".into(),
            new_context: json!({"test_result": "pass"}),
            message: Some("Review before deploy".into()),
        };
        mgr.set_pending_approval("s1", pending);
        let session = mgr.get("s1").unwrap();
        assert!(session.pending_approval.is_some());
        let p = session.pending_approval.unwrap();
        assert_eq!(p.approval_id, "apr_123");
        assert_eq!(p.from_state, "testing");
        assert_eq!(p.to_state, "deploying");
    }

    #[test]
    fn clear_pending_approval_returns_pending() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        let pending = PendingApproval {
            approval_id: "apr_456".into(),
            event: "DEPLOY".into(),
            from_state: "testing".into(),
            to_state: "deploying".into(),
            new_context: json!({}),
            message: None,
        };
        mgr.set_pending_approval("s1", pending);
        let cleared = mgr.clear_pending_approval("s1");
        assert!(cleared.is_some());
        assert_eq!(cleared.unwrap().approval_id, "apr_456");
        // After clearing, session has no pending
        let session = mgr.get("s1").unwrap();
        assert!(session.pending_approval.is_none());
    }

    #[test]
    fn clear_pending_approval_returns_none_when_empty() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        let cleared = mgr.clear_pending_approval("s1");
        assert!(cleared.is_none());
    }

    #[test]
    fn has_pending_approval() {
        let mgr = SessionManager::new();
        mgr.create("s1".into(), test_definition());
        assert!(!mgr.has_pending_approval("s1"));
        mgr.set_pending_approval(
            "s1",
            PendingApproval {
                approval_id: "apr_789".into(),
                event: "DEPLOY".into(),
                from_state: "testing".into(),
                to_state: "deploying".into(),
                new_context: json!({}),
                message: None,
            },
        );
        assert!(mgr.has_pending_approval("s1"));
    }
}
