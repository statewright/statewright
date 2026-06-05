# POST redirect chain loses method change

`Session.resolve_redirects` copies the original request at the start of each redirect iteration but never updates the `req` variable. After a 303 (POST→GET conversion), the next iteration copies the original POST again. A subsequent 307 (preserve method) then incorrectly sends a POST instead of GET.

The fix: add `req = prepared_request` before `self.send()` in the redirect loop so that subsequent iterations copy the modified request, not the original.

## Reproduction

A POST to an endpoint that returns 303 (→GET) then 307 (→preserve method):
- Expected: POST → GET (303) → GET (307)
- Actual: POST → GET (303) → POST (307) ← wrong, reverts to original
