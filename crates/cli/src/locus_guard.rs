use std::collections::HashSet;
use std::path::Path;

pub fn is_package_adjacent_source(target: &str, allowed: &HashSet<String>) -> bool {
    let target = normalize(target);
    let Some(parent) = Path::new(&target).parent() else {
        return false;
    };
    if parent.as_os_str().is_empty() {
        return false;
    }

    allowed.iter().any(|candidate| {
        let candidate = normalize(candidate);
        Path::new(&candidate).parent() == Some(parent)
    })
}

fn normalize(path: &str) -> String {
    path.trim().trim_start_matches("./").replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_existing_source_lateral_move_within_grounded_package() {
        let allowed = HashSet::from([
            "django/db/models/fields/__init__.py".to_string(),
            "django/forms/fields.py".to_string(),
        ]);
        assert!(is_package_adjacent_source(
            "django/db/models/fields/related.py",
            &allowed
        ));
        assert!(is_package_adjacent_source(
            "./django/db/models/fields/related_descriptors.py",
            &allowed
        ));
    }

    #[test]
    fn rejects_root_siblings_and_unrelated_packages() {
        let allowed = HashSet::from([
            "django/db/models/fields/__init__.py".to_string(),
            "README.md".to_string(),
        ]);
        assert!(!is_package_adjacent_source("orders/models.py", &allowed));
        assert!(!is_package_adjacent_source("setup.py", &allowed));
    }
}
