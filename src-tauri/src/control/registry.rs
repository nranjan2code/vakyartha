//! Native project, workspace and binding identities.
//!
//! Projects are organizational records. A workspace identifies one physical
//! source folder. A session binding grants a revision-fenced workspace/mode.
//! Keep this state inside the control actor's durable snapshot when wiring it;
//! do not add a second registry file or leave a TypeScript writer active.
use super::folder::FolderIdentity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

const MAX_PROJECTS: usize = 10_000;
const MAX_WORKSPACES: usize = 10_000;
const MAX_BINDINGS: usize = 100_000;
const MAX_NAME_BYTES: usize = 400;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    CopyReview,
    Direct,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingState {
    Admitted,
    Revoked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectRecord {
    id: String,
    name: String,
    preferred_workspace: Option<String>,
    revision: u64,
}

impl ProjectRecord {
    pub fn new(id: String, name: String) -> Result<Self, RegistryError> {
        valid_id(&id)?;
        validate_name(&name)?;
        Ok(Self {
            id,
            name,
            preferred_workspace: None,
            revision: 1,
        })
    }

    pub fn set_preferred_workspace(
        &mut self,
        expected_revision: u64,
        workspace_id: Option<String>,
        registry: &RegistryState,
    ) -> Result<(), RegistryError> {
        check_revision(self.revision, expected_revision)?;
        if let Some(workspace_id) = &workspace_id {
            valid_id(workspace_id)?;
            if !registry.workspaces.contains_key(workspace_id) {
                return Err(RegistryError::WorkspaceNotFound);
            }
        }
        self.preferred_workspace = workspace_id;
        self.revision = next_revision(self.revision)?;
        Ok(())
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceRecord {
    id: String,
    canonical_path: PathBuf,
    identity: FolderIdentity,
    revision: u64,
}

impl WorkspaceRecord {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceBinding {
    id: String,
    session_id: String,
    workspace_id: String,
    realm_id: Option<String>,
    mode: WorkspaceMode,
    revision: u64,
    state: BindingState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectMembership {
    session_id: String,
    project_id: Option<String>,
    revision: u64,
}

impl ProjectMembership {
    pub fn project_id(&self) -> Option<&str> {
        self.project_id.as_deref()
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

impl WorkspaceBinding {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn state(&self) -> BindingState {
        self.state
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceGrant {
    pub binding_id: String,
    pub binding_revision: u64,
    pub session_id: String,
    pub workspace_id: String,
    pub canonical_path: PathBuf,
    pub folder_identity: FolderIdentity,
    pub realm_id: Option<String>,
    pub mode: WorkspaceMode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegistryError {
    InvalidIdentity,
    InvalidName,
    DuplicateIdentity,
    ProjectNotFound,
    WorkspaceNotFound,
    BindingNotFound,
    RevisionConflict,
    IdentityChanged,
    BindingRevoked,
    LimitReached,
    Corrupt,
    Io(String),
}

impl From<io::Error> for RegistryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryState {
    projects: BTreeMap<String, ProjectRecord>,
    workspaces: BTreeMap<String, WorkspaceRecord>,
    bindings: BTreeMap<String, WorkspaceBinding>,
    memberships: BTreeMap<String, ProjectMembership>,
}

impl RegistryState {
    pub fn membership(&self, session_id: &str) -> Option<ProjectMembership> {
        self.memberships.get(session_id).cloned()
    }

    pub fn create_project(&mut self, project: ProjectRecord) -> Result<(), RegistryError> {
        if self.projects.len() >= MAX_PROJECTS {
            return Err(RegistryError::LimitReached);
        }
        let id = project.id.clone();
        if self.projects.contains_key(&id) {
            return Err(RegistryError::DuplicateIdentity);
        }
        self.projects.insert(id, project);
        Ok(())
    }

    pub fn register_workspace(
        &mut self,
        id: String,
        path: &Path,
    ) -> Result<WorkspaceRecord, RegistryError> {
        valid_id(&id)?;
        if self.workspaces.len() >= MAX_WORKSPACES {
            return Err(RegistryError::LimitReached);
        }
        if self.workspaces.contains_key(&id) {
            return Err(RegistryError::DuplicateIdentity);
        }
        let (canonical_path, identity) = FolderIdentity::capture(path)?;
        if self
            .workspaces
            .values()
            .any(|workspace| workspace.identity == identity)
        {
            return Err(RegistryError::DuplicateIdentity);
        }
        let record = WorkspaceRecord {
            id: id.clone(),
            canonical_path,
            identity,
            revision: 1,
        };
        self.workspaces.insert(id, record.clone());
        Ok(record)
    }

    pub fn bind(
        &mut self,
        id: String,
        session_id: String,
        workspace_id: String,
        realm_id: Option<String>,
        mode: WorkspaceMode,
    ) -> Result<WorkspaceBinding, RegistryError> {
        valid_id(&id)?;
        valid_id(&session_id)?;
        valid_id(&workspace_id)?;
        if let Some(realm_id) = &realm_id {
            valid_id(realm_id)?;
        }
        if !self.workspaces.contains_key(&workspace_id) {
            return Err(RegistryError::WorkspaceNotFound);
        }
        if self.bindings.len() >= MAX_BINDINGS || self.bindings.contains_key(&session_id) {
            return Err(if self.bindings.contains_key(&session_id) {
                RegistryError::DuplicateIdentity
            } else {
                RegistryError::LimitReached
            });
        }
        let binding = WorkspaceBinding {
            id,
            session_id: session_id.clone(),
            workspace_id,
            realm_id,
            mode,
            revision: 1,
            state: BindingState::Admitted,
        };
        self.bindings.insert(session_id, binding.clone());
        Ok(binding)
    }

    pub fn set_membership(
        &mut self,
        session_id: String,
        project_id: Option<String>,
        expected_revision: Option<u64>,
    ) -> Result<ProjectMembership, RegistryError> {
        valid_id(&session_id)?;
        if let Some(project_id) = &project_id {
            valid_id(project_id)?;
            if !self.projects.contains_key(project_id) {
                return Err(RegistryError::ProjectNotFound);
            }
        }
        let revision = match (self.memberships.get(&session_id), expected_revision) {
            (None, None) => 1,
            (Some(current), Some(expected)) if current.revision == expected => {
                next_revision(current.revision)?
            }
            _ => return Err(RegistryError::RevisionConflict),
        };
        let membership = ProjectMembership {
            session_id: session_id.clone(),
            project_id,
            revision,
        };
        self.memberships.insert(session_id, membership.clone());
        Ok(membership)
    }

    /// Explicitly revoke a grant. Filesystem availability checks never restore it.
    pub fn revoke(
        &mut self,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<WorkspaceBinding, RegistryError> {
        let binding = self
            .bindings
            .get_mut(session_id)
            .ok_or(RegistryError::BindingNotFound)?;
        check_revision(binding.revision, expected_revision)?;
        binding.state = BindingState::Revoked;
        binding.revision = next_revision(binding.revision)?;
        Ok(binding.clone())
    }

    /// Explicit user rebinding is the only operation that can restore a revoked grant.
    pub fn rebind(
        &mut self,
        session_id: &str,
        expected_revision: u64,
        workspace_id: String,
        realm_id: Option<String>,
        mode: WorkspaceMode,
    ) -> Result<WorkspaceBinding, RegistryError> {
        valid_id(&workspace_id)?;
        if !self.workspaces.contains_key(&workspace_id) {
            return Err(RegistryError::WorkspaceNotFound);
        }
        if let Some(realm_id) = &realm_id {
            valid_id(realm_id)?;
        }
        let binding = self
            .bindings
            .get_mut(session_id)
            .ok_or(RegistryError::BindingNotFound)?;
        check_revision(binding.revision, expected_revision)?;
        binding.workspace_id = workspace_id;
        binding.realm_id = realm_id;
        binding.mode = mode;
        binding.state = BindingState::Admitted;
        binding.revision = next_revision(binding.revision)?;
        Ok(binding.clone())
    }

    /// Resolve only the exact admitted revision and recheck its physical folder.
    pub fn grant(
        &self,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<WorkspaceGrant, RegistryError> {
        let binding = self
            .bindings
            .get(session_id)
            .ok_or(RegistryError::BindingNotFound)?;
        check_revision(binding.revision, expected_revision)?;
        if binding.state != BindingState::Admitted {
            return Err(RegistryError::BindingRevoked);
        }
        let workspace = self
            .workspaces
            .get(&binding.workspace_id)
            .ok_or(RegistryError::WorkspaceNotFound)?;
        if !workspace.identity.still_names(&workspace.canonical_path)? {
            return Err(RegistryError::IdentityChanged);
        }
        Ok(WorkspaceGrant {
            binding_id: binding.id.clone(),
            binding_revision: binding.revision,
            session_id: binding.session_id.clone(),
            workspace_id: workspace.id.clone(),
            canonical_path: workspace.canonical_path.clone(),
            folder_identity: workspace.identity.clone(),
            realm_id: binding.realm_id.clone(),
            mode: binding.mode,
        })
    }

    pub fn validate(&self) -> Result<(), RegistryError> {
        if self.projects.len() > MAX_PROJECTS
            || self.workspaces.len() > MAX_WORKSPACES
            || self.bindings.len() > MAX_BINDINGS
            || self.memberships.len() > MAX_BINDINGS
        {
            return Err(RegistryError::Corrupt);
        }
        for (id, project) in &self.projects {
            if valid_id(id).is_err()
                || id != &project.id
                || project.revision == 0
                || validate_name(&project.name).is_err()
                || project
                    .preferred_workspace
                    .as_ref()
                    .is_some_and(|workspace| !self.workspaces.contains_key(workspace))
            {
                return Err(RegistryError::Corrupt);
            }
        }
        for (id, workspace) in &self.workspaces {
            if valid_id(id).is_err()
                || id != &workspace.id
                || workspace.revision == 0
                || !workspace.canonical_path.is_absolute()
                || workspace.identity.validate().is_err()
            {
                return Err(RegistryError::Corrupt);
            }
        }
        for (session_id, binding) in &self.bindings {
            if session_id != &binding.session_id
                || valid_id(session_id).is_err()
                || valid_id(&binding.id).is_err()
                || binding.revision == 0
                || valid_id(&binding.workspace_id).is_err()
                || !self.workspaces.contains_key(&binding.workspace_id)
                || binding
                    .realm_id
                    .as_ref()
                    .is_some_and(|realm| valid_id(realm).is_err())
            {
                return Err(RegistryError::Corrupt);
            }
        }
        for (session_id, membership) in &self.memberships {
            if session_id != &membership.session_id
                || valid_id(session_id).is_err()
                || membership.revision == 0
                || membership.project_id.as_ref().is_some_and(|project| {
                    valid_id(project).is_err() || !self.projects.contains_key(project)
                })
            {
                return Err(RegistryError::Corrupt);
            }
        }
        Ok(())
    }
}

fn validate_name(name: &str) -> Result<(), RegistryError> {
    if name.trim().is_empty() || name.len() > MAX_NAME_BYTES {
        return Err(RegistryError::InvalidName);
    }
    Ok(())
}

fn valid_id(value: &str) -> Result<(), RegistryError> {
    if (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err(RegistryError::InvalidIdentity)
    }
}

fn check_revision(actual: u64, expected: u64) -> Result<(), RegistryError> {
    if actual == expected {
        Ok(())
    } else {
        Err(RegistryError::RevisionConflict)
    }
}

fn next_revision(revision: u64) -> Result<u64, RegistryError> {
    revision.checked_add(1).ok_or(RegistryError::Corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("vakyartha-registry-{}-{id}", std::process::id()));
        fs::create_dir(&path).expect("temporary directory can be created");
        path
    }

    #[test]
    fn project_can_exist_without_workspace_and_binding_is_revision_fenced() {
        let mut state = RegistryState::default();
        state
            .create_project(ProjectRecord::new("project-0001".into(), "Research".into()).unwrap())
            .unwrap();
        state.validate().unwrap();
        let path = temp_dir();
        state
            .register_workspace("workspace-01".into(), &path)
            .unwrap();
        let binding = state
            .bind(
                "binding-001".into(),
                "session-001".into(),
                "workspace-01".into(),
                None,
                WorkspaceMode::CopyReview,
            )
            .unwrap();
        assert!(state.grant("session-001", 2).is_err());
        let grant = state.grant("session-001", binding.revision).unwrap();
        assert!(grant.realm_id.is_none());
        let membership = state
            .set_membership("session-001".into(), Some("project-0001".into()), None)
            .unwrap();
        assert_eq!(membership.project_id(), Some("project-0001"));
        assert!(
            state
                .set_membership("session-001".into(), None, Some(membership.revision() + 1))
                .is_err()
        );
        let ungrouped = state
            .set_membership("session-001".into(), None, Some(membership.revision()))
            .unwrap();
        assert_eq!(ungrouped.project_id(), None);
        state.revoke("session-001", 1).unwrap();
        assert_eq!(
            state.grant("session-001", 2),
            Err(RegistryError::BindingRevoked)
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn a_path_replacement_does_not_inherit_a_bound_workspace_identity() {
        let mut state = RegistryState::default();
        let path = temp_dir();
        let workspace = state
            .register_workspace("workspace-02".into(), &path)
            .unwrap();
        fs::remove_dir_all(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_ne!(
            workspace.identity,
            FolderIdentity::capture(&path).unwrap().1
        );
    }

    #[test]
    fn only_an_explicit_revision_checked_rebind_restores_a_revoked_grant() {
        let mut state = RegistryState::default();
        let first = temp_dir();
        let second = temp_dir();
        state
            .register_workspace("workspace-03".into(), &first)
            .unwrap();
        state
            .register_workspace("workspace-04".into(), &second)
            .unwrap();
        let binding = state
            .bind(
                "binding-003".into(),
                "session-003".into(),
                "workspace-03".into(),
                None,
                WorkspaceMode::Direct,
            )
            .unwrap();
        let revoked = state.revoke("session-003", binding.revision).unwrap();
        assert_eq!(
            state.grant("session-003", revoked.revision),
            Err(RegistryError::BindingRevoked)
        );
        assert_eq!(
            state.rebind(
                "session-003",
                binding.revision,
                "workspace-04".into(),
                None,
                WorkspaceMode::CopyReview,
            ),
            Err(RegistryError::RevisionConflict)
        );
        let rebound = state
            .rebind(
                "session-003",
                revoked.revision,
                "workspace-04".into(),
                None,
                WorkspaceMode::CopyReview,
            )
            .unwrap();
        assert_eq!(rebound.revision(), revoked.revision + 1);
        assert_eq!(
            state
                .grant("session-003", rebound.revision())
                .unwrap()
                .workspace_id,
            "workspace-04"
        );
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }
}
