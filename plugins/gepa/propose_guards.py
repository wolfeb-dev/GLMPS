"""proposer@1: our copy of GEPA (gepa 0.1.4, MIT) optimizes the '## Learned
guards' text against recurring agent failures, judged by Claude through the
GLMPS model route. A human approves every proposed rule before it lands.

Verified against the vendored gepa 0.1.4 source (the evidence is in this
module's tests):
  - optimize_anything(seed_candidate, *, evaluator, dataset, objective,
    config) is the entry point; evaluator is called as evaluator(candidate,
    example) whenever dataset is not None, and may return a bare float or
    (score, side_info).
  - GEPAConfig(tracking=None) is NOT safe: optimize_anything dereferences
    config.tracking.logger unconditionally partway through the run, so a
    None there raises AttributeError deep inside the engine. We leave
    tracking at its dataclass default (a real TrackingConfig()) instead.
  - EngineConfig.raise_on_exception controls whether an EVALUATOR exception
    aborts the run (re-raised out of optimize_anything) or is swallowed as a
    0.0 score with an "error" side_info key and the run continues. We set it
    True: a broken model route must fail the whole proposal loudly (house
    rule: no catch may swallow), not silently degrade into a useless
    best-of-nothing guard proposal.
  - REFLECTION (the "strong" model) exceptions are swallowed unconditionally
    by gepa's own reflective_mutation proposer regardless of
    raise_on_exception (gepa/proposer/reflective_mutation/reflective_mutation.py,
    _propose_texts_batch_safe): a failed reflection call is logged and
    treated as "no candidate proposed" for that iteration, never raised.
    Left unaddressed, a fully broken reflection route also has no natural
    stopping point: max_metric_calls only counts EVALUATOR calls, and if
    reflection never successfully proposes a new candidate, no new
    candidate is ever evaluated, so total_num_evals never grows and the
    engine's main loop (gepa/core/engine.py, _should_stop) never trips.
    Fixed here two ways, without patching vendor: (1) reflection_lm and the
    evaluator are both wrapped in _CallCounter so WE see every attempt and
    failure gepa itself would otherwise hide; (2)
    EngineConfig.max_candidate_proposals is always set (bounded by
    max_metric_calls), which gepa's own MaxCandidateProposalsStopper checks
    against the iteration count regardless of whether any given iteration's
    reflection succeeded - guaranteeing the run still terminates even if
    every reflection call fails from the first iteration on. Verified
    empirically: without max_candidate_proposals, an always-failing
    reflection_lm with max_metric_calls=999999 never stops on its own;
    with max_candidate_proposals=5 it stops after 5 iterations regardless.
  - A model_call built on plain urllib.request.urlopen follows redirects by
    default (HTTPRedirectHandler is installed by default, and it rewrites a
    301/302/303 response to a new request against whatever host the
    redirect names) - so a modelUrl that returns a redirect can make an
    outbound request to a non-local host even after assert_local_model_url
    validated the original URL. Fixed by using a custom opener whose
    redirect handler always raises instead of following.
  - GEPAResult exposes best_candidate (str, since we pass a str seed) and
    total_metric_calls (int | None); we no longer read the latter for our
    own metricCalls/reflectionCalls counts (see _CallCounter above) since a
    raised run leaves no GEPAResult to read at all - we need counts that are
    correct on both the success and failure paths.
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# The literal seed_candidate run() uses when
# seedGuards is empty (below); new_rules() must never return this as if it
# were a genuinely proposed rule.
NO_GUARDS_PLACEHOLDER = "(no guards yet)"

DEFAULT_MAX_METRIC_CALLS = 40
MAX_METRIC_CALLS_CEILING = 200
DEFAULT_MAX_WALL_SECONDS = 2400
MAX_WALL_SECONDS_CEILING = 3600
ALLOWED_MODEL_HOSTS = ("127.0.0.1", "localhost")

JUDGE_TEMPLATE = """You audit coding-agent guard rules.
Guards currently in force:
{candidate}

A recurring agent failure:
code: {code}
title: {title}
details: {body}

