pub fn patch_has_authoritative_source(changed_files: &[String], changed_lines: usize) -> bool {
    changed_lines > 0
        && !changed_files.is_empty()
        && changed_files
            .iter()
            .all(|path| is_authoritative_source_path(path))
}

pub fn non_authoritative_patch_paths(changed_files: &[String]) -> Vec<String> {
    changed_files
        .iter()
        .filter(|path| !is_authoritative_source_path(path))
        .cloned()
        .collect()
}

pub fn is_authoritative_source_path(path: &str) -> bool {
    let normalized = normalize_path(path);
    if normalized.is_empty() {
        return false;
    }
    if is_generated_or_build_path(&normalized) {
        return false;
    }
    if is_test_path(&normalized) {
        return false;
    }
    true
}

pub fn is_test_path(path: &str) -> bool {
    let normalized = normalize_path(path);
    normalized.contains("/tests/")
        || normalized.starts_with("tests/")
        || normalized.ends_with("_test.py")
        || normalized.ends_with("_tests.py")
        || normalized.starts_with("test_")
        || normalized.contains("/test_")
}

fn is_generated_or_build_path(path: &str) -> bool {
    let prefixes = [
        ".eggs/",
        ".mypy_cache/",
        ".pytest_cache/",
        ".tox/",
        ".venv/",
        "__pycache__/",
        "build/",
        "dist/",
        "node_modules/",
        "site-packages/",
        "target/",
        "venv/",
    ];
    prefixes.iter().any(|prefix| path.starts_with(prefix))
        || path.contains("/__pycache__/")
        || path.contains("/build/")
        || path.contains("/dist/")
        || path.contains("/node_modules/")
        || path.contains("/site-packages/")
        || path.ends_with(".egg-info")
        || path.contains(".egg-info/")
}

fn normalize_path(path: &str) -> String {
    path.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_start_matches("a/")
        .trim_start_matches("b/")
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_build_paths_are_not_authoritative() {
        assert!(!is_authoritative_source_path(
            "build/lib/django/core/validators.py"
        ));
        assert!(!is_authoritative_source_path("pkg/__pycache__/mod.pyc"));
        assert!(!is_authoritative_source_path(
            ".tox/py/lib/python/site-packages/pkg/mod.py"
        ));
    }

    #[test]
    fn tests_are_not_authoritative_patch_targets() {
        assert!(!is_authoritative_source_path("tests/test_model.py"));
        assert!(!is_authoritative_source_path("pkg/tests/test_model.py"));
        assert!(!is_authoritative_source_path("pkg/model_tests.py"));
    }

    #[test]
    fn source_paths_are_authoritative() {
        assert!(is_authoritative_source_path("django/core/validators.py"));
        assert!(is_authoritative_source_path(
            "astropy/nddata/mixins/ndarithmetic.py"
        ));
    }
}
