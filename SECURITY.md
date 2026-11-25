# Security Policy

## Supported versions

Only the latest images built from `main` (`ghcr.io/roundtable-k8s/pi-knight` and `ghcr.io/roundtable-k8s/claude-knight`) receive fixes.

## Reporting a vulnerability

Please do not report security problems in public issues.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/roundtable-k8s/knights/security/advisories/new)).

Include what you can: the affected package and version or image tag, how to reproduce it, and what an attacker could do. You'll get an acknowledgement within a few days, and credit in the fix unless you ask otherwise.

## Scope notes

A knight runs model-chosen commands and reads untrusted content by design. The platform contains that with isolation outside the runtime (sandboxing, network limits, narrow credentials); see [roundtable-k8s/roundtable](https://github.com/roundtable-k8s/roundtable). Reports about escaping those limits, leaking credentials, or the guardrail and redaction code in this repo are in scope.