Would an agent that follows these guards avoid this failure? Reply with one JSON
object: {{"score": <0..1>, "reason": "<one sentence>"}}. Score 1 only if a guard
clearly and specifically prevents it; penalise vague or redundant guards."""


def bullets(text):
    return [m.group(1).strip() for m in re.finditer(r"^\s*-\s+(.*\S)\s*$", text or "", re.M)]


def new_rules(seed, best):
    have = set(bullets(seed))
    return [b for b in bullets(best) if b not in have and b != NO_GUARDS_PLACEHOLDER]


def parse_score(text, on_failure=None):
    """A malformed judge reply (no JSON
    object at all, or one that fails to parse) used to silently become a
    real, indistinguishable-from-genuine score of 0.0 - the caller could
    never tell "the guards clearly fail this case" from "the judge's output
    was garbage". `on_failure`, if given, is called exactly once whenever
    this falls back to 0.0, so the caller (make_evaluator, then run()) can
    count real parse failures separately from real scores."""
    try:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise ValueError("no JSON object found in judge output")
        obj = json.loads(m.group(0))
        return max(0.0, min(1.0, float(obj.get("score", 0)))), str(obj.get("reason", ""))
    except Exception:
        if on_failure:
            on_failure()
        return 0.0, "unparseable judge output"


def assert_local_model_url(model_url):
    """Refuse any modelUrl that is not the local GLMPS route: a stray config
    must never send judge/reflection prompts to a remote host."""
    parsed = urllib.parse.urlparse(model_url)
    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError(f"modelUrl scheme must be http or https, got {parsed.scheme!r}")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_MODEL_HOSTS:
        raise ValueError(f"modelUrl host must be 127.0.0.1 or localhost, got {host!r}")


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Installed in place of urllib's default HTTPRedirectHandler (a
    same-base-class handler passed to build_opener replaces the default
    instead of stacking with it). Without this, a modelUrl that itself
    passes the localhost/127.0.0.1 host check could still respond with a
    301/302/303 pointing anywhere, and urllib would transparently follow it
    - sending the prompt, and treating the redirected reply as model
    output."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"refusing redirect to {newurl}", headers, fp)


def _build_local_only_opener():
    # build_opener()'s default handler set
    # otherwise includes a ProxyHandler that reads HTTP_PROXY/HTTPS_PROXY
    # from the environment - an operator-set proxy on the box running the
    # server would silently send every judge/reflection prompt through it,
    # off the machine entirely, even though the URL itself is already
    # validated local. ProxyHandler({}) (an explicit empty mapping, not the
    # no-arg env-reading default) replaces that default with one that
    # installs no per-scheme proxy_open handler at all, so it can never
    # proxy anything regardless of the environment. Built fresh per
    # model_call() (not a module-level constant) so it always reflects the
    # environment this process actually runs with, rather than whatever the
    # environment happened to be at import time.
    #
    # The opener is assembled by hand rather than with build_opener() so it
    # carries only the http(s) handlers: the default set also installs
    # FileHandler, FTPHandler and DataHandler, which would let a url that got
    # past the host check read a local file or reach an ftp host.
    opener = urllib.request.OpenerDirector()
    handlers = [
        urllib.request.ProxyHandler({}),
        urllib.request.UnknownHandler(),
        urllib.request.HTTPHandler(),
        urllib.request.HTTPDefaultErrorHandler(),
        _RefuseRedirects(),
        urllib.request.HTTPErrorProcessor(),
    ]
    if hasattr(urllib.request, "HTTPSHandler"):
        handlers.append(urllib.request.HTTPSHandler())
    for h in handlers:
        opener.add_handler(h)
    return opener


def model_call(model_url, model):
    opener = _build_local_only_opener()

    def call(prompt):
        messages = prompt if isinstance(prompt, list) else [{"role": "user", "content": prompt}]
        req = urllib.request.Request(
            f"{model_url}/chat/completions",
            data=json.dumps({"model": model, "messages": messages}).encode(),
            headers={"content-type": "application/json"},
        )
        # opener raises rather than following a redirect; urlopen()-
        # equivalent raises urllib.error.HTTPError on a non-2xx status, and
        # json.loads raises on an unparseable body: none of these are caught
        # here, so a broken model route always surfaces as a raised
        # exception rather than a silently empty or wrong reply.
        with opener.open(req, timeout=300) as r:
            return json.loads(r.read())["choices"][0]["message"]["content"] or ""

    return call


class DeadlineExceeded(Exception):
    """Raised by a _CallCounter once the run's maxWallSeconds budget has
    passed, instead of making the model call."""


class _CallCounter:
    """Wraps a model_call callable (judge or reflection) to record every
    attempt and failure, and to enforce a wall-clock deadline.

    This exists because gepa 0.1.4 hides both kinds of information from the
    caller in the cases we most need them:
      - on a raised run (evaluator raise_on_exception=True), the
        GEPAResult is never constructed, so there is nothing to read
        metricCalls from - we need our own count of calls actually made.
      - reflection failures never raise at all (see module docstring), so
        gepa's own total_metric_calls says nothing about how many
        reflection attempts were made or how many of them failed.
    """

    def __init__(self, inner, deadline_at):
        self._inner = inner
        self._deadline_at = deadline_at
        self.attempts = 0
        self.failures = 0

    def __call__(self, prompt):
        self.attempts += 1
        if time.monotonic() > self._deadline_at:
            self.failures += 1
            raise DeadlineExceeded("maxWallSeconds exceeded; refusing further model calls")
        try:
            return self._inner(prompt)
        except Exception:
            self.failures += 1
            raise


class _ParseFailureCounter:
    """Counts how many judge replies
    parse_score() could not parse, separately from judge_calls.attempts (a
    successfully-parsed score of 0 - "this guard clearly does not prevent
    the failure" - must never look the same as garbage output run() cannot
    trust at all)."""

    def __init__(self):
        self.count = 0

    def mark(self):
        self.count += 1


def make_evaluator(judge, parse_failures=None):
    def evaluate(candidate, example):
        score, reason = parse_score(
            judge(
                JUDGE_TEMPLATE.format(
                    candidate=candidate,
                    code=example.get("code", ""),
                    title=example.get("title", ""),
                    body=example.get("body", ""),
                )
            ),
            on_failure=parse_failures.mark if parse_failures is not None else None,
        )
        try:
            import gepa.optimize_anything as oa

            oa.log(f"failure {example.get('code')}: score {score}. {reason}")
        except Exception as e:
            # The log line is diagnostic only, so a failure never changes the
            # score, but it must not vanish either.
            print(f"propose_guards: oa.log failed: {e!r}", file=sys.stderr)
        return score

    return evaluate


def _validate_failures_have_item_ids(failures):
    for f in failures:
        item_id = f.get("itemId") if isinstance(f, dict) else None
        if not isinstance(item_id, str) or not item_id.strip():
            return f"every failure needs a non-empty itemId, got {f!r}"
    return None


def _validate_max_metric_calls(inp):
    if "maxMetricCalls" not in inp or inp["maxMetricCalls"] is None:
        return DEFAULT_MAX_METRIC_CALLS, None
    value = inp["maxMetricCalls"]
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > MAX_METRIC_CALLS_CEILING:
        return None, f"maxMetricCalls must be an integer between 1 and {MAX_METRIC_CALLS_CEILING}, got {value!r}"
    return value, None


def _validate_max_wall_seconds(inp):
    if "maxWallSeconds" not in inp or inp["maxWallSeconds"] is None:
        return DEFAULT_MAX_WALL_SECONDS, None
    value = inp["maxWallSeconds"]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0 or value > MAX_WALL_SECONDS_CEILING:
        return None, f"maxWallSeconds must be a positive number no greater than {MAX_WALL_SECONDS_CEILING}, got {value!r}"
    return value, None


def run(inp):
    failures = inp.get("failures") or []
    seed = inp.get("seedGuards") or ""
    empty = {
        "ok": False,
        "error": None,
        "bestGuards": seed,
        "newRules": [],
        "sourceItemIds": [],
        "metricCalls": 0,
        "reflectionCalls": 0,
        "reflectionFailures": 0,
        "judgeParseFailures": 0,
    }

    # Every validation below runs before any network call is made.
    if not failures:
        return {**empty, "error": "no failures to learn from"}

    item_id_error = _validate_failures_have_item_ids(failures)
    if item_id_error:
        return {**empty, "error": item_id_error}

    model_url = inp.get("modelUrl", "")
    try:
        assert_local_model_url(model_url)
    except ValueError as e:
        return {**empty, "error": str(e)}

    max_metric_calls, error = _validate_max_metric_calls(inp)
    if error:
        return {**empty, "error": error}

    max_wall_seconds, error = _validate_max_wall_seconds(inp)
    if error:
        return {**empty, "error": error}

    from gepa.optimize_anything import EngineConfig, GEPAConfig, ReflectionConfig, optimize_anything

    deadline_at = time.monotonic() + max_wall_seconds
    judge_calls = _CallCounter(model_call(model_url, inp["models"]["fast"]), deadline_at)
    reflect_calls = _CallCounter(model_call(model_url, inp["models"]["strong"]), deadline_at)
    judge_parse_failures = _ParseFailureCounter()

    def counts():
        return {
            "metricCalls": judge_calls.attempts,
            "reflectionCalls": reflect_calls.attempts,
            "reflectionFailures": reflect_calls.failures,
            "judgeParseFailures": judge_parse_failures.count,
        }

    try:
        result = optimize_anything(
            seed_candidate=seed or f"- {NO_GUARDS_PLACEHOLDER}",
            evaluator=make_evaluator(judge_calls, judge_parse_failures),
            dataset=failures,
            objective="A short list of '- ' bullet rules for a coding agent that prevents the recurring failures without vague or redundant rules.",
            config=GEPAConfig(
                engine=EngineConfig(
                    max_metric_calls=max_metric_calls,
                    # gepa's reflective_mutation proposer swallows every
                    # reflection failure internally (see module docstring);
                    # without also bounding candidate proposals, a fully
                    # broken reflection route with no evaluator failures
                    # would never trip any stopping condition and spin
                    # forever. Bounding by max_metric_calls keeps this a
                    # single user-facing budget.
                    max_candidate_proposals=max_metric_calls,
                    parallel=False,
                    raise_on_exception=True,
                ),
                reflection=ReflectionConfig(reflection_lm=reflect_calls),
            ),
        )
    except Exception as e:
        return {**empty, "error": f"{type(e).__name__}: {e}", **counts()}

    if reflect_calls.attempts > 0 and reflect_calls.failures == reflect_calls.attempts:
        return {
            **empty,
            "error": "every reflection (strong model) call failed; no candidate improvements could be proposed",
            **counts(),
        }

    # parse_score() never raises, so an
    # evaluator run entirely against unparseable judge output would
    # otherwise complete "successfully" - every candidate scored a real,
    # trustworthy-looking 0.0 that was actually just garbage nobody could
    # ever verify. If EVERY judge call's output was unparseable, this is not
    # a usable result no matter what optimize_anything returned.
    if judge_calls.attempts > 0 and judge_parse_failures.count == judge_calls.attempts:
        return {
            **empty,
            "error": "every judge call's output was unparseable; no evaluator score could be trusted",
            **counts(),
        }

    best = result.best_candidate if isinstance(result.best_candidate, str) else json.dumps(result.best_candidate)
    return {
        "ok": True,
        "error": None,
        "bestGuards": best,
        "newRules": new_rules(seed, best),
        "sourceItemIds": [f["itemId"] for f in failures],
        **counts(),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.inp, encoding="utf-8") as f:
        inp = json.load(f)
    try:
        out = run(inp)
    except Exception as e:
        out = {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "bestGuards": inp.get("seedGuards", ""),
            "newRules": [],
            "sourceItemIds": [],
            "metricCalls": 0,
            "reflectionCalls": 0,
            "reflectionFailures": 0,
            "judgeParseFailures": 0,
        }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
