# Project Phoenix retrospective

Phoenix shipped two weeks behind schedule. Root cause: the auth migration was estimated against the old IdP, and the new IdP added two extra round-trips per request.

Conclusion: future migrations get a one-week spike before estimation.
