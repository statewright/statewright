"""Test that resolve_redirects updates req each iteration."""
import sys, os

fixture_dir = os.path.dirname(os.path.abspath(__file__))

def test_redirect_req_updated():
    """The resolve_redirects loop must set req = prepared_request before send()."""
    with open(os.path.join(fixture_dir, "sessions.py")) as f:
        source = f.read()

    # Find the resolve_redirects method
    assert "def resolve_redirects" in source

    # The fix adds "req = prepared_request" in the redirect loop
    # Find it between "prepare_auth" and "self.send("
    idx_auth = source.find("prepare_auth(new_auth)")
    idx_send = source.find("resp = self.send(", idx_auth if idx_auth > 0 else 0)

    if idx_auth > 0 and idx_send > 0:
        between = source[idx_auth:idx_send]
        assert "req = prepared_request" in between, \
            "resolve_redirects must update req = prepared_request before self.send()"
    else:
        # Fallback: just check it exists anywhere in the method
        method_start = source.find("def resolve_redirects")
        method_body = source[method_start:method_start + 5000]
        assert "req = prepared_request" in method_body, \
            "resolve_redirects must contain req = prepared_request"
